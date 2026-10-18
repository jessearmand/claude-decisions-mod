import { describe, expect, it } from "vitest";
import { overriddenOptions, resolveConfig } from "./config.ts";
import { memoryHost } from "./host/memory-host.ts";

describe("overriddenOptions", () => {
    it("names an option the environment replaces with another value", () => {
        const host = memoryHost({ env: { BASH_RISK_JUDGE_ASK_THRESHOLD: "0.6" } });
        const options = { askThreshold: 0.75 };
        expect(resolveConfig(host, options).judge.askThreshold).toBe(0.6);
        expect(overriddenOptions(host, options)).toEqual([
            "the askThreshold option (0.75) is ignored: BASH_RISK_JUDGE_ASK_THRESHOLD=0.6 in the " +
                "environment overrides it. Remove one of them so they cannot disagree.",
        ]);
    });

    it("compares values as resolveConfig reads them", () => {
        const host = memoryHost({
            env: { BASH_RISK_JUDGE_ASK_THRESHOLD: "0.70", SECRETS_GUARD_LEVEL: " HIGH " },
        });
        expect(overriddenOptions(host, { askThreshold: "0.7", secretsLevel: "high" })).toEqual([]);
    });

    it("covers levels, the model and the timeout", () => {
        const host = memoryHost({
            env: { DANGEROUS_COMMANDS_LEVEL: "strict", HOOK_JEV_MODEL: "a/m", HOOK_JEV_TIMEOUT: "9" },
        });
        const warnings = overriddenOptions(host, {
            dangerousLevel: "critical",
            jevModel: "b/m",
            jevTimeoutSeconds: 5,
        });
        expect(warnings.map((w) => w.split(" ", 2)[1])).toEqual([
            "jevTimeoutSeconds",
            "jevModel",
            "dangerousLevel",
        ]);
    });

    it("is quiet when only one side is set, or the environment value is invalid", () => {
        expect(overriddenOptions(memoryHost({}), { askThreshold: 0.75 })).toEqual([]);
        expect(overriddenOptions(memoryHost({ env: { BASH_RISK_JUDGE_ASK_THRESHOLD: "0.6" } }), {})).toEqual(
            [],
        );
        const invalid = memoryHost({
            env: { BASH_RISK_JUDGE_ASK_THRESHOLD: "high", SECRETS_GUARD_LEVEL: "max" },
        });
        expect(overriddenOptions(invalid, { askThreshold: 0.75, secretsLevel: "strict" })).toEqual([]);
    });
});
