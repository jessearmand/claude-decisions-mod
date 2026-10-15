/**
 * Unwrapping: from `sudo -u x env A=b timeout 5 nice rm ...` to the program
 * that runs, through prefix wrappers, `env -S`/`-C`, subcommand runners
 * (`npm exec`, `uv run`, `mise exec -c`), `xargs` with a known feeder,
 * `find -exec` and `parallel`. Part of shell_parse.
 *
 * Ported from shell_unwrap.py.
 */

import { unique } from "../util/paths.ts";
import { isDigit, splitWhitespace } from "../util/text.ts";
import { changeDirectory } from "./effects.ts";
import { echoedText, MAX_BRACE_WORDS } from "./expand.ts";
import type { Context, SimpleCommand } from "./model.ts";
import { parseInto } from "./parse.ts";
import {
    CLI_OPTIONS_WITH_VALUE,
    PREFIX_WRAPPERS,
    SUBCOMMAND_RUNNERS,
    type WrapperSpec,
    wrapperSpec,
} from "./wrappers.ts";

const FIND_EXEC: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** `(inner argv or null, label, directory it switches to)`: one unwrapping step. */
export type UnwrapStep = readonly [inner: string[] | null, label: string, chdir: string | null];

/**
 * One unwrapping step: (inner argv or null, label, directory it switches to).
 *
 * undefined: not a wrapper. Inner null: the wrapper runs nothing further here.
 */
export async function unwrapOnce(
    name: string,
    argv: readonly string[],
    ctx: Context,
    via: readonly string[],
    depth: number,
    indirect: boolean,
): Promise<UnwrapStep | undefined> {
    // re-entry: parsed as a command list
    const args = argv.slice(1);
    if (name === "env") {
        return unwrapEnv(args, ctx, via, depth, indirect);
    }
    const spec = PREFIX_WRAPPERS.get(name);
    if (spec !== undefined) {
        const chdir = optionValue(args, spec.chdirOptions) ?? null;
        const command = optionValue(args, spec.commandOptions);
        if (command !== undefined) {
            await parseInto(command, ctx, [...via, `${name} -c`], depth + 1, indirect);
            return [null, name, chdir];
        }
        const inner = skipOptions(args, spec);
        return [inner !== undefined && inner.length > 0 ? inner : null, name, chdir];
    }
    if (name === "find") {
        return undefined;
    }
    const runner = SUBCOMMAND_RUNNERS.get(name);
    if (runner !== undefined) {
        const command = runnerCommandString(args, name);
        if (command !== undefined) {
            // `npm exec -c 'CMD'`, `mise exec -c 'CMD'`: a string a shell runs.
            const [sub, value] = command;
            await parseInto(value, ctx, [...via, `${name} ${sub} -c`], depth + 1, indirect);
            return [null, `${name} ${sub}`, null];
        }
        const found = skipSubcommandRunner(args, name);
        if (found === undefined) {
            return undefined;
        }
        const chdir = optionValue(args.slice(0, args.length - found[1].length), runner.chdirOptions) ?? null;
        return [found[1], `${name} ${found[0]}`, chdir];
    }
    return undefined;
}

async function unwrapEnv(
    args: readonly string[],
    ctx: Context,
    via: readonly string[],
    depth: number,
    indirect: boolean,
): Promise<UnwrapStep> {
    // re-entry: parsed as a command list
    const spec = PREFIX_WRAPPERS.get("env") as WrapperSpec;
    const chdir = optionValue(args, spec.chdirOptions) ?? null;
    let index = 0;
    while (index < args.length) {
        const arg = args[index] as string;
        const split = splitStringValue(args, index, ["-S", "--split-string"]);
        if (split !== undefined) {
            // `env -C dir -S "cmd"`: the split command runs in dir.
            const saved = [ctx.cwd, ctx.cwdOptions] as const;
            if (chdir !== null) {
                ctx.cwd = changeDirectory(ctx.cwd, chdir, ctx.host.home);
                ctx.cwdOptions = unique(ctx.cwdOptions.map((o) => changeDirectory(o, chdir, ctx.host.home)));
            }
            try {
                await parseInto(split, ctx, [...via, "env -S"], depth + 1, indirect);
            } finally {
                [ctx.cwd, ctx.cwdOptions] = saved;
            }
            return [null, "env", null];
        }
        if (arg === "--" || !arg.startsWith("-")) {
            break;
        }
        index += spec.withArg.has(arg) ? 2 : 1;
    }
    const inner = skipOptions(args, spec);
    return [inner !== undefined && inner.length > 0 ? inner : null, "env", chdir];
}

/**
 * The value of the first option in `names`, in any spelling: `-c X`, `-cX`,
 * `--command X`, `--command=X`. Stops at `--`.
 */
export function optionValue(args: readonly string[], names: ReadonlySet<string>): string | undefined {
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index] as string;
        if (arg === "--") {
            return undefined;
        }
        for (const name of names) {
            if (arg === name) {
                return index + 1 < args.length ? args[index + 1] : undefined;
            }
            if (name.startsWith("--") && arg.startsWith(`${name}=`)) {
                return arg.slice(arg.indexOf("=") + 1);
            }
            const shortAttached = name.length === 2 && !arg.startsWith("--") && arg.startsWith(name);
            if (shortAttached && arg.length > 2) {
                return arg.slice(2);
            }
        }
    }
    return undefined;
}

function splitStringValue(
    args: readonly string[],
    index: number,
    names: readonly string[],
): string | undefined {
    const arg = args[index] as string;
    for (const name of names) {
        if (arg === name) {
            return args.slice(index + 1).join(" ");
        }
        if (arg.startsWith(`${name}=`) || (name.length === 2 && arg.startsWith(name) && arg.length > 2)) {
            const first =
                arg.includes("=") && name.startsWith("--")
                    ? arg.slice(arg.indexOf("=") + 1)
                    : arg.slice(name.length);
            return [first, ...args.slice(index + 1)].join(" ");
        }
    }
    return undefined;
}

/** Skip a wrapper's options and own positionals. undefined if it runs nothing. */
export function skipOptions(args: readonly string[], spec: WrapperSpec): string[] | undefined {
    let index = 0;
    while (index < args.length) {
        const arg = args[index] as string;
        if (arg === "--") {
            index += 1;
            break;
        }
        if (!arg.startsWith("-") || arg === "-") {
            break;
        }
        if (spec.noExec.has(arg) || spec.noExec.has(arg.split("=", 1)[0] as string)) {
            return undefined;
        }
        if (arg.startsWith("--")) {
            index += arg.includes("=") ? 1 : spec.withArg.has(arg) ? 2 : 1;
            continue;
        }
        if (isDigit(arg.slice(1))) {
            // `nice -10`
            index += 1;
            continue;
        }
        if ([...arg.slice(1)].some((letter) => spec.noExec.has(`-${letter}`))) {
            return undefined;
        }
        if (spec.withArg.has(arg.slice(0, 2)) && arg.length > 2) {
            index += 1; // value attached: `-uroot`, `-oL`
        } else if (spec.withArg.has(`-${arg[arg.length - 1]}`)) {
            index += 2; // last letter of a cluster takes the next word: `-Eu root`
        } else {
            index += 1;
        }
    }
    index += spec.positionals;
    return index <= args.length ? args.slice(index) : [];
}

/** Where the runner's subcommand is, after any global options. */
function subcommandIndex(args: readonly string[], name: string): number | undefined {
    const runner = SUBCOMMAND_RUNNERS.get(name);
    if (runner === undefined) return undefined;
    const globalWithValue = new Set<string>([...runner.withArg, ...(CLI_OPTIONS_WITH_VALUE.get(name) ?? [])]);
    let index = 0;
    while (index < args.length && (args[index] as string).startsWith("-") && args[index] !== "--") {
        index += globalWithValue.has(args[index] as string) ? 2 : 1;
    }
    return index < args.length && runner.subcommands.has(args[index] as string) ? index : undefined;
}

/** (subcommand, command string) for `npm exec -c 'CMD'` and the like. */
function runnerCommandString(args: readonly string[], name: string): readonly [string, string] | undefined {
    const runner = SUBCOMMAND_RUNNERS.get(name);
    if (runner === undefined) return undefined;
    const options = runner.commandOptions;
    const index = options.size > 0 ? subcommandIndex(args, name) : undefined;
    if (index === undefined) {
        return undefined;
    }
    // Only the runner's own options, before the command it runs (`exec sh -c` is sh's -c).
    const own: string[] = [];
    const rest = args.slice(index + 1);
    let position = 0;
    while (position < rest.length && (rest[position] as string).startsWith("-") && rest[position] !== "--") {
        const takesValue =
            runner.withArg.has(rest[position] as string) || options.has(rest[position] as string);
        own.push(...rest.slice(position, position + (takesValue ? 2 : 1)));
        position += takesValue ? 2 : 1;
    }
    const value = optionValue(own, options);
    return value !== undefined ? [args[index] as string, value] : undefined;
}

/**
 * (subcommand, command it runs) for `uv [opts] run [opts] cmd...` and the like.
 *
 * Global options may come before the subcommand (`uv --directory . run ...`).
 */
function skipSubcommandRunner(
    args: readonly string[],
    name: string,
): readonly [string, string[]] | undefined {
    const runner = SUBCOMMAND_RUNNERS.get(name);
    if (runner === undefined) return undefined;
    const index = subcommandIndex(args, name);
    if (index === undefined) {
        return undefined;
    }
    const subcommand = args[index] as string;
    const rest = args.slice(index + 1);
    let inner: string[];
    if (rest.includes("--")) {
        inner = rest.slice(rest.indexOf("--") + 1);
    } else {
        inner = skipOptions(rest, wrapperSpec(runner.withArg, { positionals: runner.positionals })) ?? [];
    }
    return inner.length > 0 ? [subcommand, inner] : undefined;
}

/** The command piping into stage `stage` of `pipeline`, if already recorded. */
export function feeder(ctx: Context, pipeline: number, stage: number): SimpleCommand | undefined {
    if (stage === 0) {
        return undefined;
    }
    for (let index = ctx.result.commands.length - 1; index >= 0; index -= 1) {
        const c = ctx.result.commands[index] as SimpleCommand;
        if (c.pipeline === pipeline && c.stage === stage - 1) return c;
    }
    return undefined;
}

/**
 * The command lines xargs builds when its input is known text
 * (`printf '%s\\n' -rf x | xargs rm` runs `rm -rf x`). `[inner]` otherwise.
 */
export function xargsRuns(
    args: readonly string[],
    inner: readonly string[],
    feeder: SimpleCommand | undefined,
    ctx: Context,
): string[][] {
    const own = args.slice(0, args.length - inner.length);
    if (
        feeder === undefined ||
        feeder.dynamicHead ||
        !(feeder.name === "echo" || feeder.name === "printf") ||
        optionValue(own, new Set(["-a", "--arg-file"])) !== undefined
    ) {
        return [[...inner]];
    }
    const text = echoedText(feeder);
    let replace = optionValue(own, new Set(["-I", "--replace"]));
    if (!replace) {
        const attached = own.find((a) => a.startsWith("-i"));
        replace = attached === undefined ? undefined : attached.slice(2) || "{}";
    }
    const delimiter =
        own.includes("-0") || own.includes("--null")
            ? "\0"
            : optionValue(own, new Set(["-d", "--delimiter"]));
    if (replace) {
        const separator = delimiter ? unicodeEscape(delimiter) : "\n";
        const items = text
            .split(separator)
            .map((item) => item.trim())
            .filter((item) => item !== "");
        if (items.length > MAX_BRACE_WORDS) {
            ctx.result.truncated = true; // more input lines than are checked
        }
        const pattern = replace;
        const runs = items
            .slice(0, MAX_BRACE_WORDS)
            .map((item) => inner.map((arg) => arg.replaceAll(pattern, item)));
        return runs.length > 0 ? runs : [[...inner]];
    }
    let items: string[];
    if (delimiter) {
        items = text.split(unicodeEscape(delimiter)).filter((item) => item !== "");
    } else {
        items = shlexSplit(text) ?? splitWhitespace(text);
    }
    return [[...inner, ...items]];
}

const ESCAPES: ReadonlyMap<string, string> = new Map([
    ["n", "\n"],
    ["t", "\t"],
    ["r", "\r"],
    ["a", "\x07"],
    ["b", "\b"],
    ["f", "\f"],
    ["v", "\v"],
    ["\\", "\\"],
    ["'", "'"],
    ['"', '"'],
]);

/** Python's `text.encode().decode("unicode_escape")`: backslash escapes become the characters they name. */
function unicodeEscape(text: string): string {
    return text.replace(
        /\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|[0-7]{1,3}|[ntrabfv\\'"])/g,
        (whole: string, code: string) => {
            const named = ESCAPES.get(code);
            if (named !== undefined) return named;
            if (code.startsWith("x") || code.startsWith("u")) {
                return String.fromCodePoint(Number.parseInt(code.slice(1), 16));
            }
            const octal = Number.parseInt(code, 8);
            return Number.isNaN(octal) ? whole : String.fromCodePoint(octal);
        },
    );
}

/** `shlex.split(text)`: POSIX quoting; undefined where Python raises ValueError. */
function shlexSplit(text: string): string[] | undefined {
    const words: string[] = [];
    let word = "";
    let inWord = false;
    let index = 0;
    while (index < text.length) {
        const char = text[index] as string;
        if (char === " " || char === "\t" || char === "\r" || char === "\n") {
            if (inWord) {
                words.push(word);
                word = "";
                inWord = false;
            }
            index += 1;
            continue;
        }
        inWord = true;
        if (char === "\\") {
            if (index + 1 >= text.length) return undefined; // "No escaped character"
            word += text[index + 1] as string;
            index += 2;
            continue;
        }
        if (char === "'") {
            const end = text.indexOf("'", index + 1);
            if (end < 0) return undefined; // "No closing quotation"
            word += text.slice(index + 1, end);
            index = end + 1;
            continue;
        }
        if (char === '"') {
            index += 1;
            let closed = false;
            while (index < text.length) {
                const inner = text[index] as string;
                if (inner === '"') {
                    closed = true;
                    index += 1;
                    break;
                }
                const next = text[index + 1];
                if (inner === "\\" && (next === '"' || next === "\\")) {
                    word += next;
                    index += 2;
                    continue;
                }
                word += inner;
                index += 1;
            }
            if (!closed) return undefined;
            continue;
        }
        word += char;
        index += 1;
    }
    if (inWord) {
        words.push(word);
    }
    return words;
}

export function findExecCommands(args: readonly string[]): string[][] {
    const commands: string[][] = [];
    let index = 0;
    while (index < args.length) {
        if (FIND_EXEC.has(args[index] as string)) {
            let end = index + 1;
            while (end < args.length && args[end] !== ";" && args[end] !== "+") {
                end += 1;
            }
            if (end > index + 1) {
                commands.push(args.slice(index + 1, end));
            }
            index = end;
        }
        index += 1;
    }
    return commands;
}

export function parallelCommand(args: readonly string[]): string[] | undefined {
    const terminators = [":::", "::::", ":::+", "::::+"];
    let end = args.findIndex((arg) => terminators.includes(arg));
    if (end < 0) end = args.length;
    let command = args.slice(0, end);
    while (command.length > 0 && (command[0] as string).startsWith("-")) {
        command = command.slice(1);
    }
    return command.length > 0 ? command : undefined;
}
