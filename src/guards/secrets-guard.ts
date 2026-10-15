/**
 * Claude Code Hook: Secrets Guard (ported from secrets_guard.py)
 * ==============================================================
 * PreToolUse guard for Read, Edit, MultiEdit, Write, NotebookEdit, Grep, Glob and
 * Bash. Blocks access to credential files and to shell commands that would read,
 * mutate, or exfiltrate secrets.
 *
 * Consolidates three earlier hooks:
 *   env_file_protection_hook.py  .env access patterns in Bash
 *   read_env_protection_hook.py  .env paths in Read
 *   protect-secrets.js           tiered secret files + Bash exfiltration (ported)
 *
 * Generated files that must not be hand-edited (lockfiles, .git/ internals) are a
 * separate category and live in file-protection.ts.
 *
 * Policy lives in secrets-guard-rules.ts, tiered so coverage can be dialled:
 *   critical  SSH keys, cloud credentials, .env files
 *   high      + secrets files, env dumps, exfiltration attempts   <- default
 *   strict    + database configs and anything that might hold a secret
 *
 * A match answers `deny` (or `ask`, per level). A non-match defers (`undefined`)
 * — never `allow`, which would auto-approve every unrelated tool call and
 * silently defeat the user's own permission rules.
 *
 * Configuration (config.ts, from the userConfig options or the environment):
 *   SECRETS_GUARD_LEVEL=critical|high|strict   enforcement tier (default: high)
 *   SECRETS_GUARD_DISABLE=1                    turn the guard off entirely
 *   SECRETS_GUARD_LOG_DIR=<dir>                default ~/.claude/hooks-logs
 *   HOOK_ASK_CRITICAL / HOOK_ASK_HIGH / HOOK_ASK_STRICT = true
 *       prompt the user for that tier instead of denying outright
 */

import { logEvent } from "../audit.ts";
import { type Config, LEVEL_ORDER, type Level } from "../config.ts";
import {
    actionVerb,
    type Decision,
    decision,
    type HookInput,
    pathsFrom,
    READ_TOOLS,
    WRITE_TOOLS,
} from "../decision.ts";
import type { Host } from "../host/host.ts";
import { inlinePrograms, stringLiterals } from "../shell/interpreters.ts";
import type { SourceResolver } from "../shell/model.ts";
import { parse } from "../shell/parse.ts";
import { resolve } from "../shell/sources.ts";
import { truncate } from "../util/text.ts";
import type { Guard, GuardDeps } from "./guard.ts";
import {
    ALLOWLIST,
    ALLOWLIST_IN_COMMAND,
    type CommandRule,
    EXEMPT_COMMAND_HEADS,
    type FileRule,
    HIGH,
    SECRET_COMMANDS,
    SECRET_FILES,
} from "./secrets-guard-rules.ts";

export { LEVEL_ORDER };

export const HOOK_NAME = "secrets-guard";

const LEVEL_MARKS: Readonly<Record<Level, string>> = { critical: "🔐", high: "🛡️", strict: "⚠️" };
export const DEFAULT_LEVEL: Level = HIGH;

export const HANDLED_TOOLS: ReadonlySet<string> = new Set([...READ_TOOLS, ...WRITE_TOOLS, "Bash"]);

// Statement separators only. A single `|` is deliberately NOT a separator: a
// pipeline is one data flow, and several rules (`cat .env | pbcopy`,
// `ls .env* | xargs cat`) must be able to see across it. Rules keep themselves
// inside a simple command via their own `[^;|&\n]*` fragments instead.
const COMMAND_SPLIT = /(?:\|\||&&|[;&\n])/;

// A heredoc body is an argument, not a statement — it is what the command reads,
// not what the shell runs. Commit messages, docs and scripts routinely quote
// secret-shaped examples in one, and splitting the raw string on `;` mistakes
// those lines for commands.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1(.*?)^\s*\2\s*$/gms;

// ...except when the body is piped to something that executes it, where the
// heredoc really is a command list.
const INTERPRETER = /\b(?:bash|sh|zsh|ksh|dash|fish|eval|source|ssh)\b/;

/** A rule that forbids a path, or a command; the finding carries which. */
export type SecretRule = FileRule | CommandRule;

/** (rule, matched text or path, indirect): what `evaluate` and `findCommandRule` answer. */
export type Finding<Rule extends SecretRule = SecretRule> = readonly [
    rule: Rule,
    target: string,
    indirect: boolean,
];

// --------------------------------------------------------------------------- #
// Configuration
// --------------------------------------------------------------------------- #

/** The enforcement tier (Python `safety_level()`, already resolved by config.ts). */
export function safetyLevel(config: Config): Level {
    return config.secretsGuard.level;
}

/** Whether a tier should prompt the user rather than deny outright. */
export function asksFor(level: Level, config: Config): boolean {
    return config.askForLevel[level];
}

function inScope(level: Level, threshold: Level): boolean {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[threshold];
}

// --------------------------------------------------------------------------- #
// Matching
// --------------------------------------------------------------------------- #

/** True for templates and examples that never hold real secrets. */
export function isAllowlisted(path: string): boolean {
    return path !== "" && ALLOWLIST.test(path);
}

/** Return the first rule that forbids touching `path`. */
export function checkPath(path: string, threshold: Level): FileRule | undefined {
    if (path === "" || isAllowlisted(path)) return undefined;
    // Python replaced os.sep with "/"; the guards cover POSIX hosts, where it already is.
    const normalized = path;
    return SECRET_FILES.find((rule) => inScope(rule.level, threshold) && rule.pattern.test(normalized));
}

/** Replace heredoc bodies with a placeholder, unless a shell would run them. */
function stripHeredocs(command: string): string {
    if (INTERPRETER.test(command)) return command;
    return command.replace(HEREDOC, "<<heredoc");
}

/**
 * Strip the parts of a command that cannot possibly leak a secret.
 *
 * Allowlisted filenames are replaced in place rather than used to wave the
 * whole command through, so `cat .env.example; cat .env` still trips on the
 * second half. Heredoc bodies are dropped as data, and segments headed by a
 * text-only command (`git commit -m "…"`) are dropped entirely.
 *
 * The result is one statement per line, so rules anchored with `^`/`$` see
 * statement boundaries (the rule patterns are compiled MULTILINE).
 */
function neutralize(command: string): string {
    const scrubbed = stripHeredocs(command).replace(
        new RegExp(ALLOWLIST_IN_COMMAND.source, `${ALLOWLIST_IN_COMMAND.flags}g`),
        "<allowlisted>",
    );
    const kept: string[] = [];
    for (const segment of scrubbed.split(COMMAND_SPLIT)) {
        const stripped = segment.trim();
        if (stripped !== "" && !EXEMPT_COMMAND_HEADS.test(stripped)) kept.push(stripped);
    }
    return kept.join("\n");
}

function matchText(command: string, threshold: Level): CommandRule | undefined {
    if (command === "") return undefined;
    const candidate = neutralize(command);
    if (candidate.trim() === "") return undefined;
    return SECRET_COMMANDS.find((rule) => inScope(rule.level, threshold) && rule.pattern.test(candidate));
}

/**
 * (rule, matched text, indirect) for the first secret access `command` performs.
 *
 * Beyond the command text itself, every string a shell would parse again is
 * checked: `bash -c '...'`, `eval`, `ssh host '...'`, heredocs fed to a
 * shell, interpreter one-liners that call a shell. Program text from files
 * the command runs (scripts, package.json scripts, Makefile recipes) is
 * checked too and reported as indirect.
 */
export async function findCommandRule(
    command: string,
    threshold: Level,
    cwd: string,
    host: Host,
    sources: SourceResolver | null = resolve,
): Promise<Finding<CommandRule> | undefined> {
    const direct = matchText(command, threshold);
    if (direct) return [direct, command, false];
    if (command === "") return undefined;
    let indirectHit: Finding<CommandRule> | undefined;
    for (const nested of (await parse(command, cwd, host, sources)).nestedSources) {
        const rule = matchText(nested.text, threshold);
        if (rule === undefined) continue;
        if (!nested.indirect) return [rule, nested.text, false];
        indirectHit = indirectHit ?? [rule, nested.text, true];
    }
    return indirectHit;
}

/**
 * A secret file named in a string literal of an interpreter program the
 * command runs: `python3 -c "open('/home/u/.ssh/id_rsa').read()"`. The program
 * may only mention the path, so this is asked about, never denied.
 */
export async function findInterpreterSecret(
    command: string,
    threshold: Level,
    cwd: string,
    host: Host,
): Promise<readonly [rule: FileRule, literal: string] | undefined> {
    if (command === "") return undefined;
    for (const simple of (await parse(command, cwd, host)).commands) {
        for (const program of inlinePrograms(simple.name, simple.args, simple.redirects)) {
            for (const literal of stringLiterals(program)) {
                if (/\s/.test(literal)) continue; // prose or code, not a path
                const rule = checkPath(literal, threshold);
                if (rule) return [rule, literal];
            }
        }
    }
    return undefined;
}

/** Return the first rule that forbids running `command` as typed. */
export async function checkCommand(
    command: string,
    threshold: Level,
    cwd: string,
    host: Host,
    sources: SourceResolver | null = resolve,
): Promise<CommandRule | undefined> {
    const found = await findCommandRule(command, threshold, cwd, host, sources);
    return found && !found[2] ? found[0] : undefined;
}

/** Match a tool call against the rules. Returns (rule, target, indirect) or undefined. */
export async function evaluate(
    toolName: string,
    inputs: Readonly<Record<string, unknown>>,
    threshold: Level,
    cwd: string,
    host: Host,
    sources: SourceResolver | null = resolve,
): Promise<Finding | undefined> {
    if (toolName === "Bash") {
        const command = inputs.command ?? "";
        if (typeof command !== "string") return undefined;
        const found = await findCommandRule(command, threshold, cwd, host, sources);
        if (found) return [found[0], command, found[2]];
        const literal = await findInterpreterSecret(command, threshold, cwd, host);
        return literal ? [literal[0], literal[1], true] : undefined;
    }

    for (const path of pathsFrom(inputs)) {
        const rule = checkPath(path, threshold);
        if (rule) return [rule, path, false];
    }
    return undefined;
}

// --------------------------------------------------------------------------- #
// Output
// --------------------------------------------------------------------------- #

export function buildReason(
    rule: SecretRule,
    toolName: string,
    target: string,
    kind: "deny" | "ask" = "deny",
): string {
    const verb = kind === "deny" ? "BLOCKED" : "Confirm";
    const lines = [
        `${LEVEL_MARKS[rule.level]} ${verb} by secrets-guard [${rule.ruleId}] — ` +
            `cannot ${actionVerb(toolName)}: ${rule.reason}`,
        `    target: ${truncate(target)}`,
        "",
    ];
    lines.push(
        rule.remediation ??
            "Do not work around this by another route (a different tool, a shell " +
                "redirect, a Python one-liner). If you genuinely need this, explain why " +
                "and let the user run it themselves with `! <command>`.",
    );
    return lines.join("\n");
}

/** Return the secrets policy decision for one tool call. */
async function run(input: HookInput, deps: GuardDeps): Promise<Decision | undefined> {
    const { config, host } = deps;
    if (config.secretsGuard.disable) return undefined;

    const toolName = input.toolName;
    if (!HANDLED_TOOLS.has(toolName)) return undefined;

    const threshold = safetyLevel(config);
    const finding = await evaluate(toolName, input.toolInput, threshold, input.cwd, host, deps.sources);
    if (!finding) return undefined;

    const [rule, target, indirect] = finding;
    // Found only in a file the command runs: the user decides, as with the other guards.
    const kind = indirect || asksFor(rule.level, config) ? "ask" : "deny";
    await logEvent(
        host,
        HOOK_NAME,
        {
            outcome: kind,
            rule: rule.ruleId,
            level: rule.level,
            tool: toolName,
            target: target.slice(0, 200),
            threshold,
            indirect,
            session_id: input.sessionId,
            cwd: input.cwd,
            permission_mode: input.permissionMode,
        },
        config.secretsGuard.logDirEnv,
        { logDir: config.logDir },
    );
    return decision(
        kind,
        buildReason(rule, toolName, target, kind),
        `secrets-guard [${rule.ruleId}]: ${rule.reason}`,
        HOOK_NAME,
    );
}

export const secretsGuard: Guard = { name: HOOK_NAME, tools: HANDLED_TOOLS, run };
