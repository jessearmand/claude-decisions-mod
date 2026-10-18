import { describe, expect, it } from "vitest";
import { decide } from "./chain.ts";
import { resolveConfig } from "./config.ts";
import type { Decision, HookInput } from "./decision.ts";
import type { Guard, GuardDeps } from "./guards/guard.ts";
import { memoryHost } from "./host/memory-host.ts";

function guard(name: string, answer: Decision | undefined | Error, tools = ["Bash"]): Guard {
    return {
        name,
        tools: new Set(tools),
        async run() {
            if (answer instanceof Error) throw answer;
            return answer;
        },
    };
}

const ask = (hook: string): Decision => ({ decision: "ask", reason: `${hook} asks`, hook });
const deny = (hook: string): Decision => ({ decision: "deny", reason: `${hook} denies`, hook });

function deps(env: Record<string, string> = {}): GuardDeps {
    const host = memoryHost({ env });
    return { host, config: resolveConfig(host), sources: async () => [] };
}

const bash: HookInput = { toolName: "Bash", toolInput: { command: "x" }, cwd: "/home/user/proj" };

describe("decide", () => {
    it("defers when no guard decides and there is no judge", async () => {
        const outcome = await decide({ guards: [guard("a", undefined)] }, bash, deps());
        expect(outcome.decision).toBeUndefined();
        expect(outcome.judged).toBe(false);
    });

    it("lets a deny win over an earlier ask", async () => {
        const outcome = await decide({ guards: [guard("a", ask("a")), guard("b", deny("b"))] }, bash, deps());
        expect(outcome.decision?.decision).toBe("deny");
        expect(outcome.decision?.hook).toBe("b");
        expect(outcome.verdicts.map(([name]) => name)).toEqual(["a", "b"]);
    });

    it("skips guards that do not handle the tool", async () => {
        const outcome = await decide({ guards: [guard("a", deny("a"), ["Edit"])] }, bash, deps());
        expect(outcome.decision).toBeUndefined();
    });

    it("turns a deterministic ask into a deny under bypassPermissions", async () => {
        const outcome = await decide(
            { guards: [guard("a", ask("a"))] },
            { ...bash, permissionMode: "bypassPermissions" },
            deps(),
        );
        expect(outcome.decision?.decision).toBe("deny");
        expect(outcome.decision?.reason).toContain("Permission mode is bypassPermissions");
    });

    it("keeps the ask when HOOK_UNATTENDED_KEEP_ASK is set", async () => {
        const outcome = await decide(
            { guards: [guard("a", ask("a"))] },
            { ...bash, permissionMode: "dontAsk" },
            deps({ HOOK_UNATTENDED_KEEP_ASK: "1" }),
        );
        expect(outcome.decision?.decision).toBe("ask");
    });

    it("fails closed when a guard throws", async () => {
        const outcome = await decide({ guards: [guard("a", new Error("boom"))] }, bash, deps());
        expect(outcome.decision?.decision).toBe("deny");
        expect(outcome.errors).toEqual([["a", "boom"]]);
    });

    it("consults the judge only when nothing deterministic decided", async () => {
        let asked = 0;
        const judge: Guard = {
            name: "judge",
            tools: new Set(["Bash"]),
            async run() {
                asked += 1;
                return ask("judge");
            },
        };
        const decided = await decide({ guards: [guard("a", ask("a"))], judge }, bash, deps());
        expect(decided.judged).toBe(false);
        expect(asked).toBe(0);
        const open = await decide({ guards: [guard("a", undefined)], judge }, bash, deps());
        expect(open.judged).toBe(true);
        expect(open.decision?.hook).toBe("judge");
        expect(asked).toBe(1);
    });

    it("leaves the judge's ask alone under bypassPermissions unless opted in", async () => {
        const judge = guard("judge", ask("judge"));
        const input = { ...bash, permissionMode: "bypassPermissions" };
        const kept = await decide({ guards: [], judge }, input, deps());
        expect(kept.decision?.decision).toBe("ask");
        const denied = await decide(
            { guards: [], judge },
            input,
            deps({ BASH_RISK_JUDGE_UNATTENDED_DENY: "1" }),
        );
        expect(denied.decision?.decision).toBe("deny");
    });

    it("defers when the judge throws", async () => {
        const outcome = await decide(
            { guards: [], judge: guard("judge", new Error("network")) },
            bash,
            deps(),
        );
        expect(outcome.decision).toBeUndefined();
        expect(outcome.errors).toEqual([["judge", "network"]]);
    });
});
