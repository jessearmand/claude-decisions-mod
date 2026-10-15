/**
 * What a command does to the filesystem that later commands on the line depend
 * on: `cd`, files written from literal text, and links or copies that make one
 * path stand for another. Part of shell_parse.
 *
 * Ported from shell_effects.py.
 */

import { basename, dirname, expanduser, isAbsolute, join, normpath } from "../util/paths.ts";
import { rstripChars } from "../util/text.ts";
import { commandOutput } from "./expand.ts";
import { HEREDOC_OPERATORS } from "./lexer.ts";
import {
    at,
    bounded,
    type Context,
    type Directory,
    FUNCTION,
    HASHED,
    type SimpleCommand,
    UNSET,
    type WrittenFile,
} from "./model.ts";

/** Move the tracked directory for `cd`/`pushd`/`popd` run in the current shell. */
export function followDirectoryChange(command: SimpleCommand, ctx: Context): void {
    if (!["cd", "pushd", "popd"].includes(command.name) || command.stage > 0) {
        return; // a `cd` inside a pipeline runs in a subshell
    }
    let target: string | null;
    if (command.name === "popd") {
        target = null;
    } else {
        const targets = command.args.filter((arg) => !(arg.startsWith("-") && arg !== "-"));
        target = targets.length > 0 ? (targets[0] as string) : "~";
    }
    ctx.cwd = changeDirectory(ctx.cwd, target, ctx.host.home);
    // The `cd` may fail, or sit in a branch that does not run (`cd a || cd b`):
    // the directories possible before it stay possible after it.
    const moved = ctx.cwdOptions.map((option) => changeDirectory(option, target, ctx.host.home));
    ctx.cwdOptions = bounded([...ctx.cwdOptions, ...moved]);
}

/** The directory after `cd target` from `current`; null when it cannot be known. */
export function changeDirectory(current: Directory, target: string | null, home: string): Directory {
    if (target === null) {
        return null; // popd: the directory stack is not tracked
    }
    const rewritten = target.replace(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/, "~");
    if (rewritten === "-" || rewritten.includes("$") || rewritten.includes("`")) {
        return null; // OLDPWD or a value computed at run time
    }
    const expanded = expanduser(rewritten, home);
    if (isAbsolute(expanded)) {
        return normpath(expanded);
    }
    return current === null ? null : normpath(join(current, expanded));
}

/** Remember literal text written to a file, so running it later is judged by its body. */
export function recordWrittenFile(command: SimpleCommand, ctx: Context): void {
    // The exact bytes written: a heredoc ends with a newline, `echo -n` and
    // `printf r` do not, so `printf r > f; printf m >> f` builds `rm`.
    let body: string | undefined;
    for (const r of command.redirects) {
        if (HEREDOC_OPERATORS.has(r.op) && r.body !== undefined) {
            body = r.body + (r.body.endsWith("\n") ? "" : "\n");
            break;
        }
    }
    if (
        body === undefined &&
        (command.name === "echo" || command.name === "printf") &&
        !command.dynamicHead
    ) {
        body = commandOutput(command) ?? undefined;
    }
    const directories = command.possibleCwds.filter((d): d is string => d !== null);
    if (body === undefined || directories.length === 0) {
        return;
    }
    const targets: Array<[string, boolean]> = command.redirects
        .filter((r) => [">", ">>", ">|"].includes(r.op) && !r.dynamic)
        .map((r) => [r.target, r.op === ">>"]);
    if (command.name === "tee") {
        const appends = command.args.some((a) => a === "-a" || a === "--append");
        for (const arg of command.args) {
            if (!arg.startsWith("-")) targets.push([arg, appends]);
        }
    }
    // `dict.fromkeys` over (path, appends) pairs: each pair once, in order.
    const paths = new Map<string, [string, boolean]>();
    for (const [t, appends] of targets) {
        for (const d of directories) {
            const path = normpath(join(d, expanduser(t, ctx.host.home)));
            const key = `${path}\0${appends}`;
            if (!paths.has(key)) paths.set(key, [path, appends]);
        }
    }
    const text = body;
    for (const [path, appends] of paths.values()) {
        const earlier = ctx.writtenFiles.get(path);
        let written: WrittenFile;
        if (appends && earlier !== undefined) {
            written = { text: earlier.text + text, replaces: earlier.replaces };
        } else {
            written = { text, replaces: !appends };
        }
        ctx.writtenFiles.set(path, written);
    }
}

/**
 * The program a path runs once this line's links and copies are followed:
 * `ln -s /bin/rm x; ./x` and `cp /bin/rm x; ./x` run /bin/rm. A bare name runs
 * what `hash -p` set for it, unless a function of that name comes first;
 * otherwise it is looked up in PATH, which is not modelled, and stays.
 */
export function executable(word: string, ctx: Context, functions = true, hashed = true): string {
    let program = word;
    if (!program.includes("/")) {
        // `functions`: the shell looks the name up as a function first; `hashed`:
        // it consults `hash -p` (the shell itself and `command` do; `sudo` does not).
        const mapping: readonly string[] = hashed
            ? (ctx.variables.get(HASHED + program) ?? [UNSET])
            : [UNSET];
        const definitions = ctx.variables.get(FUNCTION + program) ?? [UNSET];
        const onlyUnset = mapping.length === 1 && mapping[0] === UNSET;
        if ((functions && !definitions.includes(UNSET)) || onlyUnset) {
            return program;
        }
        if (mapping.length > 1) {
            // A mapping that may not have been made (`false && hash -p …`): which
            // program runs is not known; the most recent possibility is checked.
            ctx.result.truncated = true;
        }
        program = mapping.find((path) => path !== UNSET) ?? program;
    }
    if (ctx.cwd === null) {
        return program;
    }
    let path = normpath(join(ctx.cwd, expanduser(program, ctx.host.home)));
    const seen = new Set<string>([path]);
    for (;;) {
        const following = ctx.result.links.get(path) || ctx.copies.get(path);
        if (!following || seen.has(following)) break;
        path = following;
        seen.add(path);
    }
    return seen.size === 1 ? program : path;
}

// Options taking a value, per command that makes a path stand for another.
const PATH_MAKER_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["ln", new Set(["-S", "--suffix"])],
    ["cp", new Set(["-S", "--suffix"])],
    ["mv", new Set(["-S", "--suffix"])],
    ["install", new Set(["-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group"])],
]);

/**
 * Remember the links `ln` creates, so later writes through them resolve to the
 * target: `ln -s ~/.claude/settings.json x; printf y > x` writes settings.json.
 * Copies and moves (`cp`, `mv`, `install`) are remembered too, for what a later
 * command runs: `cp /bin/rm x; ./x -rf v` runs rm.
 */
export async function recordLink(command: SimpleCommand, ctx: Context): Promise<void> {
    const valued = PATH_MAKER_VALUES.get(command.name);
    if (valued === undefined || command.dynamicHead) {
        return;
    }
    const args = [...command.args];
    const operands: string[] = [];
    let directory: string | undefined;
    let index = 0;
    let ended = false;
    while (index < args.length) {
        const arg = args[index] as string;
        const short = arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1;
        if (ended || !arg.startsWith("-") || arg === "-") {
            operands.push(arg);
        } else if (arg === "--") {
            ended = true;
        } else if (arg.startsWith("--target-directory")) {
            if (arg.includes("=")) {
                directory = arg.slice(arg.indexOf("=") + 1);
            } else {
                directory = at(args, index + 1);
                index += 1;
            }
        } else if (valued.has(arg)) {
            index += 1;
        } else if (short && arg.includes("t")) {
            // `-t DIR`, `-sfDIR`-style clusters: the rest of the cluster, or the next word.
            const rest = arg.slice(arg.indexOf("t") + 1);
            if (rest) {
                directory = rest;
            } else {
                directory = at(args, index + 1);
                index += 1;
            }
        }
        index += 1;
    }
    if (directory === undefined && operands.length === 1) {
        directory = ".";
    }
    if (directory === undefined && operands.length < 2) {
        return;
    }
    const sources = directory !== undefined ? operands : operands.slice(0, -1);
    const symbolic = args.some(
        (a) => a === "--symbolic" || (a.startsWith("-") && !a.startsWith("--") && a.includes("s")),
    );
    const home = ctx.host.home;
    for (const cwd of command.possibleCwds) {
        if (cwd === null) continue;
        for (const source of sources) {
            const named = directory !== undefined ? directory : (operands[operands.length - 1] as string);
            let destination = join(cwd, expanduser(named, home));
            const intoDirectory =
                directory !== undefined ||
                sources.length > 1 ||
                (await ctx.host.stat(destination))?.kind === "dir";
            if (intoDirectory) {
                destination = join(destination, basename(rstripChars(source, "/")));
            }
            const link = normpath(destination);
            let target = expanduser(source, home);
            if (command.name !== "ln") {
                ctx.copies.set(link, normpath(join(cwd, target)));
                continue;
            }
            if (!isAbsolute(target)) {
                target = join(symbolic ? dirname(link) : cwd, target);
            }
            ctx.result.links.set(link, normpath(target));
        }
    }
}
