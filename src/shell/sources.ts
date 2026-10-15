/**
 * Program text a command executes from disk, for shell_parse.parse(sources=...).
 *
 * Writing `rm -rf ~` into `cleanup.sh` and then running `./cleanup.sh` used to
 * pass every guard: the hooks only ever saw the second command. This resolver
 * reads what such a command would run, so the guards judge the body instead of
 * the file name:
 *
 *   ./script.sh, bash script.sh, source/. script.sh
 *       the file, when it is a small text file with a shell shebang (or no
 *       shebang and a shell extension)
 *   npm/pnpm/yarn/bun run NAME, npm test/start/...
 *       package.json scripts[NAME] plus its pre/post hooks
 *   make [TARGET...]
 *       the recipe lines of those targets (or the default target) and, one
 *       level down, their prerequisites, with Make variables expanded; plus the
 *       commands Make itself runs while reading the Makefile (`$(shell …)`,
 *       `VAR != …`) and the files `$(file >PATH,…)` writes, see make-expand.ts
 *   git ALIAS ...
 *       what the alias expands to in the repository, global or system config:
 *       the shell command of a `!` alias, or the git command line otherwise
 *       (git-aliases.ts, plugged in through `createSourceResolver`)
 *
 * Everything returned is marked `indirect` by the parser: the agent did not
 * type it in this call, and the file may predate the session, so guards
 * generally ask about it rather than deny. Reading never raises; anything that
 * cannot be read cleanly is skipped.
 *
 * Ported from shell_sources.py. Every read goes through the host, so the
 * resolver is asynchronous (see `SourceResolver` in model.ts).
 */

import type { Host } from "../host/host.ts";
import { basename, dirname, expanduser, isAbsolute, join, normpath } from "../util/paths.ts";
import { splitWhitespace } from "../util/text.ts";
import { globPaths } from "./glob.ts";
import { expand, parseTimeCommands, parseTimeWrites, type VariableTable, variables } from "./make-expand.ts";
import {
    type SimpleCommand,
    SOURCE_TOO_LARGE,
    type SourceResolver,
    type SourceText,
    type WrittenFiles,
} from "./model.ts";
import { CLI_OPTIONS_WITH_VALUE, SHELLS, shellInvocation, sourceArguments } from "./wrappers.ts";

export const MAX_SOURCE_BYTES = 256 * 1024;
/**
 * How far into a file the shebang probe reads. Python read the first 512 bytes
 * of any file; the host reads whole files, so an executable larger than this
 * is judged by its extension alone.
 */
export const MAX_SHEBANG_PROBE_BYTES = 4 * 1024 * 1024;
const SHEBANG_SHELL = /^#!\s*\S*?(?:\/env\s+(?:-S\s+)?)?\S*?\b(?:ba|z|da|k|mk|a)?sh\b/;
const SHELL_SUFFIXES = [".sh", ".bash", ".zsh", ".ksh"];
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
const NPM_LIFECYCLE: ReadonlySet<string> = new Set(["test", "start", "stop", "restart"]);
const MAKE_OPTIONS_WITH_ARG: ReadonlySet<string> = new Set([
    "-C",
    "--directory",
    "-f",
    "--file",
    "--makefile",
    "-I",
    "-E",
    "--eval",
    "--include-dir",
    "-o",
    "--old-file",
    "-W",
    "--what-if",
    "-l",
    "--load-average",
]);
const MAKEFILE_NAMES = ["GNUmakefile", "makefile", "Makefile"];
const MAKE_RULE = /^([^\s:#=][^:=]*?)\s*::?(?!=)\s*(.*)$/;
export const MAX_MAKE_TARGETS = 256;

/** What a `git ALIAS` command runs; supplied by the guards wave (git-aliases.ts). */
export type GitAliasResolver = (command: SimpleCommand, host: Host) => Promise<SourceText[]>;

export interface SourceResolverOptions {
    readonly gitAliases?: GitAliasResolver;
}

/**
 * A `SourceResolver` that reads scripts, package.json scripts and Makefiles
 * through the host, and `git` aliases through `gitAliases` when given (the
 * Python module imported git_aliases lazily; without it `git` resolves to []).
 */
export function createSourceResolver(options: SourceResolverOptions = {}): SourceResolver {
    const gitAliases = options.gitAliases ?? (async () => []);
    /**
     * (program text, label) pairs that `command` would execute from disk.
     *
     * `written` holds files the same command line wrote from literal text
     * before running them; they are used in place of what is on disk.
     */
    return async (command, cwd, written, host) => {
        try {
            return await resolveSources(command, cwd, written ?? new Map(), host, gitAliases);
        } catch {
            return []; // Python caught OSError, ValueError (bad JSON) and RecursionError
        }
    };
}

/** The default resolver: `git` aliases are not resolved until the guards wave plugs them in. */
export const resolve: SourceResolver = createSourceResolver();

async function resolveSources(
    command: SimpleCommand,
    cwd: string,
    written: WrittenFiles,
    host: Host,
    gitAliases: GitAliasResolver,
): Promise<SourceText[]> {
    if (command.argv.length === 0 || command.dynamicHead) return [];
    const name = command.name;
    let args = [...command.args];
    const head = command.argv[0] as string;

    if (SHELLS.has(name)) {
        const shell = shellInvocation(name, args);
        if (shell.syntaxOnly || shell.script === undefined) {
            return []; // command strings and stdin are parsed by the parser itself
        }
        return script(shell.script, cwd, written, false, host);
    }
    if (name === "source" || name === ".") {
        args = [...sourceArguments(command.args)];
        if (args.length === 0) return [];
        // Each PATH the line may have gives the file `source` may read.
        const found: SourceText[] = [];
        for (const path of await sourcePaths(args[0] as string, command, cwd, written, host)) {
            found.push(...(await script(path, cwd, written, false, host)));
        }
        return found;
    }
    if (head.includes("/")) return script(head, cwd, written, true, host);
    if (PACKAGE_RUNNERS.has(name)) return packageScript(name, args, cwd, written, host);
    if (name === "make" || name === "gmake") return make(args, cwd, written, host);
    if (name === "git") return gitAliases(command, host);
    return [];
}

/**
 * The files `source NAME` may read, one per value PATH may hold: a NAME
 * without a slash is looked up in PATH first (bash's default), then in the
 * current directory.
 */
async function sourcePaths(
    operand: string,
    command: SimpleCommand,
    cwd: string,
    written: WrittenFiles,
    host: Host,
): Promise<string[]> {
    if (operand.includes("/")) return [operand];
    const envValues = command.envValues("PATH");
    const pathValues = envValues.length > 0 ? envValues : [host.env("PATH") ?? ""];
    const found: string[] = [];
    for (const value of pathValues) found.push(await sourcePath(operand, value, cwd, written, host));
    return [...new Set(found)];
}

/** The file `source NAME` reads when PATH is `pathValue`. */
async function sourcePath(
    operand: string,
    pathValue: string,
    cwd: string,
    written: WrittenFiles,
    host: Host,
): Promise<string> {
    for (const directory of pathValue.split(":")) {
        const candidate = join(expanduser(directory || ".", host.home), operand);
        const absolute = normpath(join(cwd, candidate));
        if (written.has(absolute) || (await host.stat(absolute))?.kind === "file") return absolute;
    }
    return operand;
}

// --------------------------------------------------------------------------- #
// Shell scripts
// --------------------------------------------------------------------------- #

async function isFile(path: string, host: Host): Promise<boolean> {
    return (await host.stat(path))?.kind === "file";
}

async function tooLarge(path: string, host: Host): Promise<boolean> {
    const stat = await host.stat(path);
    return stat?.kind === "file" && stat.size > MAX_SOURCE_BYTES;
}

async function firstLine(path: string, host: Host): Promise<string> {
    const text = await host.readText(path, MAX_SHEBANG_PROBE_BYTES);
    if (text === undefined) return "";
    return text.slice(0, 512).split("\n", 1)[0] as string;
}

async function readText(path: string, host: Host): Promise<string | undefined> {
    const stat = await host.stat(path);
    if (stat?.kind !== "file" || stat.size > MAX_SOURCE_BYTES) return undefined;
    // bash runs a script with stray non-UTF-8 bytes; read it the same way (the
    // host decodes with replacement characters). A NUL byte marks a binary.
    const text = await host.readText(path, MAX_SOURCE_BYTES);
    if (text === undefined || text.includes("\0")) return undefined;
    return text;
}

function absolute(path: string, cwd: string, host: Host): string {
    const expanded = expanduser(path, host.home);
    return normpath(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}

async function script(
    path: string,
    cwd: string,
    written: WrittenFiles,
    requireShebang: boolean,
    host: Host,
): Promise<SourceText[]> {
    const target = absolute(path, cwd, host);
    const entry = written.get(target);
    if (entry !== undefined) {
        // Written by this same command line: its author is the agent, right now.
        // Appended text runs after whatever the file already held.
        const found: SourceText[] = [[entry.text, `written ${path}`]];
        if (!entry.replaces) {
            if (await tooLarge(target, host)) {
                found.unshift([SOURCE_TOO_LARGE, `script ${path}`]);
            } else {
                const onDisk = await readText(target, host);
                if (onDisk) found.unshift([onDisk, `script ${path}`]);
            }
        }
        return found;
    }
    if (requireShebang) {
        const line = await firstLine(target, host);
        const hasShebang = line.startsWith("#!");
        const isShell = hasShebang
            ? SHEBANG_SHELL.test(line)
            : SHELL_SUFFIXES.some((suffix) => path.endsWith(suffix));
        if (!isShell) return [];
    }
    if (await tooLarge(target, host)) {
        return [[SOURCE_TOO_LARGE, `script ${path}`]]; // the caller asks instead of guessing
    }
    const text = await readText(target, host);
    if (text === undefined) {
        // A file a shell runs that cannot be read as text: ask rather than guess.
        return (await isFile(target, host)) ? [[SOURCE_TOO_LARGE, `script ${path}`]] : [];
    }
    return [[text, `script ${path}`]];
}

// --------------------------------------------------------------------------- #
// package.json scripts
// --------------------------------------------------------------------------- #

/** Positional words, skipping option values (`npm -w web run build`). */
function operands(args: readonly string[], withValue: ReadonlySet<string>): string[] {
    const words: string[] = [];
    let index = 0;
    while (index < args.length) {
        const arg = args[index] as string;
        if (arg === "--") break; // arguments for the script itself
        if (!arg.startsWith("-")) words.push(arg);
        else if (withValue.has(arg)) index += 1;
        index += 1;
    }
    return words;
}

// Options naming the package directory to run in, and options selecting workspaces.
const PACKAGE_DIR_OPTIONS: ReadonlySet<string> = new Set(["--prefix", "-C", "--dir", "--cwd"]);
const WORKSPACE_OPTIONS: ReadonlySet<string> = new Set(["-w", "--workspace", "-F", "--filter"]);
const ALL_WORKSPACES: ReadonlySet<string> = new Set(["-ws", "--workspaces", "-r", "--recursive"]);

/** `os.path.relpath(path, start)` for two absolute, normalized paths. */
function relpath(path: string, start: string): string {
    const pathParts = normpath(path)
        .split("/")
        .filter((part) => part);
    const startParts = normpath(start)
        .split("/")
        .filter((part) => part);
    let common = 0;
    while (
        common < pathParts.length &&
        common < startParts.length &&
        pathParts[common] === startParts[common]
    ) {
        common += 1;
    }
    const parts = [...Array<string>(startParts.length - common).fill(".."), ...pathParts.slice(common)];
    return parts.length === 0 ? "." : parts.join("/");
}

/**
 * package.json scripts a package-manager command runs, in the package it selects.
 *
 * `npm -w app run clean`, `pnpm --filter app clean` and `yarn workspace app clean`
 * run app/package.json's script, not the root's; `npm --prefix dir run x` and
 * `pnpm -C dir x` run dir's. An unresolvable workspace selector is checked
 * against every workspace package.
 */
async function packageScript(
    runner: string,
    args: readonly string[],
    cwd: string,
    written: WrittenFiles,
    host: Host,
): Promise<SourceText[]> {
    let positionals = operands(args, CLI_OPTIONS_WITH_VALUE.get(runner) ?? new Set<string>());
    const selectors = optionValues(args, WORKSPACE_OPTIONS);
    if (runner === "yarn" && positionals[0] === "workspace" && positionals.length > 1) {
        selectors.push(positionals[1] as string);
        positionals = positionals.slice(2);
    } else if (runner === "yarn" && positionals[0] === "workspaces" && positionals[1] === "foreach") {
        positionals = positionals.slice(2);
        selectors.push("*");
    }
    const name = scriptName(runner, positionals);
    if (name === undefined) return [];

    const root = packageRoot(args, cwd, host);
    if (args.some((a) => ALL_WORKSPACES.has(a) || a.startsWith("--workspaces="))) selectors.push("*");
    const directories = selectors.length > 0 ? await selectWorkspaces(root, selectors, host) : [root];

    const found: SourceText[] = [];
    for (const directory of directories) {
        const [scripts, typed] = await packageScripts(directory, written, host);
        if (!scripts.has(name)) continue;
        const where = directory === root ? "" : ` in ${relpath(directory, root)}`;
        // A package.json this same line wrote: its scripts count as typed by the agent.
        const prefix = typed ? "written " : "";
        for (const hook of [`pre${name}`, name, `post${name}`]) {
            const body = scripts.get(hook);
            if (body !== undefined) found.push([body, `${prefix}${runner} script ${hook}${where}`]);
        }
    }
    return found;
}

function scriptName(runner: string, positionals: readonly string[]): string | undefined {
    if (positionals.length === 0) return undefined;
    const verb = positionals[0] as string;
    if (verb === "run" || verb === "run-script") return positionals.length > 1 ? positionals[1] : undefined;
    if (runner === "npm") return NPM_LIFECYCLE.has(verb) ? verb : undefined;
    return ["yarn", "bun", "pnpm"].includes(runner) ? verb : undefined; // `yarn build` runs a script
}

function optionValues(args: readonly string[], names: ReadonlySet<string>): string[] {
    const values: string[] = [];
    args.forEach((arg, index) => {
        const separator = arg.indexOf("=");
        const key = separator < 0 ? arg : arg.slice(0, separator);
        if (names.has(key) && separator >= 0) values.push(arg.slice(separator + 1));
        else if (names.has(arg) && index + 1 < args.length) values.push(args[index + 1] as string);
    });
    return values;
}

function packageRoot(args: readonly string[], cwd: string, host: Host): string {
    const chosen = optionValues(args, PACKAGE_DIR_OPTIONS);
    return chosen.length > 0 ? absolute(chosen[chosen.length - 1] as string, cwd, host) : cwd;
}

/** `json.loads(text) if text else {}`, narrowed to an object (anything else has no keys). */
async function packageData(directory: string, host: Host): Promise<Record<string, unknown>> {
    const text = await readText(join(directory, "package.json"), host);
    const data: unknown = text ? JSON.parse(text) : {};
    return isObject(data) ? data : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PNPM_WORKSPACE_ENTRY = /^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/gm;

/** Package directories listed by package.json `workspaces` or pnpm-workspace.yaml. */
async function workspaceDirs(root: string, host: Host): Promise<string[]> {
    const patterns: string[] = [];
    let declared: unknown = (await packageData(root, host)).workspaces;
    if (isObject(declared)) declared = declared.packages;
    if (Array.isArray(declared)) {
        patterns.push(...declared.filter((p): p is string => typeof p === "string"));
    }
    const pnpm = (await readText(join(root, "pnpm-workspace.yaml"), host)) ?? "";
    for (const match of pnpm.matchAll(PNPM_WORKSPACE_ENTRY)) patterns.push(match[1] as string);
    const found: string[] = [];
    for (const pattern of patterns) {
        if (pattern.startsWith("!")) continue;
        for (const path of (await globPaths(join(root, pattern), host)).sort()) {
            if ((await isFile(join(path, "package.json"), host)) && !found.includes(path)) {
                found.push(normpath(path));
            }
        }
    }
    return found;
}

async function packageName(directory: string, host: Host): Promise<string> {
    const name = (await packageData(directory, host)).name;
    return typeof name === "string" ? name : "";
}

/**
 * `fnmatch.fnmatch(name, pattern)`: `*`, `?` and `[seq]`/`[!seq]`, case-sensitive
 * as on POSIX, with an unclosed `[` taken literally.
 */
function fnmatch(name: string, pattern: string): boolean {
    let regex = "";
    let index = 0;
    while (index < pattern.length) {
        const char = pattern[index] as string;
        index += 1;
        if (char === "*") regex += ".*";
        else if (char === "?") regex += ".";
        else if (char === "[") {
            let end = index;
            if (end < pattern.length && pattern[end] === "!") end += 1;
            if (end < pattern.length && pattern[end] === "]") end += 1;
            while (end < pattern.length && pattern[end] !== "]") end += 1;
            if (end >= pattern.length) {
                regex += "\\[";
                continue;
            }
            let body = pattern.slice(index, end).replaceAll("\\", "\\\\");
            index = end + 1;
            if (body.startsWith("!")) body = `^${body.slice(1)}`;
            else if (body.startsWith("^")) body = `\\${body}`;
            regex += `[${body.replaceAll("[", "\\[")}]`;
        } else regex += char.replace(/[.*+?^${}()|[\]\\/]/, "\\$&");
    }
    return new RegExp(`^(?:${regex})$`, "s").test(name);
}

/** Workspace directories matching any selector by path, directory name or package name. */
async function selectWorkspaces(root: string, selectors: readonly string[], host: Host): Promise<string[]> {
    const candidates = await workspaceDirs(root, host);
    const chosen: string[] = [];
    for (const selector of selectors) {
        const target =
            selector === "." || selector === "./"
                ? ""
                : selector.replace(/^[{}]+|[{}]+$/g, "").replace(/^[./]+/, "");
        const direct = absolute(selector, root, host);
        if (await isFile(join(direct, "package.json"), host)) {
            chosen.push(direct);
            continue;
        }
        const matches: string[] = [];
        for (const d of candidates) {
            if (
                selector === "*" ||
                fnmatch(await packageName(d, host), target) ||
                fnmatch(relpath(d, root), target) ||
                fnmatch(basename(d), target)
            ) {
                matches.push(d);
            }
        }
        // Cannot tell which package is meant: judge every workspace, never none.
        chosen.push(...(matches.length > 0 ? matches : candidates));
    }
    const unique = [...new Set(chosen)];
    return unique.length > 0 ? unique : [root];
}

/** The `scripts` of cwd/package.json, and whether that file was written by this line. */
async function packageScripts(
    cwd: string,
    written: WrittenFiles,
    host: Host,
): Promise<readonly [Map<string, string>, boolean]> {
    const path = normpath(join(cwd, "package.json"));
    const entry = written.get(path);
    let text: string | undefined;
    if (entry !== undefined) {
        text = entry.replaces ? entry.text : ((await readText(path, host)) ?? "") + entry.text;
    } else {
        text = await readText(path, host);
    }
    if (text === undefined) return [new Map(), false];
    const data: unknown = JSON.parse(text); // malformed JSON throws, and the resolver answers []
    const scripts = isObject(data) ? data.scripts : undefined;
    if (!isObject(scripts)) return [new Map(), entry !== undefined];
    const found = new Map<string, string>();
    for (const [key, value] of Object.entries(scripts)) {
        if (typeof value === "string") found.set(key, value);
    }
    return [found, entry !== undefined];
}

// --------------------------------------------------------------------------- #
// Makefile recipes
// --------------------------------------------------------------------------- #

/** target -> (prerequisites, recipe lines) */
type MakeRules = Map<string, readonly [string[], string[]]>;

async function make(
    args: readonly string[],
    cwd: string,
    written: WrittenFiles,
    host: Host,
): Promise<SourceText[]> {
    let directory = cwd;
    let makefile: string | undefined;
    const targets: string[] = [];
    const evaluated: string[] = [];
    let index = 0;
    while (index < args.length) {
        const [arg, value, step] = makeOption(args, index);
        if (arg === "-E" || arg === "--eval") {
            // `make --eval='x:; cmd' x`: a makefile statement typed in the command.
            evaluated.push(value);
            index += step;
        } else if (arg === "-C" || arg === "--directory") {
            directory = absolute(value, directory, host);
            index += step;
        } else if (arg === "-f" || arg === "--file" || arg === "--makefile") {
            makefile = value;
            index += step;
        } else if (MAKE_OPTIONS_WITH_ARG.has(arg)) {
            index += step;
        } else if (arg.startsWith("-") || arg.includes("=")) {
            index += 1;
        } else {
            targets.push(arg);
            index += 1;
        }
    }

    let path: string | undefined;
    if (makefile) {
        path = absolute(makefile, directory, host);
    } else {
        for (const candidate of MAKEFILE_NAMES.map((n) => join(directory, n))) {
            if (written.has(candidate) || (await isFile(candidate, host))) {
                path = candidate;
                break;
            }
        }
    }
    let text: string;
    let typed: boolean;
    const entry = path !== undefined ? written.get(path) : undefined;
    if (path !== undefined && entry !== undefined) {
        // A Makefile this same command line wrote: make reads the new text, and
        // its recipes count as typed by the agent.
        const onDisk = entry.replaces ? "" : ((await readText(path, host)) ?? "");
        text = onDisk + entry.text;
        typed = true;
    } else if (path && (await tooLarge(path, host))) {
        return [[SOURCE_TOO_LARGE, `make ${path}`]];
    } else {
        text = (path ? await readText(path, host) : undefined) ?? "";
        typed = false;
    }
    const statements = evaluated.join("\n");
    const makefileText = `${text}\n${statements}`;
    const [rules, defaultTarget] = makeRules(makefileText);
    const typedTargets = new Set(statements ? makeRules(statements)[0].keys() : []);
    const wanted = targets.length > 0 ? targets : defaultTarget ? [defaultTarget] : [];
    const table = variables(makefileText);
    const found: SourceText[] = makeRecipes(rules, wanted, table).map(([recipe, label]) => [
        recipe,
        typed || typedTargets.has(label.split(" ").slice(1).join(" ")) ? `written ${label}` : label,
    ]);
    // Make runs these before any recipe, whichever targets were asked for.
    const parseTime = parseTimeCommands(makefileText);
    const typedParseTime = new Set(statements ? parseTimeCommands(statements) : []);
    for (const command of parseTime) {
        found.push([command, `${typed || typedParseTime.has(command) ? "written " : ""}make $(shell)`]);
    }
    // `$(file >PATH,…)` writes PATH with no shell; surfaced as the equivalent redirect.
    const typedWrites = new Set(statements ? parseTimeWrites(statements) : []);
    for (const write of parseTimeWrites(makefileText)) {
        found.push([write, `${typed || typedWrites.has(write) ? "written " : ""}make $(file)`]);
    }
    return found;
}

/** (option name, value, words consumed) for `-C dir`, `-Cdir`, `--directory=dir`. */
function makeOption(args: readonly string[], index: number): readonly [string, string, number] {
    const arg = args[index] as string;
    const following = index + 1 < args.length ? (args[index + 1] as string) : "";
    if (arg.startsWith("--") && arg.includes("=")) {
        const separator = arg.indexOf("=");
        return [arg.slice(0, separator), arg.slice(separator + 1), 1];
    }
    if (!arg.startsWith("--") && arg.length > 2 && MAKE_OPTIONS_WITH_ARG.has(arg.slice(0, 2))) {
        return [arg.slice(0, 2), arg.slice(2), 1];
    }
    return [arg, following, 2];
}

/** target -> (prerequisites, recipe lines), plus the default target. */
function makeRules(text: string): readonly [MakeRules, string | undefined] {
    const rules: MakeRules = new Map();
    let defaultTarget: string | undefined;
    let current: string[] = [];
    for (const raw of text.replaceAll("\\\n", " ").split("\n")) {
        if (raw.startsWith("\t")) {
            const line = raw.slice(1).replace(/^[@\-+ \t]+/, "");
            for (const target of current) (rules.get(target) as readonly [string[], string[]])[1].push(line);
            continue;
        }
        if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
        const match = MAKE_RULE.exec(raw);
        if (!match) {
            current = [];
            continue;
        }
        const names = splitWhitespace(match[1] as string);
        const prerequisites = (match[2] as string).split(";");
        const [requirements, ...recipeParts] = prerequisites as [string, ...string[]];
        const inlineRecipe = recipeParts.join(";");
        current = names.filter((name) => !name.includes("%"));
        for (const name of current) {
            let rule = rules.get(name);
            if (rule === undefined) {
                rule = [[], []];
                rules.set(name, rule);
            }
            rule[0].push(...splitWhitespace(requirements));
            if (recipeParts.length > 0 && inlineRecipe.trim()) rule[1].push(inlineRecipe.trim());
            if (defaultTarget === undefined && !name.startsWith(".")) defaultTarget = name;
        }
    }
    return [rules, defaultTarget];
}

function makeRecipes(rules: MakeRules, wanted: readonly string[], table: VariableTable): SourceText[] {
    const found: SourceText[] = [];
    const seen = new Set<string>();
    const queue = [...wanted];
    while (queue.length > 0) {
        if (seen.size >= MAX_MAKE_TARGETS) {
            found.push([SOURCE_TOO_LARGE, `make: more than ${MAX_MAKE_TARGETS} targets`]);
            break;
        }
        const target = queue.shift() as string;
        const rule = rules.get(target);
        if (seen.has(target) || rule === undefined) continue;
        seen.add(target);
        const [prerequisites, recipe] = rule;
        if (recipe.length > 0) {
            const expanded = expand(recipe.join("\n"), table);
            found.push([automaticVariables(expanded, target, prerequisites), `make ${target}`]);
        }
        queue.push(...prerequisites.filter((p) => p !== "|"));
    }
    return found;
}

const AUTOMATIC = /\$\$|\$\(([@<^+])([DF]?)\)|\$\{([@<^+])([DF]?)\}|\$([@<^+])/g;

/**
 * The recipe as Make hands it to the shell: `$@` is the target, `$<` the first
 * prerequisite, `$^` and `$+` all of them, with `D`/`F` forms; `$$` is a `$`.
 * `$*` and `$?` depend on pattern stems and timestamps and stay as written.
 */
function automaticVariables(recipe: string, target: string, prerequisites: readonly string[]): string {
    const bar = prerequisites.indexOf("|");
    const normal = bar >= 0 ? prerequisites.slice(0, bar) : prerequisites;
    const values: Readonly<Record<string, readonly string[]>> = {
        "@": [target],
        "<": normal.slice(0, 1),
        "^": [...new Set(normal)],
        "+": normal,
    };
    return recipe.replace(
        AUTOMATIC,
        (whole, p1?: string, p2?: string, p3?: string, p4?: string, p5?: string) => {
            if (whole === "$$") return "$";
            const name = (p1 || p3 || p5) as string;
            const part = p2 || p4 || "";
            let words = values[name] as readonly string[];
            if (part === "D") words = words.map((word) => dirname(word) || ".");
            else if (part === "F") words = words.map((word) => basename(word));
            return words.join(" ");
        },
    );
}
