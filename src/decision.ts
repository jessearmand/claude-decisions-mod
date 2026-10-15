/**
 * The decision protocol every guard speaks, ported from hook_protocol.py.
 *
 * A guard's `run` answers a `Decision` (`deny` or `ask`, with the reason the
 * user or the model reads) or `undefined` to defer: the normal permission
 * flow then applies. No guard ever answers `allow`: that would approve the
 * call without prompting and defeat the user's own permission settings.
 *
 * The hooks module turns a `Decision` into a `classic.PreToolUse` result,
 * `{ deny: reason }` or `{ ask: reason }`, and `undefined` into `next(e)`.
 */

import { envFlag } from "./host/host.ts";

export type DecisionKind = "deny" | "ask";

export interface Decision {
    readonly decision: DecisionKind;
    readonly reason: string;
    /** A one-line summary for the transcript (Python `systemMessage`). */
    readonly systemMessage?: string;
    /** The guard that decided, e.g. "rm-rf-guard". */
    readonly hook: string;
}

export function decision(
    kind: DecisionKind,
    reason: string,
    systemMessage: string | undefined,
    hook: string,
): Decision {
    return { decision: kind, reason, systemMessage, hook };
}

/**
 * What a guard sees of one tool call: the Python hooks' stdin payload,
 * camel-cased. `toolInput` is the tool's arguments as the model sent them.
 */
export interface HookInput {
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>>;
    /** The directory the session runs in, absolute and normalized. */
    readonly cwd: string;
    readonly permissionMode?: string;
    readonly sessionId?: string;
    readonly agentId?: string;
}

/** Tool inputs that can carry a path, across every tool these hooks match. */
export const PATH_KEYS = ["file_path", "notebook_path", "path", "filePath", "file"] as const;

export const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
export const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob"]);

const ACTION_VERBS: Readonly<Record<string, string>> = {
    Read: "read",
    Grep: "search",
    Glob: "list",
    Edit: "modify",
    MultiEdit: "modify",
    Write: "write",
    NotebookEdit: "modify",
    Bash: "run",
};

/** Every path-like value in a tool input, deduplicated, in key order. */
export function pathsFrom(inputs: Readonly<Record<string, unknown>>): string[] {
    const found: string[] = [];
    for (const key of PATH_KEYS) {
        const value = inputs[key];
        if (typeof value === "string" && value !== "" && !found.includes(value)) found.push(value);
    }
    return found;
}

export function actionVerb(toolName: string): string {
    return ACTION_VERBS[toolName] ?? "use";
}

/** The Bash tool's command, or undefined when the input carries none. */
export function commandOf(inputs: Readonly<Record<string, unknown>>): string | undefined {
    const value = inputs.command;
    return typeof value === "string" ? value : undefined;
}

/**
 * Permission modes in which nobody is there to answer an `ask`. Claude Code
 * already denies an unanswered ask under dontAsk and in `-p` runs; under
 * bypassPermissions the docs do not say, so the guards decide explicitly.
 */
export const UNATTENDED_MODES: ReadonlySet<string> = new Set(["bypassPermissions", "dontAsk"]);

/**
 * Turn a deterministic guard's `ask` into `deny` when no one can be asked.
 *
 * Only tightens: a deny stays a deny and a deferral stays a deferral.
 * `keepAsk` (HOOK_UNATTENDED_KEEP_ASK=1 or the userConfig option) leaves asks unchanged.
 */
export function forPermissionMode(
    result: Decision | undefined,
    input: HookInput,
    keepAsk: boolean | string | undefined = false,
): Decision | undefined {
    const keep = typeof keepAsk === "boolean" ? keepAsk : envFlag(keepAsk);
    if (result === undefined || result.decision !== "ask" || keep) return result;
    const mode = input.permissionMode;
    if (mode === undefined || !UNATTENDED_MODES.has(mode)) return result;
    return {
        decision: "deny",
        reason:
            `${result.reason}\n\n[${result.hook || "guard"}] Permission mode is ${mode}, so no one can ` +
            "confirm this. It is denied instead; ask the user to run it or to switch modes.",
        systemMessage: result.systemMessage,
        hook: result.hook,
    };
}

/**
 * The strongest of several guards' decisions, as the live hook chain settles
 * them: a deny from any guard wins over an ask from another; a deferral from
 * all is a deferral. Order among equals is the guards' registration order.
 */
export function strongest(decisions: ReadonlyArray<Decision | undefined>): Decision | undefined {
    let ask: Decision | undefined;
    for (const candidate of decisions) {
        if (candidate === undefined) continue;
        if (candidate.decision === "deny") return candidate;
        ask = ask ?? candidate;
    }
    return ask;
}
