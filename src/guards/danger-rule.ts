/**
 * The rule type shared by the dangerous_commands rule tables, plus argument helpers.
 *
 * A rule matches one parsed command (shell/parse SimpleCommand) instead of the
 * raw command text, so wrappers, nesting and quoting are already resolved when
 * it runs. `match` returns a short detail string naming what it saw, or
 * undefined. Rules that probe the disk (git refs, `realpath`) do so through
 * the context's host, so a matcher may answer a promise; the dispatcher awaits
 * every match.
 *
 * Ported from danger_rule.py.
 */

import { LEVEL_ORDER, type Level } from "../config.ts";
import type { Host } from "../host/host.ts";
import type { ParseResult, SimpleCommand } from "../shell/model.ts";
import { CLI_OPTIONS_WITH_VALUE } from "../shell/wrappers.ts";
import { dirname, expanduser, isAbsolute, isInside, join, normpath } from "../util/paths.ts";

export { isInside, LEVEL_ORDER };

export const CRITICAL: Level = "critical";
export const HIGH: Level = "high";
export const STRICT: Level = "strict";

export interface RuleContext {
    readonly parsed: ParseResult;
    readonly cwd: string;
    /** The world outside the command line: `~`, the file system, `git`. */
    readonly host: Host;
}

/** A match whose evidence came from a file rather than the typed command. */
export interface MatchDetail {
    readonly text: string;
    readonly indirect: boolean;
    readonly origin: string;
}

/** `MatchDetail(text, indirect=False, origin="SQL command file")`. */
export function matchDetail(text: string, indirect = false, origin = "SQL command file"): MatchDetail {
    return { text, indirect, origin };
}

export type MatchResult = string | MatchDetail | undefined;

export type Matcher = (command: SimpleCommand, context: RuleContext) => Promise<MatchResult> | MatchResult;

export interface DangerRule {
    readonly ruleId: string;
    readonly level: Level;
    readonly reason: string;
    readonly remediation: string;
    readonly match: Matcher;
    /**
     * "deny", or "ask" for commands that are often legitimate but deserve a
     * human look. A deny can be softened to ask by configuration; an ask is
     * never softened further.
     */
    readonly decision: "deny" | "ask";
}

/** `DangerRule(rule_id, level, reason, remediation, match, decision="deny")`. */
export function dangerRule(
    ruleId: string,
    level: Level,
    reason: string,
    remediation: string,
    match: Matcher,
    decision: "deny" | "ask" = "deny",
): DangerRule {
    return { ruleId, level, reason, remediation, match, decision };
}

// --------------------------------------------------------------------------- #
// Argument helpers
// --------------------------------------------------------------------------- #

/**
 * True if any of `letters` appears as a short option or in a cluster (`-fd`).
 *
 * Letters in `withValue` take a value, so the rest of the cluster is that
 * value: in `git switch -cfeature`, `f` belongs to the branch name.
 */
export function shortFlag(args: readonly string[], letters: string, withValue = ""): boolean {
    let skipNext = false;
    for (const arg of args) {
        if (skipNext) {
            skipNext = false;
            continue;
        }
        if (arg === "--") return false;
        if (!(arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1)) continue;
        for (let position = 1; position < arg.length; position += 1) {
            const letter = arg[position] as string;
            if (letters.includes(letter)) return true;
            if (withValue.includes(letter)) {
                skipNext = position === arg.length - 1;
                break;
            }
        }
    }
    return false;
}

/** True for `--name`, `--name=x`, or an unambiguous prefix such as `--forc`. */
export function longFlag(args: readonly string[], names: string | readonly string[], minPrefix = 5): boolean {
    const wanted = typeof names === "string" ? [names] : names;
    for (const arg of args) {
        if (arg === "--") return false;
        if (!arg.startsWith("--")) continue;
        const key = arg.split("=", 1)[0] as string;
        for (const name of wanted) {
            if (key === name || (key.length >= minPrefix && name.startsWith(key))) return true;
        }
    }
    return false;
}

export function has(args: readonly string[], ...tokens: string[]): boolean {
    return args.some((arg) => tokens.includes(arg));
}

const NO_OPTIONS: ReadonlySet<string> = new Set();

export function operands(args: readonly string[], withArg: ReadonlySet<string> = NO_OPTIONS): string[] {
    const found: string[] = [];
    let index = 0;
    let ended = false;
    while (index < args.length) {
        const arg = args[index] as string;
        if (ended || !arg.startsWith("-") || arg === "-") {
            found.push(arg);
        } else if (arg === "--") {
            ended = true;
        } else if (withArg.has(arg)) {
            index += 1;
        }
        index += 1;
    }
    return found;
}

/** `os.path.normpath(expanduser(path))` against `cwd`; `$HOME` and `${HOME}` read as `~`. */
export function expand(path: string, cwd: string, home: string): string {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell spelling of HOME, not a template
    const expanded = expanduser(path.replaceAll("${HOME}", "~").replaceAll("$HOME", "~"), home);
    return normpath(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}

const BROAD_ROOTS: ReadonlySet<string> = new Set([
    "/",
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/lib",
    "/opt",
    "/sbin",
    "/srv",
    "/usr",
    "/var",
    "/System",
    "/Library",
    "/Applications",
    "/Users",
    "/home",
    "/private",
]);

/** Filesystem root, a system root, the home directory, or a strict ancestor of cwd. */
export function isBroadTarget(path: string, cwd: string, home: string): boolean {
    const resolved = expand(path, cwd, home);
    const strictAncestor = resolved !== cwd && isInside(cwd, resolved);
    return BROAD_ROOTS.has(resolved) || resolved === home || strictAncestor || dirname(resolved) === "/";
}

/**
 * The command's positional words (subcommand first), skipping its options' values.
 *
 * `cargo +nightly publish` names a toolchain before the subcommand; it is skipped too.
 */
export function positionalWords(command: SimpleCommand): string[] {
    let words = operands(command.args, CLI_OPTIONS_WITH_VALUE.get(command.name) ?? NO_OPTIONS);
    if (command.name === "cargo") words = words.filter((word) => !word.startsWith("+"));
    return words;
}
