/**
 * Which paths a parsed shell command writes, deletes, moves or re-permissions.
 *
 * Used by guards that protect files from the Bash tool as well as from the
 * Write/Edit tools. Works on shell_parse.SimpleCommand, so wrappers and nested
 * strings are already resolved: `sudo tee ~/.claude/settings.json`,
 * `bash -c 'cat x > .mcp.json'` and `xargs -I{} cp {} ~/.zshrc` all reach here
 * as the plain command.
 *
 * Coverage is deliberately about the common spellings, not every program that
 * can write a file. Interpreters (`python -c "open(p,'w')"`) are out of scope;
 * the model judge sees those.
 *
 * `git apply` names its targets inside the patch, so `writtenPaths` takes the
 * files the same line wrote and otherwise reads the patch from disk (through
 * the host, which makes it asynchronous; everything else here is pure).
 *
 * Ported from shell_writes.py.
 */

import type { Host } from "../host/host.ts";
import { expanduser, join, normpath } from "../util/paths.ts";
import { isDigit, rsplitOnce } from "../util/text.ts";
import type { SimpleCommand, WrittenFiles } from "./model.ts";

export const WRITE = "write";
export const DELETE = "delete";
/** recursive removal: everything below goes too */
export const DELETE_TREE = "delete-tree";
/** copied into this directory; the exact file names may not be known */
export const INTO_DIR = "into-dir";
/** the source of a move or rename: it disappears */
export const MOVE = "move";
export const PERMISSIONS = "permissions";
export const LINK = "link";

const WRITE_REDIRECTS: ReadonlySet<string> = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);

/** What an INTO_DIR write puts in its directory, so it can be listed. */
export interface Contents {
    /** a tar or zip file whose members land there */
    readonly archive?: string;
    readonly zipArchive: boolean;
    /** tar --strip-components */
    readonly strip: number;
    /** tar -P: members keep a leading / */
    readonly absoluteNames: boolean;
    /** copied paths: a file under its own name, a directory with its tree */
    readonly sources: readonly string[];
    /** directories among the sources are copied with what they hold */
    readonly recursive: boolean;
    /** cp -L / rsync --copy-links materializes linked directories */
    readonly followLinks: boolean;
    /** `src/` copies what src holds, not src itself: rsync, and BSD cp (macOS). */
    readonly slashCopiesContents: boolean;
    /** ditto: always what the source holds */
    readonly copiesContents: boolean;
    /** cp --parents, rsync -R: a source lands under its own path, not its name (keptPaths). */
    readonly keepParents: boolean;
    /** rsync's reading of that path (keptPaths) */
    readonly rsyncRelative: boolean;
}

/** `Contents(...)` with the dataclass defaults. */
export function contents(fields: Partial<Contents> = {}): Contents {
    return {
        archive: fields.archive,
        zipArchive: fields.zipArchive ?? false,
        strip: fields.strip ?? 0,
        absoluteNames: fields.absoluteNames ?? false,
        sources: fields.sources ?? [],
        recursive: fields.recursive ?? false,
        followLinks: fields.followLinks ?? false,
        slashCopiesContents: fields.slashCopiesContents ?? false,
        copiesContents: fields.copiesContents ?? false,
        keepParents: fields.keepParents ?? false,
        rsyncRelative: fields.rsyncRelative ?? false,
    };
}

export interface PathWrite {
    readonly path: string;
    readonly action: string;
    readonly dynamic: boolean;
    /** INTO_DIR: undefined when what lands there cannot be listed */
    readonly contents?: Contents;
}

/** `PathWrite(path, action, dynamic, contents)`. */
export function pathWrite(path: string, action: string, dynamic = false, contents?: Contents): PathWrite {
    return { path, action, dynamic, contents };
}

const NO_OPTIONS: ReadonlySet<string> = new Set();

function union(...sets: ReadonlySet<string>[]): ReadonlySet<string> {
    return new Set(sets.flatMap((set) => [...set]));
}

/** Non-option arguments, honouring `--` and options that take a value. */
function operands(args: readonly string[], withArg: ReadonlySet<string> = NO_OPTIONS): string[] {
    const found: string[] = [];
    let index = 0;
    let optionsEnded = false;
    while (index < args.length) {
        const arg = args[index] as string;
        if (optionsEnded || !arg.startsWith("-") || arg === "-") found.push(arg);
        else if (arg === "--") optionsEnded = true;
        else if (withArg.has(arg)) index += 1;
        index += 1;
    }
    return found;
}

function optionValue(args: readonly string[], names: readonly string[]): string | undefined {
    for (const [index, arg] of args.entries()) {
        for (const name of names) {
            if (arg === name && index + 1 < args.length) return args[index + 1];
            if (name.startsWith("--") && arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
            if (!name.startsWith("--") && arg.startsWith(name) && arg.length > name.length)
                return arg.slice(name.length);
        }
    }
    return undefined;
}

const RECURSIVE_COPY = /^(?:-[A-Za-z]*[rRa][A-Za-z]*|--recursive|--archive)$/;
const TARGET_DIRECTORY_OPTIONS: ReadonlySet<string> = new Set(["-t", "--target-directory", "-S", "--suffix"]);

/**
 * cp/mv/install/ln/rsync: what the destination may become.
 *
 * A destination that is (or turns out to be) a directory receives each
 * source under its own name: `cp settings.json ~/.claude/` writes
 * `~/.claude/settings.json`. Both readings are returned, plus the
 * directory itself (INTO_DIR) for copies whose file names cannot be known,
 * such as `rsync -a dir/ dest/`.
 */
function copyLike(
    args: readonly string[],
    withArg: ReadonlySet<string>,
    name: string,
    platform: Host["platform"],
): PathWrite[] {
    const directory = optionValue(args, ["-t", "--target-directory"]);
    const words = operands(args, union(withArg, TARGET_DIRECTORY_OPTIONS));
    let sources: readonly string[];
    let destination: string;
    if (directory) {
        sources = words;
        destination = directory;
    } else if (words.length >= 2) {
        sources = words.slice(0, -1);
        destination = words[words.length - 1] as string;
    } else {
        return [];
    }
    const keepParents = keepsParents(name, args);
    const rsyncRelative = keepParents && name === "rsync";
    const found: PathWrite[] = directory || keepParents ? [] : [pathWrite(destination, WRITE)];
    for (const source of sources) {
        const names = keepParents
            ? keptPaths(source, rsyncRelative)
            : source.endsWith("/")
              ? []
              : [rsplitOnce(source.replace(/\/+$/, ""), "/").at(-1) as string];
        for (const base of names) {
            if (base) found.push(pathWrite(`${destination.replace(/\/+$/, "")}/${base}`, WRITE));
        }
    }
    const what = contents({
        sources,
        recursive: name === "mv" || name === "ditto" || args.some((a) => RECURSIVE_COPY.test(a)),
        followLinks: followsLinks(name, args),
        slashCopiesContents: name === "rsync" || (name === "cp" && platform === "darwin"),
        copiesContents: name === "ditto",
        keepParents,
        rsyncRelative,
    });
    found.push(pathWrite(destination, INTO_DIR, false, what));
    return found;
}

/** rsync short options whose value is the rest of the cluster or the next word. */
const RSYNC_SHORT_WITH_VALUE: ReadonlySet<string> = new Set([..."BefMT@"]);

// rsync options that copy what a symlink points to instead of the link, each with
// its own `--no-` form: -L/--copy-links (every link), -k/--copy-dirlinks (links to
// directories), --copy-unsafe-links (links leaving the tree) (PR review).
const RSYNC_FOLLOW_LONG: ReadonlyMap<string, string> = new Map([
    ["--copy-links", "L"],
    ["--copy-dirlinks", "k"],
    ["--copy-unsafe-links", "unsafe"],
]);
const RSYNC_FOLLOW_SHORT: ReadonlySet<string> = new Set(["L", "k"]);

/**
 * Whether a recursive copy materializes linked directories, respecting option
 * values and later overrides: cp -L/--dereference (undone by -P, -a, -d, -H and
 * --no-dereference), rsync -L, -k and --copy-unsafe-links (each undone by its `--no-` form).
 */
function followsLinks(name: string, args: readonly string[]): boolean {
    if (name === "cp") {
        let follow = false;
        for (const arg of options(
            args,
            union(COPY_WITH_ARG.get(name) as ReadonlySet<string>, TARGET_DIRECTORY_OPTIONS),
        )) {
            if (arg.startsWith("--")) {
                const key = arg.split("=", 1)[0] as string;
                if (key === "--dereference") follow = true;
                else if (key === "--no-dereference" || key === "--archive") follow = false;
            } else {
                for (const letter of arg.slice(1)) {
                    if (letter === "L") follow = true;
                    else if ("PadH".includes(letter)) follow = false;
                }
            }
        }
        return follow;
    }
    if (name !== "rsync") return false;
    const enabled = new Set<string>();
    for (const arg of options(args, COPY_WITH_ARG.get(name) as ReadonlySet<string>, RSYNC_SHORT_WITH_VALUE)) {
        if (arg.startsWith("--")) {
            const key = arg.split("=", 1)[0] as string;
            const positive = `--${key.slice(5)}`;
            if (RSYNC_FOLLOW_LONG.has(key)) enabled.add(RSYNC_FOLLOW_LONG.get(key) as string);
            else if (key.startsWith("--no-") && RSYNC_FOLLOW_LONG.has(positive))
                enabled.delete(RSYNC_FOLLOW_LONG.get(positive) as string);
            else if (key.startsWith("--no-") && RSYNC_FOLLOW_SHORT.has(key.slice(5)))
                enabled.delete(key.slice(5)); // `--no-L`, `--no-k`
            continue;
        }
        for (const letter of arg.slice(1)) {
            if (RSYNC_FOLLOW_SHORT.has(letter)) enabled.add(letter);
            if (RSYNC_SHORT_WITH_VALUE.has(letter)) break; // the rest of the cluster is that option's value
        }
    }
    return enabled.size > 0;
}

/**
 * Whether a copy writes each source under its own path rather than its name
 * (PR review): GNU `cp --parents a/b/c dest` writes dest/a/b/c, so
 * `cd evil && cp --parents .claude/settings.json ..` lands in the parent
 * project's `.claude/`; `rsync -R` / `--relative` does the same. The last of
 * rsync's `-R`, `--relative`, `--no-relative`, `--no-R` wins.
 */
function keepsParents(name: string, args: readonly string[]): boolean {
    if (name === "cp" || name === "gcp") {
        // getopt accepts an unambiguous prefix: `--pa` is `--parents` (`--p` could be `--preserve`).
        return options(args, TARGET_DIRECTORY_OPTIONS).some(
            (a) => a.length >= 4 && "--parents".startsWith(a),
        );
    }
    if (name !== "rsync") return false;
    let relative = false;
    for (const arg of options(
        args,
        COPY_WITH_ARG.get("rsync") as ReadonlySet<string>,
        RSYNC_SHORT_WITH_VALUE,
    )) {
        if (arg.startsWith("--")) {
            const key = arg.split("=", 1)[0];
            if (key === "--relative") relative = true;
            else if (key === "--no-relative" || key === "--no-R") relative = false;
            continue;
        }
        for (const letter of arg.slice(1)) {
            if (letter === "R") relative = true;
            if (RSYNC_SHORT_WITH_VALUE.has(letter)) break; // the rest of the cluster is that option's value
        }
    }
    return relative;
}

/**
 * The option words before `--`, without the values of options that take
 * one: `withArg` words (`--exclude -R` excludes a file named `-R`) and a
 * `shortWithValue` letter ending a cluster (`-e ssh`).
 */
function options(
    args: readonly string[],
    withArg: ReadonlySet<string>,
    shortWithValue: ReadonlySet<string> = NO_OPTIONS,
): string[] {
    const found: string[] = [];
    let skip = false;
    for (const arg of args) {
        if (skip) {
            skip = false;
            continue;
        }
        if (arg === "--") break;
        if (arg.startsWith("-") && arg !== "-") {
            found.push(arg);
            skip =
                withArg.has(arg) ||
                (!arg.startsWith("--") && shortWithValue.has(arg[arg.length - 1] as string));
        }
    }
    return found;
}

const RSYNC_REMOTE = /^(?:rsync:\/\/[^/]*\/[^/]*\/?|[^/:]*::[^/]*\/?|[^/:]*:)/;

/**
 * Where a path-keeping copy puts `source` under its destination.
 *
 * `cp --parents` appends the source as written, without a leading `/` or
 * `./` (`/a/b` -> `a/b`, `./x/y` -> `x/y`, `../x` stays `../x`). rsync -R
 * keeps only what follows a `/./` in the path (`/srv/./app/x` -> `app/x`);
 * a leading `../` is read both kept and dropped, covering either way rsync
 * treats a path that climbs out of the destination.
 */
export function keptPaths(source: string, rsyncRelative = false): string[] {
    let path = source.replace(/\/+$/, "");
    if (rsyncRelative && RSYNC_REMOTE.test(path)) {
        path = path.replace(RSYNC_REMOTE, ""); // `host:a/b`, `host::module/a/b`, `rsync://host/module/a/b`
    }
    if (rsyncRelative && path.includes("/./")) path = path.slice(path.indexOf("/./") + 3);
    while (path.startsWith("./") || path.startsWith("/"))
        path = path.startsWith("./") ? path.slice(2) : path.slice(1);
    const found = [path];
    if (rsyncRelative) {
        let inside = path;
        while (inside.startsWith("../")) inside = inside.slice(3);
        found.push(inside);
    }
    return [...new Set(found)].filter((p) => p && p !== "." && p !== "..");
}

const SED_SCRIPT_OPTIONS: ReadonlySet<string> = new Set([
    "-e",
    "--expression",
    "-f",
    "--file",
    "-l",
    "--line-length",
]);

/** A short option cluster ending in `-i`: BSD sed takes the next word as its backup suffix. */
const BSD_IN_PLACE = /^-[a-zA-Z]*i$/;

/**
 * `args` without BSD sed's empty backup suffix: on macOS `sed -i '' s/a/b/ f`
 * takes `''` as the suffix, where GNU sed takes it as the script. Only an
 * empty word is dropped, since GNU sed (gsed, or a GNU `sed` first on PATH)
 * runs it as an empty script that leaves each file's text as it was. A
 * non-empty word stays, read the GNU way: that reading names every file the
 * BSD one does, and one more.
 */
function withoutBackupSuffix(
    name: string,
    args: readonly string[],
    platform: Host["platform"],
): readonly string[] {
    if (name !== "sed" || platform !== "darwin") return args;
    const index = args.findIndex((a) => BSD_IN_PLACE.test(a));
    if (index < 0 || args[index + 1] !== "") return args;
    return [...args.slice(0, index + 1), ...args.slice(index + 2)];
}

function sedInPlace(name: string, allArgs: readonly string[], platform: Host["platform"]): PathWrite[] {
    const inPlace = allArgs.some(
        (a) => a.startsWith("-i") || a.startsWith("--in-place") || /^-[a-zA-Z]*i[a-zA-Z]*$/.test(a),
    );
    if (!inPlace) return [];
    const args = withoutBackupSuffix(name, allArgs, platform);
    const words = operands(args, SED_SCRIPT_OPTIONS);
    const hasScriptOption = args.some(
        (a) => ["-e", "--expression", "-f", "--file"].includes(a) || a.startsWith("--expression="),
    );
    const files = hasScriptOption ? words : words.slice(1);
    return files.map((path) => pathWrite(path, WRITE));
}

function dd(args: readonly string[]): PathWrite[] {
    return args.filter((arg) => arg.startsWith("of=")).map((arg) => pathWrite(arg.slice(3), WRITE));
}

// Short options that take a value: in a cluster, the rest of the argument (or
// the next one) is that value, so `curl -sLo out URL` saves to `out`.
const DOWNLOAD_SHORT_WITH_VALUE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["curl", new Set([..."AbcCdDeEFHKmoPQrtTuUwxXyYz"])],
    ["wget", new Set([..."aABDeiIlOoPQRtTUwX"])],
]);
/** (output, remote-name flag, directory) as (short letter, long names). */
type DownloadOption = readonly [letter: string, long: readonly string[]];
const DOWNLOAD_OPTIONS: ReadonlyMap<string, readonly [DownloadOption, DownloadOption, DownloadOption]> =
    new Map([
        [
            "curl",
            [
                ["o", ["--output"]],
                ["O", ["--remote-name", "--remote-name-all"]],
                ["", ["--output-dir"]],
            ],
        ],
        [
            "wget",
            [
                ["O", ["--output-document"]],
                ["", []],
                ["P", ["--directory-prefix"]],
            ],
        ],
    ]);

/**
 * Each short option of a curl/wget call with its value, clusters expanded:
 * `-sLo out` gives s, L and (o, "out"). wget's `-nv`/`-nc` are single options.
 */
function shortOptions(name: string, args: readonly string[]): Array<readonly [string, string | undefined]> {
    const withValue = DOWNLOAD_SHORT_WITH_VALUE.get(name) as ReadonlySet<string>;
    const found: Array<readonly [string, string | undefined]> = [];
    let index = 0;
    while (index < args.length) {
        const arg = args[index] as string;
        index += 1;
        if (arg === "--") break;
        if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < 2) continue;
        let position = 1;
        while (position < arg.length) {
            const letter = arg[position] as string;
            if (name === "wget" && letter === "n") {
                position += 2; // -nv, -nc, -nd, -nH, -np
                continue;
            }
            if (withValue.has(letter)) {
                let value = arg.slice(position + 1);
                if (!value && index < args.length) {
                    value = args[index] as string;
                    index += 1;
                }
                found.push([letter, value]);
                break;
            }
            found.push([letter, undefined]);
            position += 1;
        }
    }
    return found;
}

/**
 * Files a curl/wget call saves: an explicit output, or the URL's own file name
 * (`curl -O URL`, and wget's default).
 */
function download(name: string, args: readonly string[]): PathWrite[] {
    const [[outLetter, outLong], [remoteLetter, remoteLong], [dirLetter, dirLong]] = DOWNLOAD_OPTIONS.get(
        name,
    ) as readonly [DownloadOption, DownloadOption, DownloadOption];
    const short = shortOptions(name, args);
    const explicit = short.flatMap(([letter, value]) =>
        letter === outLetter && value !== undefined ? [value] : [],
    );
    const longOutput = optionValue(args, outLong);
    if (longOutput !== undefined) explicit.push(longOutput);
    let directory = short.find(([letter]) => dirLetter !== "" && letter === dirLetter)?.[1];
    directory = optionValue(args, dirLong) || directory;
    let names = explicit.filter((path) => path !== "-");
    const remote =
        short.some(([letter]) => letter === remoteLetter) || args.some((a) => remoteLong.includes(a));
    if (explicit.length === 0 && (name === "wget" || remote)) {
        const urls = args.filter((a) => a.includes("://") && !a.startsWith("-"));
        names = urls.map(
            (url) =>
                rsplitOnce((url.split("?", 1)[0] as string).replace(/\/+$/, ""), "/").at(-1) || "index.html",
        );
    }
    return names.map((n) =>
        pathWrite(directory && !n.startsWith("/") ? `${directory.replace(/\/+$/, "")}/${n}` : n, WRITE),
    );
}

const TARGET_ONLY: ReadonlyMap<string, readonly [string, ReadonlySet<string>]> = new Map([
    ["tee", [WRITE, NO_OPTIONS]],
    ["touch", [WRITE, new Set(["-d", "-r", "-t", "--date", "--reference"])]],
    ["truncate", [WRITE, new Set(["-s", "--size", "-r", "--reference"])]],
    ["sponge", [WRITE, NO_OPTIONS]],
    ["rm", [DELETE, NO_OPTIONS]],
    ["unlink", [DELETE, NO_OPTIONS]],
    ["shred", [DELETE, new Set(["-n", "--iterations", "-s", "--size", "--random-source"])]],
    ["rmdir", [DELETE, NO_OPTIONS]],
    ["trash", [DELETE, NO_OPTIONS]],
    ["chattr", [PERMISSIONS, NO_OPTIONS]],
    ["setfacl", [PERMISSIONS, new Set(["-m", "-x", "-M", "-X", "--modify", "--remove"])]],
    ["xattr", [PERMISSIONS, new Set(["-w", "-d"])]],
]);
/** Mode/owner is the first operand; the rest are targets. */
const LEADING_SPEC: ReadonlyMap<string, string> = new Map([
    ["chmod", PERMISSIONS],
    ["chown", PERMISSIONS],
    ["chgrp", PERMISSIONS],
    ["chflags", PERMISSIONS],
]);
// `chmod -x FILE`, `chmod -rw,g+x FILE`, `chmod -w+s FILE`: a mode that starts
// with a dash. GNU chmod reads an argument as a mode when the letter after the
// dash is one of these (no chmod option uses them); BSD chmod, for r s t u w x X g o.
const CHMOD_DASH_MODE = /^-[rwxXstugoa0-7,+=][rwxXstugoa0-7,+=-]*$/;

/**
 * The mode of `chmod -x FILE`, which reads as an option; undefined when the
 * mode is an ordinary operand.
 *
 * Before the first operand, GNU and BSD chmod both read a dash mode as the
 * mode. After it (`chmod 4755 FILE -s`) GNU still does, while BSD reads a
 * file; `anywhere=true` takes the GNU reading.
 */
export function chmodDashMode(args: readonly string[], anywhere = false): string | undefined {
    for (const arg of args) {
        if (arg === "--") return undefined;
        if (CHMOD_DASH_MODE.test(arg)) return arg;
        if (!anywhere && !arg.startsWith("-")) return undefined;
    }
    return undefined;
}

const COPY_WITH_ARG: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["cp", NO_OPTIONS],
    ["mv", NO_OPTIONS],
    ["ln", NO_OPTIONS],
    ["install", new Set(["-m", "--mode", "-o", "--owner", "-g", "--group"])],
    [
        "rsync",
        new Set([
            "-e",
            "--rsh",
            "--exclude",
            "--include",
            "--filter",
            "-f",
            "--exclude-from",
            "--include-from",
            "--files-from",
            "--chmod",
        ]),
    ],
    ["ditto", NO_OPTIONS],
    ["scp", new Set(["-P", "-i", "-o", "-F", "-c", "-l", "-S", "-J"])],
]);

const EDITOR_WITH_ARG: ReadonlySet<string> = new Set(["-i", "-o", "-r", "-d", "-p", "-B", "-z", "-D"]);

/**
 * Every path `command` writes, deletes, moves away, links, or re-permissions.
 *
 * `written` holds the files the same command line wrote from literal text,
 * by absolute path; `git apply` reads its patch from there before disk
 * (through `host`, which also tells BSD cp from GNU cp by its platform).
 */
export async function writtenPaths(
    command: SimpleCommand,
    written: WrittenFiles | undefined,
    host: Host,
): Promise<PathWrite[]> {
    let found: PathWrite[] = command.redirects
        .filter((r) => WRITE_REDIRECTS.has(r.op))
        .map((r) => pathWrite(r.target, WRITE, r.dynamic));
    if (command.argv.length === 0 || command.dynamicHead) return found;
    const name = command.name;
    const args = command.args;

    const targetOnly = TARGET_ONLY.get(name);
    const leading = LEADING_SPEC.get(name);
    const copyWithArg = COPY_WITH_ARG.get(name);
    if (targetOnly !== undefined) {
        let [action, withArg] = targetOnly;
        if (name === "rm" && recursive(args)) action = DELETE_TREE;
        found.push(...operands(args, withArg).map((path) => pathWrite(path, action)));
    } else if (leading !== undefined) {
        const words = operands(args, new Set(["--reference", "--from"]));
        // `chmod --reference=RFILE FILE...`, `chmod -x FILE...`: no mode operand,
        // every operand is a target (under either chmod's reading of a dash mode).
        const byReference = args.some((a) => a === "--reference" || a.startsWith("--reference="));
        const allTargets = byReference || (name === "chmod" && chmodDashMode(args, true) !== undefined);
        found.push(...words.slice(allTargets ? 0 : 1).map((path) => pathWrite(path, leading)));
    } else if (copyWithArg !== undefined) {
        found.push(...copyLike(args, copyWithArg, name, host.platform));
        if (name === "ln") found = found.map((w) => (w.action === WRITE ? pathWrite(w.path, LINK) : w));
        if (name === "mv" || (name === "rsync" && args.includes("--remove-source-files"))) {
            // mv, and rsync --remove-source-files, take the sources away.
            const words = operands(args, union(TARGET_DIRECTORY_OPTIONS, copyWithArg));
            const targetDir = optionValue(args, ["-t", "--target-directory"]);
            const sources = targetDir ? words : words.slice(0, -1);
            found.push(...sources.map((path) => pathWrite(path, MOVE)));
        }
    } else if (name === "sed" || name === "gsed" || name === "perl") {
        found.push(...(name !== "perl" ? sedInPlace(name, args, host.platform) : perlInPlace(args)));
    } else if (name === "dd") {
        found.push(...dd(args));
    } else if (name === "curl" || name === "wget") {
        found.push(...download(name, args));
    } else if (["tar", "bsdtar", "gtar", "unzip", "7z", "7za"].includes(name)) {
        found.push(...extract(name, args));
    } else if (name === "git") {
        found.push(...gitCheckoutDirs(args));
        found.push(...gitConfigFile(args));
        found.push(...(await gitApply(args, command, written ?? new Map(), host)));
    } else if (name === "ed" || name === "ex" || name === "patch") {
        found.push(
            ...operands(args, EDITOR_WITH_ARG)
                .slice(0, 1)
                .map((path) => pathWrite(path, WRITE)),
        );
    }
    return found;
}

/** git's global options that take a value as the next word. */
const GIT_GLOBAL_WITH_VALUE: ReadonlySet<string> = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--config-env",
    "--exec-path",
    "--super-prefix",
    "--list-cmds",
]);
// Per subcommand: options taking a value, and whether the directory is the
// second operand (clone, submodule add: after the repository) or the first.
const GIT_DIRECTORY_COMMANDS: ReadonlyArray<readonly [readonly string[], ReadonlySet<string>, boolean]> = [
    [
        ["clone"],
        new Set([
            "-o",
            "--origin",
            "-b",
            "--branch",
            "-u",
            "--upload-pack",
            "--reference",
            "--reference-if-able",
            "--separate-git-dir",
            "--depth",
            "--shallow-since",
            "--shallow-exclude",
            "-c",
            "--config",
            "-j",
            "--jobs",
            "--template",
            "--filter",
            "--bundle-uri",
            "--server-option",
            "--ref-format",
        ]),
        true,
    ],
    [["submodule", "add"], new Set(["-b", "--branch", "--name", "--reference", "--depth"]), true],
    [["worktree", "add"], new Set(["-b", "-B", "--reason"]), false],
];

/**
 * `git clone URL [DIR]`, `git submodule add URL [PATH]`, `git worktree add PATH`:
 * the directory filled with a checkout. Without DIR, clone and submodule add
 * use the repository's name. `git -C D` makes a relative directory start at D.
 */
function gitCheckoutDirs(args: readonly string[]): PathWrite[] {
    let base: string | undefined;
    let index = 0;
    while (index < args.length && (args[index] as string).startsWith("-")) {
        if (args[index] === "-C" && index + 1 < args.length) {
            // `git -C a -C b`: a relative b continues from a; an absolute one replaces it.
            const target = args[index + 1] as string;
            const absolute = target.startsWith("/") || target.startsWith("~") || target.startsWith("$HOME");
            base = base === undefined || absolute ? target : `${base.replace(/\/+$/, "")}/${target}`;
        }
        index += GIT_GLOBAL_WITH_VALUE.has(args[index] as string) ? 2 : 1;
    }
    const rest = args.slice(index);
    for (const [words, withArg, afterRepository] of GIT_DIRECTORY_COMMANDS) {
        if (words.some((word, position) => rest[position] !== word)) continue;
        const found = operands(rest.slice(words.length), withArg);
        if (found.length === 0) return [];
        let directory: string;
        if (afterRepository) {
            directory = found.length > 1 ? (found[1] as string) : repositoryName(found[0] as string);
        } else {
            directory = found[0] as string;
        }
        if (base !== undefined && !directory.startsWith("/") && !directory.startsWith("~")) {
            directory = `${base.replace(/\/+$/, "")}/${directory}`;
        }
        return [pathWrite(directory, INTO_DIR, directory.includes("$"))];
    }
    return [];
}

/** (subcommand, its arguments) after git's global options; ("", []) if none. */
function gitSubcommand(args: readonly string[]): readonly [string, readonly string[]] {
    let index = 0;
    while (index < args.length && (args[index] as string).startsWith("-")) {
        index += GIT_GLOBAL_WITH_VALUE.has(args[index] as string) ? 2 : 1;
    }
    return index < args.length ? [args[index] as string, args.slice(index + 1)] : ["", []];
}

// `git config` forms that only read; anything else with a file writes it.
const GIT_CONFIG_READS: ReadonlySet<string> = new Set([
    "--get",
    "--get-all",
    "--get-regexp",
    "--get-urlmatch",
    "--get-color",
    "--get-colorbool",
    "-l",
    "--list",
    "--show-origin",
    "--show-scope",
]);
const GIT_CONFIG_WRITES: ReadonlySet<string> = new Set([
    "--unset",
    "--unset-all",
    "--add",
    "--replace-all",
    "--rename-section",
    "--remove-section",
    "-e",
    "--edit",
]);
const GIT_CONFIG_WITH_VALUE: ReadonlySet<string> = new Set([
    "-f",
    "--file",
    "--blob",
    "--type",
    "--default",
    "--comment",
    "--value",
    "--url",
]);
const GIT_CONFIG_WRITE_VERBS = ["set", "unset", "rename-section", "remove-section", "edit"];

/**
 * `git config -f FILE k v` writes FILE itself, wherever it is (PR review).
 * A lookup (`--get`, `--list`, one key operand) or `--blob` only reads.
 */
function gitConfigFile(args: readonly string[]): PathWrite[] {
    const [subcommand, rest] = gitSubcommand(args);
    if (subcommand !== "config") return [];
    const path = optionValue(rest, ["-f", "--file"]);
    if (
        path === undefined ||
        rest.some((a) => GIT_CONFIG_READS.has(a)) ||
        rest.some((a) => a.startsWith("--blob"))
    )
        return [];
    const words = operands(rest, GIT_CONFIG_WITH_VALUE);
    const verb = words[0];
    if (verb === "get" || verb === "list") return [];
    const writes =
        rest.some((a) => GIT_CONFIG_WRITES.has(a)) ||
        words.length >= 2 ||
        (verb !== undefined && GIT_CONFIG_WRITE_VERBS.includes(verb));
    return writes ? [pathWrite(path, WRITE, path.includes("$") || path.includes("`"))] : [];
}

/** `git apply` forms that touch no working-tree file. */
const GIT_APPLY_DRY: ReadonlySet<string> = new Set([
    "--check",
    "--stat",
    "--numstat",
    "--summary",
    "--cached",
]);
const GIT_APPLY_WITH_VALUE: ReadonlySet<string> = new Set([
    "-p",
    "-C",
    "--whitespace",
    "--directory",
    "--exclude",
    "--include",
    "--build-fake-ancestor",
]);
export const MAX_PATCH_BYTES = 1024 * 1024;
// `+++ b/path` and `--- a/path` carry -p's leading component; `rename to path` and
// `copy to path` do not. A tab ends a traditional header's path (a timestamp follows).
const PATCH_TARGET = /^(?<header>\+\+\+ |--- |rename to |copy to )(?<path>"(?:[^"\\]|\\.)*"|[^\t\n]+)/m;

/**
 * The files a patch given to `git apply` changes, from its headers, with
 * `-pN` stripped and `--directory=ROOT` prepended (PR review). When the patch
 * cannot be read (a pipe, a computed name) the target is unknown, which asks.
 */
async function gitApply(
    args: readonly string[],
    command: SimpleCommand,
    written: WrittenFiles,
    host: Host,
): Promise<PathWrite[]> {
    const [subcommand, rest] = gitSubcommand(args);
    if (subcommand !== "apply" || rest.some((a) => GIT_APPLY_DRY.has(a))) return [];
    const stripValue = optionValue(rest, ["-p"]);
    const strip = stripValue !== undefined && isDigit(stripValue) ? Number(stripValue) : 1;
    const root = (optionValue(rest, ["--directory"]) ?? "").replace(/^\/+|\/+$/g, "");
    const texts: string[] = [];
    let unknown = false;
    const sources = operands(rest, GIT_APPLY_WITH_VALUE);
    for (const redirect of command.redirects) {
        if ((redirect.op === "<<" || redirect.op === "<<-") && redirect.body !== undefined) {
            texts.push(redirect.body);
        } else if (redirect.op === "<<<") {
            texts.push(redirect.target);
        } else if (
            (redirect.op === "<" || redirect.op === "<>") &&
            (redirect.fd === undefined || redirect.fd === 0)
        ) {
            if (redirect.dynamic) unknown = true;
            else sources.push(redirect.target);
        }
    }
    if (sources.length === 0 && texts.length === 0) unknown = true; // the patch arrives on a pipe, or there is none
    for (const source of sources) {
        const text = await patchText(source, command, written, host);
        if (text === undefined) unknown = true;
        else texts.push(text);
    }
    const found: PathWrite[] = unknown ? [pathWrite("$(patch)", WRITE, true)] : [];
    for (const text of texts) {
        for (const match of text.matchAll(new RegExp(PATCH_TARGET.source, "gm"))) {
            const header = match.groups?.header as string;
            const prefixed = header === "+++ " || header === "--- ";
            const target = patchPath(match.groups?.path as string, prefixed ? strip : 0, root);
            if (target) found.push(pathWrite(target, WRITE));
        }
    }
    return uniqueWrites(found);
}

/** `list(dict.fromkeys(found))`: each write once, by value. */
function uniqueWrites(found: readonly PathWrite[]): PathWrite[] {
    const seen = new Set<string>();
    const unique: PathWrite[] = [];
    for (const write of found) {
        const key = JSON.stringify([write.path, write.action, write.dynamic, write.contents ?? null]);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(write);
    }
    return unique;
}

/** The patch `source` holds: written on this line, else read from disk. */
async function patchText(
    source: string,
    command: SimpleCommand,
    written: WrittenFiles,
    host: Host,
): Promise<string | undefined> {
    if (source === "-" || source.includes("$") || source.includes("`")) return undefined;
    for (const directory of command.possibleCwds) {
        if (directory === null) continue;
        const absolute = normpath(join(directory, expanduser(source, host.home)));
        const entry = written.get(absolute);
        if (entry !== undefined) return entry.text;
        const text = await host.readText(absolute, MAX_PATCH_BYTES);
        if (text !== undefined) return text;
    }
    return undefined;
}

/**
 * `shlex.split(text)[0]`: the first word of POSIX shell-quoted text, or
 * undefined when a quote is left open (shlex raises ValueError).
 */
function shlexFirstWord(text: string): string | undefined {
    let word = "";
    let index = 0;
    let started = false;
    while (index < text.length) {
        const char = text[index] as string;
        if (/\s/.test(char)) {
            if (started) break;
            index += 1;
            continue;
        }
        started = true;
        if (char === "'") {
            const end = text.indexOf("'", index + 1);
            if (end < 0) return undefined;
            word += text.slice(index + 1, end);
            index = end + 1;
        } else if (char === '"') {
            index += 1;
            let closed = false;
            while (index < text.length) {
                const inner = text[index] as string;
                if (inner === '"') {
                    closed = true;
                    index += 1;
                    break;
                }
                if (
                    inner === "\\" &&
                    index + 1 < text.length &&
                    ['"', "\\"].includes(text[index + 1] as string)
                ) {
                    word += text[index + 1];
                    index += 2;
                    continue;
                }
                word += inner;
                index += 1;
            }
            if (!closed) return undefined;
        } else if (char === "\\") {
            if (index + 1 >= text.length) return undefined;
            word += text[index + 1];
            index += 2;
        } else {
            word += char;
            index += 1;
        }
    }
    return started ? word : undefined;
}

function patchPath(rawName: string, strip: number, root: string): string | undefined {
    let name: string | undefined = rawName;
    if (name.startsWith('"')) {
        name = shlexFirstWord(name);
        if (name === undefined) return undefined;
    }
    name = name.trim();
    if (!name || name === "/dev/null") return undefined;
    const parts = name.split("/").filter((part) => part);
    if (parts.length <= strip) return undefined;
    const path = parts.slice(strip).join("/");
    return root ? `${root}/${path}` : path;
}

/** The directory git names a clone after: `https://h/a/evil.git` -> `evil`. */
function repositoryName(repository: string): string {
    const trimmed = repository.replace(/\/+$/, "");
    let name = trimmed.split(/[/:]/).at(-1) as string;
    if (name === ".git") name = trimmed.slice(0, -"/.git".length).split(/[/:]/).at(-1) as string;
    return (name.endsWith(".git") ? name.slice(0, -".git".length) : name) || name;
}

/** The directory an archive extraction writes into (file names unknown). */
function extract(name: string, args: readonly string[]): PathWrite[] {
    if (name === "unzip") {
        if (args.some((a) => ["-l", "-v", "-t", "-Z", "-p", "-c"].includes(a))) return []; // list, test or print to stdout
        const archive = operands(args, new Set(["-d", "-P"]))[0];
        const what = archive ? contents({ archive, zipArchive: true }) : undefined;
        return [pathWrite(optionValue(args, ["-d"]) || ".", INTO_DIR, false, what)];
    }
    if (name === "7z" || name === "7za") {
        if (args.length === 0 || (args[0] !== "x" && args[0] !== "e")) return [];
        const output = args.find((a) => a.startsWith("-o") && a.length > 2)?.slice(2) ?? ".";
        return [pathWrite(output, INTO_DIR)];
    }
    const first = args[0] ?? "";
    const extracting =
        args.some((a) => a === "-x" || a === "--extract" || a === "--get") ||
        (first !== "" && !first.startsWith("-") && first.includes("x")) ||
        args.some((a) => /^-[a-zA-Z]*x[a-zA-Z]*$/.test(a));
    if (!extracting || args.some((a) => a === "-O" || a === "--to-stdout")) return [];
    const directory = optionValue(args, ["-C", "--directory"]);
    return [pathWrite(directory || ".", INTO_DIR, false, tarContents(args))];
}

/** member names rewritten: not listable here */
const TAR_RENAMES = ["--transform", "--xform", "-s"];

function tarContents(args: readonly string[]): Contents | undefined {
    const archive = tarArchive(args);
    if (!archive || archive === "-" || args.some((a) => TAR_RENAMES.includes(a.split("=", 1)[0] as string))) {
        return undefined; // read from stdin, or renamed on the way out
    }
    const strip = optionValue(args, ["--strip-components"]);
    if (strip !== undefined && !isDigit(strip)) return undefined;
    const absolute = args.includes("--absolute-names") || args.some((a) => /^-[A-Za-z]*P[A-Za-z]*$/.test(a));
    return contents({ archive, strip: Number(strip || 0), absoluteNames: absolute });
}

/** The file `tar` reads: `-f FILE`, `--file=FILE`, `-xzf FILE`, `xzf FILE`. */
function tarArchive(args: readonly string[]): string | undefined {
    const named = optionValue(args, ["--file"]);
    if (named !== undefined) return named;
    for (const [index, arg] of args.entries()) {
        if (arg.startsWith("--")) continue;
        let cluster: string;
        if (arg.startsWith("-")) cluster = arg.slice(1);
        else if (index === 0) cluster = arg; // old style: `tar xzf FILE`
        else continue;
        if (cluster.includes("f")) {
            const attached = cluster.slice(cluster.indexOf("f") + 1);
            if (attached && arg.startsWith("-")) return attached; // `-fFILE`, `-xfFILE`
            return index + 1 < args.length ? args[index + 1] : undefined;
        }
    }
    return undefined;
}

function recursive(args: readonly string[]): boolean {
    for (const arg of args) {
        if (arg === "--") return false;
        if (arg.startsWith("--") && arg.length > 3 && "--recursive".startsWith(arg)) return true;
        if (arg.startsWith("-") && !arg.startsWith("--") && (arg.includes("r") || arg.includes("R")))
            return true;
    }
    return false;
}

function perlInPlace(args: readonly string[]): PathWrite[] {
    if (!args.some((a) => /^-[a-zA-Z]*i\S*$/.test(a))) return [];
    const words = operands(args, new Set(["-e", "-E", "-M", "-I"]));
    const hasScript = args.some((a) => a === "-e" || a === "-E" || /^-[a-zA-Z]*[eE]$/.test(a));
    const files = hasScript ? words : words.slice(1);
    return files.map((path) => pathWrite(path, WRITE));
}
