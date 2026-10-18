/**
 * Claude Code Hook: rm -rf Guard (ported from rm_rf_guard.py)
 * ===========================================================
 * PreToolUse guard for the Bash tool. Asks the user before any `rm` invocation
 * that combines recursive (-r/-R/--recursive) with force (-f/--force). In a
 * permission mode where no one can be asked, the ask becomes a deny (the chain
 * applies forPermissionMode), and Claude is told not to work around it.
 *
 * The reason includes a per-target analysis so the user (or Claude, when it is
 * denied) can see the least destructive command that still does the job:
 *
 *     plain `rm <file>`   for regular files
 *     `rm -r <dir>`       for directories
 *     `rm -rf <dir>`      only after the user explicitly confirms
 *
 * An `ask` shows the reason to the user, who confirms or declines. `undefined`
 * defers to the normal permission flow.
 *
 * One exception: an `rm -rf` whose every target lies in a `scratchpad`
 * directory inside the project defers. The agent keeps its own temporary
 * work there and clears it as it goes; asking each time teaches the user to
 * approve `rm -rf` without reading it.
 */

import { commandOf, type Decision, decision, type HookInput } from "../decision.ts";
import type { Host } from "../host/host.ts";
import type { SimpleCommand, SourceResolver } from "../shell/model.ts";
import { parse } from "../shell/parse.ts";
import { dirname, expanduser, isAbsolute, join, normpath } from "../util/paths.ts";
import { shellQuote } from "../util/text.ts";
import type { Guard, GuardDeps } from "./guard.ts";

// Long options, matched by unambiguous prefix the way GNU coreutils does.
const LONG_RECURSIVE = "--recursive";
const LONG_FORCE = "--force";

const GLOB_METACHARACTERS = /[*?[\]]/;
const UNEXPANDED_VARIABLE = /\$\{?\w+/;

// Fallback detector used only when the command cannot be parsed completely
// (an unterminated quote or substitution). Deliberately loose: a detection
// failure here would let an `rm -rf` through unexamined.
const UNPARSEABLE_FALLBACK = new RegExp(
    "(?:^|[;&|`(]|\\s)rm\\s+(?:-\\w*\\s+)*-\\w*(?:r\\w*f|f\\w*r)|(?:^|[;&|`(]|\\s)rm\\s+(?:[^;&|]*\\s)?" +
        "(?:--recursive\\s+(?:[^;&|]*\\s)?--force|--force\\s+(?:[^;&|]*\\s)?--recursive)",
    "i",
);

// A command name computed at run time that still says "rm": `$(which rm)`,
// `$RM`, `${RM_CMD}`. With recursive and force flags it is treated as rm.
const DYNAMIC_RM = /\brm\b|\$\{?RM/i;

export const HOOK_NAME = "rm-rf-guard";

const SYSTEM_ROOTS: ReadonlySet<string> = new Set([
    "/Applications",
    "/Library",
    "/System",
    "/Users",
    "/Volumes",
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/lib",
    "/opt",
    "/private",
    "/sbin",
    "/srv",
    "/usr",
    "/var",
]);

/** A single parsed `rm` command line. */
export class RmInvocation {
    recursive = false;
    force = false;
    flags: string[] = [];
    targets: string[] = [];
    /** How the parser reached it (`bash -c`, `script ./clean.sh`), outermost first. */
    origin = "";
    /** Found inside a file the command runs rather than typed in this call. */
    indirect = false;
    /** Directory it runs in after any earlier `cd`; null when that is computed. */
    cwd: string | null = null;
    /**
     * An `rm` whose arguments the parser could not fully work out (the parse
     * was cut short): it may be recursive and forced.
     */
    uncertain = false;

    constructor(fields: Partial<RmInvocation> = {}) {
        Object.assign(this, fields);
    }

    get isRecursiveForce(): boolean {
        return this.recursive && this.force;
    }

    rendered(): string {
        const text = ["rm", ...this.flags, ...this.targets].join(" ");
        return this.origin ? `${text}    (via ${this.origin})` : text;
    }
}

export type TargetKind = "file" | "directory" | "symlink" | "missing" | "glob" | "unresolved";
export type Severity = "critical" | "high" | "normal";

/** What a single `rm` target actually points at, and how to remove it safely. */
export interface TargetAnalysis {
    readonly raw: string;
    readonly kind: TargetKind;
    readonly detail: string;
    readonly saferCommand: string | undefined;
    readonly severity: Severity;
}

function isRm(command: SimpleCommand): boolean {
    if (command.dynamicHead) {
        const head = command.argv[0];
        return head !== undefined && DYNAMIC_RM.test(head);
    }
    return command.name === "rm";
}

/** Parse `rm` arguments into recursive/force flags and target paths. */
function parseRmArguments(args: readonly string[]): RmInvocation {
    const invocation = new RmInvocation();
    let optionsEnded = false;

    for (const argument of args) {
        if (optionsEnded) {
            invocation.targets.push(argument);
            continue;
        }

        if (argument === "--") {
            optionsEnded = true;
            invocation.flags.push(argument);
            continue;
        }

        if (argument.startsWith("--") && argument.length > 2) {
            invocation.flags.push(argument);
            if (LONG_RECURSIVE.startsWith(argument)) invocation.recursive = true;
            else if (LONG_FORCE.startsWith(argument)) invocation.force = true;
            continue;
        }

        if (argument.startsWith("-") && argument.length > 1) {
            invocation.flags.push(argument);
            for (const letter of argument.slice(1)) {
                if (letter === "r" || letter === "R") invocation.recursive = true;
                else if (letter === "f") invocation.force = true;
            }
            continue;
        }

        invocation.targets.push(argument);
    }

    return invocation;
}

/**
 * Return every `rm -rf`-equivalent invocation a command would run.
 *
 * The parser sees through wrappers (`sudo -u root`, `timeout 5`, `xargs`,
 * `find -exec`), re-parsed strings (`bash -c`, `eval`, `ssh host`, `$(...)`,
 * heredocs fed to a shell) and, with `sources`, files the command executes.
 *
 * The second element is true when the command could not be parsed
 * completely and the regex fallback had to be used, in which case
 * flags/targets are unavailable.
 */
export async function findRecursiveForceInvocations(
    command: string,
    cwd: string,
    host: Host,
    sources: SourceResolver | null = null,
): Promise<readonly [invocations: RmInvocation[], unparseable: boolean]> {
    const parsed = await parse(command, cwd, host, sources);
    const invocations: RmInvocation[] = [];
    for (const simple of parsed.commands) {
        if (!isRm(simple)) continue;
        const invocation = parseRmArguments(simple.args);
        if (invocation.isRecursiveForce) {
            invocation.origin = simple.origin();
            invocation.indirect = simple.indirect;
            invocation.cwd = simple.cwd;
            invocations.push(invocation);
        }
    }

    const incomplete = parsed.unparseable || parsed.truncated;
    if (invocations.length === 0 && incomplete && UNPARSEABLE_FALLBACK.test(command)) {
        return [[new RmInvocation({ recursive: true, force: true })], true];
    }
    if (invocations.length === 0 && parsed.truncated) {
        for (const simple of parsed.commands) {
            if (isRm(simple)) {
                const invocation = parseRmArguments(simple.args);
                invocation.origin = simple.origin();
                invocation.cwd = simple.cwd;
                invocation.uncertain = true;
                return [[invocation], false];
            }
        }
    }
    return [invocations, false];
}

function resolveTarget(target: string, cwd: string, home: string): string {
    let expanded = expanduser(target, home);
    if (!isAbsolute(expanded)) expanded = join(cwd, expanded);
    return normpath(expanded);
}

/** Rate how catastrophic removing `resolved` would be. */
function severityFor(resolved: string, cwd: string, home: string): readonly [Severity, string | undefined] {
    if (resolved === "/") return ["critical", "this is the filesystem root"];
    if (resolved === home) return ["critical", "this is your entire home directory"];
    if (SYSTEM_ROOTS.has(resolved)) return ["critical", "this is a system directory"];
    if (cwd === resolved || cwd.startsWith(`${resolved.replace(/\/+$/, "")}/`)) {
        return ["critical", "this is the working directory or one of its ancestors"];
    }
    if (dirname(resolved) === "/") return ["high", "this is a top-level directory"];
    if (!resolved.startsWith(`${home}/`)) return ["high", "this is outside your home directory"];
    return ["normal", undefined];
}

/** Where relative targets resolve: after any `cd`, or `/` (worst case) when unknown. */
function analysisCwd(invocation: RmInvocation, cwd: string): string {
    if (invocation.cwd !== null) return invocation.cwd;
    return invocation.targets.length > 0 ? "/" : cwd;
}

/** The directory an agent keeps its temporary work in, inside a project. */
export const SCRATCH_DIR = "scratchpad";

/**
 * Whether `target`, run from `cwd`, lies in a scratchpad directory of the
 * project at `projectDir`: `scratchpad`, `scratchpad/x` or `pkg/scratchpad/x`,
 * with every symbolic link followed, so a `scratchpad` linking out of the
 * project does not count. A glob counts by the directories before its first
 * wildcard (`scratchpad/*` does, `scratch*` does not); a target holding an
 * unexpanded variable never does.
 */
export async function inProjectScratchpad(
    target: string,
    cwd: string,
    projectDir: string,
    host: Host,
): Promise<boolean> {
    if (UNEXPANDED_VARIABLE.test(target)) return false;
    const segments = target.split("/");
    const firstGlob = segments.findIndex((segment) => GLOB_METACHARACTERS.test(segment));
    const fixed = firstGlob < 0 ? target : segments.slice(0, firstGlob).join("/");
    if (fixed === "") return false;
    const project = await host.realPath(normpath(projectDir));
    const resolved = await host.realPath(resolveTarget(fixed, cwd, host.home));
    if (!resolved.startsWith(`${project.replace(/\/+$/, "")}/`)) return false;
    return resolved.slice(project.length).split("/").includes(SCRATCH_DIR);
}

/** Whether every target of `invocation` lies in a project scratchpad (see inProjectScratchpad). */
async function scratchpadOnly(invocation: RmInvocation, projectDir: string, host: Host): Promise<boolean> {
    if (invocation.uncertain || invocation.targets.length === 0) return false;
    const cwd = analysisCwd(invocation, projectDir);
    for (const target of invocation.targets) {
        if (!(await inProjectScratchpad(target, cwd, projectDir, host))) return false;
    }
    return true;
}

/** Describe a target and name the least destructive command that removes it. */
export async function analyzeTarget(target: string, cwd: string, host: Host): Promise<TargetAnalysis> {
    if (UNEXPANDED_VARIABLE.test(target)) {
        return {
            raw: target,
            kind: "unresolved",
            detail:
                "contains an unexpanded variable, so the real target is unknown. " +
                "If it expands to an empty string this deletes the wrong tree",
            saferCommand: undefined,
            severity: "critical",
        };
    }

    if (GLOB_METACHARACTERS.test(target)) {
        return {
            raw: target,
            kind: "glob",
            detail: `is a glob; run \`ls -d ${shellQuote(target)}\` first to see exactly what it matches`,
            saferCommand: undefined,
            severity: "high",
        };
    }

    const resolved = resolveTarget(target, cwd, host.home);
    const [severity, danger] = severityFor(resolved, cwd, host.home);
    const quoted = shellQuote(target);
    const stat = await host.stat(resolved);

    let analysis: TargetAnalysis;
    if (stat?.isLink) {
        const detail = "is a symlink (plain `rm` removes the link, not its target)";
        analysis = { raw: target, kind: "symlink", detail, saferCommand: `rm ${quoted}`, severity };
    } else if (stat?.kind === "dir") {
        const entries = await host.list(resolved);
        const count =
            entries === undefined
                ? "unreadable contents"
                : `${entries.length} immediate ${entries.length === 1 ? "entry" : "entries"}`;
        const detail = `is a directory (${count}) at ${resolved}`;
        analysis = { raw: target, kind: "directory", detail, saferCommand: `rm -r ${quoted}`, severity };
    } else if (stat?.kind === "file") {
        const detail = `is a regular file at ${resolved}`;
        analysis = { raw: target, kind: "file", detail, saferCommand: `rm ${quoted}`, severity };
    } else {
        const detail =
            `does not exist (${resolved}); removing it is a no-op, so if \`-f\` was ` +
            "only there to suppress 'No such file or directory', drop the command entirely";
        analysis = { raw: target, kind: "missing", detail, saferCommand: undefined, severity: "normal" };
    }

    if (danger) return { ...analysis, detail: `${analysis.detail} — ${danger}` };
    return analysis;
}

const SEVERITY_MARKERS: Readonly<Record<Severity, string>> = {
    critical: "  [CRITICAL] ",
    high: "  [CAUTION]  ",
    normal: "  ",
};

function formatTargetSection(analyses: readonly TargetAnalysis[]): string[] {
    const lines: string[] = [];
    for (const analysis of analyses) {
        lines.push(`${SEVERITY_MARKERS[analysis.severity]}${analysis.raw} ${analysis.detail}`);
        if (analysis.saferCommand) lines.push(`      safer: ${analysis.saferCommand}`);
    }
    return lines;
}

async function analyzeAll(
    invocations: readonly RmInvocation[],
    cwd: string,
    host: Host,
): Promise<TargetAnalysis[]> {
    const analyses: TargetAnalysis[] = [];
    for (const invocation of invocations) {
        for (const target of invocation.targets) {
            analyses.push(await analyzeTarget(target, analysisCwd(invocation, cwd), host));
        }
    }
    return analyses;
}

/**
 * What the user sees when asked to confirm, and Claude sees if it is declined
 * or denied because no one can be asked.
 */
export async function buildAskReason(
    invocations: readonly RmInvocation[],
    cwd: string,
    unparseable: boolean,
    host: Host,
): Promise<string> {
    const sections: string[] = [
        "rm-rf-guard: this command runs `rm` with both recursive and force, which deletes " +
            "without stopping on anything. It runs only if the user confirms.",
        "",
    ];

    if (unparseable) {
        sections.push(
            "The command could not be parsed completely, but it appears to contain a recursive forced `rm`.",
            "",
        );
    } else {
        sections.push("Invocation(s):");
        sections.push(...invocations.map((invocation) => `  ${invocation.rendered()}`));
        sections.push("");

        const analyses = await analyzeAll(invocations, cwd, host);
        if (analyses.length > 0) {
            sections.push("Target analysis:");
            sections.push(...formatTargetSection(analyses));
            sections.push("");
        }
    }

    sections.push(
        "Less destructive alternatives:",
        "  `rm <file>`      removes a single file — no flags needed",
        "  `rm -r <dir>`    removes a directory tree, but stops on write-protected entries " +
            "instead of silently forcing them",
        "",
        "If this is declined or denied: do NOT retry it and do NOT route around this hook — " +
            "no `sudo`, no `find -delete`, no `git clean -xdf`, no Python `shutil.rmtree`, no " +
            "`trash`/`mv` to a temp dir. Use a 'safer:' command above if one fits, otherwise ask " +
            "the user how to proceed (for example, they can run `! rm -rf <target>` themselves), " +
            "and report it in your reply. Never silently skip a removal the task depended on.",
    );

    return sections.join("\n");
}

/** Feedback for an `rm -rf` found only inside a file or an interpreter's string. */
export async function buildIndirectReason(
    invocations: readonly RmInvocation[],
    cwd: string,
    host: Host,
): Promise<string> {
    const lines: string[] = [
        "rm-rf-guard: this command runs a script, recipe or interpreter program that contains " +
            "a recursive forced `rm` (in a string, it may only be data). The agent did not type it " +
            "as a command here, so the user decides:",
        "",
    ];
    lines.push(...invocations.map((invocation) => `  ${invocation.rendered()}`));
    const analyses = await analyzeAll(invocations, cwd, host);
    if (analyses.length > 0) lines.push("", "Target analysis:", ...formatTargetSection(analyses));
    lines.push(
        "",
        "If the user declines, do not edit the script to get around this; report it and ask how to proceed.",
    );
    return lines.join("\n");
}

/** Ask before recursive forced removals, typed in the command or run from files. */
async function run(input: HookInput, deps: GuardDeps): Promise<Decision | undefined> {
    if (deps.config.rmRfGuard.disable) return undefined;
    if (input.toolName !== "Bash") return undefined;

    const command = commandOf(input.toolInput);
    if (!command) return undefined;

    const cwd = normpath(input.cwd);
    const [found, unparseable] = await findRecursiveForceInvocations(command, cwd, deps.host, deps.sources);
    const invocations: RmInvocation[] = [];
    for (const invocation of found) {
        if (!(await scratchpadOnly(invocation, cwd, deps.host))) invocations.push(invocation);
    }
    if (invocations.length === 0 && !unparseable) return undefined;

    if (invocations.every((invocation) => invocation.uncertain) && !unparseable) {
        return decision(
            "ask",
            "rm-rf-guard: this command runs `rm` with arguments that could not all be worked out " +
                "(too many possible values to check every combination):\n\n" +
                invocations.map((invocation) => `  ${invocation.rendered()}`).join("\n") +
                "\n\nThe user decides whether it may run.",
            "rm-rf-guard: an `rm` whose flags could not be fully determined.",
            HOOK_NAME,
        );
    }
    const direct = invocations.filter((invocation) => !invocation.indirect);
    if (direct.length > 0 || unparseable) {
        return decision(
            "ask",
            await buildAskReason(direct, cwd, unparseable, deps.host),
            "rm-rf-guard: confirm the `rm -rf` before it runs.",
            HOOK_NAME,
        );
    }
    return decision(
        "ask",
        await buildIndirectReason(invocations, cwd, deps.host),
        "rm-rf-guard: the command runs a script containing `rm -rf`.",
        HOOK_NAME,
    );
}

export const rmRfGuard: Guard = { name: HOOK_NAME, tools: new Set(["Bash"]), run };
