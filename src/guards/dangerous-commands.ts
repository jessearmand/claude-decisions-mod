/**
 * Claude Code Hook: Dangerous Commands
 * ====================================
 * PreToolUse guard for Bash. Denies (or asks about) commands that destroy data,
 * rewrite history, run downloaded code, weaken security, publish packages or
 * set up persistence. It complements rm-rf-guard (recursive forced rm),
 * secrets-guard (credentials) and config-guard (the agent's own config).
 *
 * Commands are parsed structurally (shell/parse), so `sudo -u x`, `bash -c`,
 * `eval`, `ssh host`, `$(...)`, `python -c "os.system(...)"`, heredocs fed
 * to a shell and scripts the command runs are all seen through. Rules live in
 * dangerous-system.ts, dangerous-git.ts and dangerous-infra.ts.
 *
 * Decision policy, in line with the other deterministic guards:
 *   * a rule's default is deny, or ask for commands that are often legitimate;
 *   * a match found only inside a file the command runs (script, package.json
 *     script, Makefile recipe) is asked about, never denied;
 *   * configuration can soften a deny to ask, never an ask to nothing.
 *
 * Configuration (config.ts, from the userConfig options or the Python hooks'
 * environment variables):
 *   DANGEROUS_COMMANDS_LEVEL=critical|high|strict   tier (default: high)
 *   DANGEROUS_COMMANDS_DISABLE=1                    turn the hook off
 *   DANGEROUS_COMMANDS_ASK=1                        ask instead of deny, every tier
 *   HOOK_ASK_CRITICAL / HOOK_ASK_HIGH / HOOK_ASK_STRICT = true
 *       ask instead of deny for that tier (shared with secrets-guard)
 *   DANGEROUS_COMMANDS_LOG_DIR=<dir>                default ~/.claude/hooks-logs
 *
 * Ported from dangerous_commands.py. The chain applies `forPermissionMode`;
 * this guard does not.
 */

import { logEvent } from "../audit.ts";
import type { Config, Level } from "../config.ts";
import { commandOf, type Decision, type DecisionKind, decision, type HookInput } from "../decision.ts";
import type { Host } from "../host/host.ts";
import type { SimpleCommand, SourceResolver } from "../shell/model.ts";
import { parse } from "../shell/parse.ts";
import { normpath } from "../util/paths.ts";
import { truncate } from "../util/text.ts";
import { type DangerRule, LEVEL_ORDER, type MatchResult, type RuleContext } from "./danger-rule.ts";
import { GIT_RULES } from "./dangerous-git.ts";
import { INFRA_RULES } from "./dangerous-infra.ts";
import { SYSTEM_RULES } from "./dangerous-system.ts";
import type { Guard, GuardDeps } from "./guard.ts";

export const HOOK_NAME = "dangerous-commands";
export const DEFAULT_LEVEL: Level = "high";
export const MARKS: Readonly<Record<Level, string>> = { critical: "☠️", high: "⛔", strict: "⚠️" };

// Order is reporting order: the first deny found wins over any ask.
export const RULES: readonly DangerRule[] = [...SYSTEM_RULES, ...GIT_RULES, ...INFRA_RULES];

export interface Finding {
    readonly rule: DangerRule;
    readonly command: SimpleCommand;
    readonly detail: string;
    readonly decision: DecisionKind;
}

function decisionFor(rule: DangerRule, command: SimpleCommand, config: Config | undefined): DecisionKind {
    if (rule.decision === "ask" || command.indirect) return "ask";
    if (config !== undefined && (config.dangerousCommands.ask || config.askForLevel[rule.level]))
        return "ask";
    return "deny";
}

/** One rule's verdict on one command; a rule that throws answers nothing (a rule bug must not break the hook). */
async function matchRule(
    rule: DangerRule,
    command: SimpleCommand,
    context: RuleContext,
): Promise<MatchResult> {
    try {
        return await rule.match(command, context);
    } catch (error) {
        context.host.debug(`${HOOK_NAME}: rule ${rule.ruleId} failed: ${String(error)}`);
        return undefined;
    }
}

/**
 * Every rule hit in `command`, denies first.
 *
 * `config` softens denies to asks (DANGEROUS_COMMANDS_ASK, HOOK_ASK_<LEVEL>);
 * without it every rule keeps its own default.
 */
export async function findDangers(
    command: string,
    cwd: string,
    host: Host,
    sources: SourceResolver,
    level: Level = DEFAULT_LEVEL,
    config?: Config,
): Promise<Finding[]> {
    const parsed = await parse(command, cwd, host, sources);
    const findings: Finding[] = [];
    for (const simple of parsed.commands) {
        // Rules resolve relative paths where the command might run: after any
        // `cd`, or as if it failed. An unknown directory is judged as `/`.
        const contexts: RuleContext[] = [...new Set(simple.possibleCwds)].map((directory) => ({
            parsed,
            cwd: directory || "/",
            host,
        }));
        for (const rule of RULES) {
            if (LEVEL_ORDER[rule.level] > LEVEL_ORDER[level]) continue;
            for (const context of contexts) {
                const found = await matchRule(rule, simple, context);
                if (found === undefined || found === "") continue;
                let matched = simple;
                let detail: string;
                if (typeof found === "string") {
                    detail = found;
                } else {
                    if (found.indirect)
                        matched = simple.with({ indirect: true, via: [...simple.via, found.origin] });
                    detail = found.text;
                }
                findings.push({
                    rule,
                    command: matched,
                    detail,
                    decision: decisionFor(rule, matched, config),
                });
            }
        }
    }
    findings.sort(
        (a, b) =>
            Number(a.decision !== "deny") - Number(b.decision !== "deny") ||
            LEVEL_ORDER[a.rule.level] - LEVEL_ORDER[b.rule.level],
    );
    return findings;
}

export function buildReason(finding: Finding): string {
    const { rule, command } = finding;
    const verb = finding.decision === "deny" ? "BLOCKED" : "Confirm with the user";
    const lines = [
        `${MARKS[rule.level]} ${verb} — dangerous-commands [${rule.ruleId}]: ${rule.reason}.`,
        `    matched: ${truncate(finding.detail)}`,
        `    command: ${truncate(command.rendered())}`,
    ];
    if (command.via.length > 0) lines.push(`    reached via: ${command.origin()}`);
    if (command.indirect) {
        lines.push(
            "    (not typed as a command in this call: found in a file this command runs, " +
                "or in a string inside an interpreter program, which may only be data)",
        );
    }
    lines.push("", rule.remediation);
    if (finding.decision === "deny") {
        lines.push(
            "",
            "Do not retry it another way (a wrapper, a script, an interpreter one-liner). If the " +
                "task really needs it, explain why and let the user run it with `! <command>`.",
        );
    }
    return lines.join("\n");
}

async function run(input: HookInput, deps: GuardDeps): Promise<Decision | undefined> {
    const { config, host } = deps;
    if (config.dangerousCommands.disable || input.toolName !== "Bash") return undefined;
    const command = commandOf(input.toolInput);
    if (command === undefined || command.trim() === "") return undefined;

    // Python fell back to the hook process's cwd; here an unknown directory is judged as `/`, as below.
    const cwd = input.cwd ? normpath(input.cwd) : "/";
    const level = config.dangerousCommands.level;
    const findings = await findDangers(command, cwd, host, deps.sources, level, config);
    const top = findings[0];
    if (top === undefined) return undefined;

    await logEvent(
        host,
        HOOK_NAME,
        {
            outcome: top.decision,
            rule: top.rule.ruleId,
            level: top.rule.level,
            detail: top.detail.slice(0, 200),
            indirect: top.command.indirect,
            via: [...top.command.via],
            also: [...new Set(findings.slice(1).map((f) => f.rule.ruleId))].sort(),
            command: command.slice(0, 300),
            threshold: level,
            // Python logged `None` for a missing field; `null` keeps the key in the record.
            session_id: input.sessionId ?? null,
            cwd: input.cwd,
            permission_mode: input.permissionMode ?? null,
        },
        config.dangerousCommands.logDirEnv,
        { logDir: config.logDir },
    );
    return decision(
        top.decision,
        buildReason(top),
        `dangerous-commands [${top.rule.ruleId}]: ${top.rule.reason}`,
        HOOK_NAME,
    );
}

export const dangerousCommands: Guard = {
    name: HOOK_NAME,
    tools: new Set(["Bash"]),
    run,
};
