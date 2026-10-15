/**
 * bash_command_validator.py shipped without a test file; these cases were
 * checked against the Python `_validate_command` as the oracle.
 */

import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.ts";
import type { HookInput } from "../decision.ts";
import { memoryHost } from "../host/memory-host.ts";
import { bashCommandValidator, validateCommand } from "./bash-command-validator.ts";
import type { GuardDeps } from "./guard.ts";

const GREP = "Use 'rg' (ripgrep) instead of 'grep' for better performance and features";
const FIND =
    "Use 'rg --files | rg pattern' or 'rg --files -g pattern' instead of 'find -name' for better performance";
const AST_GREP =
    "Use 'ast-grep -p pattern' instead of 'rg' for Swift, Python, TypeScript, JavaScript, JSX, TSX, Rust, Go, C, C++, HTML, Java, Kotlin, Ruby, and YAML source code";

function deps(env: Record<string, string> = {}): GuardDeps {
    const host = memoryHost({ env });
    return { host, config: resolveConfig(host), sources: async () => [] };
}

function input(command: string, toolName = "Bash"): HookInput {
    return { toolName, toolInput: { command }, cwd: "/home/user/proj" };
}

describe("validateCommand", () => {
    it.each([
        ["grep foo src/", [GREP]],
        ["grep -rn TODO .", [GREP]],
        ["grep foo file | head", []],
        ["rg foo | grep bar", []],
        ["find . -name '*.py'", [FIND]],
        ["find src -name main.rs -exec cat {} +", [FIND]],
        ["find . -type f", []],
        ["rg --type python foo", [AST_GREP]],
        ["rg foo '*.ts'", [AST_GREP]],
        ["rg -g '*.swift' import", [AST_GREP]],
        ["rg --files -g '*.ts'", []],
        ["rg --files | rg '*.ts'", []],
        ["rg foo src/", []],
        ["rg --type md foo", []],
        ["ls -la", []],
        ["echo grep", []],
    ])("%s -> %j", (command, expected) => {
        expect(validateCommand(command)).toEqual(expected);
    });
});

describe("bashCommandValidator", () => {
    it("denies with the bullet list the Python hook printed to stderr", async () => {
        const out = await bashCommandValidator.run(input("grep foo src/"), deps());
        expect(out).toEqual({
            decision: "deny",
            reason: `• ${GREP}`,
            systemMessage: undefined,
            hook: "bash-command-validator",
        });
    });

    it("defers for clean commands, other tools and an empty command", async () => {
        expect(await bashCommandValidator.run(input("rg foo src/"), deps())).toBeUndefined();
        expect(await bashCommandValidator.run(input("grep foo src/", "Read"), deps())).toBeUndefined();
        expect(await bashCommandValidator.run(input(""), deps())).toBeUndefined();
        expect(
            await bashCommandValidator.run(
                { toolName: "Bash", toolInput: {}, cwd: "/home/user/proj" },
                deps(),
            ),
        ).toBeUndefined();
    });

    it("BASH_COMMAND_VALIDATOR_DISABLE=1 -> defer", async () => {
        expect(
            await bashCommandValidator.run(
                input("grep foo src/"),
                deps({ BASH_COMMAND_VALIDATOR_DISABLE: "1" }),
            ),
        ).toBeUndefined();
    });
});
