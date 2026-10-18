/**
 * Thin client for a decision model on Vercel AI Gateway, for use inside the
 * Bash risk judge. The default is TypeSafe's Jev; any gateway decision model
 * works, such as OpenAI's `openai/gpt-6-luna-decisions`.
 *
 * A decision model answers typed questions (boolean / choice / score) about a
 * piece of shared state and returns calibrated probabilities instead of prose.
 * That makes it a good fit for hooks: a hook can ask "is this command
 * destructive?" and get a number back in well under the hook timeout, with no
 * output to parse beyond JSON.
 *
 * The Python client (jev_client.py) shelled out to `ai decide` wrapped in
 * `fnox exec`. Here the gateway's decision endpoint is called over HTTP
 * directly through `host.fetch`:
 *
 *   POST {config.judge.gatewayUrl}            (default .../v1/evaluate)
 *   { model, state, questions: { id: { type, instructions, criteria? } } }
 *   -> { answers: { id: { type, probability | choice | score, ... } },
 *        model, usage, providerMetadata }
 *
 * The contract of this module is that it NEVER throws and NEVER blocks a hook:
 * every failure mode returns `undefined`, and the calling hook must treat that
 * as "no opinion" and fall back to its existing deterministic behaviour.
 *
 * Failure modes that return `undefined` (printed through `host.debug` only
 * when `config.judge.debug`, HOOK_JEV_DEBUG=1):
 *   * `config.judge.enable` is off (opt-in; default off): no error is recorded
 *   * the request times out, the network fails, the gateway answers non-2xx,
 *     or the body is not the documented JSON shape
 *
 * Credentials, in order: `config.judge.apiKey` (AI_GATEWAY_API_KEY,
 * VERCEL_OIDC_TOKEN or the jevApiKey option); else `fnox exec -- printenv
 * AI_GATEWAY_API_KEY`, pointed at `config.judge.fnoxConfig` when set; else the
 * request goes out with no Authorization header, since a proxy may inject one
 * (a sandbox whose proxy holds the gateway key). A 401/403 in that last case
 * is reported as "no credential".
 *
 * Why a call fell back is available two ways: `tryEvaluate` returns
 * `{ evaluation, error }` and is safe under concurrency (the scripts use it);
 * `evaluate` returns the evaluation alone and stores the error for
 * `lastError()`, as the Python module did, for callers that run one call at a
 * time (the hook).
 */

import type { Config } from "../config.ts";
import type { Host } from "../host/host.ts";
import { expanduser } from "../util/paths.ts";

export const API_KEY_ENV = "AI_GATEWAY_API_KEY";

export type QuestionKind = "boolean" | "choice" | "score";

/** One typed question. `kind` is boolean, choice or score. */
export interface Question {
    readonly id: string;
    readonly kind: QuestionKind;
    readonly text: string;
    /** The choices of a choice question, or the levels of a score question, low to high. */
    readonly options?: readonly string[];
    /** What each choice means, for a choice question; an option without one is described by its name. */
    readonly criteria?: Readonly<Record<string, string>>;
}

/** One question as the gateway's evaluate endpoint takes it. */
export type QuestionSpec =
    | { readonly type: "boolean"; readonly instructions: string }
    | {
          readonly type: "choice";
          readonly instructions: string;
          readonly criteria: Readonly<Record<string, string>>;
      }
    | { readonly type: "score"; readonly instructions: string; readonly criteria: readonly string[] };

/** The request body: `question.cliArgs()` of the Python client, as JSON. */
export function questionSpec(question: Question): QuestionSpec {
    const options = question.options ?? [];
    switch (question.kind) {
        case "boolean":
            return { type: "boolean", instructions: question.text };
        case "choice": {
            const criteria: Record<string, string> = {};
            for (const option of options) criteria[option] = question.criteria?.[option] ?? option;
            return { type: "choice", instructions: question.text, criteria };
        }
        case "score":
            return { type: "score", instructions: question.text, criteria: options };
        default:
            throw new Error(`unknown question kind: ${String(question.kind)}`);
    }
}

export interface EvaluateRequest {
    readonly model: string;
    readonly state: string;
    readonly questions: Readonly<Record<string, QuestionSpec>>;
}

export function requestBody(model: string, state: string, questions: readonly Question[]): EvaluateRequest {
    const specs: Record<string, QuestionSpec> = {};
    for (const question of questions) specs[question.id] = questionSpec(question);
    return { model, state, questions: specs };
}

/** One answer as the gateway returned it; the fields of interest are validated by `answerProblem`. */
export type Answer = Readonly<Record<string, unknown>>;

/** Parsed answers keyed by question id, plus the raw result for logging. */
export class Evaluation {
    /** Kept as a plain record (not a Map) because it is logged as JSON unchanged. */
    readonly answers: Readonly<Record<string, Answer>>;
    readonly raw: Readonly<Record<string, unknown>>;

    constructor(answers: Readonly<Record<string, Answer>> = {}, raw: Readonly<Record<string, unknown>> = {}) {
        this.answers = answers;
        this.raw = raw;
    }

    probability(questionId: string): number | undefined {
        const value = this.answers[questionId]?.probability;
        return typeof value === "number" ? value : undefined;
    }

    choice(questionId: string): string | undefined {
        const value = this.answers[questionId]?.choice;
        return typeof value === "string" ? value : undefined;
    }

    score(questionId: string): number | undefined {
        const value = this.answers[questionId]?.score;
        return typeof value === "number" ? value : undefined;
    }

    /** Per-question confidence for choice/score answers, from whichever provider answered. */
    confidence(): Readonly<Record<string, unknown>> | undefined {
        const metadata = this.raw.providerMetadata;
        if (!isRecord(metadata)) return undefined;
        for (const [provider, values] of Object.entries(metadata)) {
            if (provider !== "gateway" && isRecord(values) && isRecord(values.confidence))
                return values.confidence;
        }
        return undefined;
    }
}

export interface EvaluateOutcome {
    readonly evaluation: Evaluation | undefined;
    /** Why there is no evaluation; undefined when the judge is simply not enabled. */
    readonly error: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): boolean {
    // A JSON `true` must not be read as P=1.0; it is a boolean, not a number, here.
    return typeof value === "number" && value >= 0 && value <= 1;
}

function show(value: unknown): string {
    return value === undefined ? "undefined" : (JSON.stringify(value) ?? String(value));
}

/** Why an answer cannot be trusted, or undefined. One bad answer voids the whole result. */
export function answerProblem(answer: unknown): string | undefined {
    if (!isRecord(answer)) return "not an object";
    if ("probability" in answer && !isProbability(answer.probability))
        return `probability ${show(answer.probability)} is not a number in [0, 1]`;
    if ("choice" in answer && typeof answer.choice !== "string")
        return `choice ${show(answer.choice)} is not a string`;
    if ("score" in answer && typeof answer.score !== "number")
        return `score ${show(answer.score)} is not a number`;
    return undefined;
}

/** The evaluation in a reply body, or the reason it cannot be used. */
export function parseReply(text: string): { evaluation?: Evaluation; error?: string } {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return { error: "response was not JSON" };
    }
    const answers = isRecord(data) ? data.answers : undefined;
    if (!isRecord(answers)) return { error: "JSON had no `answers` object" };
    const validated: Record<string, Answer> = {};
    for (const [questionId, answer] of Object.entries(answers)) {
        const problem = answerProblem(answer);
        if (problem) return { error: `answer ${show(questionId)} rejected: ${problem}` };
        validated[questionId] = answer as Answer;
    }
    return { evaluation: new Evaluation(validated, data as Record<string, unknown>) };
}

/** The argv that asks fnox for the gateway key (the Python `fnox exec` wrapper, reduced to the key). */
export function fnoxArgv(fnoxConfig: string | undefined, home: string): string[] {
    const argv = ["fnox"];
    if (fnoxConfig) argv.push("-c", expanduser(fnoxConfig, home));
    argv.push("exec", "--if-missing", "error", "--", "printenv", API_KEY_ENV);
    return argv;
}

interface Credential {
    readonly key: string | undefined;
    /** Why no key is known, for the debug message should the gateway refuse the request. */
    readonly missing: string | undefined;
}

async function resolveCredential(config: Config, host: Host, timeoutMs: number): Promise<Credential> {
    if (config.judge.apiKey) return { key: config.judge.apiKey, missing: undefined };
    const result = await host.run(fnoxArgv(config.judge.fnoxConfig, host.home), { timeoutMs });
    if (result === undefined)
        return { key: undefined, missing: `${API_KEY_ENV} not set and \`fnox\` not found` };
    const key = result.stdout.trim();
    if (result.exitCode === 0 && key) return { key, missing: undefined };
    const detail = result.stderr.trim().slice(-200) || `exit ${result.exitCode}`;
    return { key: undefined, missing: `${API_KEY_ENV} not set and \`fnox exec\` gave no key (${detail})` };
}

let lastErrorMessage: string | undefined;

/** Why the most recent `evaluate()` fell back, or undefined. */
export function lastError(): string | undefined {
    return lastErrorMessage;
}

/**
 * Ask the decision model `questions` about `state`. Never throws; `evaluation`
 * is undefined whenever the model cannot answer, with `error` saying why
 * (or undefined when the judge is simply not enabled).
 */
export async function tryEvaluate(
    state: string,
    questions: readonly Question[],
    config: Config,
    host: Host,
): Promise<EvaluateOutcome> {
    const outcome = await request(state, questions, config, host);
    if (outcome.error !== undefined && config.judge.debug) host.debug(`jev-client: ${outcome.error}`);
    return outcome;
}

async function request(
    state: string,
    questions: readonly Question[],
    config: Config,
    host: Host,
): Promise<EvaluateOutcome> {
    const none = (error: string | undefined): EvaluateOutcome => ({ evaluation: undefined, error });
    if (!config.judge.enable) return none(undefined);
    if (!state.trim() || questions.length === 0) return none(undefined);

    const timeoutMs = Math.max(1, config.judge.timeoutSeconds) * 1000;
    const started = host.now();
    let body: string;
    try {
        body = JSON.stringify(requestBody(config.judge.model, state, questions));
    } catch (error) {
        return none(
            `request could not be encoded: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const credential = await resolveCredential(config, host, timeoutMs);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (credential.key) headers.Authorization = `Bearer ${credential.key}`;

    // One deadline covers the fnox lookup and the request, as the Python
    // subprocess timeout covered `fnox exec -- ai decide`; a second is the floor.
    const remaining = Math.max(1000, timeoutMs - (host.now() - started));
    const seconds = config.judge.timeoutSeconds;
    let reply: Awaited<ReturnType<Host["fetch"]>>;
    try {
        reply = await host.fetch(config.judge.gatewayUrl, {
            method: "POST",
            headers,
            body,
            timeoutMs: remaining,
        });
    } catch (error) {
        return none(
            `gateway request did not complete: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (reply === undefined) {
        return none(`gateway request did not complete: timed out after ${seconds}s or the network failed`);
    }
    if (!reply.ok) {
        const detail = reply.text.trim().slice(-200);
        if (credential.missing !== undefined && (reply.status === 401 || reply.status === 403)) {
            return none(
                `no gateway credential: ${credential.missing}; gateway answered ${reply.status}: ${detail}`,
            );
        }
        return none(`gateway answered ${reply.status}: ${detail}`);
    }
    const parsed = parseReply(reply.text);
    return parsed.evaluation ? { evaluation: parsed.evaluation, error: undefined } : none(parsed.error);
}

/**
 * Ask the decision model `questions` about `state`. Returns undefined whenever
 * it cannot answer, with the cause available from `lastError()` (undefined
 * when the judge is not enabled: opting out is not a failure).
 */
export async function evaluate(
    state: string,
    questions: readonly Question[],
    config: Config,
    host: Host,
): Promise<Evaluation | undefined> {
    lastErrorMessage = undefined;
    const outcome = await tryEvaluate(state, questions, config, host);
    lastErrorMessage = outcome.error;
    return outcome.evaluation;
}
