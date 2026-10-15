/**
 * Claude Code Hook: Bash Command Validator (ported from bash_command_validator.py)
 * ===============================================================================
 * PreToolUse guard for the Bash tool. It validates bash commands against a set
 * of rules before execution. In this case it steers grep calls to rg, and rg
 * over source code to ast-grep.
 *
 * The Python hook exited 2 with the bullet messages on stderr, which blocks the
 * tool call and shows them to Claude; here that is a `deny` whose reason is the
 * same bullet list.
 *
 * Configuration (config.ts): BASH_COMMAND_VALIDATOR_DISABLE=1 turns it off.
 */

import { commandOf, type Decision, decision, type HookInput } from "../decision.ts";
import type { Guard, GuardDeps } from "./guard.ts";

export const HOOK_NAME = "bash-command-validator";

/** Validation rules as (regex pattern, message) pairs, searched anywhere in the command. */
const VALIDATION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
    [/^grep\b(?!.*\|)/, "Use 'rg' (ripgrep) instead of 'grep' for better performance and features"],
    [
        /^find\s+\S+\s+-name\b/,
        "Use 'rg --files | rg pattern' or 'rg --files -g pattern' instead of 'find -name' for better performance",
    ],
    [
        /^rg\b(?!.*\s--files\b(?:\s+-g\s+\S+)?).*(?:\*\.(swift|py|ts|js|jsx|tsx|rs|go|c|cpp|html|java|kt|rb|yaml|yml)\b|--type\s+(swift|python|typescript|javascript|rust|go|c|cpp|html|java|kotlin|ruby|yaml))/,
        "Use 'ast-grep -p pattern' instead of 'rg' for Swift, Python, TypeScript, JavaScript, JSX, TSX, Rust, Go, C, C++, HTML, Java, Kotlin, Ruby, and YAML source code",
    ],
];

/** Every rule message `command` trips, in rule order. */
export function validateCommand(command: string): string[] {
    const issues: string[] = [];
    for (const [pattern, message] of VALIDATION_RULES) {
        if (pattern.test(command)) issues.push(message);
    }
    return issues;
}

async function run(input: HookInput, deps: GuardDeps): Promise<Decision | undefined> {
    if (deps.config.commandValidator.disable) return undefined;
    if (input.toolName !== "Bash") return undefined;

    const command = commandOf(input.toolInput);
    if (!command) return undefined;

    const issues = validateCommand(command);
    if (issues.length === 0) return undefined;
    return decision("deny", issues.map((message) => `• ${message}`).join("\n"), undefined, HOOK_NAME);
}

export const bashCommandValidator: Guard = { name: HOOK_NAME, tools: new Set(["Bash"]), run };
