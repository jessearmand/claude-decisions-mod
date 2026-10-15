/**
 * Context for the model judge: what the user asked for, what the agent just
 * ran, and what the command will execute from disk.
 *
 * A command is only "off task" or "suspicious" relative to the task. shellkeeper's
 * model card shows the difference: red-team AUC 0.953 with the user's task and
 * recent commands in the prompt, 0.618 without. This module assembles that
 * context from what a hook can see:
 *
 *   * the latest prompt the user typed and the last few shell commands the
 *     agent ran in this session, from the `TranscriptReader` the hooks module
 *     backs with the engine's session messages (the Python module read the
 *     transcript JSONL file named by `transcript_path`);
 *   * program text the command runs from disk (scripts, package.json scripts,
 *     Makefile recipes), resolved by the parser's source resolver.
 *
 * All of it is redacted with the same secret patterns as the command and
 * bounded in size. Reading never throws; anything missing is simply left out.
 * `config.judge.context === false` (BASH_RISK_JUDGE_CONTEXT=0) sends the
 * command alone, as before.
 */

import type { Config } from "../config.ts";
import type { HookInput } from "../decision.ts";
import type { Transcript, TranscriptReader } from "../guards/guard.ts";
import { startsWithAny } from "../util/text.ts";

export const PROMPT_LIMIT = 1500;
export const RECENT_COMMANDS = 5;
export const RECENT_COMMAND_LIMIT = 300;
export const SOURCE_LIMIT = 8000;

/** Rows the engine injects rather than the person typing; a prompt starting so is not a task. */
export const NOT_TYPED: readonly string[] = [
    "[Request interrupted",
    "<command-",
    "<local-command",
    "<system-reminder",
    "Caveat:",
];

/** (label, text) for program text the command runs from files. */
export type LabelledSource = readonly [label: string, text: string];

export interface JudgeContext {
    task?: string;
    recentCommands: string[];
    sources: LabelledSource[];
    /** True when some program text was cut to fit; the model saw only part of it. */
    truncated: boolean;
}

export function emptyContext(): JudgeContext {
    return { task: undefined, recentCommands: [], sources: [], truncated: false };
}

export function clip(text: string, limit: number): [string, boolean] {
    return text.length <= limit ? [text, false] : [`${text.slice(0, limit)}\n[... truncated]`, true];
}

/** The transcript for this call, or nothing: a reader that fails leaves the judge without context. */
async function readTranscript(
    input: HookInput,
    transcript: TranscriptReader | undefined,
): Promise<Transcript | undefined> {
    if (transcript === undefined) return undefined;
    try {
        return await transcript(input);
    } catch {
        return undefined;
    }
}

/**
 * Assemble redacted, size-bounded context for one Bash call.
 *
 * `transcript` is `deps.transcript`, read here (and only when context is
 * enabled) so a disabled judge context never touches the session.
 */
export async function gather(
    input: HookInput,
    command: string,
    indirectSources: readonly LabelledSource[],
    redact: (text: string) => string,
    config: Config,
    transcript?: TranscriptReader,
): Promise<JudgeContext> {
    const context = emptyContext();
    if (!config.judge.context) return context;

    const read = await readTranscript(input, transcript);
    const latest = read?.latestPrompt;
    const prompt = latest && !startsWithAny(latest.trimStart(), NOT_TYPED) ? latest : undefined;
    if (prompt?.trim()) context.task = redact(clip(prompt.trim(), PROMPT_LIMIT)[0]);
    // The command being judged is usually the newest tool_use already; skip it.
    const recent = (read?.recentBashCommands ?? [])
        .slice(-RECENT_COMMANDS)
        .filter((c) => c.trim() !== command.trim());
    context.recentCommands = recent.map((c) => redact(clip(c, RECENT_COMMAND_LIMIT)[0]));

    let budget = SOURCE_LIMIT;
    for (const [label, text] of indirectSources) {
        if (budget <= 0) {
            context.truncated = true;
            break;
        }
        const [clipped, cut] = clip(text, budget);
        context.truncated = context.truncated || cut;
        context.sources.push([label, redact(clipped)]);
        budget -= clipped.length;
    }
    return context;
}

/** The state text sent to the model. */
export function render(context: JudgeContext, cwd: string, command: string): string {
    const parts: string[] = [];
    if (context.task) parts.push(`user's latest request:\n${context.task}\n`);
    if (context.recentCommands.length > 0) {
        parts.push(
            `commands the agent ran just before this one:\n${context.recentCommands.map((c) => `$ ${c}`).join("\n")}\n`,
        );
    }
    parts.push(`cwd: ${cwd}\ncommand:\n${command}\n`);
    for (const [label, text] of context.sources) parts.push(`this command executes (${label}):\n${text}\n`);
    return parts.join("\n");
}
