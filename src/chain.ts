/**
 * The guard chain: how one tool call becomes one decision.
 *
 * The Python hooks ran as separate settings hooks and Claude Code merged
 * their answers (a deny from any hook wins over an ask). Here they run in
 * one chain, in a fixed order, with the same merge:
 *
 *   1. every deterministic guard that handles the tool runs; the strongest
 *      decision wins (deny over ask), and an ask becomes a deny when the
 *      permission mode means nobody can answer (forPermissionMode);
 *   2. only when nothing deterministic decided is the model judge consulted,
 *      and it can only ask, never allow or deny. That is the omp adapter's
 *      monotonic ordering described in docs/cc-safety-net-coverage.md of
 *      claude-code-rules: deterministic denial first, deterministic ask
 *      second, the model last.
 *
 * A guard that throws is a bug; the chain records it and treats the call as
 * if that guard had denied, so a crashing guard fails closed, never open.
 */

import type { Decision, HookInput } from "./decision.ts";
import { forPermissionMode, strongest } from "./decision.ts";
import type { Guard, GuardDeps } from "./guards/guard.ts";

export interface ChainOutcome {
    readonly decision: Decision | undefined;
    /** Each guard that answered, in chain order, before the permission-mode adjustment. */
    readonly verdicts: ReadonlyArray<readonly [guard: string, decision: Decision]>;
    /** Guards that threw, with the error's message. */
    readonly errors: ReadonlyArray<readonly [guard: string, error: string]>;
    /** Whether the judge was consulted (it runs only when nothing deterministic decided). */
    readonly judged: boolean;
}

export interface Chain {
    readonly guards: readonly Guard[];
    /** The advisory model judge, or undefined when the mod runs without one. */
    readonly judge?: Guard;
}

function failureDecision(guard: Guard, error: unknown): Decision {
    const message = error instanceof Error ? error.message : String(error);
    return {
        decision: "deny",
        reason:
            `${guard.name}: the guard failed while checking this call (${message}). ` +
            "It is denied rather than run unexamined; report the error and ask the user how to proceed.",
        systemMessage: `${guard.name} failed: ${message}`,
        hook: guard.name,
    };
}

async function runGuard(
    guard: Guard,
    input: HookInput,
    deps: GuardDeps,
    errors: Array<readonly [string, string]>,
): Promise<Decision | undefined> {
    if (!guard.tools.has(input.toolName)) return undefined;
    try {
        return await guard.run(input, deps);
    } catch (error) {
        errors.push([guard.name, error instanceof Error ? error.message : String(error)]);
        return failureDecision(guard, error);
    }
}

/** Run the chain for one tool call. */
export async function decide(chain: Chain, input: HookInput, deps: GuardDeps): Promise<ChainOutcome> {
    const errors: Array<readonly [string, string]> = [];
    const verdicts: Array<readonly [string, Decision]> = [];
    for (const guard of chain.guards) {
        const result = await runGuard(guard, input, deps, errors);
        if (result !== undefined) verdicts.push([guard.name, result]);
    }
    const deterministic = forPermissionMode(
        strongest(verdicts.map(([, verdict]) => verdict)),
        input,
        deps.config.unattendedKeepAsk,
    );
    if (deterministic !== undefined || chain.judge === undefined || !chain.judge.tools.has(input.toolName)) {
        return { decision: deterministic, verdicts, errors, judged: false };
    }
    // The judge never denies on its own; a failure inside it defers, as the Python hook did.
    let advisory: Decision | undefined;
    try {
        advisory = await chain.judge.run(input, deps);
    } catch (error) {
        errors.push([chain.judge.name, error instanceof Error ? error.message : String(error)]);
        deps.host.debug(`${chain.judge.name}: failed, deferring: ${String(error)}`);
    }
    if (advisory !== undefined) {
        verdicts.push([chain.judge.name, advisory]);
        // Only an explicit opt-in lets the model's ask become a deny when no one can answer.
        advisory = deps.config.judge.unattendedDeny
            ? forPermissionMode(advisory, input, deps.config.unattendedKeepAsk)
            : advisory;
    }
    return { decision: advisory, verdicts, errors, judged: true };
}
