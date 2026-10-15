/**
 * Every path through the gateway client, each fallback included, with
 * `host.fetch` and `host.run` stubbed: no network, no processes.
 */

import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.ts";
import type { HttpReply, HttpRequest, RunOptions, RunResult } from "../host/host.ts";
import { memoryHost } from "../host/memory-host.ts";
import {
    API_KEY_ENV,
    answerProblem,
    Evaluation,
    evaluate,
    fnoxArgv,
    lastError,
    parseReply,
    type Question,
    questionSpec,
    requestBody,
    tryEvaluate,
} from "./jev-client.ts";

const QUESTIONS: Question[] = [
    { id: "destructive", kind: "boolean", text: "Is it destructive?" },
    {
        id: "scope",
        kind: "choice",
        text: "Which files?",
        options: ["working_directory_only", "unknown"],
        criteria: { working_directory_only: "only files under the working directory" },
    },
    { id: "severity", kind: "score", text: "How bad?", options: ["none", "minor", "severe"] },
];

const SUCCESS = {
    answers: {
        destructive: { type: "boolean", probability: 0.93 },
        exfiltrates: { type: "boolean", probability: 0.02 },
        scope: {
            type: "choice",
            choice: "home_directory",
            probabilities: { home_directory: 0.9, unknown: 0.1 },
            confidence: 0.9,
        },
        severity: { type: "score", score: 2.9, probabilities: { severe: 0.9 } },
    },
    model: "typesafe-ai/jev",
    usage: { inputTokens: 40, outputTokens: 3 },
    providerMetadata: { typesafe: { confidence: { scope: 0.9, severity: 1 } }, gateway: { cost: "0.00001" } },
};

interface Call {
    url: string;
    request: HttpRequest;
}

interface Setup {
    env?: Record<string, string>;
    reply?: HttpReply | ((request: HttpRequest) => HttpReply | undefined);
    run?: (argv: readonly string[], options?: RunOptions) => RunResult | undefined;
}

const ENABLED = { HOOK_JEV_ENABLE: "1", [API_KEY_ENV]: "test-key", HOOK_JEV_TIMEOUT: "2" };

function ok(body: unknown): HttpReply {
    return { status: 200, ok: true, text: typeof body === "string" ? body : JSON.stringify(body) };
}

function setup(options: Setup = {}) {
    const calls: Call[] = [];
    const runs: (readonly string[])[] = [];
    const host = memoryHost({
        env: options.env ?? ENABLED,
        fetch: (url, request) => {
            calls.push({ url, request });
            const reply = options.reply ?? ok(SUCCESS);
            return typeof reply === "function" ? reply(request) : reply;
        },
        run: (argv, runOptions) => {
            runs.push(argv);
            return options.run?.(argv, runOptions);
        },
    });
    return { host, config: resolveConfig(host), calls, runs };
}

function body(call: Call | undefined): Record<string, unknown> {
    return JSON.parse(call?.request.body ?? "{}") as Record<string, unknown>;
}

describe("requestBody", () => {
    it("encodes each question kind as the gateway takes it", () => {
        expect(questionSpec(QUESTIONS[0] as Question)).toEqual({
            type: "boolean",
            instructions: "Is it destructive?",
        });
        expect(questionSpec(QUESTIONS[1] as Question)).toEqual({
            type: "choice",
            instructions: "Which files?",
            criteria: {
                working_directory_only: "only files under the working directory",
                unknown: "unknown",
            },
        });
        expect(questionSpec(QUESTIONS[2] as Question)).toEqual({
            type: "score",
            instructions: "How bad?",
            criteria: ["none", "minor", "severe"],
        });
        const request = requestBody("typesafe-ai/jev", "cwd: /\ncommand:\nrm x\n", QUESTIONS);
        expect(request.model).toBe("typesafe-ai/jev");
        expect(request.state).toBe("cwd: /\ncommand:\nrm x\n");
        expect(Object.keys(request.questions)).toEqual(["destructive", "scope", "severity"]);
    });
});

describe("evaluate: the happy path", () => {
    it("posts the state and questions with the bearer key and parses the answers", async () => {
        const { host, config, calls, runs } = setup();
        const evaluation = await evaluate("cwd: /p\ncommand:\ngit clean -xdf\n", QUESTIONS, config, host);
        expect(evaluation).toBeInstanceOf(Evaluation);
        expect(lastError()).toBeUndefined();
        expect(runs).toEqual([]); // the key was known: no fnox
        expect(calls).toHaveLength(1);
        const call = calls[0] as Call;
        expect(call.url).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
        expect(call.request.method).toBe("POST");
        expect(call.request.headers).toEqual({
            "Content-Type": "application/json",
            Authorization: "Bearer test-key",
        });
        expect(call.request.timeoutMs).toBe(2000);
        const sent = body(call);
        expect(sent.model).toBe("typesafe-ai/jev");
        expect(sent.state).toBe("cwd: /p\ncommand:\ngit clean -xdf\n");
        expect(evaluation?.probability("destructive")).toBe(0.93);
        expect(evaluation?.probability("missing")).toBeUndefined();
        expect(evaluation?.choice("scope")).toBe("home_directory");
        expect(evaluation?.choice("destructive")).toBeUndefined();
        expect(evaluation?.score("severity")).toBe(2.9);
        expect(evaluation?.score("scope")).toBeUndefined();
        expect(evaluation?.confidence()).toEqual({ scope: 0.9, severity: 1 });
        expect(evaluation?.answers.destructive).toEqual({ type: "boolean", probability: 0.93 });
        expect(evaluation?.raw.usage).toEqual({ inputTokens: 40, outputTokens: 3 });
    });

    it("honours the model, gateway URL and timeout from the configuration", async () => {
        const { host, config, calls } = setup({
            env: {
                ...ENABLED,
                HOOK_JEV_MODEL: "openai/gpt-6-luna-decisions",
                HOOK_JEV_GATEWAY_URL: "https://gateway.example/v1/evaluate",
                HOOK_JEV_TIMEOUT: "7",
            },
        });
        await evaluate("state", QUESTIONS, config, host);
        expect(calls[0]?.url).toBe("https://gateway.example/v1/evaluate");
        expect(body(calls[0]).model).toBe("openai/gpt-6-luna-decisions");
        expect(calls[0]?.request.timeoutMs).toBe(7000);
    });

    it("accepts a Vercel OIDC token as the credential", async () => {
        const { host, config, calls } = setup({ env: { HOOK_JEV_ENABLE: "1", VERCEL_OIDC_TOKEN: "oidc" } });
        expect(await evaluate("state", QUESTIONS, config, host)).toBeDefined();
        expect(calls[0]?.request.headers?.Authorization).toBe("Bearer oidc");
    });

    it("reads confidence from any non-gateway provider", () => {
        const evaluation = new Evaluation({}, { providerMetadata: { gateway: { confidence: { x: 1 } } } });
        expect(evaluation.confidence()).toBeUndefined();
        expect(
            new Evaluation({}, { providerMetadata: { other: { confidence: { q: 0.5 } } } }).confidence(),
        ).toEqual({ q: 0.5 });
        expect(new Evaluation().confidence()).toBeUndefined();
    });
});

describe("evaluate: opting out", () => {
    it("returns undefined with no error and no request when HOOK_JEV_ENABLE is unset", async () => {
        const { host, config, calls } = setup({ env: { [API_KEY_ENV]: "test-key" } });
        expect(await evaluate("state", QUESTIONS, config, host)).toBeUndefined();
        expect(lastError()).toBeUndefined();
        expect(calls).toEqual([]);
    });

    it("returns undefined with no error when HOOK_JEV_ENABLE=0", async () => {
        const { host, config, calls } = setup({ env: { ...ENABLED, HOOK_JEV_ENABLE: "0" } });
        expect(await tryEvaluate("state", QUESTIONS, config, host)).toEqual({
            evaluation: undefined,
            error: undefined,
        });
        expect(calls).toEqual([]);
    });

    it("sends nothing for an empty state or no questions", async () => {
        const { host, config, calls } = setup();
        expect(await evaluate("   \n", QUESTIONS, config, host)).toBeUndefined();
        expect(await evaluate("state", [], config, host)).toBeUndefined();
        expect(lastError()).toBeUndefined();
        expect(calls).toEqual([]);
    });
});

describe("evaluate: credentials", () => {
    const NO_KEY = { HOOK_JEV_ENABLE: "1", HOOK_JEV_TIMEOUT: "2" };

    it("asks fnox for the key when none is configured, pointed at HOOK_JEV_FNOX_CONFIG", async () => {
        const { host, config, calls, runs } = setup({
            env: { ...NO_KEY, HOOK_JEV_FNOX_CONFIG: "~/cfg/fnox.toml" },
            run: () => ({ exitCode: 0, stdout: "fnox-key\n", stderr: "" }),
        });
        expect(await evaluate("state", QUESTIONS, config, host)).toBeDefined();
        expect(runs).toEqual([
            [
                "fnox",
                "-c",
                "/home/user/cfg/fnox.toml",
                "exec",
                "--if-missing",
                "error",
                "--",
                "printenv",
                API_KEY_ENV,
            ],
        ]);
        expect(calls[0]?.request.headers?.Authorization).toBe("Bearer fnox-key");
    });

    it("runs fnox without -c when no config is named", () => {
        expect(fnoxArgv(undefined, "/home/user")).toEqual([
            "fnox",
            "exec",
            "--if-missing",
            "error",
            "--",
            "printenv",
            API_KEY_ENV,
        ]);
    });

    it("sends the request without Authorization when fnox is missing, since a proxy may inject the key", async () => {
        const { host, config, calls } = setup({ env: NO_KEY, run: () => undefined });
        expect(await evaluate("state", QUESTIONS, config, host)).toBeDefined();
        expect(calls[0]?.request.headers).toEqual({ "Content-Type": "application/json" });
    });

    it("reports a 401 without a key as a missing credential, naming fnox", async () => {
        const { host, config } = setup({
            env: { ...NO_KEY, HOOK_JEV_DEBUG: "1" },
            run: () => undefined,
            reply: { status: 401, ok: false, text: '{"error":"unauthorized"}' },
        });
        expect(await evaluate("state", QUESTIONS, config, host)).toBeUndefined();
        expect(lastError()).toContain("no gateway credential");
        expect(lastError()).toContain("fnox");
        expect(lastError()).toContain("401");
        expect(host.debugLines).toEqual([`jev-client: ${lastError()}`]);
    });

    it("reports a 403 after fnox failed with fnox's own message", async () => {
        const { host, config } = setup({
            env: NO_KEY,
            run: () => ({ exitCode: 1, stdout: "", stderr: "secret AI_GATEWAY_API_KEY not found" }),
            reply: { status: 403, ok: false, text: "forbidden" },
        });
        expect(await evaluate("state", QUESTIONS, config, host)).toBeUndefined();
        expect(lastError()).toContain("no gateway credential");
        expect(lastError()).toContain("secret AI_GATEWAY_API_KEY not found");
    });

    it("reports a 401 with a configured key as the gateway's answer, not a missing credential", async () => {
        const { host, config } = setup({ reply: { status: 401, ok: false, text: "bad key" } });
        expect(await evaluate("state", QUESTIONS, config, host)).toBeUndefined();
        expect(lastError()).toBe("gateway answered 401: bad key");
    });
});

describe("evaluate: fallbacks", () => {
    it("defers when the request times out or the network fails", async () => {
        const { host, config } = setup({ reply: () => undefined });
        expect(await evaluate("state", QUESTIONS, config, host)).toBeUndefined();
        expect(lastError()).toContain("did not complete");
        expect(lastError()).toContain("2s");
    });

    it("defers on a non-2xx reply, keeping the tail of the body", async () => {
        const { host, config } = setup({ reply: { status: 500, ok: false, text: `x${"y".repeat(300)}` } });
        expect(await evaluate("state", QUESTIONS, config, host)).toBeUndefined();
        expect(lastError()).toBe(`gateway answered 500: ${"y".repeat(200)}`);
    });

    it("defers when the body is not JSON", async () => {
        const { host, config } = setup({ reply: ok("not json") });
        expect(await evaluate("state", QUESTIONS, config, host)).toBeUndefined();
        expect(lastError()).toBe("response was not JSON");
    });

    it("defers when the JSON has no answers object", async () => {
        const { host, config } = setup({ reply: ok({ usage: {} }) });
        expect(await evaluate("state", QUESTIONS, config, host)).toBeUndefined();
        expect(lastError()).toBe("JSON had no `answers` object");
        expect(parseReply("[]").error).toBe("JSON had no `answers` object");
        expect(parseReply('{"answers": []}').error).toBe("JSON had no `answers` object");
    });

    // Answers that parse as JSON but must not be trusted. Each voids the whole
    // result, so the hook defers instead of acting on a malformed probability.
    const UNTRUSTED_ANSWERS: Array<[string, Record<string, unknown>]> = [
        ["probability above 1", { destructive: { probability: 2 } }],
        ["negative probability", { destructive: { probability: -0.5 } }],
        ["boolean probability", { destructive: { probability: true } }],
        ["string probability", { destructive: { probability: "0.99" } }],
        ["null probability", { destructive: { probability: null } }],
        ["answer is not an object", { destructive: 0.99 }],
        [
            "one bad answer voids a good one",
            { destructive: { probability: 0.99 }, exfiltrates: { probability: 7 } },
        ],
        ["non-string choice", { destructive: { probability: 0.99 }, scope: { choice: 3 } }],
        ["string score", { severity: { score: "2" } }],
        ["boolean score", { severity: { score: true } }],
    ];

    it.each(UNTRUSTED_ANSWERS)("rejects an untrusted answer: %s", async (_name, answers) => {
        const { host, config } = setup({ reply: ok({ answers }) });
        expect(await evaluate("state", QUESTIONS, config, host)).toBeUndefined();
        expect(lastError()).toContain("rejected");
    });

    it("names the problem with each untrusted answer", () => {
        expect(answerProblem(0.99)).toBe("not an object");
        expect(answerProblem({ probability: true })).toBe("probability true is not a number in [0, 1]");
        expect(answerProblem({ probability: "0.99" })).toBe('probability "0.99" is not a number in [0, 1]');
        expect(answerProblem({ choice: 3 })).toBe("choice 3 is not a string");
        expect(answerProblem({ score: "2" })).toBe('score "2" is not a number');
        expect(answerProblem({ probability: 0, choice: "x", score: -1 })).toBeUndefined();
        expect(answerProblem({})).toBeUndefined();
    });

    it("prints the cause through host.debug only when HOOK_JEV_DEBUG is set", async () => {
        const quiet = setup({ reply: () => undefined });
        await evaluate("state", QUESTIONS, quiet.config, quiet.host);
        expect(quiet.host.debugLines).toEqual([]);
        const loud = setup({ env: { ...ENABLED, HOOK_JEV_DEBUG: "1" }, reply: ok("nope") });
        await evaluate("state", QUESTIONS, loud.config, loud.host);
        expect(loud.host.debugLines).toEqual(["jev-client: response was not JSON"]);
    });

    it("clears the last error on a later success", async () => {
        const failing = setup({ reply: () => undefined });
        await evaluate("state", QUESTIONS, failing.config, failing.host);
        expect(lastError()).toBeDefined();
        const working = setup();
        await evaluate("state", QUESTIONS, working.config, working.host);
        expect(lastError()).toBeUndefined();
    });

    it("never throws, even when the host's fetch does", async () => {
        const host = memoryHost({
            env: ENABLED,
            fetch: () => {
                throw new Error("socket exploded");
            },
        });
        const outcome = await tryEvaluate("state", QUESTIONS, resolveConfig(host), host);
        expect(outcome.evaluation).toBeUndefined();
        expect(outcome.error).toContain("socket exploded");
    });
});
