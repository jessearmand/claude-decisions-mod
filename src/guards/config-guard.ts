/**
 * Claude Code Hook: Config Guard
 * ==============================
 * PreToolUse hook for Write, Edit, MultiEdit, NotebookEdit and Bash. Stops the
 * agent from changing its own configuration: settings and permissions, hook
 * scripts, MCP servers, other harnesses' config (Codex, omp, pi, opencode), the
 * skills, subagents and global instructions loaded from the home directory, and
 * places that make code run again later (shell rc files, git hooks and git
 * config, launchd, systemd, cron).
 *
 * Without it, every other guard is one `sed -i` away from being switched off.
 *
 * Bash writes are found structurally (shell/parse + shell/writes): redirects,
 * tee, sed/perl -i, cp/mv/install/rsync/ln destinations, rm/unlink/shred,
 * chmod/chown, dd of=, curl -o / wget -O. Removing, moving or re-permissioning
 * a directory that contains a protected path counts too (`rm -r ~/.claude`).
 * Writes found only inside a script the command runs are asked about, not
 * denied: the agent did not type them in this call.
 *
 * Paths are checked as written and after resolving `~`, `$HOME`, the working
 * directory and symlinks, so a symlinked `~/.claude/hooks` protects the
 * directory it points to.
 *
 * Configuration (`Config.configGuard`, from the userConfig options and the
 * Python hooks' environment variables):
 *   CONFIG_GUARD_DISABLE=1     turn the hook off entirely
 *   CONFIG_GUARD_ASK=1         prompt instead of denying
 *   CONFIG_GUARD_LOG_DIR=<dir> default ~/.claude/hooks-logs
 *   CONFIG_GUARD_LIVE_DIRS=<dir>:<dir>
 *       extra directories that hold running guard code (e.g. the omp
 *       extension checkout). Writes there are asked about, not denied.
 *   CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL,
 *   GIT_CONFIG_SYSTEM          honoured where they move a protected location
 *                              (config-guard-rules HOME_ALIASES)
 *
 * Live guard sources. The guards usually run from a git checkout that
 * ~/.claude/hooks links to, or (omp) straight from this repo. Editing that
 * checkout changes the running guards, but it is also where they are
 * developed, so a write there is asked about rather than denied. The live
 * directories are the target of ~/.claude/hooks and `Config.configGuard.liveDirs`
 * (CONFIG_GUARD_LIVE_DIRS plus, wired by the hooks module, the plugin root the
 * running guard code lives in: the Python hook used its own `__file__` directory).
 *
 * Ported from config_guard.py.
 */

import { logEvent } from "../audit.ts";
import {
    actionVerb,
    commandOf,
    type Decision,
    decision,
    type HookInput,
    pathsFrom,
    WRITE_TOOLS,
} from "../decision.ts";
import type { Host } from "../host/host.ts";
import { caseInsensitive, isInside as insideOf, patternMatches } from "../shell/filesystem-paths.ts";
import { globPaths } from "../shell/glob.ts";
import { landingPaths } from "../shell/landing-paths.ts";
import type { ParseResult, SimpleCommand, SourceResolver } from "../shell/model.ts";
import { parse } from "../shell/parse.ts";
import { isUnknown, reason as unknownReason } from "../shell/unknown-target.ts";
import {
    DELETE_TREE,
    INTO_DIR,
    MOVE,
    type PathWrite,
    PERMISSIONS,
    WRITE,
    writtenPaths,
} from "../shell/writes.ts";
import { basename, expanduser, isAbsolute, join, normpath, unique } from "../util/paths.ts";
import { truncate } from "../util/text.ts";
import {
    CONFIG_RULES,
    type ConfigRule,
    HOME_ALIASES,
    PROJECT_PROTECTED_ROOTS,
    PROTECTED_ROOTS,
} from "./config-guard-rules.ts";
import type { Guard, GuardDeps } from "./guard.ts";

export const HOOK_NAME = "config-guard";
const HANDLED_TOOLS: ReadonlySet<string> = new Set([...WRITE_TOOLS, "Bash"]);
const HOME_VARIABLE = /^(?:\$HOME|\$\{HOME\})(?=\/|$)/;
const GLOB = /[*?[]/;
/** Actions that take everything below a directory with them. */
const TREE_ACTIONS: ReadonlySet<string> = new Set([DELETE_TREE, MOVE, PERMISSIONS]);
export const CONFIG_DIR_RULE: ConfigRule = {
    ruleId: "agent-config-dir",
    level: "high",
    pattern: /(?!)/,
    reason: "copying into an agent configuration directory can add or replace its settings, hooks or plugins",
};
export const UNKNOWN_TARGET_RULE: ConfigRule = {
    ruleId: "unknown-target",
    level: "high",
    pattern: /(?!)/,
    reason: "the path is computed at run time and could be an agent's configuration",
};
export const LIVE_SOURCE_RULE: ConfigRule = {
    ruleId: "guard-sources",
    level: "live",
    pattern: /(?!)/,
    reason: "this directory holds the guard code that is running now",
};

export interface Finding {
    readonly rule: ConfigRule;
    readonly target: string;
    readonly action: string;
    readonly indirect: boolean;
    /**
     * Why the target is only possibly protected (an unknown directory, an
     * unknown file name). Such a finding asks instead of denying.
     */
    readonly uncertain?: string;
}

function finding(
    rule: ConfigRule,
    target: string,
    action: string,
    indirect = false,
    uncertain?: string,
): Finding {
    return { rule, target, action, indirect, uncertain };
}

/** Directories holding running guard code, as `run` passes them down (Config.configGuard.liveDirs). */
type LiveDirs = readonly string[];

// --------------------------------------------------------------------------- //
// Path resolution
// --------------------------------------------------------------------------- //

function expand(path: string, cwd: string, home: string): string {
    let expanded = path.replace(HOME_VARIABLE, () => home);
    expanded = expanduser(expanded, home);
    if (!isAbsolute(expanded)) expanded = join(cwd, expanded);
    return normpath(expanded);
}

export const MAX_GLOB_MATCHES = 10_000;

/** True when a glob matches more files than candidatePaths inspects. */
export async function globOverflows(path: string, cwd: string, host: Host): Promise<boolean> {
    const expanded = expand(path, cwd, host.home);
    if (!GLOB.test(expanded)) return false;
    const matches = await globPaths(expanded, host, { limit: MAX_GLOB_MATCHES + 1 });
    return matches.length > MAX_GLOB_MATCHES;
}

/** The path as written, expanded, symlink-resolved, and glob-expanded. */
export async function candidatePaths(path: string, cwd: string, host: Host): Promise<string[]> {
    const expanded = expand(path, cwd, host.home);
    const found = [path, expanded];
    if (GLOB.test(expanded)) found.push(...(await globPaths(expanded, host, { limit: MAX_GLOB_MATCHES })));
    const resolved: string[] = [];
    for (const value of found.slice(1)) resolved.push(await host.realPath(value));
    const insensitive = await caseInsensitive(expanded, host, cwd);
    const lookup = await homeLookup(host);
    const seen = new Set<string>();
    const uniqueForms: string[] = [];
    for (const value of [...found, ...resolved]) {
        for (const form of [value, ...homeFormsWith(value, lookup, insensitive)]) {
            // os.sep is "/" on every platform the guards cover: nothing to replace.
            if (form !== "" && !seen.has(form)) {
                seen.add(form);
                uniqueForms.push(form);
            }
        }
    }
    return uniqueForms;
}

/** An absolute directory as written and with symlinks resolved. */
async function directoryForms(path: string, host: Host): Promise<string[]> {
    const expanded = normpath(expanduser(path, host.home));
    if (!isAbsolute(expanded)) return [];
    return unique([expanded, await host.realPath(expanded)]);
}

/** (directory the environment set, the default it stands for). */
async function aliases(host: Host): Promise<Array<readonly [base: string, defaultPath: string]>> {
    const found: Array<readonly [string, string]> = [];
    for (const [variable, defaultPath] of HOME_ALIASES) {
        for (const base of await directoryForms(host.env(variable) ?? "", host))
            found.push([base, defaultPath]);
    }
    return found;
}

/** What `homeForms` needs from the environment and the disk, computed once per path set. */
interface HomeLookup {
    readonly aliases: ReadonlyArray<readonly [base: string, defaultPath: string]>;
    /** The home directory as spelled and resolved (`directoryForms("~")`). */
    readonly homes: readonly string[];
}

async function homeLookup(host: Host): Promise<HomeLookup> {
    return { aliases: await aliases(host), homes: await directoryForms("~", host) };
}

function homeFormsWith(path: string, lookup: HomeLookup, insensitive: boolean): string[] {
    if (!path.startsWith("/")) return [];
    const defaults = lookup.aliases
        .filter(([base]) => insideOf(path, base, insensitive))
        .map(([base, defaultPath]) => defaultPath + path.slice(base.length));
    const forms = [...defaults];
    for (const form of [path, ...defaults]) {
        if (form.startsWith("/")) {
            forms.push(
                ...lookup.homes
                    .filter((home) => home !== "/" && insideOf(form, home, insensitive))
                    .map((home) => `~${form.slice(home.length)}`),
            );
        }
    }
    return unique(forms).filter((form) => form !== path);
}

/**
 * An absolute `path` as the rules spell it: under a moved location's default
 * (`$CODEX_HOME/skills` -> `~/.codex/skills`), and relative to the home
 * directory (`/Users/me/.gitconfig` -> `~/.gitconfig`), which `^~/` rules need.
 *
 * `insensitive` is `caseInsensitive` of the path's volume, computed by the caller.
 */
export async function homeForms(path: string, host: Host, insensitive = false): Promise<string[]> {
    return homeFormsWith(path, await homeLookup(host), insensitive);
}

async function protectedRoots(cwd: string, host: Host, insensitive: boolean): Promise<string[]> {
    const roots = PROTECTED_ROOTS.map((root) => expand(root, cwd, host.home));
    roots.push(...PROJECT_PROTECTED_ROOTS.map((root) => join(cwd, root)));
    // A root under a moved location's default is also under where it moved to.
    const moved = await aliases(host);
    for (const root of PROTECTED_ROOTS) {
        for (const [base, defaultPath] of moved) {
            if (insideOf(root, defaultPath, insensitive)) roots.push(base + root.slice(defaultPath.length));
        }
    }
    const resolved: string[] = [];
    for (const root of roots) resolved.push(await host.realPath(root));
    return unique([...roots, ...resolved].map((root) => normpath(root)));
}

async function isInsideConfigDir(path: string, host: Host, insensitive: boolean): Promise<boolean> {
    const configDir = host.env("CLAUDE_CONFIG_DIR");
    if (!configDir) return false;
    return insideOf(path, await host.realPath(expanduser(configDir, host.home)), insensitive);
}

/**
 * Directories holding the guard code that runs for this harness: the target of
 * `~/.claude/hooks` and `liveDirs` (Config.configGuard.liveDirs: CONFIG_GUARD_LIVE_DIRS
 * and the plugin root the hooks module passes). The Python hook also listed its
 * own `__file__` directory; in the mod that directory is the plugin root.
 */
export async function liveSourceDirs(host: Host, liveDirs: LiveDirs = []): Promise<string[]> {
    const dirs = [await host.realPath(expanduser("~/.claude/hooks", host.home))];
    for (const dir of liveDirs) {
        if (dir.trim() !== "") dirs.push(await host.realPath(expanduser(dir, host.home)));
    }
    return unique(dirs);
}

// --------------------------------------------------------------------------- //
// Matching
// --------------------------------------------------------------------------- //

/** The rule that protects `path` from `action`, if any. */
export async function checkPath(
    path: string,
    cwd: string,
    host: Host,
    action: string = WRITE,
    liveDirs: LiveDirs = [],
): Promise<ConfigRule | undefined> {
    const candidates = await candidatePaths(path, cwd, host);
    const insensitive = await caseInsensitive(expand(path, cwd, host.home), host, cwd);
    for (const candidate of candidates) {
        for (const rule of CONFIG_RULES) {
            if (patternMatches(rule.pattern, candidate, insensitive)) return rule;
        }
        if (await isInsideConfigDir(candidate, host, insensitive)) return CONFIG_RULES[0];
    }
    if (TREE_ACTIONS.has(action)) {
        const rule = await checkTree(candidates, cwd, host, insensitive);
        if (rule) return rule;
    }
    const live = await liveSourceDirs(host, liveDirs);
    for (const candidate of candidates) {
        if (
            candidate.startsWith("/") &&
            live.some(
                (root) =>
                    insideOf(candidate, root, insensitive) ||
                    (TREE_ACTIONS.has(action) && insideOf(root, candidate, insensitive)),
            )
        ) {
            return LIVE_SOURCE_RULE;
        }
    }
    return undefined;
}

/** A delete/move/chmod of a directory that holds a protected root. */
async function checkTree(
    candidates: readonly string[],
    cwd: string,
    host: Host,
    insensitive: boolean,
): Promise<ConfigRule | undefined> {
    const roots = await protectedRoots(cwd, host, insensitive);
    const lookup = await homeLookup(host);
    for (const candidate of candidates) {
        if (!candidate.startsWith("/")) continue;
        for (const root of roots) {
            if (insideOf(root, candidate, insensitive)) {
                const inside = `${root}/x`;
                for (const form of [inside, ...homeFormsWith(inside, lookup, insensitive)]) {
                    for (const rule of CONFIG_RULES) {
                        if (patternMatches(rule.pattern, form, insensitive)) return rule;
                    }
                }
                return CONFIG_RULES[0];
            }
        }
    }
    return undefined;
}

/** A relative write after `cd "$DIR"`: protected if it would be from any protected root. */
async function checkFromUnknownDir(
    path: string,
    cwd: string,
    action: string,
    host: Host,
    liveDirs: LiveDirs,
): Promise<ConfigRule | undefined> {
    if (isAbsolute(expanduser(path, host.home))) return checkPath(path, cwd, host, action, liveDirs);
    const insensitive = await caseInsensitive(cwd, host, cwd);
    for (const root of await protectedRoots(cwd, host, insensitive)) {
        const rule = await checkPath(join(root, path), cwd, host, action, liveDirs);
        if (rule !== undefined) return rule;
    }
    return undefined;
}

const INTO_PROTECTED = "copied into a protected directory under names that cannot be known";
const HOLDS_PROTECTED =
    "copied or extracted into a directory holding protected config, with contents that cannot be listed";

type Verdict = readonly [rule: ConfigRule | undefined, uncertain: string | undefined];

/**
 * A copy or extraction into a directory: (rule, why it is uncertain).
 *
 * Into a protected or live directory, the names do not matter. Into a
 * directory that holds one (`tar xf x.tar` in a project or in ~), the files
 * it lands are listed and each is checked; when they cannot be listed, ask.
 */
async function checkIntoDir(
    write: PathWrite,
    path: string,
    cwd: string,
    host: Host,
    liveDirs: LiveDirs,
    madeEarlier: ReadonlySet<string> = new Set(),
): Promise<Verdict> {
    const insensitive = await caseInsensitive(expand(path, cwd, host.home), host, cwd);
    const roots = await protectedRoots(cwd, host, insensitive);
    const live = await liveSourceDirs(host, liveDirs);
    for (const candidate of await candidatePaths(path, cwd, host)) {
        if (!candidate.startsWith("/")) continue;
        if (roots.some((root) => insideOf(candidate, root, insensitive)))
            return [CONFIG_DIR_RULE, INTO_PROTECTED];
        if (live.some((root) => insideOf(candidate, root, insensitive)))
            return [LIVE_SOURCE_RULE, INTO_PROTECTED];
        const held = roots.filter((root) => insideOf(root, candidate, insensitive));
        if (held.length === 0) continue;
        const rule = await checkLanded(write, candidate, held, cwd, host, liveDirs, madeEarlier, insensitive);
        if (rule !== undefined) return rule;
    }
    return [undefined, undefined];
}

async function checkLanded(
    write: PathWrite,
    destination: string,
    held: readonly string[],
    cwd: string,
    host: Host,
    liveDirs: LiveDirs,
    madeEarlier: ReadonlySet<string>,
    insensitive: boolean,
): Promise<Verdict | undefined> {
    const descend = (relative: string): boolean => {
        // Only directories on the way to, or inside, a protected root matter.
        const target = join(destination, relative);
        return held.some(
            (root) => insideOf(root, target, insensitive) || insideOf(target, root, insensitive),
        );
    };

    const landed = await landingPaths(write.contents, cwd, descend, host, (name) =>
        madeEarlier.has(basename(name)),
    );
    if (landed === null) return [CONFIG_DIR_RULE, HOLDS_PROTECTED];
    for (const relative of landed) {
        const target = normpath(join(destination, relative));
        const rule = await checkPath(target, cwd, host, WRITE, liveDirs);
        if (rule !== undefined) return [rule, undefined]; // a named file the command writes: as certain as `cp x target`
    }
    return undefined;
}

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * `$NAME` the command line does not set comes from the environment the agent
 * runs in, which this hook shares: `> "$CLAUDE_CONFIG_DIR/settings.json"`.
 * Resolved here, for the path check only, so values never reach a message.
 *
 * Inside Claude Code the host answers only the names in KNOWN_ENV_NAMES
 * (CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL,
 * GIT_CONFIG_SYSTEM, HOME among them); any other `$VAR` stays as written.
 */
function inherited(path: string, host: Host): string {
    if (!path.includes("$")) return path;
    return path.replace(VARIABLE, (whole: string, braced?: string, bare?: string) => {
        const found = host.env((braced ?? bare) as string);
        return found === undefined ? whole : found;
    });
}

/** `path` after following links created earlier in the same command line. */
function throughLinks(path: string, links: ReadonlyMap<string, string>): string {
    let current = path;
    for (let round = 0; round < 8; round += 1) {
        let followed = false;
        for (const [link, target] of links) {
            if (current === link || current.startsWith(`${link}/`)) {
                current = target + current.slice(link.length);
                followed = true;
                break;
            }
        }
        if (!followed) return current;
    }
    return current;
}

/** Check one write as if its command runs in `directory` (null: unknown). */
async function findingFor(
    write: PathWrite,
    directory: string | null,
    cwd: string,
    simple: SimpleCommand,
    host: Host,
    liveDirs: LiveDirs,
    links?: ReadonlyMap<string, string>,
    madeEarlier: ReadonlySet<string> = new Set(),
): Promise<Finding | undefined> {
    let uncertain: string | undefined;
    let rule: ConfigRule | undefined;
    const path = inherited(write.path, host);
    if (directory === null) {
        rule = await checkFromUnknownDir(path, cwd, write.action, host, liveDirs);
        uncertain = "relative to a directory set by a computed `cd`";
    } else if (write.action === INTO_DIR) {
        [rule, uncertain] = await checkIntoDir(write, path, directory, host, liveDirs, madeEarlier);
    } else {
        rule = await checkPath(path, directory, host, write.action, liveDirs);
        if (rule === undefined && links !== undefined && links.size > 0) {
            const absolute = normpath(join(directory, expanduser(path, host.home)));
            const linked = throughLinks(absolute, links);
            if (linked !== absolute) rule = await checkPath(linked, directory, host, write.action, liveDirs);
        }
        if (rule === undefined && (await globOverflows(path, directory, host))) {
            rule = CONFIG_DIR_RULE;
            uncertain = "a glob matching more files than can be checked";
        }
    }
    return rule ? finding(rule, write.path, write.action, simple.indirect, uncertain) : undefined;
}

/**
 * The first protected write in `command`.
 *
 * Each relative path is resolved in every directory its command might run
 * in: after a `cd`, and also as if that `cd` failed or sat in a branch
 * that did not run (`cd a || cd b`).
 */
export async function checkCommand(
    command: string,
    cwd: string,
    host: Host,
    sources: SourceResolver | null = null,
    liveDirs: LiveDirs = [],
): Promise<Finding | undefined> {
    const parsed: ParseResult = await parse(command, cwd, host, sources);
    let softer: Finding | undefined;
    const made = new Set<string>(); // names of files written earlier on the line (`curl -o a.tgz URL`)
    for (const simple of parsed.commands) {
        const writes = await writtenPaths(simple, parsed.writtenFiles, host);
        const madeEarlier: ReadonlySet<string> = new Set(made);
        for (const write of writes) made.add(basename(write.path.replace(/\/+$/, "")));
        for (const write of writes) {
            for (const directory of simple.possibleCwds) {
                const found = await findingFor(
                    write,
                    directory,
                    cwd,
                    simple,
                    host,
                    liveDirs,
                    parsed.links,
                    madeEarlier,
                );
                if (found === undefined) continue;
                if (!(found.indirect || found.uncertain)) return found;
                softer = softer ?? found;
            }
            if (softer === undefined && isUnknown(inherited(write.path, host), host.home)) {
                // `cp x "$OUT"`: where it lands is not known, so what the command does decides.
                const why = unknownReason(simple, write, parsed);
                if (why)
                    softer = finding(UNKNOWN_TARGET_RULE, write.path, write.action, simple.indirect, why);
            }
        }
    }
    return softer;
}

export async function evaluate(
    toolName: string,
    inputs: Readonly<Record<string, unknown>>,
    cwd: string,
    host: Host,
    sources: SourceResolver | null = null,
    liveDirs: LiveDirs = [],
): Promise<Finding | undefined> {
    if (toolName === "Bash") {
        const command = commandOf(inputs);
        return command ? checkCommand(command, cwd, host, sources, liveDirs) : undefined;
    }
    for (const path of pathsFrom(inputs)) {
        const rule = await checkPath(path, cwd, host, WRITE, liveDirs);
        if (rule) return finding(rule, path, "write");
    }
    return undefined;
}

// --------------------------------------------------------------------------- //
// Output
// --------------------------------------------------------------------------- //

export function buildReason(found: Finding, toolName: string, kind: string): string {
    const verb = kind === "deny" ? "BLOCKED" : "Confirm";
    const source = found.indirect
        ? " (inside a script, or an interpreter program's string, this command runs)"
        : found.uncertain
          ? ` (${found.uncertain})`
          : "";
    return [
        `🧷 ${verb} by config-guard [${found.rule.ruleId}] — cannot ` +
            `${actionVerb(toolName)} (${found.action})${source}: ${found.rule.reason}.`,
        `    target: ${truncate(found.target)}`,
        "",
        "An agent must not change its own configuration, hooks or persistence " +
            "locations: that is how guards get switched off. Do not route around this " +
            "(another tool, a copy-and-rename, a script). Tell the user exactly what to " +
            "change and let them make the edit, or have them run it with `! <command>`.",
    ].join("\n");
}

async function run(input: HookInput, deps: GuardDeps): Promise<Decision | undefined> {
    const settings = deps.config.configGuard;
    if (settings.disable) return undefined;
    const toolName = input.toolName;
    if (!HANDLED_TOOLS.has(toolName)) return undefined;

    const cwd = normpath(input.cwd);
    const found = await evaluate(toolName, input.toolInput, cwd, deps.host, deps.sources, [
        ...settings.liveDirs,
    ]);
    if (found === undefined) return undefined;

    const asks =
        settings.ask || found.indirect || found.uncertain !== undefined || found.rule === LIVE_SOURCE_RULE;
    const kind = asks ? "ask" : "deny";
    await logEvent(
        deps.host,
        HOOK_NAME,
        {
            outcome: kind,
            rule: found.rule.ruleId,
            level: found.rule.level,
            action: found.action,
            indirect: found.indirect,
            tool: toolName,
            target: found.target.slice(0, 200),
            session_id: input.sessionId ?? null,
            cwd: input.cwd,
            permission_mode: input.permissionMode ?? null,
        },
        settings.logDirEnv,
        { logDir: deps.config.logDir },
    );
    return decision(
        kind,
        buildReason(found, toolName, kind),
        `config-guard [${found.rule.ruleId}]: ${found.rule.reason}`,
        HOOK_NAME,
    );
}

export const configGuard: Guard = { name: HOOK_NAME, tools: HANDLED_TOOLS, run };
