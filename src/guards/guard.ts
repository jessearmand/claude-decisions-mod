/**
 * The shape every guard takes, so the hooks module can run them as one chain
 * and the scripts (replay, probe) can run them in-process the way the Python
 * harnesses did.
 *
 * A guard's `run` mirrors the Python module's `run(data)`: it inspects one
 * tool call and answers a `Decision` or `undefined` to defer. It never throws
 * for ordinary input; a bug that does throw is caught by the hooks module's
 * `.catch`, which denies rather than letting the call through unexamined.
 */

import type { Config } from "../config.ts";
import type { Decision, HookInput } from "../decision.ts";
import type { Host } from "../host/host.ts";
import type { SourceResolver } from "../shell/model.ts";

export interface GuardDeps {
    readonly host: Host;
    readonly config: Config;
    /** Reads what a command runs from disk (scripts, package.json, Makefiles, git aliases). */
    readonly sources: SourceResolver;
}

export interface Guard {
    /** The hook name the Python module used, e.g. "rm-rf-guard"; it heads the audit records. */
    readonly name: string;
    /** The tools the guard acts on; the chain skips it for any other tool. */
    readonly tools: ReadonlySet<string>;
    run(input: HookInput, deps: GuardDeps): Promise<Decision | undefined>;
}
