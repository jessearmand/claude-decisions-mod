/**
 * The shape every guard takes, so the hooks module can run them as one chain
 * and the scripts (replay, probe) can run them in-process the way the Python
 * harnesses did.
 *
 * A guard's `run` mirrors the Python module's `run(data)`: it inspects one
 * tool call and answers a `Decision` or `undefined` to defer. It never throws
 * for ordinary input; a bug that does throw is caught by the chain, which
 * denies rather than letting the call through unexamined.
 */

import type { Config } from "../config.ts";
import type { Decision, HookInput } from "../decision.ts";
import type { Host } from "../host/host.ts";
import type { SourceResolver } from "../shell/model.ts";

/** What the judge reads of the conversation (judge_context.read_transcript). */
export interface Transcript {
    /** The latest prompt the user typed, raw; undefined when none is known. */
    readonly latestPrompt?: string;
    /** The Bash commands the agent ran in this session, oldest first, the one being judged possibly last. */
    readonly recentBashCommands: readonly string[];
}

/** Reads the transcript for one call; the hooks module backs it with `$.session.messages()`. */
export type TranscriptReader = (input: HookInput) => Promise<Transcript | undefined>;

export interface GuardDeps {
    readonly host: Host;
    readonly config: Config;
    /** Reads what a command runs from disk (scripts, package.json, Makefiles, git aliases). */
    readonly sources: SourceResolver;
    /** The conversation so far, for the judge's context; absent in scripts and tests that need none. */
    readonly transcript?: TranscriptReader;
    /**
     * Shows the user a one-line notice in the session, for a problem a guard
     * works around but the user should fix; the hooks module shows each
     * distinct notice once. Absent in scripts and tests that need none.
     */
    readonly notify?: (message: string) => void;
}

export interface Guard {
    /** The hook name the Python module used, e.g. "rm-rf-guard"; it heads the audit records. */
    readonly name: string;
    /** The tools the guard acts on; the chain skips it for any other tool. */
    readonly tools: ReadonlySet<string>;
    run(input: HookInput, deps: GuardDeps): Promise<Decision | undefined>;
}
