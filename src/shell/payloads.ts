/**
 * Program text a command runs: `bash -c`, `eval`, `trap`, `mapfile -C`,
 * `source <(...)`, `ssh host CMD`, interpreter one-liners, awk `system()`,
 * string runners, `$PS4` while `set -x` traces, and scripts read from disk
 * through the source resolver.
 * Each is parsed again as a nested command list. Part of shell_parse.
 *
 * Ported from shell_payloads.py.
 */

import { unique } from "../util/paths.ts";
import { isDigit, lstripChars, shellQuote } from "../util/text.ts";
import { knownStdin } from "./command-stdin.ts";
import {
    type ClientInput,
    clientInput,
    DIALECTS,
    fileOptionValues,
    GETOPT_CLIENTS,
    included,
    readFile,
} from "./db-client-files.ts";
import { echoedText } from "./expand.ts";
import {
    awkCommands,
    directShellStrings,
    inlinePrograms,
    interpreterKind,
    shellStrings,
} from "./interpreters.ts";
import { HEREDOC_OPERATORS } from "./lexer.ts";
import {
    type Context,
    FIELD,
    MAX_DEPTH,
    POSITIONALS,
    type Redirect,
    SimpleCommand,
    SOURCE_TOO_LARGE,
    type SourceText,
    type Trap,
} from "./model.ts";
import { emit, parseInto } from "./parse.ts";
import { MAPFILE_WITH_VALUE, openedText } from "./state.ts";
import { parseProducer, producerOutput } from "./streams.ts";
import { findExecCommands, optionValue, parallelCommand, skipOptions } from "./unwrap.ts";
import {
    SHELLS,
    SSH_OPTIONS_WITH_ARG,
    STDIN_PATHS,
    STRING_RUNNERS,
    shellInvocation,
    sourceArguments,
    wrapperSpec,
} from "./wrappers.ts";

export interface NestedOptions {
    /**
     * Text the agent did not type as a command here (a file's program, a
     * string literal), so the guards ask about it instead of denying.
     */
    readonly notTyped?: boolean;
    readonly sharesShell?: boolean;
    readonly returnBoundary?: boolean;
}

/** Parses `text` as a nested command list reached through `label`. */
export type Nested = (text: string, label: string, options?: NestedOptions) => Promise<void>;

export async function parsePayloads(command: SimpleCommand, ctx: Context, depth: number): Promise<void> {
    // re-entry: parsed as a command list
    const name = command.name;
    const args = [...command.args];
    const via = command.via;
    const nestedVia = via;
    const indirect = command.indirect;

    const nested: Nested = async (text, label, options = {}) => {
        // `not_typed`: text the agent did not type as a command here (a file's
        // program, a string literal), so the guards ask about it instead of denying.
        await parseInto(
            text,
            ctx,
            [...nestedVia, label],
            depth + 1,
            indirect || (options.notTyped ?? false),
            {
                sharesShell: options.sharesShell ?? false,
                returnBoundary: options.returnBoundary ?? false,
            },
        );
    };

    if (name === "set") {
        const tracing = xtraceOption(args);
        ctx.xtrace = tracing === undefined ? ctx.xtrace : tracing;
    }
    if (ctx.xtrace) {
        await tracePrompt(command, ctx, nested);
    }

    if (SHELLS.has(name)) {
        await shellPayload(command, args, ctx, nested);
    } else if (DIALECTS.has(name)) {
        for (const [text, typed] of await clientShellCommands(command, ctx)) {
            await nested(text, `${name} shell escape`, { notTyped: !typed });
        }
    } else if (name === "git") {
        for (const url of args) {
            if (url.startsWith("ext::")) {
                // `git clone 'ext::sh -c rm% -rf% x'`: git runs the command in the URL.
                await nested(extArgv(url.slice("ext::".length)).map(shellQuote).join(" "), "git ext::");
            }
        }
    } else if (inlinePrograms(name, command.args, command.redirects).length > 0) {
        for (const program of inlinePrograms(name, command.args, command.redirects)) {
            const direct = directShellStrings(program, interpreterKind(name));
            for (const literal of unique([...shellStrings(program), ...direct])) {
                // A string passed straight to a shell (`os.system("...")`) is a command;
                // any other literal of the program may only be data
                // (`subprocess.run(["echo", "rm -rf x"])` deletes nothing), so it asks.
                await nested(literal, `${name} string`, { notTyped: !direct.includes(literal) });
            }
        }
    } else if (awkCommands(name, command.args).length > 0) {
        for (const literal of awkCommands(name, command.args)) {
            await nested(literal, `${name} system()`);
        }
    } else if (name === "eval") {
        if (args.length > 0) {
            await nested(args.join(" "), "eval", { sharesShell: true });
        }
    } else if (name === "trap") {
        const handler = trapHandler(args);
        if (handler) {
            // `trap 'CMD' EXIT`: the shell runs CMD later, on the signal. It is checked
            // now, but what it assigns must not change the commands that run before;
            // then again when the shell exits (EXIT), or after each later command
            // that changes the variables (a signal may arrive at any point).
            await nested(handler, "trap");
            const names = trapSignals(args).map((s) => s.toUpperCase().replace(/^SIG/, ""));
            const exits = names.map((n) => n === "EXIT" || n === "0");
            const others = names.filter((n) => n !== "EXIT" && n !== "0" && n !== "DEBUG");
            const trap: Trap = {
                handler,
                via: [...via, "trap"],
                depth: depth + 1,
                indirect,
                onExit: exits.some((e) => e),
                onSignal: others.length > 0,
                onDebug: names.includes("DEBUG"),
                checked: null,
            };
            (ctx.trapFrames[ctx.trapFrames.length - 1] as Trap[]).push(trap);
        }
    } else if (name === "mapfile" || name === "readarray") {
        const callback = mapfileOption(args, "C");
        if (callback) {
            await mapfileCallbacks(callback, mapfileOption(args, "c") || "5000", ctx, nested, `${name} -C`);
        }
    } else if ((name === "source" || name === ".") && args.length > 0) {
        // `source <(printf CMD)`: the shell runs what the substitution prints.
        const operands = sourceArguments(command.args);
        if (operands.length > 0) {
            await producedScript(operands[0] as string, command, ctx, nested, true, true);
        }
    } else if (STRING_RUNNERS.has(name)) {
        const spec = STRING_RUNNERS.get(name);
        if (spec !== undefined && spec.commandOptions.size > 0) {
            const value = optionValue(args, spec.commandOptions);
            if (value !== undefined) {
                await nested(value, `${name} -c`);
            }
        } else if (spec !== undefined) {
            const inner = skipOptions(args, spec);
            if (inner !== undefined && inner.length > 0) {
                await nested(inner.join(" "), name);
            }
        }
    } else if (name === "ssh" || name === "autossh") {
        const remote = skipOptions(args, wrapperSpec(SSH_OPTIONS_WITH_ARG));
        if (remote !== undefined && remote.length > 1) {
            await nested(remote.slice(1).join(" "), `ssh ${remote[0]}`);
        }
    } else if (name === "find") {
        for (const inner of findExecCommands(args)) {
            await emit(
                inner,
                [],
                ctx,
                [...via, "find -exec"],
                depth + 1,
                indirect,
                ctx.nextPipeline(),
                0,
                false,
                ["find"],
            );
        }
    } else if (name === "parallel" && !args.includes("--dry-run")) {
        const inner = parallelCommand(args);
        if (inner !== undefined) {
            // parallel runs the argv it was given; keep each word's quoting.
            await nested(inner.map(shellQuote).join(" "), "parallel");
        }
    }

    if (depth < MAX_DEPTH) {
        for (const [text, label] of await sourcesFor(command, ctx)) {
            if (text === SOURCE_TOO_LARGE) {
                ctx.result.truncated = true;
                ctx.result.skippedSources.push([command, label]);
                continue;
            }
            // A file written earlier in this same command line was typed by the agent.
            // `source`/`.` run the file in this shell: its cd and assignments persist.
            // `source FILE ARGS`, `bash FILE ARGS` and `./FILE ARGS` make ARGS its
            // $1..$n for the duration; with none given, they stay unknown.
            const sourcing = command.name === "source" || command.name === ".";
            const callerParams = ctx.variables.get(POSITIONALS);
            const scriptArgs = scriptArguments(command);
            if (scriptArgs.length > 0) {
                ctx.variables.set(POSITIONALS, [scriptArgs.join(FIELD)]);
            }
            await nested(text, label, {
                notTyped: !label.startsWith("written "),
                sharesShell: sourcing,
                returnBoundary: sourcing,
            });
            if (scriptArgs.length > 0) {
                if (callerParams === undefined) {
                    ctx.variables.delete(POSITIONALS);
                } else {
                    ctx.variables.set(POSITIONALS, callerParams);
                }
            }
        }
    }
}

/**
 * `bash -c STR` (and fish's command options), and a script read from stdin:
 * `bash <<EOF`, `bash <<< STR`, `bash < file`, `echo STR | bash`,
 * `cat file | bash`, `bash -s args < file`.
 */
async function shellPayload(
    command: SimpleCommand,
    args: readonly string[],
    ctx: Context,
    nested: Nested,
): Promise<void> {
    const shell = shellInvocation(command.name, args);
    if (shell.syntaxOnly) {
        return; // `-n`: read and syntax-check only, never execute
    }
    if (command.name === "bash") {
        // A non-interactive bash first runs the file $BASH_ENV names, `bash -c` included.
        for (const value of command.envValues("BASH_ENV")) {
            if (await producedScript(value, command, ctx, nested)) {
                continue;
            }
            for (const path of startupPaths(value, command, ctx)) {
                await runFile(path, command, ctx, nested);
            }
        }
    }
    if (command.name === "bash" && shell.interactive) {
        if (shell.startupFile) {
            if (shell.startupFile.includes("$") || shell.startupFile.includes("`")) {
                ctx.result.truncated = true;
                ctx.result.skippedSources.push([command, "bash rc file"]);
            } else {
                await runFile(shell.startupFile, command, ctx, nested);
            }
        }
        await interactiveHooks(command, nested);
    }
    if (xtraceOption(leadingOptions(args))) {
        // `bash -x`: the child traces from its first command, expanding $PS4.
        for (const value of command.envValues("PS4")) {
            await nested(promptExpansion(value), `${command.name} -x PS4`);
        }
    }
    if (shell.interactive && readsEnvFile(command.name, args)) {
        // An interactive POSIX shell first runs the file $ENV names (PR review).
        for (const value of command.envValues("ENV")) {
            for (const path of startupPaths(value, command, ctx)) {
                await runFile(path, command, ctx, nested);
            }
        }
    }
    const prelude = optionPrelude(command.name, args);
    for (const text of shell.commands) {
        await nested(prelude + bindPositionals(text, [...shell.commandArgs]), `${command.name} -c`);
    }
    if (shell.script) {
        await producedScript(shell.script, command, ctx, nested); // `bash <(echo CMD)`
    }
    if (!shell.readsStdin) {
        return; // a command string or a script file (shell_sources resolves the file)
    }
    // Redirections apply in order: the shell reads only the last one to stdin,
    // which also replaces a pipe (`bash <<< 'rm -rf x' <<< :` runs only `:`).
    const stdin = command.redirects.filter(
        (r) => STDIN_OPERATORS.has(r.op) && (r.fd === undefined || r.fd === 0),
    );
    const lastStdin = stdin[stdin.length - 1];
    if (lastStdin !== undefined) {
        await stdinScript(lastStdin, command, ctx, nested);
        return;
    }
    const feeder = ctx.result.previousStage(command);
    if (feeder === undefined || feeder.dynamicHead) {
        return;
    }
    if (feeder.name === "echo" || feeder.name === "printf") {
        const text = echoedText(feeder);
        if (text) {
            await nested(text, `${feeder.name} | ${command.name}`);
        }
    } else if (feeder.name === "cat") {
        // `cat a.sh b.sh | bash` runs each file just like `bash a.sh`; `cat <<EOF | bash`
        // (or `cat -u - <<EOF`) passes cat's own stdin on unchanged.
        const passed = feeder.redirects.filter(
            (r) => STDIN_OPERATORS.has(r.op) && (r.fd === undefined || r.fd === 0),
        );
        const operands = catOperands(feeder.args);
        for (const operand of operands.length > 0 ? operands : ["-"]) {
            const lastPassed = passed[passed.length - 1];
            if (!STDIN_PATHS.has(operand)) {
                await runFile(operand, command, ctx, nested);
            } else if (lastPassed !== undefined) {
                await stdinScript(lastPassed, command, ctx, nested);
            }
        }
    }
}

/** cat's files; its options (`-u`, `-v`, `--show-all`) take no value. */
function catOperands(args: readonly string[]): string[] {
    const found: string[] = [];
    let ended = false;
    for (const arg of args) {
        if (ended || arg === "-" || !arg.startsWith("-")) {
            found.push(arg);
        } else if (arg === "--") {
            ended = true;
        }
    }
    return found;
}

// Shells whose interactive startup runs $ENV. bash does so only in POSIX mode;
// zsh only when emulating sh or ksh, which a command line rarely asks for.
const ENV_SHELLS: ReadonlySet<string> = new Set(["sh", "dash", "ash", "ksh", "mksh", "yash", "posh"]);

function readsEnvFile(name: string, args: readonly string[]): boolean {
    if (ENV_SHELLS.has(name)) {
        return true;
    }
    return name === "bash" && (args.includes("--posix") || setOption(args, "posix"));
}

/** `bash -o posix`: the option is set (a later `+o posix` unsets it). */
function setOption(args: readonly string[], option: string): boolean {
    let state = false;
    for (let index = 0; index < args.length - 1; index += 1) {
        const arg = args[index];
        if ((arg === "-o" || arg === "+o") && args[index + 1] === option) {
            state = arg === "-o";
        }
    }
    return state;
}

/**
 * What `set ARGS` does to xtrace: true for `-x`/`-o xtrace`, false for
 * `+x`/`+o xtrace`, undefined when it is not mentioned. The last mention wins.
 */
function xtraceOption(args: readonly string[]): boolean | undefined {
    let state: boolean | undefined;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index] as string;
        if (arg === "--" || arg === "-") {
            break;
        }
        const sign = arg[0];
        if ((arg === "-o" || arg === "+o") && index + 1 < args.length && args[index + 1] === "xtrace") {
            state = arg === "-o";
        } else if (
            arg.length > 1 &&
            (sign === "-" || sign === "+") &&
            arg[1] !== "-" &&
            arg.slice(1).includes("x")
        ) {
            state = sign === "-";
        } else if (
            !(arg.startsWith("-") || arg.startsWith("+")) &&
            (index === 0 || (args[index - 1] !== "-o" && args[index - 1] !== "+o"))
        ) {
            break; // the positional parameters start here
        }
    }
    return state;
}

/** A shell's own options: the words before its command string or script. */
function leadingOptions(args: readonly string[]): string[] {
    const options: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index] as string;
        if (
            arg.startsWith("-") ||
            arg.startsWith("+") ||
            (index > 0 && (args[index - 1] === "-o" || args[index - 1] === "+o"))
        ) {
            options.push(arg);
            if (lstripChars(arg, "-+").includes("c") && !arg.startsWith("--")) {
                break; // `-c` / `-xc`: the next word is the command string
            }
        } else {
            break;
        }
    }
    return options;
}

/** A command whose expansion runs what expanding prompt `value` runs. */
function promptExpansion(value: string): string {
    return `: "${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * While `set -x` is on, bash expands $PS4 before each command it runs, so a
 * `$(...)` in it runs too (PR review). Each value is parsed once.
 */
async function tracePrompt(command: SimpleCommand, ctx: Context, nested: Nested): Promise<void> {
    for (const value of command.envValues("PS4")) {
        if (
            ctx.tracedPrompts.has(value) ||
            !(value.includes("$(") || value.includes("`") || value.includes("$(("))
        ) {
            continue;
        }
        ctx.tracedPrompts.add(value);
        await nested(promptExpansion(value), "set -x PS4");
    }
}

/**
 * An interactive bash (`bash -i`) runs $PROMPT_COMMAND before each prompt and
 * expands $PS0/$PS1, whose `$(...)` runs too: parse what the environment sets.
 */
async function interactiveHooks(command: SimpleCommand, nested: Nested): Promise<void> {
    for (const value of command.envValues("PROMPT_COMMAND")) {
        await nested(value, "bash -i PROMPT_COMMAND");
    }
    for (const name of ["PS0", "PS1"]) {
        for (const value of command.envValues(name)) {
            if (value.includes("$(") || value.includes("`")) {
                await nested(`: "${value.replaceAll('"', '\\"')}"`, `bash -i ${name}`);
            }
        }
    }
}

const STARTUP_REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * The files a `BASH_ENV` value names once bash expands it: `$PWD/env.sh` in
 * each directory the command may run in, `$HOME` and the command's other
 * variables by value. One it cannot expand leaves the analysis incomplete.
 */
function startupPaths(value: string, command: SimpleCommand, ctx: Context): string[] {
    if (!value) {
        return [];
    }
    if (!value.includes("$")) {
        return [value];
    }
    const paths: string[] = [];
    const cwds = command.possibleCwds.length > 0 ? command.possibleCwds : [null];
    for (const cwd of cwds) {
        let unknown = false;
        const expanded = value.replace(STARTUP_REFERENCE, (whole, braced?: string, bare?: string) => {
            const name = braced || bare || "";
            const values: ReadonlyArray<string | null> =
                name === "PWD" ? [cwd] : name === "HOME" ? [ctx.host.home] : command.envValues(name);
            const only = values[0];
            if (values.length !== 1 || only === null || only === undefined) {
                unknown = true;
                return whole;
            }
            return only;
        });
        if (unknown) {
            ctx.result.truncated = true;
            continue;
        }
        if (expanded.includes("$") || expanded.includes("`")) {
            ctx.result.truncated = true; // command or arithmetic substitution
            continue;
        }
        paths.push(expanded);
    }
    return unique(paths);
}

const STDIN_OPERATORS: ReadonlySet<string> = new Set(["<", "<<<", "<&", "<>", ...HEREDOC_OPERATORS]);

/** Parse the script a shell reads from its stdin redirection. */
async function stdinScript(
    redirect: Redirect,
    command: SimpleCommand,
    ctx: Context,
    nested: Nested,
): Promise<void> {
    if (HEREDOC_OPERATORS.has(redirect.op) && redirect.body !== undefined) {
        await nested(redirect.body, `${command.name} <<heredoc`);
    } else if (redirect.op === "<<<") {
        await nested(redirect.target, `${command.name} <<<`);
    } else if (
        (redirect.op === "<" || redirect.op === "<>") &&
        (await producedScript(redirect.target, command, ctx, nested))
    ) {
        // `bash < <(printf CMD)`
    } else if ((redirect.op === "<" || redirect.op === "<>") && !redirect.dynamic) {
        // `bash < script.sh` runs the file just like `bash script.sh`.
        await runFile(redirect.target, command, ctx, nested);
    } else if (redirect.op === "<&" && isDigit(redirect.target)) {
        const [text] = openedText(Number(redirect.target), ctx); // `exec 3<<< CMD; bash <&3`
        if (text === undefined) {
            ctx.result.truncated = true; // the descriptor's text is not known
        } else {
            await nested(text, `${command.name} <&${redirect.target}`);
        }
    } else if (redirect.dynamic) {
        ctx.result.truncated = true; // a computed file: the script is not known
    }
}

/**
 * Options a new shell starts with, as commands to parse first: dash's and
 * sh's echo always expands escapes, as does bash's with `-O xpg_echo`.
 */
function optionPrelude(name: string, args: readonly string[]): string {
    const xpg =
        ["sh", "dash", "ash"].includes(name) ||
        args.some((a, i) => (a === "xpg_echo" && i > 0 && args[i - 1] === "-O") || a === "-Oxpg_echo");
    return xpg ? "shopt -s xpg_echo\n" : "";
}

// Shell escapes of database clients (PR review), by dialect (db_client_files.DIALECTS):
// sqlite3/duckdb `.shell CMD`, `.system CMD`, and a file name starting with `|`,
// which is a command it runs and reads from or writes to (`.read "|CMD"`,
// `.import '|CMD' t`, `.output |CMD`, `.once |CMD`; unquoted, the rest of the
// line is the command); psql `\! CMD`, output to a pipe (`\o |CMD`, `\g |CMD`,
// `\w |CMD`), and `COPY`/`\copy ... PROGRAM 'CMD'`, to which cockroach adds
// `\| CMD` (its output runs as SQL); mysql/mariadb `system CMD`, `\! CMD` and a
// `pager`; sqlcmd `!! CMD`.
const PSQL_SHELL =
    "\\\\!\\s*(.+?)\\s*$" +
    "|\\\\(?:o|out|g|w|write)\\s+(?:'\\|([^']*)'|\\|\\s*(.+?)\\s*$)" +
    "|\\bPROGRAM\\s+(?:'([^']*)'|E'([^']*)')";
const CLIENT_SHELL: ReadonlyMap<string, RegExp> = new Map([
    [
        "sqlite",
        new RegExp(
            "^\\s*\\.(?:shell|system)\\s+(.+)$" +
                "|^\\s*\\.(?:read|import|output|once)\\s+(?:\"\\|([^\"]*)\"|'\\|([^']*)'|\\|(.+?)\\s*$)",
            "gm",
        ),
    ],
    ["psql", new RegExp(PSQL_SHELL, "gmi")],
    ["cockroach", new RegExp(`${PSQL_SHELL}|\\\\\\|\\s*(.+?)\\s*$`, "gmi")],
    ["mysql", /^\s*(?:system|\\!|pager|\\P)\s+(.+?)\s*;?\s*$/gm],
    ["sqlcmd", /^\s*:?!!\s*(.+?)\s*$/gm],
]);

/**
 * (command, typed) for each shell escape in what a database client runs:
 * its arguments, its command files, and the files those include.
 */
async function clientShellCommands(
    command: SimpleCommand,
    ctx: Context,
): Promise<Array<readonly [string, boolean]>> {
    const pattern = CLIENT_SHELL.get(DIALECTS.get(command.name) ?? "");
    if (pattern === undefined) {
        return [];
    }
    let inputs: ClientInput[] = clientTexts(command).map((text) => ({
        text,
        typed: true,
        directory: undefined,
    }));
    inputs.push(...(await clientFileTexts(command, ctx)));
    const source = await knownStdin(command, ctx.result, ctx.writtenFiles, ctx.host);
    if (source != null) {
        inputs.push(source);
    }

    const unknown = (_name: string): void => {
        ctx.result.truncated = true; // an included file that cannot be followed
    };

    inputs = [
        ...inputs,
        ...(await included(command.name, inputs, command.possibleCwds, ctx.writtenFiles, unknown, ctx.host)),
    ];
    const found: Array<readonly [string, boolean]> = [];
    for (const input of inputs) {
        for (const match of input.text.matchAll(new RegExp(pattern.source, pattern.flags))) {
            found.push([firstGroup(match), input.typed]);
        }
    }
    return found;
}

/**
 * What a database client reads as input: its arguments (`-c SQL`, `-cmd SQL`,
 * trailing statements, and a value attached to a short option, `-c'SQL'`), a
 * heredoc or a here-string.
 */
function clientTexts(command: SimpleCommand): string[] {
    const texts = command.args.filter((a) => !a.startsWith("-") || a.startsWith("-cmd"));
    if (GETOPT_CLIENTS.has(command.name)) {
        texts.push(
            ...command.args
                .filter((a) => a.length > 2 && a[0] === "-" && a[1] !== "-")
                .map((a) => a.slice(2)),
        );
    }
    return [
        ...texts,
        ...command.redirects.filter((r) => r.body).map((r) => r.body || ""),
        ...command.redirects.filter((r) => r.op === "<<<").map((r) => r.target),
    ];
}

/**
 * Each file of statements the client reads: a command file option, or
 * `< FILE` on stdin, typed when the same line wrote the file
 * (`printf '.shell …' > i.sql; sqlite3 -init i.sql`), else read from disk
 * (PR review). A computed name leaves the analysis incomplete.
 */
async function clientFileTexts(command: SimpleCommand, ctx: Context): Promise<ClientInput[]> {
    // (name, whether the client opens it itself): on stdin, psql's `\ir` is relative to the cwd.
    const names: Array<[string, boolean]> = fileOptionValues(command.name, command.args).map((name) => [
        name,
        true,
    ]);
    for (const redirect of command.redirects) {
        if (redirect.op === "<" && (redirect.fd === undefined || redirect.fd === 0)) {
            if (redirect.dynamic) {
                ctx.result.truncated = true;
                continue;
            }
            names.push([redirect.target, false]);
        }
    }
    const found: ClientInput[] = [];
    for (const [name, opened] of names) {
        if (name.includes("$") || name.includes("`")) {
            ctx.result.truncated = true; // which file runs is not known
            continue;
        }
        const entry = await readFile(name, command.possibleCwds, ctx.writtenFiles, ctx.host);
        if (entry != null) {
            found.push(opened ? entry : clientInput(entry.text, entry.typed));
        }
    }
    return found;
}

const EXT_ESCAPES: ReadonlyMap<string, string> = new Map([
    [" ", " "],
    ["%", "%"],
    ["s", "git-upload-pack"],
    ["S", "git-upload-pack"],
]);

/**
 * The argv git-remote-ext builds from `ext::CMD ARGS`: words split on single
 * spaces, `% ` a space inside a word, `%%` a `%`, `%s`/`%S` the service name,
 * `%G`/`%V` the repository and host (unknown here).
 */
function extArgv(spec: string): string[] {
    const argv: string[] = [];
    let word = "";
    let index = 0;
    while (index < spec.length) {
        const char = spec[index] as string;
        if (char === "%" && index + 1 < spec.length) {
            const code = spec[index + 1] as string;
            word += EXT_ESCAPES.get(code) ?? "";
            index += 2;
            continue;
        }
        if (char === " ") {
            if (word) {
                argv.push(word);
            }
            word = "";
        } else {
            word += char;
        }
        index += 1;
    }
    if (word) {
        argv.push(word);
    }
    return argv;
}

function firstGroup(match: RegExpMatchArray): string {
    return match.slice(1).find((g): g is string => g !== undefined) ?? "";
}

/**
 * A script given as `<(producer)`: parse what the producer prints when that
 * is known statically (`echo`/`printf` text, `cat FILE`), as one stream. False
 * if `operand` is not a process substitution.
 */
async function producedScript(
    operand: string,
    shell: SimpleCommand,
    ctx: Context,
    nested: Nested,
    sharesShell = false,
    returnBoundary = false,
): Promise<boolean> {
    if (!(operand.startsWith("<(") && operand.endsWith(")"))) {
        return false;
    }
    const producer = await parseProducer(operand, shell.cwd, ctx);
    const output = await producerOutput(producer, ctx);
    const commands = producer.commands.filter((c) => c.name !== "shopt");
    const label = `${shell.name} <(${commands.map((c) => c.name).join("; ")})`;
    if (output !== undefined) {
        if (output) {
            await nested(output, label, { sharesShell, returnBoundary });
        }
        return true;
    }
    const only = commands[0];
    const singleFile =
        commands.length === 1 && only !== undefined && only.name === "cat" && only.args.length === 1;
    if (!singleFile) {
        // A script whose text cannot be known (`<(base64 -d <<< ...)`, or where one
        // command's output ends and the next begins): the analysis is incomplete.
        ctx.result.truncated = true;
    }
    for (const command of commands) {
        if (command.via.length > 0 || command.dynamicHead) {
            continue;
        }
        if (command.name === "echo" || command.name === "printf") {
            const text = echoedText(command);
            if (text) {
                await nested(text, `${shell.name} <(${command.name})`, { sharesShell, returnBoundary });
            }
        } else if (command.name === "cat" && command.args.length === 1) {
            await runFile(command.args[0] as string, shell, ctx, nested);
        }
    }
    return true;
}

/**
 * The code `trap CODE SIGNAL...` installs; undefined for `-p`/`-l`, a reset (`-`,
 * a lone signal) or an ignore (`''`).
 */
function trapHandler(args: readonly string[]): string | undefined {
    const operands = args[0] === "--" ? args.slice(1) : args;
    const first = operands[0];
    if (first === undefined || (first.startsWith("-") && first !== "-")) {
        return undefined;
    }
    if (operands.length < 2 || first === "-" || first === "") {
        return undefined;
    }
    return first;
}

/** The conditions `trap CODE SIGNAL...` installs CODE for. */
function trapSignals(args: readonly string[]): string[] {
    const operands = args[0] === "--" ? args.slice(1) : args;
    return operands.slice(1);
}

/**
 * `mapfile -C CMD -c N`: after every Nth line read, CMD runs with the index
 * that line goes to and the line appended (`CMD 0 'text'`), in this shell.
 * Lines not known (or a computed N) leave the analysis incomplete.
 */
async function mapfileCallbacks(
    callback: string,
    quantum: string,
    ctx: Context,
    nested: Nested,
    label: string,
): Promise<void> {
    const records = ctx.mapfileRecords;
    if (records === null || !isDigit(quantum) || Number(quantum) === 0) {
        ctx.result.truncated = true;
        await nested(`${callback} 0 "$MAPFILE_LINE"`, label, { sharesShell: true });
        return;
    }
    const conditional = ctx.conditional;
    ctx.conditional = conditional || records.length > 1; // several streams: each may be the one read
    try {
        for (const stream of records) {
            let count = 0;
            for (const [index, line] of stream) {
                count += 1;
                if (count % Number(quantum) === 0) {
                    await nested(`${callback} ${index} ${shellQuote(line)}`, label, { sharesShell: true });
                }
            }
        }
    } finally {
        ctx.conditional = conditional;
    }
}

/** The value of `mapfile`/`readarray` option `-C` or `-c`, attached (`-Ccmd`) or not. */
function mapfileOption(args: readonly string[], wanted: string): string | undefined {
    let index = 0;
    while (index < args.length && (args[index] as string).startsWith("-") && args[index] !== "--") {
        const arg = args[index] as string;
        for (let offset = 2; offset <= arg.length; offset += 1) {
            const letter = arg[offset - 1] as string;
            if (MAPFILE_WITH_VALUE.has(letter)) {
                const attached = arg.slice(offset);
                const value = attached || (index + 1 < args.length ? (args[index + 1] as string) : "");
                if (!attached) {
                    index += 1;
                }
                if (letter === wanted) {
                    return value || undefined;
                }
                break;
            }
        }
        index += 1;
    }
    return undefined;
}

/** Parse a file a shell reads as its program, via the source resolver. */
async function runFile(path: string, shell: SimpleCommand, ctx: Context, nested: Nested): Promise<void> {
    const asScript = new SimpleCommand({
        argv: [shell.argv[0] ?? "", path],
        indirect: shell.indirect,
        cwd: shell.cwd,
        cwdOptions: shell.cwdOptions,
    });
    for (const [text, label] of await sourcesFor(asScript, ctx)) {
        if (text === SOURCE_TOO_LARGE) {
            ctx.result.truncated = true;
            ctx.result.skippedSources.push([shell, label]);
            continue;
        }
        await nested(text, label, { notTyped: !label.startsWith("written ") });
    }
}

/** The arguments a script `command` runs is given as $1, $2, ... */
function scriptArguments(command: SimpleCommand): readonly string[] {
    if (command.name === "source" || command.name === ".") {
        return sourceArguments(command.args).slice(1);
    }
    if (SHELLS.has(command.name)) {
        return shellInvocation(command.name, command.args).scriptArgs;
    }
    if (command.argv[0]?.includes("/")) {
        return command.args; // `./cleanup.sh a b`
    }
    return []; // package scripts and Make recipes do not see the caller's arguments
}

/**
 * Program text `command` runs from disk, looked up in every directory it might
 * run in (`cd a || cd b; ./x.sh` may run a/x.sh or b/x.sh). Duplicates are dropped.
 */
async function sourcesFor(command: SimpleCommand, ctx: Context): Promise<SourceText[]> {
    if (ctx.sources === null) {
        return [];
    }
    const found: SourceText[] = [];
    for (const directory of command.possibleCwds) {
        if (directory === null) {
            continue;
        }
        for (const item of await ctx.sources(command, directory, ctx.writtenFiles, ctx.host)) {
            if (!found.some(([text, label]) => text === item[0] && label === item[1])) {
                found.push(item);
            }
        }
    }
    return found;
}

const POSITIONAL = /"\$\{?(\d)\}?"|\$\{(\d+)\}|\$(\d)|"\$[@*]"|\$[@*]/g;

/**
 * `bash -c 'rm -rf "$1"' _ ~` runs `rm -rf ~`: substitute literal arguments.
 *
 * arguments[0] is $0; the rest are $1, $2, ... An unset parameter is left
 * as written, which the guards treat as an unknown value.
 */
function bindPositionals(script: string, args: readonly string[]): string {
    if (args.length === 0 || !script.includes("$")) {
        return script;
    }
    return script.replace(POSITIONAL, (whole, quoted?: string, braced?: string, bare?: string) => {
        const number = quoted || braced || bare;
        if (number === undefined) {
            return args.slice(1).map(shellQuote).join(" ");
        }
        const index = Number(number);
        const argument = args[index];
        return argument !== undefined ? shellQuote(argument) : whole;
    });
}
