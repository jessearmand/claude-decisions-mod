/**
 * System-level dangerous commands: disks, fetch-and-execute, permissions,
 * persistence, package publishing, bulk deletion, and switching off security
 * controls.
 *
 * Sources: dcg system.disk / system.permissions / package_managers packs,
 * karanb192 block-dangerous-commands, sh-guard's download->execute taint rule,
 * cc-safety-net device/find rules, and the cancelli rubric axes for
 * persistence, weakened controls and fetch-and-execute.
 *
 * Ported from dangerous_system.py. Rules that read the disk (`realpath` for
 * temp roots, the written paths of a command) go through the context's host.
 */

import type { Host } from "../host/host.ts";
import { interpreterKind } from "../shell/interpreters.ts";
import type { SimpleCommand } from "../shell/model.ts";
import { parse } from "../shell/parse.ts";
import { type PythonProgram, pythonProgram } from "../shell/python-argv.ts";
import { SHELLS, STDIN_PATHS, shellInvocation } from "../shell/wrappers.ts";
import { chmodDashMode, WRITE, writtenPaths } from "../shell/writes.ts";
import { basename, dirname, expanduser, isAbsolute, join, normpath } from "../util/paths.ts";
import { isDigit } from "../util/text.ts";
import {
    CRITICAL,
    type DangerRule,
    dangerRule,
    expand,
    HIGH,
    has,
    isBroadTarget,
    isInside,
    longFlag,
    operands,
    positionalWords,
    type RuleContext,
    shortFlag,
} from "./danger-rule.ts";

// --------------------------------------------------------------------------- #
// Disks and devices
// --------------------------------------------------------------------------- #

const HARMLESS_DEVICES = /^\/dev\/(?:null|zero|u?random|stdout|stderr|stdin|tty\w*|fd\/\d+|pts\/\d+)$/;
const BLOCK_DEVICE = /^\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|disk|rdisk|md|dm-|mapper\/|loop)/;

async function deviceWrite(command: SimpleCommand, ctx: RuleContext): Promise<string | undefined> {
    const redirected = new Set(command.redirects.map((r) => r.target));
    for (const write of await writtenPaths(command, undefined, ctx.host)) {
        if (write.action !== WRITE || write.dynamic) continue;
        for (const target of devicePaths(write.path, command, ctx.host.home)) {
            // `dd of=` takes any device but the harmless ones; other writers
            // (`tee /dev/sda`, `cp image /dev/sda`, `> /dev/disk2`) a block device.
            const rawDevice = command.name === "dd" && !HARMLESS_DEVICES.test(target);
            if (BLOCK_DEVICE.test(target) || (rawDevice && !redirected.has(write.path))) {
                if (redirected.has(write.path)) return `redirect into ${target}`;
                return command.name === "dd" ? `dd of=${target}` : `${command.name} writes ${target}`;
            }
        }
    }
    return undefined;
}

/** The /dev paths `path` may name: `cd /dev && dd of=sda` writes /dev/sda. */
function devicePaths(path: string, command: SimpleCommand, home: string): string[] {
    const found: string[] = [];
    for (const directory of command.possibleCwds) {
        if (directory === null && !path.startsWith("/") && !path.startsWith("~")) continue;
        const target = normpath(join(directory || "/", expanduser(path, home)));
        if (target.startsWith("/dev/") && !found.includes(target)) found.push(target);
    }
    return found;
}

const FORMATTERS = /^(?:mkfs(?:\.\w+)?|mke2fs|mkswap|newfs(?:_\w+)?|wipefs|blkdiscard|sfdisk|cfdisk)$/;
const DISKUTIL_DESTRUCTIVE: ReadonlySet<string> = new Set([
    "eraseDisk",
    "eraseVolume",
    "partitionDisk",
    "zeroDisk",
    "randomDisk",
    "secureErase",
    "reformat",
    "deleteVolume",
    "apfs",
]);

/**
 * A /dev path, from any directory the command may run in (`cd /dev && mkfs
 * sdb1`), or a computed one; formatting an image file is harmless.
 */
function namesDevice(command: SimpleCommand, home: string): boolean {
    return operands(command.args).some(
        (a) =>
            a.startsWith("/dev/") ||
            a.includes("$") ||
            a.includes("`") ||
            devicePaths(a, command, home).length > 0,
    );
}

// parted commands that only report; any other command (or none: interactive) may write.
const PARTED_READ_ONLY: ReadonlySet<string> = new Set([
    "print",
    "p",
    "help",
    "h",
    "version",
    "v",
    "unit",
    "align-check",
    "quit",
    "q",
]);
const PARTED_UNITS: ReadonlySet<string> = new Set([
    "s",
    "B",
    "kB",
    "MB",
    "MiB",
    "GB",
    "GiB",
    "TB",
    "TiB",
    "%",
    "cyl",
    "chs",
    "compact",
]);

/**
 * `parted -l` and `parted DEV print` only read; `parted DEV mklabel gpt print`
 * writes a new label before printing it, and bare `parted DEV` is interactive.
 */
function parted(command: SimpleCommand): string | undefined {
    if (shortFlag(command.args, "l") || longFlag(command.args, "--list")) return undefined;
    const words = operands(command.args, new Set(["-a", "--align"])).slice(1); // after the device
    const commands = words.filter(
        (w) => !isDigit(w) && !PARTED_UNITS.has(w) && w !== "minimal" && w !== "optimal",
    );
    if (commands.length > 0 && commands.every((w) => PARTED_READ_ONLY.has(w))) return undefined;
    return "parted";
}

function diskFormat(command: SimpleCommand, ctx: RuleContext): string | undefined {
    if (FORMATTERS.test(command.name) && namesDevice(command, ctx.host.home)) return command.name;
    if (command.name === "parted") return parted(command);
    if (["fdisk", "gdisk", "sgdisk"].includes(command.name) && !shortFlag(command.args, "l")) {
        return command.name;
    }
    const first = command.args[0];
    if (command.name === "diskutil" && first !== undefined && DISKUTIL_DESTRUCTIVE.has(first)) {
        // `diskutil apfs list` is harmless; `diskutil apfs deleteContainer` is not.
        const second = command.args[1];
        const apfsDestructive =
            second !== undefined && (second.startsWith("delete") || second.startsWith("erase"));
        if (first !== "apfs" || apfsDestructive) return `diskutil ${first}`;
    }
    return undefined;
}

// --------------------------------------------------------------------------- #
// Fetch-and-execute and decode-and-execute
// --------------------------------------------------------------------------- #

const FETCHERS: ReadonlySet<string> = new Set([
    "curl",
    "wget",
    "fetch",
    "aria2c",
    "http",
    "https",
    "xh",
    "xhs",
    "httpie",
    "nc",
    "ncat",
    "netcat",
    "socat",
    "lwp-request",
    "GET",
]);
const DECODERS: ReadonlySet<string> = new Set([
    "base64",
    "base32",
    "xxd",
    "openssl",
    "uudecode",
    "gunzip",
    "zcat",
    "rev",
]);
const FETCH_IN_ARG = /(?:\$\(|<\(|`)\s*(?:\S*\/)?(?:curl|wget|fetch|aria2c|http|https|xh)\b/;

const INTERPRETER_OPTIONS_WITH_ARG: ReadonlySet<string> = new Set(["-W", "-X", "-m", "-r", "-I", "-M"]);
const SOURCE_BUILTINS: ReadonlySet<string> = new Set(["eval", "source", "."]);

/** A shell or interpreter that will run whatever arrives on stdin. */
function executesStdin(command: SimpleCommand): boolean {
    const name = command.name;
    const args = command.args;
    if (SHELLS.has(name)) {
        const shell = shellInvocation(name, args);
        return shell.readsStdin && !shell.syntaxOnly;
    }
    if (interpreterKind(name) === "python") {
        return pythonRunsStdin(pythonProgram(args, command.environment));
    }
    if (interpreterKind(name)) {
        const scriptArgs = operands(args, INTERPRETER_OPTIONS_WITH_ARG);
        return scriptArgs.length === 0 || STDIN_PATHS.has(scriptArgs[0] as string);
    }
    return SOURCE_BUILTINS.has(name);
}

// Modules that read stdin only as data. Others, such as `code`, `asyncio` or
// `pdb`, run what arrives on stdin, so a module is only trusted by name.
const STDIN_DATA_MODULES: ReadonlySet<string> = new Set([
    "json.tool",
    "json",
    "base64",
    "gzip",
    "quopri",
    "tokenize",
    "ast",
]);

/** `-i` (or PYTHONINSPECT) runs what remains on stdin once the program ends. */
function pythonRunsStdin(program: PythonProgram): boolean {
    if (program.inspect || program.kind === "stdin") return true;
    if (program.kind === "module") return !STDIN_DATA_MODULES.has(program.target ?? "");
    return program.kind === "script" && STDIN_PATHS.has(program.target ?? "");
}

function pipelineSources(command: SimpleCommand, ctx: RuleContext): SimpleCommand[] {
    const found: SimpleCommand[] = [];
    let current = ctx.parsed.previousStage(command);
    while (current !== undefined) {
        found.push(current);
        current = ctx.parsed.previousStage(current);
    }
    return found;
}

function fetchAndExecute(command: SimpleCommand, ctx: RuleContext): string | undefined {
    if (executesStdin(command)) {
        for (const source of pipelineSources(command, ctx)) {
            if (FETCHERS.has(source.name)) return `${source.name} ... | ${command.name}`;
        }
    }
    if (SHELLS.has(command.name) || SOURCE_BUILTINS.has(command.name) || interpreterKind(command.name)) {
        for (const arg of command.args) {
            if (FETCH_IN_ARG.test(arg)) return `${command.name} runs downloaded code: ${arg.slice(0, 60)}`;
        }
        // `bash < <(curl -fsSL URL)`: the download arrives as stdin.
        if (executesStdin(command)) {
            for (const redirect of command.redirects) {
                if (redirect.op === "<" && FETCH_IN_ARG.test(redirect.target)) {
                    return `${command.name} < downloaded code: ${redirect.target.slice(0, 60)}`;
                }
            }
        }
    }
    return undefined;
}

const SCRIPT_OPTIONS_WITH_ARG: ReadonlySet<string> = new Set([
    "-W",
    "-X",
    "-m",
    "-r",
    "-I",
    "-M",
    "-c",
    "-e",
]);

/**
 * Files `command` runs as a program: a script argument, `./tool`, `source f`,
 * or a file a shell or interpreter reads on stdin (`< f`, `cat f | bash`).
 */
function executedFiles(command: SimpleCommand, ctx: RuleContext): string[] {
    const files: string[] = [];
    const head = command.argv[0] ?? "";
    if (SHELLS.has(command.name)) {
        const shell = shellInvocation(command.name, command.args);
        if (shell.script && !shell.syntaxOnly) files.push(shell.script);
    } else if (interpreterKind(command.name)) {
        const script = operands(command.args, SCRIPT_OPTIONS_WITH_ARG).slice(0, 1);
        files.push(...script.filter((s) => !STDIN_PATHS.has(s)));
    } else if ((command.name === "source" || command.name === ".") && command.args.length > 0) {
        files.push(command.args[0] as string);
    } else if (head.includes("/") && !command.dynamicHead) {
        files.push(head);
    }
    if (executesStdin(command)) {
        files.push(...command.redirects.filter((r) => r.op === "<" && !r.dynamic).map((r) => r.target));
        for (const source of pipelineSources(command, ctx)) {
            if (source.name === "cat" && !source.dynamicHead) {
                files.push(...operands(source.args).filter((f) => !STDIN_PATHS.has(f)));
            }
        }
    }
    return files;
}

/**
 * `python3 -m a.b` imports `a` from the directory it runs in first (sys.path[0]).
 * Any file there named `a.<suffix>` (.py, .pyc, .so, ...) or under `a/` may load.
 */
function moduleRoots(command: SimpleCommand, home: string): string[] {
    if (interpreterKind(command.name) !== "python") return [];
    const program = pythonProgram(command.args, command.environment);
    const top = program.kind === "module" && program.target ? (program.target.split(".")[0] as string) : "";
    const roots: string[] = [];
    for (const directory of command.possibleCwds) {
        const root = top ? absolute(top, directory, home) : undefined;
        if (root) roots.push(root);
    }
    return roots;
}

function loadsFrom(path: string, roots: readonly string[]): boolean {
    return roots.some(
        (root) =>
            path.startsWith(`${root}/`) ||
            (dirname(path) === dirname(root) &&
                basename(path).split(".")[0] === basename(root) &&
                basename(path) !== basename(root)),
    );
}

function absolute(path: string, directory: string | null, home: string): string | undefined {
    const expanded = expanduser(path, home);
    if (isAbsolute(expanded)) return normpath(expanded);
    return directory === null ? undefined : normpath(join(directory, expanded));
}

/** `curl -o x.sh URL && bash x.sh`: running a file this same line downloaded. */
async function runDownloaded(command: SimpleCommand, ctx: RuleContext): Promise<string | undefined> {
    const home = ctx.host.home;
    const executed = new Set<string>();
    for (const file of executedFiles(command, ctx)) {
        for (const directory of command.possibleCwds) {
            const path = absolute(file, directory, home);
            if (path) executed.add(path);
        }
    }
    const roots = moduleRoots(command, home);
    if (executed.size === 0 && roots.length === 0) return undefined;
    for (const earlier of ctx.parsed.commands) {
        if (earlier === command) break;
        if (!FETCHERS.has(earlier.name)) continue;
        for (const write of await writtenPaths(earlier, undefined, ctx.host)) {
            for (const directory of earlier.possibleCwds) {
                const landed = absolute(write.path, directory, home);
                if (landed !== undefined && (executed.has(landed) || loadsFrom(landed, roots))) {
                    return `${earlier.name} downloads ${write.path}, then ${command.name} runs it`;
                }
            }
        }
    }
    return undefined;
}

/**
 * A script, Makefile or recipe set this command runs that could not be read
 * (too large, binary, or past a resolver limit).
 */
function uninspectedProgram(command: SimpleCommand, ctx: RuleContext): string | undefined {
    for (const [skipped, label] of ctx.parsed.skippedSources) {
        if (skipped === command) return `${command.name} runs ${label} (could not be inspected)`;
    }
    return undefined;
}

/**
 * The parser stopped early (nesting depth, wrapper chain, expansion limits):
 * what it did not see may be anything. Reported once, on the first command.
 */
function incompleteAnalysis(command: SimpleCommand, ctx: RuleContext): string | undefined {
    if (ctx.parsed.truncated && ctx.parsed.commands.length > 0 && command === ctx.parsed.commands[0]) {
        return "the command is nested or expanded beyond what the guards analyse";
    }
    return undefined;
}

const DECODED_HEAD = /^(?:\$\(([\s\S]*)\)|`([\s\S]*)`)$/;

async function decodeAndExecute(command: SimpleCommand, ctx: RuleContext): Promise<string | undefined> {
    const head = command.argv[0];
    if (command.dynamicHead && head !== undefined) {
        // `$(base64 -d <<< cm0=) -rf x`: the program to run is decoded text.
        const body = DECODED_HEAD.exec(head);
        if (body) {
            const inner = body.slice(1).find((group) => group !== undefined) as string;
            for (const source of (await parse(inner, "/", ctx.host)).commands) {
                if (decodes(source)) return `$(${source.name} (decode) ...) as the command`;
            }
        }
    }
    if (!executesStdin(command)) return undefined;
    for (const source of pipelineSources(command, ctx)) {
        if (decodes(source)) return `${source.name} (decode) ... | ${command.name}`;
    }
    return undefined;
}

function decodes(source: SimpleCommand): boolean {
    return (
        DECODERS.has(source.name) &&
        (shortFlag(source.args, "dDr") ||
            longFlag(source.args, "--decode") ||
            ["uudecode", "gunzip", "zcat", "rev"].includes(source.name))
    );
}

// --------------------------------------------------------------------------- #
// Permissions
// --------------------------------------------------------------------------- #

const NUMERIC_WORLD_WRITABLE = /^0*[0-7]?[0-7][0-7][2367]$/;
const NUMERIC_SETUID = /^0*[4267][0-7]{3}$/;
// One clause of a symbolic mode: who, then one or more operations
// (`u+x`, `-x`, `go-w+s`, `a=rwx`, `o=u`).
const CLAUSE = /^([ugoa]*)((?:[-+=][rwxXstugo]*)+)$/;
const OPERATION = /([-+=])([rwxXstugo]*)/g;

/**
 * Some clause of a symbolic mode adds `permission`. Copying another
 * class's bits (`o=u`) may add `w`. With `worldOnly`, only a clause for
 * others counts: `o`, `a`, or no who (umask may not mask it).
 */
function grants(mode: string, permission: string, worldOnly: boolean): boolean {
    for (const clause of mode.split(",")) {
        const match = CLAUSE.exec(clause);
        if (!match) continue;
        const who = match[1] as string;
        if (worldOnly && who && !who.includes("o") && !who.includes("a")) continue;
        for (const operation of (match[2] as string).matchAll(OPERATION)) {
            const op = operation[1] as string;
            const perms = operation[2] as string;
            const copies = permission === "w" && /[ugo]/.test(perms);
            if (op !== "-" && (perms.includes(permission) || copies)) return true;
        }
    }
    return false;
}

function worldWritable(mode: string): boolean {
    return NUMERIC_WORLD_WRITABLE.test(mode) || grants(mode, "w", true);
}

function setuid(mode: string): boolean {
    return NUMERIC_SETUID.test(mode) || grants(mode, "s", false);
}

function chmodDangerous(command: SimpleCommand, ctx: RuleContext): string | undefined {
    if (command.name !== "chmod") return undefined;
    const home = ctx.host.home;
    const words = operands(command.args, new Set(["--reference"]));
    let mode: string;
    let targets: string[];
    const dashMode = chmodDashMode(command.args);
    if (command.args.some((a) => a === "--reference" || a.startsWith("--reference="))) {
        // `chmod --reference=RFILE FILE...`: the mode comes from RFILE; every operand is a target.
        mode = "";
        targets = words;
    } else if (dashMode) {
        // `chmod -R -w DIR`: the mode reads as an option; every operand is a target.
        // A dash mode after the first operand is a file to BSD chmod; the first
        // operand stays the mode (below), the stricter of the two readings.
        mode = dashMode;
        targets = words;
    } else if (words.length < 2) {
        return undefined;
    } else {
        mode = words[0] as string;
        targets = words.slice(1);
    }
    if (targets.length === 0) return undefined;
    const recursive = shortFlag(command.args, "R") || longFlag(command.args, "--recursive");
    if (mode && setuid(mode)) return `chmod ${mode} (setuid/setgid)`;
    const broad = targets.some((t) => isBroadTarget(t, ctx.cwd, home));
    if (mode && worldWritable(mode) && (recursive || broad)) return `chmod ${recursive ? "-R " : ""}${mode}`;
    if (recursive && broad) return `chmod -R on ${targets[0]}`;
    return undefined;
}

function chmodWorldSingle(command: SimpleCommand): string | undefined {
    if (command.name !== "chmod") return undefined;
    const words = operands(command.args);
    return words.length >= 2 && worldWritable(words[0] as string) ? `chmod ${words[0]}` : undefined;
}

function chownBroad(command: SimpleCommand, ctx: RuleContext): string | undefined {
    if (command.name !== "chown" && command.name !== "chgrp") return undefined;
    const recursive = shortFlag(command.args, "R") || longFlag(command.args, "--recursive");
    const words = operands(command.args, new Set(["--reference", "--from"]));
    // `chown --reference=RFILE FILE...`: no owner operand, every operand is a target.
    const byReference = command.args.some((a) => a === "--reference" || a.startsWith("--reference="));
    const targets = byReference ? words : words.slice(1);
    if (recursive && targets.some((t) => isBroadTarget(t, ctx.cwd, ctx.host.home))) {
        return `${command.name} -R ${targets[0]}`;
    }
    return undefined;
}

// --------------------------------------------------------------------------- #
// Persistence: scheduled jobs and services
// --------------------------------------------------------------------------- #

function crontabRemove(command: SimpleCommand): string | undefined {
    return command.name === "crontab" && shortFlag(command.args, "r") ? "crontab -r" : undefined;
}

function crontabInstall(command: SimpleCommand): string | undefined {
    if (command.name !== "crontab" || shortFlag(command.args, "lr")) return undefined;
    return "crontab (install a new table)";
}

const LAUNCHCTL_LOADS: ReadonlySet<string> = new Set(["load", "bootstrap", "enable", "submit", "kickstart"]);
const SYSTEMCTL_ENABLES: ReadonlySet<string> = new Set(["enable", "link", "preset", "edit", "set-property"]);

function schedule(command: SimpleCommand): string | undefined {
    if ((command.name === "at" || command.name === "batch") && !shortFlag(command.args, "lrdc")) {
        return command.name;
    }
    const first = command.args[0];
    if (command.name === "launchctl" && first !== undefined && LAUNCHCTL_LOADS.has(first)) {
        return `launchctl ${first}`;
    }
    const verb = positionalWords(command)[0];
    if (command.name === "systemctl" && verb !== undefined && SYSTEMCTL_ENABLES.has(verb)) {
        return `systemctl ${verb}`;
    }
    return undefined;
}

// --------------------------------------------------------------------------- #
// Publishing packages and artifacts
// --------------------------------------------------------------------------- #

const PUBLISH: ReadonlyMap<string, readonly string[]> = new Map([
    ["npm", ["publish", "unpublish", "deprecate", "dist-tag"]],
    ["pnpm", ["publish"]],
    ["yarn", ["publish", "npm"]],
    ["bun", ["publish"]],
    ["cargo", ["publish", "yank", "owner"]],
    ["gem", ["push", "yank", "owner"]],
    ["twine", ["upload"]],
    ["uv", ["publish"]],
    ["poetry", ["publish"]],
    ["flit", ["publish"]],
    ["hatch", ["publish"]],
    ["pdm", ["publish"]],
    ["vsce", ["publish", "unpublish"]],
    ["ovsx", ["publish"]],
    ["pod", ["trunk"]],
    ["dotnet", ["nuget"]],
    ["mvn", ["deploy"]],
    ["gradle", ["publish"]],
    ["goreleaser", ["release"]],
]);

const TRUNK_VERBS: ReadonlySet<string> = new Set([
    "push",
    "delete",
    "deprecate",
    "add-owner",
    "remove-owner",
]);

function publish(command: SimpleCommand): string | undefined {
    const verbs = PUBLISH.get(command.name);
    if (!verbs) return undefined;
    const words = positionalWords(command);
    const verb = words[0];
    if (verb === undefined || !verbs.includes(verb)) return undefined;
    const second = words[1];
    if (command.name === "yarn" && verb === "npm" && second !== "publish") return undefined;
    if (
        ((command.name === "cargo" && verb === "owner") || (command.name === "gem" && verb === "owner")) &&
        !(
            shortFlag(command.args, "ar", "ar") ||
            has(command.args, "--add", "--remove") ||
            command.args.some((a) => a.startsWith("--add=") || a.startsWith("--remove="))
        )
    ) {
        return undefined;
    }
    if (
        command.name === "npm" &&
        verb === "dist-tag" &&
        (second === undefined || second === "ls" || second === "list")
    ) {
        return undefined;
    }
    if (command.name === "pod" && verb === "trunk" && !(second !== undefined && TRUNK_VERBS.has(second))) {
        return undefined;
    }
    if (command.name === "dotnet" && verb === "nuget" && second !== "push" && second !== "delete") {
        return undefined;
    }
    if (has(command.args, "--dry-run", "-n") || longFlag(command.args, "--dry-run")) return undefined;
    return `${command.name} ${verb}`;
}

const GH_DESTRUCTIVE: ReadonlySet<string> = new Set([
    "release create",
    "release delete",
    "release upload",
    "repo delete",
]);

function pushArtifact(command: SimpleCommand): string | undefined {
    const words = positionalWords(command);
    if (["docker", "podman", "buildah"].includes(command.name) && words[0] === "push") {
        return `${command.name} push`;
    }
    const pair = words.slice(0, 2).join(" ");
    if (command.name === "gh" && words.length >= 2 && GH_DESTRUCTIVE.has(pair)) return `gh ${pair}`;
    return undefined;
}

// --------------------------------------------------------------------------- #
// Bulk deletion that is not `rm -rf`
// --------------------------------------------------------------------------- #

// find primaries that consume the next word (so `-name -delete` is a pattern).
const FIND_ARITY_ONE: ReadonlySet<string> = new Set([
    "-amin",
    "-anewer",
    "-atime",
    "-Bmin",
    "-Bnewer",
    "-Btime",
    "-cmin",
    "-cnewer",
    "-context",
    "-ctime",
    "-flags",
    "-fls",
    "-fprint",
    "-fprint0",
    "-fstype",
    "-gid",
    "-group",
    "-ilname",
    "-iname",
    "-inum",
    "-ipath",
    "-iregex",
    "-iwholename",
    "-links",
    "-lname",
    "-maxdepth",
    "-mindepth",
    "-mmin",
    "-mnewer",
    "-mtime",
    "-name",
    "-newer",
    "-path",
    "-perm",
    "-printf",
    "-regex",
    "-regextype",
    "-samefile",
    "-size",
    "-type",
    "-uid",
    "-used",
    "-user",
    "-wholename",
    "-xattrname",
    "-xtype",
    "-files0-from",
]);
const FIND_EXEC: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const TEMP_ROOTS = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp", "/var/folders"];

/** True when `-delete` is a find action, not an argument of another primary. */
function findDeletes(args: readonly string[]): boolean {
    let index = 0;
    while (index < args.length) {
        const arg = args[index] as string;
        if (FIND_EXEC.has(arg)) {
            while (index < args.length && args[index] !== ";" && args[index] !== "+") index += 1;
        } else if (arg === "-fprintf") {
            index += 2;
        } else if (FIND_ARITY_ONE.has(arg) || arg.startsWith("-newer")) {
            index += 1;
        } else if (arg === "-delete") {
            return true;
        }
        index += 1;
    }
    return false;
}

async function isTemp(path: string, cwd: string, host: Host): Promise<boolean> {
    // A shell spelling of TMPDIR, not a template
    if (path.startsWith("$TMPDIR") || path.startsWith("${TMPDIR}")) return true;
    const resolved = await host.realPath(expand(path, cwd, host.home));
    for (const root of TEMP_ROOTS) {
        const real = await host.realPath(root);
        if (isInside(resolved, real) && resolved !== real) return true;
    }
    return false;
}

function findStartingPoints(args: readonly string[]): string[] {
    const points: string[] = [];
    for (const arg of args) {
        if (/^[-(!)]/.test(arg)) break;
        points.push(arg);
    }
    return points.length > 0 ? points : ["."];
}

async function findDelete(command: SimpleCommand, ctx: RuleContext): Promise<string | undefined> {
    if ((command.name !== "find" && command.name !== "gfind") || !findDeletes(command.args)) return undefined;
    const points = findStartingPoints(command.args);
    const follows = command.args.some((a) => a === "-L" || a === "-follow" || a === "-H");
    const outside: string[] = [];
    for (const point of points) {
        if (
            isBroadTarget(point, ctx.cwd, ctx.host.home) ||
            !(
                isInside(expand(point, ctx.cwd, ctx.host.home), ctx.cwd) ||
                (await isTemp(point, ctx.cwd, ctx.host))
            )
        ) {
            outside.push(point);
        }
    }
    if (outside.length > 0 || follows)
        return `find ${points.join(" ")} -delete (outside the working directory)`;
    return undefined;
}

function findDeleteLocal(command: SimpleCommand): string | undefined {
    if ((command.name === "find" || command.name === "gfind") && findDeletes(command.args)) {
        return `find ${findStartingPoints(command.args).join(" ")} -delete`;
    }
    return undefined;
}

function shred(command: SimpleCommand): string | undefined {
    if ((command.name === "shred" || command.name === "srm") && operands(command.args).length > 0) {
        return command.name;
    }
    if (command.name === "mv" && operands(command.args).at(-1) === "/dev/null") return "mv ... /dev/null";
    return undefined;
}

// --------------------------------------------------------------------------- #
// System state and security controls
// --------------------------------------------------------------------------- #

function power(command: SimpleCommand): string | undefined {
    if (["shutdown", "reboot", "halt", "poweroff"].includes(command.name)) return command.name;
    const first = operands(command.args)[0];
    if ((command.name === "init" || command.name === "telinit") && (first === "0" || first === "6")) {
        return `${command.name} ${command.args[0]}`;
    }
    if (
        command.name === "systemctl" &&
        command.args.some((a) => ["poweroff", "reboot", "halt", "kexec"].includes(a))
    ) {
        return "systemctl poweroff/reboot";
    }
    return undefined;
}

/**
 * PIDs passed to kill. `kill [-s SIG | -n NUM | -SIG] pid...`: only the first
 * dash word is a signal, so in `kill -9 -1` the `-1` is the PID for everything.
 */
function killTargets(args: readonly string[]): string[] {
    let index = 0;
    const first = args[0];
    if (first !== undefined && ["-l", "-L", "--list"].includes(first)) return [];
    if (first !== undefined && ["-s", "-n", "--signal"].includes(first)) index = 2;
    else if (first?.startsWith("-") && first !== "--") index = 1;
    if (index < args.length && args[index] === "--") index += 1;
    return args.slice(index);
}

function killEverything(command: SimpleCommand): string | undefined {
    if (command.name === "kill" && killTargets(command.args).some((pid) => pid === "-1" || pid === "1")) {
        return "kill -1 / kill 1 (every process / init)";
    }
    if (command.name === "killall5") return command.name;
    return undefined;
}

const SECURITY_OFF: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["csrutil", ["disable"]],
    ["spctl", ["--master-disable", "--global-disable", "--disable"]],
    ["setenforce", ["0", "Permissive", "permissive"]],
    ["ufw", ["disable"]],
    ["pfctl", ["-d"]],
];
const SECURITY_SERVICES =
    /^(?:firewalld|ufw|apparmor|auditd|selinux|fail2ban|clamav\S*|com\.apple\.(?:alf|security)\S*)$/;
const STOP_VERBS: ReadonlySet<string> = new Set(["stop", "disable", "mask", "unload", "bootout"]);

function removeSuffix(text: string, suffix: string): string {
    return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

function weakenSecurity(command: SimpleCommand): string | undefined {
    for (const [name, args] of SECURITY_OFF) {
        if (command.name === name && command.args.some((a) => args.includes(a))) {
            return `${name} ${command.args.filter((a) => args.includes(a)).join(" ")}`;
        }
    }
    if (
        (command.name === "iptables" || command.name === "ip6tables") &&
        (shortFlag(command.args, "F") ||
            longFlag(command.args, "--flush") ||
            (has(command.args, "-P", "--policy") && command.args.includes("ACCEPT")))
    ) {
        return `${command.name} flush/accept-all`;
    }
    if (command.name === "nft" && has(command.args, "flush") && has(command.args, "ruleset")) {
        return "nft flush ruleset";
    }
    const verb = positionalWords(command)[0];
    const stops = verb !== undefined && STOP_VERBS.has(verb);
    if (
        (command.name === "systemctl" || command.name === "launchctl") &&
        stops &&
        command.args
            .slice(1)
            .some((a) =>
                SECURITY_SERVICES.test(removeSuffix(removeSuffix(basename(a), ".service"), ".plist")),
            )
    ) {
        return `${command.name} ${verb} (security service)`;
    }
    if (command.name === "defaults" && command.args.includes("LSQuarantine"))
        return "defaults write LSQuarantine";
    if (
        ["npm", "pnpm", "yarn"].includes(command.name) &&
        has(command.args, "strict-ssl") &&
        has(command.args, "false")
    ) {
        return `${command.name} config strict-ssl false`;
    }
    if (
        (command.name === "pip" || command.name === "pip3") &&
        command.args.some((a) => a.includes("trusted-host")) &&
        has(command.args, "config")
    ) {
        return "pip config trusted-host";
    }
    return undefined;
}

const HISTORY_FILES: ReadonlySet<string> = new Set([
    ".bash_history",
    ".zsh_history",
    ".zhistory",
    ".python_history",
]);

function clearHistory(command: SimpleCommand): string | undefined {
    if (command.name === "history" && shortFlag(command.args, "cw")) return "history -c";
    if (command.name === "unset" && has(command.args, "HISTFILE")) return "unset HISTFILE";
    if (
        ["rm", "shred", "truncate"].includes(command.name) &&
        command.args.some((a) => HISTORY_FILES.has(basename(a)))
    ) {
        return `${command.name} shell history`;
    }
    return undefined;
}

function forkBomb(command: SimpleCommand, ctx: RuleContext): string | undefined {
    // A fork bomb is a function definition; look at the source text it came from.
    if (command.name === ":" && command.stage === 1) {
        const source = ctx.parsed.previousStage(command);
        if (source !== undefined && source.name === ":") return "fork bomb";
    }
    return undefined;
}

const DISK_HINT =
    "This can destroy a whole disk or filesystem. Never run it from an agent; describe it to the user.";
const FETCH_HINT =
    "Do not pipe downloaded code into a shell or interpreter. Download to a file, show the user " +
    "what it does (or its checksum and source), and let them run it.";
const PERSIST_HINT =
    "This makes code run later or on a schedule. Describe the change and let the user make it.";
const PUBLISH_HINT =
    "Publishing is public and often irreversible. Run with --dry-run and let the user publish.";

export const SYSTEM_RULES: readonly DangerRule[] = [
    dangerRule("device-write", CRITICAL, "writes directly to a block device", DISK_HINT, deviceWrite),
    dangerRule("disk-format", CRITICAL, "formats, partitions or wipes a disk", DISK_HINT, diskFormat),
    dangerRule(
        "fetch-and-execute",
        CRITICAL,
        "runs code downloaded from the network",
        FETCH_HINT,
        fetchAndExecute,
    ),
    dangerRule(
        "run-downloaded",
        CRITICAL,
        "runs a file downloaded earlier in the same command",
        FETCH_HINT,
        runDownloaded,
    ),
    dangerRule(
        "uninspected-program",
        HIGH,
        "runs program text the guards could not read",
        "Confirm with the user, or run the steps it needs directly so they can be checked.",
        uninspectedProgram,
        "ask",
    ),
    dangerRule(
        "incomplete-analysis",
        HIGH,
        "could not be analysed completely",
        "Simplify the command (fewer nested shells, wrappers or expansions) so it can be checked, " +
            "or confirm with the user.",
        incompleteAnalysis,
        "ask",
    ),
    dangerRule("decode-and-execute", CRITICAL, "decodes and runs hidden code", FETCH_HINT, decodeAndExecute),
    dangerRule("fork-bomb", CRITICAL, "exhausts process limits", DISK_HINT, forkBomb),
    dangerRule(
        "chmod-dangerous",
        HIGH,
        "makes files world-writable, setuid, or re-permissions a broad tree",
        "Grant the narrowest permission that works (e.g. `chmod u+x script.sh`).",
        chmodDangerous,
    ),
    dangerRule(
        "chown-broad",
        HIGH,
        "changes ownership of a system or home tree",
        "Change ownership of the specific files that need it.",
        chownBroad,
    ),
    dangerRule(
        "crontab-remove",
        HIGH,
        "crontab -r deletes every scheduled job without confirmation",
        "Use `crontab -l` to show the table and let the user edit it.",
        crontabRemove,
        "ask",
    ),
    dangerRule(
        "crontab-install",
        HIGH,
        "installing a crontab schedules code to run later",
        PERSIST_HINT,
        crontabInstall,
    ),
    dangerRule("publish-package", HIGH, "publishes or unpublishes a package", PUBLISH_HINT, publish),
    dangerRule(
        "find-delete-outside",
        HIGH,
        "find -delete outside the working directory or following symlinks",
        "Run with -print first and let the user delete.",
        findDelete,
        "ask",
    ),
    dangerRule(
        "shred",
        HIGH,
        "irrecoverably destroys file contents",
        "Use plain `rm` for files the task owns; let the user shred anything else.",
        shred,
        "ask",
    ),
    dangerRule("power-state", HIGH, "shuts down or reboots the machine", "Ask the user to do this.", power),
    dangerRule(
        "kill-everything",
        HIGH,
        "signals every process or init",
        "Kill specific PIDs.",
        killEverything,
    ),
    dangerRule(
        "weaken-security",
        HIGH,
        "disables a security control (SIP, Gatekeeper, SELinux, firewall, TLS checks)",
        "Do not switch off security controls; fix the underlying problem or ask the user.",
        weakenSecurity,
    ),
    // Common and often legitimate: confirm rather than block.
    dangerRule(
        "chmod-world-writable",
        HIGH,
        "makes a file world-writable",
        "Prefer `chmod u+w` or `chmod g+w`.",
        chmodWorldSingle,
        "ask",
    ),
    dangerRule(
        "schedule-job",
        HIGH,
        "schedules or enables something that runs later",
        PERSIST_HINT,
        schedule,
        "ask",
    ),
    dangerRule(
        "push-artifact",
        HIGH,
        "pushes an image or release, or deletes a repository",
        PUBLISH_HINT,
        pushArtifact,
        "ask",
    ),
    dangerRule(
        "find-delete",
        HIGH,
        "find -delete removes every match with no undo",
        "Run the same find with -print first and show the user.",
        findDeleteLocal,
        "ask",
    ),
    dangerRule(
        "clear-history",
        HIGH,
        "erases shell history (covers tracks)",
        "Leave shell history alone.",
        clearHistory,
        "ask",
    ),
];
