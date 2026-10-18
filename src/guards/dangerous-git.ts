/**
 * Git commands that destroy work, rewrite shared history, or weaken git's safety.
 *
 * Rule set follows cc-safety-net's git rules (MIT, kenryu42/cc-safety-net,
 * src/gate/analyzer/git/rules.ts) and dcg's core.git pack: discarding
 * uncommitted changes, force pushes and remote deletes, force branch deletes,
 * dropping stashes, rewriting history, plus config that hides commands (`!`
 * aliases) or moves hooks (`core.hooksPath`).
 *
 * The safe spellings stay allowed: `push --force-with-lease`, `branch -d`,
 * `clean -n`, `restore --staged`, `checkout -b`, `checkout-index` without
 * `--force` (and `--temp`, which writes temporary files), `stash pop`, `rm --cached`.
 *
 * Ported from dangerous_git.py. Refs and `.git` files are read through the
 * context's host, and `git show-ref` runs through `host.run`.
 */

import type { Host } from "../host/host.ts";
import { knownStdin } from "../shell/command-stdin.ts";
import type { SimpleCommand } from "../shell/model.ts";
import { dirname, expanduser, isAbsolute, join, normpath, unique } from "../util/paths.ts";
import { partition, splitLines } from "../util/text.ts";
import {
    type DangerRule,
    dangerRule,
    HIGH,
    has,
    longFlag,
    type MatchDetail,
    matchDetail,
    operands,
    type RuleContext,
    STRICT,
    shortFlag,
} from "./danger-rule.ts";

// Global options that take a value (`git -C dir`, `git -c k=v`).
const GLOBAL_WITH_VALUE: ReadonlySet<string> = new Set([
    "-c",
    "-C",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--config-env",
    "--exec-path",
    "--list-cmds",
]);

export interface Git {
    readonly subcommand: string;
    readonly args: readonly string[];
    /** `key=value` from -c / --config-env, lower-cased keys */
    readonly config: readonly string[];
    /** --config-env keys whose environment variable has no value we can see. */
    readonly unresolved: readonly string[];
    /**
     * Where git works: the command's possible directories, then each `-C DIR`
     * in turn. Empty when no directory is known.
     */
    readonly directories: readonly string[];
    readonly repositoryOptions: readonly string[];
}

/** The git invocation `command` is, or undefined for anything but a literal `git`. `home` expands `-C ~/x`. */
export function gitInvocation(command: SimpleCommand, home: string): Git | undefined {
    if (command.name !== "git" || command.dynamicHead) return undefined;
    const args = [...command.args];
    let config: string[] = [];
    const fromEnv: string[] = [];
    const repositoryOptions: string[] = [];
    let directories = command.possibleCwds.filter((d): d is string => d !== null);
    let index = 0;
    let arg = "";
    while (index < args.length) {
        const current = args[index] as string;
        const next = args[index + 1];
        if (GLOBAL_WITH_VALUE.has(current)) {
            if (["--git-dir", "--work-tree", "--namespace"].includes(current) && next !== undefined) {
                repositoryOptions.push(current, next);
            }
            if (current === "-C" && next !== undefined) {
                // `git -C a -C b`: b is relative to a.
                const target = expanduser(next, home);
                directories = isAbsolute(target) ? [target] : directories.map((d) => join(d, target));
            }
            if (current === "-c" && next !== undefined) config.push(next);
            else if (current === "--config-env" && next !== undefined) fromEnv.push(next);
            index += 2;
            continue;
        }
        if (current.startsWith("-c") && current.length > 2) config.push(current.slice(2));
        else if (current.startsWith("--config-env=")) fromEnv.push(current.slice("--config-env=".length));
        else if (
            current.startsWith("--git-dir=") ||
            current.startsWith("--work-tree=") ||
            current.startsWith("--namespace=")
        ) {
            repositoryOptions.push(current);
        }
        if (current.startsWith("-")) {
            index += 1;
            continue;
        }
        arg = current; // the subcommand (Python: the loop's `break`; its `else` leaves "")
        break;
    }
    const [environmentConfig, unresolved] = numberedConfig(command);
    // Git applies numbered environment config before command-line overrides.
    config = [...environmentConfig, ...config];
    for (const item of fromEnv) {
        // `--config-env=key=VAR`: git reads the value from $VAR.
        const [key, , variable] = partition(item, "=");
        const values = command.envValues(variable);
        config.push(...values.map((value) => `${key}=${value}`));
        if (values.length === 0) unresolved.push(key.toLowerCase());
    }
    if (!arg && config.length === 0 && unresolved.length === 0) return undefined;
    const rest = arg ? args.slice(index + 1) : [];
    return {
        subcommand: arg,
        args: rest,
        config: config.map(normalizeConfig),
        unresolved,
        directories: unique(directories.map((d) => normpath(d))),
        repositoryOptions,
    };
}

const MAX_ENV_CONFIG = 64;
const ENV_COUNT = /^[+]?[0-9]{1,3}$/;

/**
 * Bounded GIT_CONFIG_COUNT/KEY_n/VALUE_n input, in Git's precedence order.
 *
 * `*` records an unknown key or count, so the existing environment-config
 * rule can ask without guessing which program-bearing key it might become.
 */
function numberedConfig(command: SimpleCommand): [string[], string[]] {
    const config: string[] = [];
    const unresolved: string[] = [];
    const indices = new Set<number>();
    for (const count of command.envValues("GIT_CONFIG_COUNT")) {
        if (!ENV_COUNT.test(count) || Number(count) > MAX_ENV_CONFIG) {
            unresolved.push("*");
            continue;
        }
        for (let i = 0; i < Number(count); i += 1) indices.add(i);
    }
    for (const index of [...indices].sort((a, b) => a - b)) {
        const keys = command.envValues(`GIT_CONFIG_KEY_${index}`);
        const values = command.envValues(`GIT_CONFIG_VALUE_${index}`);
        if (keys.length === 0) unresolved.push("*");
        for (const key of keys) {
            if (/[$`]/.test(key)) {
                unresolved.push("*");
                continue;
            }
            if (values.length === 0) unresolved.push(key.toLowerCase());
            for (const value of values) {
                if (value.startsWith("$") || value.startsWith("`")) unresolved.push(key.toLowerCase());
                else config.push(`${key}=${value}`);
            }
        }
    }
    return [config, unique(unresolved)];
}

function normalizeConfig(item: string): string {
    const [key, sep, value] = partition(item, "=");
    return `${key.toLowerCase()}${sep}${value}`;
}

type GitCheck = (git: Git, ctx: RuleContext) => Promise<string | undefined> | string | undefined;

/** Decorator: run `check` only for the named git subcommand(s). */
function git(sub: string | readonly string[], check: GitCheck) {
    const names = typeof sub === "string" ? [sub] : sub;
    return (command: SimpleCommand, ctx: RuleContext): Promise<string | undefined> | string | undefined => {
        const invocation = gitInvocation(command, ctx.host.home);
        if (invocation === undefined || !names.includes(invocation.subcommand)) return undefined;
        return check(invocation, ctx);
    };
}

// --------------------------------------------------------------------------- #
// Discarding uncommitted work
// --------------------------------------------------------------------------- #

const resetHard = git("reset", (git) => {
    if (longFlag(git.args, "--hard", 4)) return "git reset --hard";
    if (longFlag(git.args, "--merge", 4)) return "git reset --merge";
    return undefined;
});

async function looksLikePath(operand: string, directories: readonly string[], host: Host): Promise<boolean> {
    if (
        operand === "." ||
        operand === ".." ||
        ["./", "../", "/", ":"].some((prefix) => operand.startsWith(prefix)) ||
        operand.endsWith("/")
    ) {
        return true;
    }
    if (/[*?[]/.test(operand)) return true; // a pathspec glob; branch names cannot contain these
    for (const directory of directories) {
        if ((await host.stat(join(directory, operand))) !== undefined) return true;
    }
    return false;
}

/** Enough of a packed-refs file to read it whole in any real repository. */
const MAX_PACKED_REFS_BYTES = 16 * 1024 * 1024;

/**
 * `git checkout foo` switches to a branch or tag named foo when one exists,
 * even if a file foo exists too: look it up in the repository's refs.
 */
async function isRef(name: string, directories: readonly string[], host: Host): Promise<boolean> {
    if (
        ["HEAD", "-", "@"].includes(name) ||
        name.startsWith("@{") ||
        name.startsWith("HEAD~") ||
        name.startsWith("HEAD^")
    ) {
        return true;
    }
    for (const directory of directories) {
        const gitDirectory = await gitDir(directory, host);
        if (gitDirectory === undefined) continue;
        for (const kind of ["heads", "tags"]) {
            if ((await host.stat(join(gitDirectory, "refs", kind, name)))?.kind === "file") return true;
        }
        // An unreadable packed-refs is skipped, as the OSError branch did.
        const packed = await host.readText(join(gitDirectory, "packed-refs"), MAX_PACKED_REFS_BYTES);
        if (packed === undefined) continue;
        const suffixes = [` refs/heads/${name}`, ` refs/tags/${name}`];
        if (splitLines(packed).some((line) => suffixes.some((suffix) => line.endsWith(suffix)))) return true;
    }
    return false;
}

/** The .git directory of the repository `directory` is in, if any. */
async function gitDir(directory: string, host: Host): Promise<string | undefined> {
    // The directories a rule hands over are absolute (the parser's cwd, `-C DIR` joined to it).
    let current = normpath(directory);
    for (;;) {
        const candidate = join(current, ".git");
        const stat = await host.stat(candidate);
        if (stat?.kind === "dir") return candidate;
        if (stat?.kind === "file") {
            // a worktree or submodule: `gitdir: PATH`
            const text = await host.readText(candidate, MAX_PACKED_REFS_BYTES);
            if (text === undefined) return undefined;
            const line = (text.split("\n", 1)[0] as string).trim();
            if (line.startsWith("gitdir:")) return normpath(join(current, line.slice(7).trim()));
        }
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

// `git checkout` options that take a separate value.
const CHECKOUT_WITH_VALUE: ReadonlySet<string> = new Set([
    "--conflict",
    "--inter-hunk-context",
    "--unified",
    "-U",
    "--pathspec-from-file",
    "--orphan",
    "-b",
    "-B",
]);

const checkoutDiscard = git("checkout", async (git, ctx) => {
    const args = git.args;
    // In `-bfeature` the rest of the cluster is the branch name, not flags.
    if (shortFlag(args, "f", "UbB") || longFlag(args, "--force")) {
        return "git checkout --force"; // discards local changes, new branch or not
    }
    if (shortFlag(args, "B", "Ub")) return "git checkout -B (force branch reset)";
    if (shortFlag(args, "bB", "U") || longFlag(args, "--orphan")) return undefined; // creates a branch: nothing is discarded
    if (longFlag(args, "--pathspec-from-file")) return "git checkout --pathspec-from-file";
    const separator = args.indexOf("--");
    if (separator >= 0) {
        if (args.length > separator + 1) return "git checkout -- <path>";
        return undefined;
    }
    const positionals = operands(args, CHECKOUT_WITH_VALUE).filter((p) => p !== "-");
    if (positionals.length >= 2) return "git checkout <ref> <path>";
    const directories = git.directories.length > 0 ? git.directories : [ctx.cwd];
    const only = positionals[0];
    if (
        positionals.length === 1 &&
        only !== undefined &&
        (await looksLikePath(only, directories, ctx.host)) &&
        !(await isRef(only, directories, ctx.host))
    ) {
        return `git checkout ${only} (a path)`;
    }
    return undefined;
});

// `--prefix` and `--stage` take a value. `--stage=all` writes temp files.
const CHECKOUT_INDEX_WITH_VALUE: ReadonlySet<string> = new Set(["--prefix", "--stage"]);

/** `--stage=all` copies conflict stages to temp names, not the worktree. */
function stageAll(args: readonly string[]): boolean {
    let index = 0;
    while (index < args.length) {
        const arg = args[index] as string;
        if (arg === "--") return false;
        if (arg === "--stage" && args[index + 1] === "all") return true;
        if (arg.startsWith("--") && arg.includes("=")) {
            const [key, , value] = partition(arg, "=");
            if (key.length >= 5 && "--stage".startsWith(key) && value === "all") return true;
        }
        index += 1;
    }
    return false;
}

/**
 * `git checkout-index -f` overwrites existing worktree files.
 *
 * `--temp` and `--stage=all` write temporary files instead, and without `-a`,
 * `--stdin`, or a path git checks nothing out. Non-forced use refuses to
 * overwrite, so it stays allowed.
 */
const checkoutIndexForce = git("checkout-index", (git) => {
    const args = git.args;
    if (has(args, "-h", "--help", "--version")) return undefined;
    if (longFlag(args, "--temp") || stageAll(args)) return undefined;
    if (!(shortFlag(args, "f") || longFlag(args, "--force"))) return undefined;
    if (shortFlag(args, "a") || longFlag(args, "--all") || longFlag(args, "--stdin")) {
        return "git checkout-index --force";
    }
    if (operands(args, CHECKOUT_INDEX_WITH_VALUE).length > 0) return "git checkout-index --force";
    return undefined;
});

const switchDiscard = git("switch", (git) => {
    if (shortFlag(git.args, "C", "c") || longFlag(git.args, "--force-create")) {
        return "git switch --force-create (branch reset)";
    }
    if (longFlag(git.args, "--discard-changes")) return "git switch --discard-changes";
    if (shortFlag(git.args, "f", "cC") || longFlag(git.args, "--force")) return "git switch --force";
    return undefined;
});

const RESTORE_WITH_VALUE: ReadonlySet<string> = new Set([
    "-s",
    "--source",
    "--conflict",
    "--inter-hunk-context",
    "-U",
    "--unified",
]);

const restoreWorktree = git("restore", (git) => {
    const args = git.args;
    if (has(args, "-h", "--help", "--version")) return undefined;
    const pathspecs = operands(args, RESTORE_WITH_VALUE);
    if (pathspecs.length === 0 && !longFlag(args, "--pathspec-from-file")) {
        return undefined; // nothing named: git refuses to restore anything
    }
    const staged = shortFlag(args, "S", "sU") || has(args, "--staged");
    let worktree = shortFlag(args, "W", "sU") || has(args, "--worktree");
    if (has(args, "--no-worktree")) worktree = false;
    else if (!staged && !has(args, "--no-staged")) worktree = true; // git restore's default target is the working tree
    return worktree ? "git restore (working tree)" : undefined;
});

const cleanForce = git("clean", (git) => {
    if (shortFlag(git.args, "n") || longFlag(git.args, "--dry-run")) return undefined;
    if (shortFlag(git.args, "f") || longFlag(git.args, "--force")) return "git clean -f";
    return undefined;
});

const rmForce = git("rm", (git) => {
    if (longFlag(git.args, "--cached") || shortFlag(git.args, "n") || longFlag(git.args, "--dry-run")) {
        return undefined;
    }
    if (shortFlag(git.args, "f") || longFlag(git.args, "--force")) return "git rm -f";
    return undefined;
});

const stashDrop = git("stash", (git) => {
    const first = git.args[0];
    if (first === "drop" || first === "clear") return `git stash ${first}`;
    return undefined;
});

const worktreeRemoveForce = git("worktree", (git) => {
    const rest = git.args.slice(1);
    if (git.args[0] === "remove" && (shortFlag(rest, "f") || longFlag(rest, "--force"))) {
        return "git worktree remove --force";
    }
    return undefined;
});

// --------------------------------------------------------------------------- #
// Rewriting or deleting history and refs
// --------------------------------------------------------------------------- #

const SAFE_FORCE: ReadonlySet<string> = new Set(["--force-with-lease", "--force-if-includes"]);

/** `-f`, `--force` or a prefix of it; never `--force-with-lease`/`--force-if-includes`. */
function forces(args: readonly string[]): boolean {
    for (const arg of args) {
        if (arg === "--") return false;
        const key = arg.split("=", 1)[0] as string;
        if (SAFE_FORCE.has(key)) continue;
        if (key.startsWith("--") && key.length >= 6 && "--force".startsWith(key)) return true;
        if (arg.startsWith("-") && !arg.startsWith("--")) {
            // In `-oci.skip-fast` the rest of the word is the push option's value.
            if ((arg.slice(1).split("o", 1)[0] as string).includes("f")) return true;
        }
    }
    return false;
}

const PUSH_WITH_VALUE: ReadonlySet<string> = new Set([
    "--repo",
    "-o",
    "--push-option",
    "--receive-pack",
    "--exec",
]);

/** `git push [<repository> [<refspec>...]]`; with `--repo` every operand is a refspec. */
function pushRefspecs(args: readonly string[]): string[] {
    const words = operands(args, PUSH_WITH_VALUE);
    const namesRepo = args.some((a) => a === "--repo" || a.startsWith("--repo="));
    return namesRepo ? words : words.slice(1);
}

const pushForce = git("push", (git) => {
    const args = git.args;
    if (longFlag(args, "--mirror")) return "git push --mirror";
    if (forces(args)) return "git push --force";
    if (pushRefspecs(args).some((r) => r.startsWith("+") || r.includes(":+")))
        return "git push +refspec (force)";
    return undefined;
});

const pushDelete = git("push", (git) => {
    if (shortFlag(git.args, "d") || longFlag(git.args, "--delete")) return "git push --delete";
    if (longFlag(git.args, "--prune")) {
        // Deletes remote branches the refspec matches but that have no local counterpart.
        return "git push --prune";
    }
    if (pushRefspecs(git.args).some((r) => r.startsWith(":") && r.length > 1))
        return "git push :ref (delete)";
    return undefined;
});

const branchForceDelete = git("branch", (git) => {
    const args = git.args;
    if (has(args, "--list", "--show-current", "--help")) return undefined;
    if (shortFlag(args, "D")) return "git branch -D";
    const deleting = shortFlag(args, "d") || longFlag(args, "--delete");
    const forcing = shortFlag(args, "f") || longFlag(args, "--force");
    if (forcing) return deleting ? "git branch --delete --force" : "git branch --force (reset or overwrite)";
    if (shortFlag(args, "MC")) return "git branch forced move/copy (overwrite)";
    return undefined;
});

const tagDelete = git("tag", (git) => {
    if (shortFlag(git.args, "lv", "mFu") || has(git.args, "--list", "--verify", "--help")) return undefined;
    if (shortFlag(git.args, "f", "mFu") || longFlag(git.args, "--force")) {
        return "git tag --force (replace release marker)";
    }
    return shortFlag(git.args, "d") || longFlag(git.args, "--delete") ? "git tag -d" : undefined;
});

const reflogDelete = git("reflog", (git) => {
    if (git.args[0] === "delete") return "git reflog delete";
    if (
        git.args[0] === "expire" &&
        git.args.some((a) => a.startsWith("--expire") && (a.endsWith("now") || a.endsWith("all")))
    ) {
        return "git reflog expire --expire=now";
    }
    return undefined;
});

const filterHistory = git(["filter-branch", "filter-repo"], (git) => `git ${git.subcommand}`);

const ZERO_OID = /^(?:0{40}|0{64})$/;
const REPOSITORY_ENV = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_NAMESPACE"];
const SHOW_REF_TIMEOUT_MS = 2000;
const STDIN_TRANSACTION = /(?:^|[\n\r\x00])\s*(?:delete|symref-delete|update|symref-update)\s/;

async function updateRefDelete(
    command: SimpleCommand,
    ctx: RuleContext,
): Promise<string | MatchDetail | undefined> {
    const git = gitInvocation(command, ctx.host.home);
    if (git === undefined || git.subcommand !== "update-ref") return undefined;
    if (shortFlag(git.args, "d", "m") || longFlag(git.args, "--delete")) return "git update-ref -d";
    if (!git.args.includes("--stdin")) {
        const refs = operands(git.args, new Set(["-m"]));
        if (refs.length < 2) return undefined;
        // An all-zero old value explicitly requires creation, never replacement.
        if (refs.length >= 3 && ZERO_OID.test(refs[2] as string)) return undefined;
        let unknown = false;
        // The lookup's environment: what the command line sets, else the process's.
        // Inside Claude Code the engine host answers only snapshotted names (GIT_DIR
        // is one; the others fall back to the process environment git itself reads).
        const lookupEnv: Record<string, string> = {};
        for (const key of REPOSITORY_ENV) {
            const values = command.envValues(key);
            if (values.length > 1) {
                return matchDetail(
                    "git update-ref (ambiguous repository)",
                    true,
                    "unresolved git repository",
                );
            }
            const value = values.length > 0 ? (values[0] as string) : ctx.host.env(key);
            if (value !== undefined) lookupEnv[key] = value;
        }
        for (const directory of git.directories.length > 0 ? git.directories : [ctx.cwd]) {
            // Read refs through Git to support packed refs and linked worktrees.
            const result = await ctx.host.run(
                [
                    "git",
                    "-C",
                    directory,
                    ...git.repositoryOptions,
                    "show-ref",
                    "--verify",
                    "--quiet",
                    "--",
                    refs[0] as string,
                ],
                { env: lookupEnv, timeoutMs: SHOW_REF_TIMEOUT_MS },
            );
            if (result === undefined) {
                unknown = true; // git missing, forbidden or timed out
                continue;
            }
            if (result.exitCode === 0) return "git update-ref (replace existing ref)";
            unknown ||= result.exitCode !== 1;
        }
        if (unknown) {
            return matchDetail("git update-ref (unresolved target ref)", true, "unresolved git ref lookup");
        }
        return undefined;
    }
    const source = await knownStdin(command, ctx.parsed, undefined, ctx.host);
    if (source === undefined) {
        return matchDetail(
            "git update-ref --stdin (unresolved transaction)",
            true,
            "unresolved git update-ref stdin",
        );
    }
    if (STDIN_TRANSACTION.test(source.text)) {
        return matchDetail(
            "git update-ref --stdin (delete or replace refs)",
            !source.typed,
            "git update-ref input file",
        );
    }
    return undefined;
}

const abortInProgress = git(["rebase", "merge", "cherry-pick", "revert", "am"], (git) =>
    has(git.args, "--abort") ? `git ${git.subcommand} --abort` : undefined,
);

// --------------------------------------------------------------------------- #
// Config that hides commands or weakens git's own checks
// --------------------------------------------------------------------------- #

const CONFIG_WITH_VALUE: ReadonlySet<string> = new Set([
    "-f",
    "--file",
    "--blob",
    "--type",
    "--default",
    "--comment",
    "--value",
]);

/** (key, value) pairs set by `git -c k=v` or `git config [--global] k v`. */
function configAssignments(command: SimpleCommand, home: string): Array<readonly [string, string]> {
    const git = gitInvocation(command, home);
    if (git === undefined) return [];
    const pairs: Array<readonly [string, string]> = git.config.map((c) => {
        const [key, , value] = partition(c, "=");
        return [key, value] as const;
    });
    if (git.subcommand === "config") {
        let positional = operands(git.args, CONFIG_WITH_VALUE);
        if (positional[0] === "set") positional = positional.slice(1);
        const [key, value] = positional;
        if (key !== undefined && value !== undefined && key.includes("."))
            pairs.push([key.toLowerCase(), value]);
    }
    return pairs;
}

function hooksPath(command: SimpleCommand, ctx: RuleContext): string | undefined {
    for (const [key] of configAssignments(command, ctx.host.home)) {
        if (key === "core.hookspath") return "git core.hooksPath";
    }
    return undefined;
}

function shellAlias(command: SimpleCommand, ctx: RuleContext): string | undefined {
    for (const [key, value] of configAssignments(command, ctx.host.home)) {
        if (key.startsWith("alias.") && value.trimStart().startsWith("!")) return `git ${key} = !shell`;
    }
    return undefined;
}

// Keys whose value is a program git runs. Set inline with `-c`, they execute
// an arbitrary command under an innocuous-looking git invocation.
const NETWORK_SUBCOMMANDS: ReadonlySet<string> = new Set([
    "clone",
    "fetch",
    "pull",
    "push",
    "ls-remote",
    "submodule",
    "remote",
    "archive",
]);
const PROGRAM_KEYS: ReadonlySet<string> = new Set([
    "core.sshcommand",
    "core.fsmonitor",
    "core.pager",
    "core.editor",
    "core.askpass",
    "credential.helper",
    "diff.external",
    "sequence.editor",
]);

// Per-driver keys whose value is a command git runs through the shell:
// `filter.X.clean`/`smudge`/`process`, `diff.X.textconv`/`command`, `merge.X.driver`.
const PROGRAM_KEY_PATTERN =
    /^(?:filter\.[^=]+\.(?:clean|smudge|process)|diff\.[^=]+\.(?:textconv|command)|merge\.[^=]+\.driver|gpg(?:\.[^=]+)?\.program|core\.gitproxy|credential\..+\.helper)$/;

// `protocol.ext.allow=always` lets any URL run a program through git-remote-ext;
// `protocol.allow=always` does the same for every transport (PR review).
const PROTOCOL_KEYS: ReadonlySet<string> = new Set(["protocol.ext.allow", "protocol.allow"]);
const FSMONITOR_BUILTIN: ReadonlySet<string> = new Set([
    "true",
    "false",
    "yes",
    "no",
    "on",
    "off",
    "1",
    "0",
    "",
]);
const SSL_OFF: ReadonlySet<string> = new Set(["false", "0", "no", "off"]);

function unsafeOverride(command: SimpleCommand, ctx: RuleContext): string | undefined {
    const git = gitInvocation(command, ctx.host.home);
    for (const [key, value] of configAssignments(command, ctx.host.home)) {
        if (key === "http.sslverify" && SSL_OFF.has(value.toLowerCase())) return "git http.sslVerify=false";
        if (PROTOCOL_KEYS.has(key) && value.toLowerCase() === "always") return `git ${key}=always`;
        // `git config core.fsmonitor PROG` stores a program every later git status
        // runs silently. (Editor, pager, credential helper, sshCommand are routine
        // settings the user sees run; true/false selects the built-in fsmonitor.)
        if (
            git &&
            git.subcommand === "config" &&
            key === "core.fsmonitor" &&
            !FSMONITOR_BUILTIN.has(value.toLowerCase())
        ) {
            return "git config core.fsmonitor <program>";
        }
    }
    for (const item of git ? git.config : []) {
        const key = partition(item, "=")[0].toLowerCase();
        if (PROGRAM_KEY_PATTERN.test(key)) return `git -c ${key}=...`;
        // sshCommand only runs on network operations; the rest run on most commands.
        if (key === "core.sshcommand" && git && !NETWORK_SUBCOMMANDS.has(git.subcommand)) continue;
        if (PROGRAM_KEYS.has(key)) return `git -c ${key}=...`;
    }
    return undefined;
}

function configFromUnknownEnv(command: SimpleCommand, ctx: RuleContext): string | undefined {
    const git = gitInvocation(command, ctx.host.home);
    for (const key of git ? git.unresolved : []) {
        if (
            key === "*" ||
            key.startsWith("alias.") ||
            PROGRAM_KEYS.has(key) ||
            key === "core.hookspath" ||
            key === "http.sslverify" ||
            PROTOCOL_KEYS.has(key) ||
            PROGRAM_KEY_PATTERN.test(key.toLowerCase())
        ) {
            return `git --config-env=${key}=<unknown value>`;
        }
    }
    return undefined;
}

/**
 * An `ext::CMD` URL makes git run CMD as the transport (git-remote-ext), on
 * clone, fetch, pull, push, ls-remote, remote add or submodule add (PR review).
 */
function extTransport(command: SimpleCommand, ctx: RuleContext): string | undefined {
    const git = gitInvocation(command, ctx.host.home);
    if (git === undefined) return undefined;
    for (const arg of git.args) {
        if (arg.startsWith("ext::")) return `git ${git.subcommand} ext::`;
    }
    return undefined;
}

const VERIFYING_SUBCOMMANDS: ReadonlySet<string> = new Set(["commit", "push", "merge", "am", "rebase"]);

function noVerify(command: SimpleCommand, ctx: RuleContext): string | undefined {
    const git = gitInvocation(command, ctx.host.home);
    if (git && VERIFYING_SUBCOMMANDS.has(git.subcommand) && has(git.args, "--no-verify")) {
        return `git ${git.subcommand} --no-verify`;
    }
    return undefined;
}

const DISCARD_HINT =
    "This discards uncommitted or unpushed work with no undo. Show the user what would be " +
    "lost (`git status`, `git diff`, `git stash list`) and let them decide, or use the safe " +
    "form: `git stash` to set changes aside, `git restore --staged` to unstage only.";
const HISTORY_HINT =
    "This rewrites or deletes history other people may have. Prefer `git push " +
    "--force-with-lease`, `git branch -d` (refuses unmerged work), or ask the user to run it.";

export const GIT_RULES: readonly DangerRule[] = [
    dangerRule(
        "git-reset-hard",
        HIGH,
        "git reset --hard/--merge discards uncommitted changes",
        DISCARD_HINT,
        resetHard,
    ),
    dangerRule(
        "git-checkout-discard",
        HIGH,
        "git checkout can discard changes or force-reset a branch",
        DISCARD_HINT,
        checkoutDiscard,
    ),
    dangerRule(
        "git-checkout-index-force",
        HIGH,
        "git checkout-index --force overwrites existing files",
        DISCARD_HINT,
        checkoutIndexForce,
    ),
    dangerRule(
        "git-switch-discard",
        HIGH,
        "git switch can discard changes or force-reset a branch",
        DISCARD_HINT,
        switchDiscard,
    ),
    dangerRule(
        "git-restore-worktree",
        HIGH,
        "git restore of the working tree discards uncommitted changes",
        DISCARD_HINT,
        restoreWorktree,
    ),
    dangerRule(
        "git-clean-force",
        HIGH,
        "git clean -f deletes untracked files permanently",
        "Preview with `git clean -n` and let the user run the deletion.",
        cleanForce,
        "ask",
    ),
    dangerRule(
        "git-rm-force",
        HIGH,
        "git rm -f deletes files with uncommitted changes",
        "Use `git rm --cached` to untrack, or plain `git rm` which refuses modified files.",
        rmForce,
        "ask",
    ),
    dangerRule(
        "git-stash-drop",
        HIGH,
        "dropping or clearing stashes loses stashed work",
        "Show `git stash list` and let the user drop it.",
        stashDrop,
    ),
    dangerRule(
        "git-worktree-remove-force",
        HIGH,
        "git worktree remove --force deletes uncommitted work",
        "Use `git worktree remove` without --force; it refuses dirty worktrees.",
        worktreeRemoveForce,
    ),
    dangerRule("git-push-force", HIGH, "force push overwrites remote history", HISTORY_HINT, pushForce),
    dangerRule(
        "git-push-delete",
        HIGH,
        "git push --delete removes a remote branch or tag",
        HISTORY_HINT,
        pushDelete,
    ),
    dangerRule(
        "git-branch-force-delete",
        HIGH,
        "git branch force operations delete or overwrite history",
        HISTORY_HINT,
        branchForceDelete,
    ),
    dangerRule(
        "git-tag-delete",
        HIGH,
        "deleting or replacing tags loses release markers",
        HISTORY_HINT,
        tagDelete,
    ),
    dangerRule(
        "git-reflog-delete",
        HIGH,
        "deleting reflog entries removes the last way to recover commits",
        HISTORY_HINT,
        reflogDelete,
    ),
    dangerRule(
        "git-filter-history",
        HIGH,
        "history rewriting tools rewrite every commit",
        HISTORY_HINT,
        filterHistory,
    ),
    dangerRule(
        "git-update-ref-delete",
        HIGH,
        "git update-ref deletes or replaces refs",
        HISTORY_HINT,
        updateRefDelete,
    ),
    dangerRule(
        "git-hooks-path",
        HIGH,
        "core.hooksPath redirects or disables git hooks",
        "Hooks are a control point; leave hook configuration to the user.",
        hooksPath,
    ),
    dangerRule(
        "git-shell-alias",
        HIGH,
        "a `!` alias runs an arbitrary shell command under a git name",
        "Run the command directly so it can be checked.",
        shellAlias,
    ),
    dangerRule(
        "git-ext-transport",
        HIGH,
        "an `ext::` URL runs an arbitrary command as git's transport",
        "Use an https:// or ssh:// URL. git-remote-ext executes the command in the URL.",
        extTransport,
    ),
    dangerRule(
        "git-unsafe-override",
        HIGH,
        "disables TLS verification or runs a program through git config",
        "Do not weaken transport security or inject programs via `-c`; fix the underlying issue.",
        unsafeOverride,
    ),
    dangerRule(
        "git-config-env-unknown",
        HIGH,
        "sets an alias, hook path or program through --config-env from a variable that cannot be checked",
        "Pass the value inline with `-c key=value` so it can be checked, or ask the user.",
        configFromUnknownEnv,
        "ask",
    ),
    dangerRule(
        "git-no-verify",
        HIGH,
        "--no-verify skips the repository's hooks and checks",
        "Fix what the hook reports instead of skipping it, or ask the user.",
        noVerify,
        "ask",
    ),
    dangerRule(
        "git-abort",
        STRICT,
        "--abort throws away an in-progress merge/rebase resolution",
        "Confirm with the user before discarding conflict resolution work.",
        abortInProgress,
        "ask",
    ),
];
