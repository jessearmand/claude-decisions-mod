/**
 * Decompose a shell command into the simple commands it would actually run.
 *
 * The guards ask "does this command line run `rm -rf`, write to settings.json,
 * or pipe a download into a shell?" Answering that by regex over the raw string
 * is how every bypass happened: a newline, `bash -c '...'`, `eval`, a backtick,
 * `sudo -u root`, `timeout 5`. This module answers it structurally:
 *
 *   * the lexer splits words and operators the way bash does;
 *   * each simple command is unwrapped through sudo/env/nice/timeout/xargs/...
 *     (wrappers.ts) until the real program is at argv[0];
 *   * command strings that are parsed again by a shell are parsed again here:
 *     `bash -c`, `eval`, `su -c`, `watch`, `ssh host CMD`, `env -S`, `$(...)`,
 *     backticks, `<(...)`, heredocs and here-strings fed to a shell, and
 *     `echo '...' | sh`;
 *   * optionally (`sources`), program text the command executes from disk is
 *     parsed too: shell scripts, `source` files, package.json scripts and
 *     Makefile recipes (sources.ts). Those commands are marked
 *     `indirect`, because the agent did not type them in this call.
 *
 * Parsing never throws. Input that cannot be finished sets `unparseable`;
 * nesting beyond MAX_DEPTH sets `truncated`. Callers decide how conservative
 * to be in either case.
 *
 * This module drives the parse (command lists, blocks, functions, the order in
 * which each command is expanded, unwrapped and recorded) and is the only one
 * callers import. The stages live beside it, each importing only those above:
 *
 *   model       the data returned and the context/variable table
 *   expand      word expansion (braces, globs, parameters, IFS, `$(echo)`)
 *   streams     text a command reads (`< file`, `<(printf ...)`)
 *   state       builtins and assignments that change later commands
 *   effects     cd, files written on the line, links and copies
 *   unwrap      wrappers, runners, xargs, find -exec, parallel
 *   payloads    program text a command runs (bash -c, eval, trap, scripts)
 *
 * Stages that parse nested command lists import `parseInto` / `emit` from
 * here at the top of their file; ES modules tolerate the cycle because nothing
 * is called while the modules load.
 *
 * Ported from shell_parse.py.
 */

import type { Host } from "../host/host.ts";
import { expanduser, isAbsolute, join, normpath } from "../util/paths.ts";
import { isDigit } from "../util/text.ts";
import {
    changeDirectory,
    executable,
    followDirectoryChange,
    recordLink,
    recordWrittenFile,
} from "./effects.ts";
import {
    arithmeticExpressions,
    arithmeticSubstitutions,
    arrayWords,
    atWordPieces,
    braceExpand,
    commandOutput,
    compoundWord,
    echoedText,
    expandWord,
    globWords,
    splitUnquoted,
    starSeparator,
} from "./expand.ts";
import { HEREDOC_OPERATORS, lex, Operator, REDIRECT_OPERATORS, Word } from "./lexer.ts";
import {
    ASSIGNMENT,
    assignSetting,
    type BodyStep,
    bounded,
    Context,
    copyVariables,
    FIELD,
    FUNCTION,
    HASHED,
    MAX_DEPTH,
    MAX_UNWRAP,
    NAME,
    NAMEREF,
    type NestedSource,
    ParseResult,
    POSITIONALS,
    positionals,
    programName,
    REFERENCE,
    type Redirect,
    redirect,
    SHELL_OPTION,
    type ShellState,
    SimpleCommand,
    SOURCE_TOO_LARGE,
    type SourceResolver,
    settings,
    type Trap,
    targetName,
    UNSET,
    type Variables,
    variableKeys,
    type WrittenFile,
} from "./model.ts";
import { parsePayloads } from "./payloads.ts";
import { builtinMutation, expandAlias, ownAssign, stripPrelude } from "./state.ts";
import { feeder, optionValue, unwrapOnce, xargsRuns } from "./unwrap.ts";
import { RESERVED_PREFIXES } from "./wrappers.ts";
import { INTO_DIR, LINK, WRITE, writtenPaths } from "./writes.ts";

export type { NestedSource, Redirect, SourceResolver, WrittenFile };
export {
    echoedText,
    MAX_DEPTH,
    optionValue,
    ParseResult,
    programName,
    SimpleCommand,
    SOURCE_TOO_LARGE,
    UNSET,
};

/** A lexer token: a word or an operator. */
export type Token = Word | Operator;

const SEPARATORS: ReadonlySet<string> = new Set(["&&", "||", ";", ";;", ";&", ";;&", "&", "\n", "(", ")"]);
const PIPES: ReadonlySet<string> = new Set(["|", "|&"]);
const AND_OR: ReadonlySet<string> = new Set(["&&", "||"]);
// Reserved words that open and close a compound command whose body may not run.
const BLOCK_OPENERS: ReadonlySet<string> = new Set(["if", "while", "until", "for", "select", "case", "{"]);
const BLOCK_CLOSERS: ReadonlySet<string> = new Set(["fi", "done", "esac", "}"]);
const MAX_VARIANTS = 64;
// Values one variable may hold, and their total size, before the oldest are
// dropped. `X="$X a"` in a function called from several branches doubles X's
// values at each call, and `X="$X$X"` doubles their length.
const MAX_VALUES = 64;
const MAX_VALUE_CHARS = 1024 * 1024;
/** The words that expand to every positional parameter. */
// Shell parameter spellings, not templates
const ALL_PARAMETERS: ReadonlySet<string> = new Set(["$@", "${@}", "$*", "${*}"]);

/** Every simple command `command` would run. Never throws. */
export async function parse(
    command: string,
    cwd: string,
    host: Host,
    sources: SourceResolver | null = null,
): Promise<ParseResult> {
    const start = cwd;
    const context = new Context(new ParseResult(), start, sources, host, [start]);
    await parseInto(command, context, [], 0, false);
    await runExitTraps(context);
    context.result.writtenFiles = new Map(context.writtenFiles);
    return context.result;
}

export interface ParseIntoOptions {
    readonly sharesShell?: boolean;
    readonly returnBoundary?: boolean;
}

/** A function body being declared, with the state to restore at its end. */
interface Declaration {
    /** block depth before the body */
    readonly level: number;
    readonly saved: ShellState;
    readonly name: string;
    readonly body: BodyStep<Token>[];
    /** whether the declaration itself may not run */
    readonly conditional: boolean;
}

/**
 * Parse `text` as a command list. Nested code runs in a child shell unless
 * `sharesShell` (eval, source): then its `cd` and assignments persist.
 * `returnBoundary` (a sourced script): a `return` in it ends the script.
 */
export async function parseInto(
    text: string,
    ctx: Context,
    via: readonly string[],
    depth: number,
    indirect: boolean,
    options: ParseIntoOptions = {},
): Promise<void> {
    const sharesShell = options.sharesShell ?? false;
    const returnBoundary = options.returnBoundary ?? false;
    for (const name of bareNames(text)) ctx.setNames.add(name);
    ctx.setNames.add("_"); // `$_`, the last argument of the previous command
    if (depth > MAX_DEPTH) {
        ctx.result.truncated = true;
        return;
    }
    if (depth > 0) {
        ctx.result.nestedSources.push({ text, via, indirect });
    }

    const lexed = lex(text);
    if (lexed.unterminated) {
        ctx.result.unparseable = true;
    }
    // Nested code (`bash -c`, `$(...)`, scripts) runs in its own process: a
    // `cd` or assignment inside it does not reach the caller.
    const entry = ctx.saveState();
    const newShell = depth > 0 && !sharesShell;
    if (newShell) {
        ctx.trapFrames.push([]);
    }
    const outerReturned = ctx.returned;
    const outerExited = ctx.exited;
    ctx.returned = false;
    if (newShell) {
        ctx.exited = false;
    }
    let coprocLevel: number | null = null; // block depth a `coproc { ... }` body runs above

    let pipeline = ctx.nextPipeline();
    let stage = 0;
    let segment: Token[] = [];
    const subshells: ShellState[] = [];
    let outerConditional = ctx.conditional;
    let previous = ";";
    let blocks = 0;
    // Function bodies being declared: (block depth before the body, state to restore
    // at its end, name, the body's commands).
    // Whether the declaration itself may not run comes last.
    const functions: Declaration[] = [];
    const header = new FunctionHeader();
    for (const token of [...lexed.tokens, new Operator("\n")]) {
        if (token instanceof Operator && (SEPARATORS.has(token.op) || PIPES.has(token.op))) {
            if (segment.length > 0) {
                // After `&&`/`||`, or inside an if/loop/case body, the command may not run.
                ctx.conditional = outerConditional || AND_OR.has(previous) || blocks > 0;
                if (header.opensBody(segment, ctx.conditional)) {
                    // A declared function runs only when called: check its body, but
                    // do not let its assignments or cd change the declaring shell.
                    functions.push({
                        level: blocks,
                        saved: ctx.saveState(),
                        name: header.name,
                        body: [],
                        conditional: header.conditional,
                    });
                }
                let isolated = PIPES.has(token.op) || stage > 0 || token.op === "&";
                const first = segment.find((t): t is Word => t instanceof Word);
                if (first !== undefined && first.text === "coproc" && !first.quoted) {
                    // `coproc CMD` runs asynchronously, like `CMD &`, body and all.
                    isolated = true;
                    coprocLevel = blocks;
                } else if (coprocLevel !== null && blocks > coprocLevel) {
                    isolated = true;
                }
                if (
                    isolated &&
                    stage > 0 &&
                    !PIPES.has(token.op) &&
                    token.op !== "&" &&
                    (ctx.variables.get(`${SHELL_OPTION}lastpipe`) ?? []).includes("on")
                ) {
                    // `shopt -s lastpipe`: the last stage runs in this shell (`... | read X`).
                    isolated = false;
                }
                const mayNotRun = AND_OR.has(previous) || blocks > 0;
                const declaring = functions[functions.length - 1];
                if (declaring !== undefined) {
                    const level = declaring.level;
                    declaring.body.push({
                        tokens: [...segment],
                        isolated,
                        conditional: AND_OR.has(previous) || blocks > level + 1,
                    });
                }
                blocks = trackBlocks(segment, blocks);
                if (
                    coprocLevel !== null &&
                    blocks <= coprocLevel &&
                    !(first !== undefined && first.text === "coproc")
                ) {
                    coprocLevel = null;
                }
                if (isolated) {
                    // Every part of a pipeline, and a background command, runs in its own subshell.
                    const saved = ctx.saveState();
                    await runSegment(segment, ctx, via, depth, indirect, pipeline, stage);
                    ctx.restoreState(saved);
                    ctx.returned = false; // a `return`/`exit` in a subshell ends only that
                    ctx.exited = false;
                } else {
                    await runSegment(segment, ctx, via, depth, indirect, pipeline, stage);
                }
                if (functions.length > 0) {
                    ctx.returned = false; // a body being declared does not run yet
                    ctx.exited = false;
                }
                if (ctx.exited && subshells.length > 0) {
                    ctx.exited = false; // `( exit )` ends only the subshell
                }
                if (ctx.exited) {
                    // `exit` ends this shell: nothing after it runs. One that may not have
                    // run leaves the rest possible.
                    ctx.exited = false;
                    if (!mayNotRun) {
                        ctx.exited = true;
                        segment = [];
                        break;
                    }
                    outerConditional = true;
                }
                if (ctx.returned && returnBoundary) {
                    // `return` in a sourced script ends it; after one that may not have
                    // run, the rest of the script may not run either.
                    ctx.returned = false;
                    if (!mayNotRun) {
                        segment = [];
                        break;
                    }
                    outerConditional = true;
                }
                while (
                    functions.length > 0 &&
                    blocks <= (functions[functions.length - 1] as Declaration).level
                ) {
                    const declared = functions.pop() as Declaration;
                    ctx.restoreState(declared.saved);
                    if (declared.name) {
                        // Replayed, with its arguments, at each call.
                        const key = `${declared.name}#${ctx.functions.size}`;
                        ctx.functions.set(key, declared.body);
                        assignSetting(
                            `${FUNCTION}${declared.name}`,
                            key,
                            UNSET,
                            ctx.variables,
                            declared.conditional,
                        );
                    }
                }
                header.afterSegment(segment, ctx.conditional);
                segment = [];
            }
            header.afterOperator(token.op);
            previous = token.op;
            if (token.op === "(") {
                subshells.push(ctx.saveState());
            } else if (token.op === ")" && subshells.length > 0) {
                // `(cd x; X=1)` changes neither the caller's directory nor its variables.
                ctx.restoreState(subshells.pop() as ShellState);
            }
            if (PIPES.has(token.op)) {
                stage += 1;
            } else {
                pipeline = ctx.nextPipeline();
                stage = 0;
            }
            continue;
        }
        segment.push(token);
    }
    ctx.conditional = outerConditional;
    if (newShell) {
        // The shell ends here: its EXIT traps run with the state it ends in.
        ctx.exited = false;
        await runExitTraps(ctx);
        ctx.trapFrames.pop();
        ctx.returned = outerReturned;
        ctx.exited = outerExited;
        ctx.restoreState(entry);
    } else if (!sharesShell || returnBoundary) {
        ctx.returned = outerReturned;
    }
}

/**
 * Remember the paths `command` creates, so a later glob on the line sees
 * them: `touch -- -rf; rm -* victim` runs `rm -rf victim`.
 */
export async function recordCreatedPaths(command: SimpleCommand, ctx: Context): Promise<void> {
    // writes.ts imports this module
    const creating = new Set<string>([WRITE, LINK, INTO_DIR]);
    const paths: Array<[string, boolean]> = (await writtenPaths(command, undefined, ctx.host))
        .filter((w) => creating.has(w.action))
        .map((w) => [w.path, w.dynamic]);
    if (command.name === "mkdir" && !command.dynamicHead) {
        // Directories it makes; after `--` every word is one (`mkdir -- -rf`).
        const args = [...command.args];
        const cut = args.includes("--") ? args.indexOf("--") : args.length;
        const names = [...args.slice(0, cut).filter((a) => !a.startsWith("-")), ...args.slice(cut + 1)];
        for (const a of names) paths.push([a, a.includes("$") || a.includes("`")]);
    }
    for (const [path, dynamic] of paths) {
        if (dynamic || path.includes("$") || path.includes("`")) {
            ctx.createdUnknown = true;
            continue;
        }
        for (const directory of command.possibleCwds) {
            if (directory === null && !isAbsolute(expanduser(path, ctx.host.home))) {
                ctx.createdUnknown = true;
                continue;
            }
            ctx.createdPaths.add(normpath(join(directory ?? "/", expanduser(path, ctx.host.home))));
        }
    }
}

/**
 * Check the shell's trap handlers again with the state it exits in:
 * `X=echo; trap '"$X" -rf v' EXIT; X=rm` runs rm. They run in a scope of
 * their own, so nothing after them sees their assignments.
 */
export async function runExitTraps(ctx: Context): Promise<void> {
    const traps = ctx.trapFrames[ctx.trapFrames.length - 1] ?? [];
    ctx.trapFrames[ctx.trapFrames.length - 1] = [];
    for (const trap of traps) {
        if (trap.onExit) {
            await checkTrap(trap, "on exit", ctx);
        }
    }
}

/**
 * Check this shell's signal handlers again when the state they depend on
 * (variables, directory, files the line wrote) changed since they were last
 * checked: `X=echo; trap '$X reset --hard' TERM; X=git; kill -TERM $$` runs
 * git, and a signal may arrive after any command.
 */
export async function runSignalTraps(ctx: Context): Promise<void> {
    const traps = (ctx.trapFrames[ctx.trapFrames.length - 1] ?? []).filter((trap) => trap.onSignal);
    if (ctx.trapping || traps.length === 0) {
        return;
    }
    for (const trap of traps) {
        if (trap.checked !== ctx.trapState()) {
            await checkTrap(trap, "on signal", ctx, true);
            // What the handler itself changed does not call for checking it again.
            trap.checked = ctx.trapState();
        }
    }
}

/**
 * Parse a trap handler as a run that may not happen. `keepEffects`: a
 * signal handler runs in this shell, so what it assigns stays possible
 * afterwards (as a value beside the earlier one); otherwise it is discarded.
 */
export async function checkTrap(trap: Trap, label: string, ctx: Context, keepEffects = false): Promise<void> {
    const saved = ctx.saveState();
    const savedConditional = ctx.conditional;
    const savedTrapping = ctx.trapping;
    ctx.conditional = true;
    ctx.trapping = true;
    try {
        await parseInto(trap.handler, ctx, [...trap.via, `trap (${label})`], trap.depth, trap.indirect, {
            sharesShell: true,
        });
    } finally {
        const options = ctx.cwdOptions;
        ctx.cwd = saved.cwd;
        ctx.cwdOptions = saved.cwdOptions;
        ctx.conditional = savedConditional;
        ctx.trapping = savedTrapping;
        if (keepEffects) {
            ctx.cwdOptions = bounded([...saved.cwdOptions, ...options]); // a `cd` in it may have run
        } else {
            ctx.variables = saved.variables;
        }
    }
}

/** Spots where a function body starts: `function NAME {` or `NAME() {`. */
export class FunctionHeader {
    private nameSeen = ""; // a one-word command, possibly a function name
    private parens = 0; // 1 after `NAME (`, 2 after `NAME ( )`
    name = ""; // the function whose body opensBody last found
    // Whether the `NAME` of `NAME() {` may not run (`false && f() {`).
    private nameConditional = false;
    conditional = false; // the same for the declaration opensBody last found

    opensBody(segment: readonly Token[], conditional: boolean): boolean {
        const words = segment.filter((t): t is Word => t instanceof Word);
        const first = words[0];
        if (first !== undefined && first.text === "function" && !first.quoted) {
            this.name = words.length > 1 ? (words[1] as Word).text : "";
            this.conditional = conditional;
            return true;
        }
        if (this.parens === 2 && first !== undefined && first.text === "{" && !first.quoted) {
            this.name = this.nameSeen;
            this.conditional = this.nameConditional || conditional;
            return true;
        }
        return false;
    }

    afterSegment(segment: readonly Token[], conditional: boolean): void {
        // `g`, or `{ g` / `then g` / `do g`: a nested declaration's name follows
        // the reserved word that opens the enclosing block.
        let words = segment.filter((t): t is Word => t instanceof Word);
        const allWords = words.length;
        while (
            words.length > 1 &&
            !(words[0] as Word).quoted &&
            RESERVED_PREFIXES.has((words[0] as Word).text)
        ) {
            words = words.slice(1);
        }
        const single = words.length === 1 && segment.length === allWords;
        this.nameSeen = single ? (words[0] as Word).text : "";
        this.nameConditional = conditional;
        this.parens = 0;
    }

    afterOperator(op: string): void {
        if (op === "(" && this.nameSeen && this.parens === 0) {
            this.parens = 1;
        } else if (op === ")" && this.parens === 1) {
            this.parens = 2;
        } else if (!(op === "\n" && this.parens === 2)) {
            // `f()` may end a line before `{`
            this.nameSeen = "";
            this.parens = 0;
        }
    }
}

/**
 * Open if/loop/case/group bodies after this command's leading reserved words
 * (`function NAME` included: its `{` opens the body).
 */
export function trackBlocks(tokens: readonly Token[], blocks: number): number {
    let words = tokens.filter((t): t is Word => t instanceof Word);
    const first = words[0];
    if (first !== undefined && first.text === "function" && !first.quoted) {
        words = words.slice(2);
    }
    let depth = blocks;
    for (const token of words) {
        if (
            token.quoted ||
            !(
                RESERVED_PREFIXES.has(token.text) ||
                BLOCK_OPENERS.has(token.text) ||
                BLOCK_CLOSERS.has(token.text)
            )
        ) {
            break;
        }
        if (BLOCK_OPENERS.has(token.text)) {
            depth += 1;
        } else if (BLOCK_CLOSERS.has(token.text)) {
            depth = Math.max(depth - 1, 0);
        }
    }
    return depth;
}

/**
 * Run one simple command, with the DEBUG handlers that run before it and
 * the signal handlers that may run after it.
 */
export async function runSegment(
    tokens: readonly Token[],
    ctx: Context,
    via: readonly string[],
    depth: number,
    indirect: boolean,
    pipeline: number,
    stage: number,
): Promise<void> {
    await runDebugTraps(ctx);
    await segmentVariants(tokens, ctx, via, depth, indirect, pipeline, stage);
    boundValues(ctx);
    await runSignalTraps(ctx);
}

/**
 * Keep the latest values of each variable, within MAX_VALUES and
 * MAX_VALUE_CHARS. Dropping the rest leaves the parse incomplete, so it is
 * marked truncated; a variable with no value left is unknown from here on.
 */
function boundValues(ctx: Context): void {
    for (const [key, values] of [...ctx.variables.entries()]) {
        let kept = values.slice(0, MAX_VALUES);
        while (kept.length > 0 && kept.reduce((total, value) => total + value.length, 0) > MAX_VALUE_CHARS) {
            kept = kept.slice(0, -1);
        }
        if (kept.length === values.length) {
            continue;
        }
        ctx.result.truncated = true;
        if (kept.length > 0) {
            ctx.variables.set(key, kept);
        } else {
            ctx.variables.delete(key);
        }
    }
}

/**
 * `trap CMD DEBUG`: CMD runs in this shell before every simple command, so
 * what it assigns holds for the command: `trap 'X=rm' DEBUG; "$X" -rf v`.
 */
async function runDebugTraps(ctx: Context): Promise<void> {
    if (ctx.trapping) {
        return;
    }
    for (const trap of (ctx.trapFrames[ctx.trapFrames.length - 1] ?? []).filter((t) => t.onDebug)) {
        const trapping: boolean = ctx.trapping;
        ctx.trapping = true;
        try {
            await parseInto(trap.handler, ctx, [...trap.via, "trap (DEBUG)"], trap.depth, trap.indirect, {
                sharesShell: true,
            });
        } finally {
            ctx.trapping = trapping;
        }
    }
}

/** One value for each variable this command reads that may hold several. */
type Choice = Map<string, string>;

/**
 * Run one simple command: once per combination of values its variables may hold
 * (`P=a || P=b; cat > "$P"` may write a or b).
 */
async function segmentVariants(
    tokens: readonly Token[],
    ctx: Context,
    via: readonly string[],
    depth: number,
    indirect: boolean,
    pipeline: number,
    stage: number,
): Promise<void> {
    await runSubstitutions(tokens, ctx, via, depth, indirect);
    const choices = variableChoices(tokens, ctx);
    if (choices.length === 1) {
        await expandAndEmit(tokens, ctx, via, depth, indirect, pipeline, stage, choices[0] as Choice);
        return;
    }
    const startCwd = ctx.cwd;
    const startOptions = ctx.cwdOptions;
    const conditional = ctx.conditional;
    const ends: Array<readonly [typeof ctx.cwd, typeof ctx.cwdOptions]> = [];
    for (const [index, choice] of choices.entries()) {
        ctx.cwd = startCwd;
        ctx.cwdOptions = startOptions;
        // Each reading adds to what an assignment may hold; only one of them runs.
        ctx.conditional = conditional || index > 0;
        // A `hash -p` or `declare -n` mapping is fixed for this reading, so the
        // command runs once through each.
        const pinned = new Map<string, readonly string[]>();
        for (const key of choice.keys()) {
            if (key.startsWith("\0")) pinned.set(key, ctx.variables.get(key) ?? []);
        }
        for (const key of pinned.keys()) {
            ctx.variables.set(key, [choice.get(key) as string]);
        }
        await expandAndEmit(tokens, ctx, via, depth, indirect, pipeline, stage, choice);
        for (const [key, values] of pinned) {
            const current = ctx.variables.get(key);
            if (current !== undefined && current.length === 1 && current[0] === choice.get(key)) {
                ctx.variables.set(key, values); // unchanged by the command: every mapping stays possible
            }
        }
        ends.push([ctx.cwd, ctx.cwdOptions]);
    }
    ctx.conditional = conditional;
    ctx.cwd = (ends[0] as (typeof ends)[number])[0];
    ctx.cwdOptions = bounded(ends.flatMap(([, options]) => [...options]));
}

/** `name`, its `declare -n` reference, and every variable that may reach. */
function referenced(name: string, ctx: Context): string[] {
    const found: string[] = [];
    const pending = [name];
    while (pending.length > 0 && found.length < 16) {
        const current = pending.pop() as string;
        if (found.includes(current)) {
            continue;
        }
        found.push(current, NAMEREF + current);
        pending.push(...settings(ctx.variables, NAMEREF + current));
    }
    return found;
}

/**
 * One {name: value} per combination of values this command's variables may
 * hold, the current values first; [{}] when every variable has one value.
 */
function variableChoices(tokens: readonly Token[], ctx: Context): Choice[] {
    const names: string[] = [];
    for (const token of tokens) {
        if (!(token instanceof Word)) {
            continue;
        }
        let candidates: string[];
        if (!token.dynamic) {
            // A name `hash -p` or `declare -n` may map more than one way: `x`, `read R`.
            candidates = NAME.test(token.text) ? [HASHED + token.text, ...referenced(token.text, ctx)] : [];
        } else {
            candidates = [...token.text.matchAll(new RegExp(REFERENCE.source, "g"))].flatMap((match) =>
                referenced(match[1] as string, ctx),
            );
        }
        for (const name of candidates) {
            if ((ctx.variables.get(name) ?? []).length > 1 && !names.includes(name)) {
                names.push(name);
            }
        }
    }
    if (names.length === 0) {
        return [new Map()];
    }
    const options = names.map((name) => ctx.variables.get(name) ?? []);
    const combinations = options.reduce((total, values) => total * values.length, 1);
    if (combinations <= MAX_VARIANTS) {
        return product(options).map(
            (values) => new Map(names.map((name, index) => [name, values[index] as string])),
        );
    }
    // Too many combinations: still give every value of every variable one turn,
    // so no possible value goes unchecked, and mark the parse incomplete because
    // pairings across variables are not all covered.
    ctx.result.truncated = true;
    const longest = Math.max(...options.map((values) => values.length));
    return Array.from(
        { length: longest },
        (_, index) =>
            new Map(
                names.map((name, position) => {
                    const values = options[position] as readonly string[];
                    return [name, values[index % values.length] as string];
                }),
            ),
    );
}

/** `itertools.product(*options)`: every combination, the first option varying slowest. */
function product(options: ReadonlyArray<readonly string[]>): string[][] {
    let result: string[][] = [[]];
    for (const values of options) {
        result = result.flatMap((prefix) => values.map((value) => [...prefix, value]));
    }
    return result;
}

async function expandAndEmit(
    tokens: readonly Token[],
    ctx: Context,
    via: readonly string[],
    depth: number,
    indirect: boolean,
    pipeline: number,
    stage: number,
    choice: Choice,
): Promise<void> {
    let words: Word[] = [];
    const redirects: Redirect[] = [];
    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index] as Token;
        if (token instanceof Operator && REDIRECT_OPERATORS.has(token.op)) {
            const target = index + 1 < tokens.length ? tokens[index + 1] : undefined;
            if (target instanceof Word) {
                if (HEREDOC_OPERATORS.has(token.op)) {
                    redirects.push(
                        redirect(
                            token.op,
                            target.text,
                            false,
                            target.heredocBody ?? undefined,
                            token.fd ?? undefined,
                        ),
                    );
                } else {
                    const expanded = await expandWord(target, ctx, choice);
                    redirects.push(
                        redirect(token.op, expanded.text, expanded.dynamic, undefined, token.fd ?? undefined),
                    );
                }
                index += 2;
                continue;
            }
        } else if (token instanceof Word && token.elements != null) {
            words.push(await compoundWord(token, ctx, choice));
        } else if (token instanceof Word) {
            const params = ALL_PARAMETERS.has(token.text) ? positionals(ctx) : null;
            const elements = params === null ? arrayWords(token, ctx) : undefined;
            const pieces = params === null && elements == null ? atWordPieces(token, ctx) : undefined;
            if (elements != null) {
                words.push(...elements); // `"${X[@]}"`: one word per element
            } else if (params !== null) {
                // `"$@"`: one word per positional parameter; quoted `"$*"` joins them
                // with the first character of IFS (`IFS=; "$*"` runs them together).
                const joined = token.quoted && token.text.includes("*");
                words.push(
                    ...(joined
                        ? [new Word(params.join(starSeparator(ctx)))]
                        : params.map((p) => new Word(p))),
                );
            } else if (pieces != null) {
                for (const piece of pieces) {
                    words.push(...splitUnquoted(piece, await expandWord(piece, ctx, choice), ctx));
                }
            } else {
                for (const piece of braceExpand(token, ctx)) {
                    words.push(...splitUnquoted(piece, await expandWord(piece, ctx, choice), ctx));
                }
            }
        }
        index += 1;
    }

    const [stripped, environment] = stripPrelude(words, ctx);
    const aliased = await expandAlias(stripped, ctx, via, depth, indirect);
    if (aliased === undefined) {
        return;
    }
    ctx.pipedText = pipedText(ctx, pipeline, stage) ?? null;
    try {
        await builtinMutation(
            aliased.map((word) => word.text),
            redirects,
            ctx,
            environment,
        );
    } finally {
        ctx.pipedText = null;
    }
    words = await globWords(aliased, ctx);
    const head = words[0];
    if (head === undefined) {
        if (redirects.length > 0) {
            // `> file` and `X=1 > file` still open (and truncate) the file.
            ctx.result.commands.push(
                new SimpleCommand({
                    argv: [],
                    redirects,
                    via,
                    wrappers: [],
                    dynamicHead: false,
                    indirect,
                    pipeline,
                    stage,
                    cwd: ctx.cwd,
                    cwdOptions: ctx.cwdOptions,
                }),
            );
        }
        return;
    }
    const argv = words.map((w) => w.text);
    await emit(argv, redirects, ctx, via, depth, indirect, pipeline, stage, head.dynamic, [], environment);
}

/** What the stage before this one prints, when it echoes known text. */
function pipedText(ctx: Context, pipeline: number, stage: number): string | undefined {
    const previous = feeder(ctx, pipeline, stage);
    if (
        previous === undefined ||
        previous.dynamicHead ||
        previous.via.length > 0 ||
        previous.redirects.length > 0
    ) {
        return undefined;
    }
    return previous.name === "echo" || previous.name === "printf"
        ? (commandOutput(previous) ?? undefined)
        : undefined;
}

/**
 * Parse the command substitutions in this command's words, left to right.
 *
 * They run when this command is reached, so they see the directory and
 * variables left by the commands before it (`cd ~/.claude && echo $(...)`,
 * `X=rm; echo $($X ...)`). Each runs in a subshell: a `cd` inside does not
 * move the caller.
 */
async function runSubstitutions(
    tokens: readonly Token[],
    ctx: Context,
    via: readonly string[],
    depth: number,
    indirect: boolean,
): Promise<void> {
    for (const token of tokens) {
        if (!(token instanceof Word)) continue;
        for (const [index, body] of token.substitutions.entries()) {
            const guard = token.guards.get(index);
            if (guard !== undefined && branchSkipped(guard, ctx)) {
                // `X=ok; echo "${X:-$(cmd)}"`: bash never runs cmd. It is still
                // checked, as text the agent did not type to run, so it asks.
                await parseInto(
                    body,
                    ctx,
                    [...via, `\${${guard[0]}${guard[1]}$(...)} (not taken)`],
                    depth + 1,
                    true,
                );
                continue;
            }
            // A subshell: parseInto restores the caller's directory and variables.
            await parseInto(body, ctx, [...via, "$(...)"], depth + 1, indirect);
        }
    }
    const words = tokens.filter((t): t is Word => t instanceof Word);
    const expressions = words.flatMap((word) => arithmeticExpressions(word.text));
    const first = words[0];
    if (first !== undefined && first.text === "let" && !first.quoted) {
        expressions.push(...words.slice(1).map((word) => word.text)); // `let EXPR...`
    }
    for (const expression of expressions) {
        for (const body of arithmeticSubstitutions(expression, ctx)) {
            // `$((X))` with X='a[$(cmd)]': evaluating X runs cmd.
            await parseInto(body, ctx, [...via, "$((variable))"], depth + 1, indirect);
        }
    }
}

/**
 * Whether `${NAME<op>word}` certainly does not expand `word` here: NAME's
 * every possible value picks NAME itself (`-`, `=`, `?`) or nothing (`+`).
 * An unknown NAME may pick either, so it is not skipped.
 */
function branchSkipped(guard: readonly [string, string], ctx: Context): boolean {
    const [name, op] = guard;
    let values: readonly string[];
    if (isDigit(name) || name === "@" || name === "*" || name === "#") {
        const params = positionals(ctx);
        if (params === null) {
            return false;
        }
        const position = Number(name);
        values = [
            name === "#"
                ? String(params.length)
                : name === "@" || name === "*"
                  ? params.join(" ")
                  : 0 < position && position <= params.length
                    ? (params[position - 1] as string)
                    : UNSET,
        ];
    } else if (ctx.variables.has(targetName(name, ctx))) {
        values = ctx.variables.get(targetName(name, ctx)) as readonly string[];
    } else if (name === "HOME") {
        values = [ctx.host.home];
    } else {
        return false;
    }

    const selectsWord = (value: string): boolean => {
        const isSet = value !== UNSET && (value !== "" || !op.startsWith(":"));
        return op.endsWith("+") ? isSet : !isSet;
    };

    return !values.some(selectsWord);
}

const BARE_NAME = /(?<![$\w{#!])([A-Za-z_][A-Za-z0-9_]*)/g;
const HEAD_REFERENCE = /\$\{?[#!]?([A-Za-z_][A-Za-z0-9_]*)/g;

/** Identifiers `text` uses other than right after `$` / `${`. */
function bareNames(text: string): Set<string> {
    return new Set([...text.matchAll(new RegExp(BARE_NAME.source, "g"))].map((match) => match[1] as string));
}

/** Whether an unresolved program name refers to a variable the line sets. */
function computedHere(head: string, ctx: Context): boolean {
    return [...head.matchAll(new RegExp(HEAD_REFERENCE.source, "g"))].some((match) =>
        ctx.setNames.has(match[1] as string),
    );
}

/**
 * Unwrap `argv`, record the resulting command, and parse anything it runs.
 *
 * `environment` holds the command's prefix assignments (`X=1 cmd`): visible
 * to what cmd runs (`X=1 sh -c 'echo $X'`), gone once cmd returns.
 */
export async function emit(
    argv: readonly string[],
    redirects: readonly Redirect[],
    ctx: Context,
    via: readonly string[],
    depth: number,
    indirect: boolean,
    pipeline: number,
    stage: number,
    dynamicHead: boolean,
    wrappers: readonly string[],
    environment: readonly string[] = [],
): Promise<void> {
    // The caller's variables, once the command has an environment of its own.
    const caller: Variables[] = [];
    for (const text of environment) {
        ownAssign(text, ctx, caller);
    }
    try {
        await unwrapAndRecord(
            argv,
            redirects,
            ctx,
            via,
            depth,
            indirect,
            pipeline,
            stage,
            dynamicHead,
            wrappers,
            caller,
        );
    } finally {
        const outer = caller[0];
        if (outer !== undefined) {
            // The command's own environment reached what it runs, and is gone now.
            ctx.variables = outer;
        }
    }
}

async function unwrapAndRecord(
    initialArgv: readonly string[],
    redirects: readonly Redirect[],
    ctx: Context,
    via: readonly string[],
    depth: number,
    indirect: boolean,
    pipeline: number,
    stage: number,
    initialDynamicHead: boolean,
    initialWrappers: readonly string[],
    caller: Variables[],
): Promise<void> {
    let argv = [...initialArgv];
    let dynamicHead = initialDynamicHead;
    let wrappers = initialWrappers;
    let outer: readonly [typeof ctx.cwd, typeof ctx.cwdOptions] | undefined;
    let exhausted = true;
    for (let round = 0; round < MAX_UNWRAP; round += 1) {
        while (argv.length > 0 && ASSIGNMENT.test(argv[0] as string)) {
            // `env A=b cmd`, `sudo A=b cmd`: A is in cmd's environment.
            ownAssign(argv[0] as string, ctx, caller);
            argv = argv.slice(1);
        }
        const head = argv[0];
        if (head === undefined) {
            return;
        }
        const finds = findsFunctions(wrappers);
        argv = [
            executable(head, ctx, finds, finds || wrappers[wrappers.length - 1] === "command"),
            ...argv.slice(1),
        ];
        const name = programName(argv[0] as string);
        const step = await unwrapOnce(name, argv, ctx, via, depth, indirect);
        if (step === undefined) {
            exhausted = false;
            break;
        }
        let [inner, label, chdir] = step;
        if (name === "xargs" && inner !== null && inner.length > 0) {
            // Arguments xargs reads from a statically known feeder join the command.
            const runs = xargsRuns(argv.slice(1), inner, feeder(ctx, pipeline, stage), ctx);
            for (const extra of runs.slice(1)) {
                await emit(extra, [], ctx, via, depth, indirect, pipeline, stage, false, [
                    ...wrappers,
                    label,
                ]);
            }
            inner = runs[0] as string[];
        }
        if (chdir !== null) {
            // `env -C dir cmd`, `sudo -D dir cmd`: cmd (and what it runs) starts in dir.
            outer = outer ?? [ctx.cwd, ctx.cwdOptions];
            const directory = chdir;
            ctx.cwd = changeDirectory(ctx.cwd, directory, ctx.host.home);
            ctx.cwdOptions = [
                ...new Set(ctx.cwdOptions.map((o) => changeDirectory(o, directory, ctx.host.home))),
            ];
        }
        if (inner === null) {
            // The wrapper is a query (`command -v rm`) or ran a string we
            // already parsed; record the wrapper itself and stop.
            exhausted = false;
            break;
        }
        argv = inner;
        wrappers = [...wrappers, label];
        dynamicHead = false;
    }
    if (exhausted) {
        ctx.result.truncated = true; // more nested wrappers than are unwrapped
    }

    const head = argv[0];
    if (dynamicHead && head !== undefined && computedHere(head, ctx)) {
        // The program is computed from a variable this line sets, in a way not
        // modelled (`declare -A X; X[k]=rm; ${X[k]}`): what runs is not known.
        ctx.result.truncated = true;
    }
    const command = new SimpleCommand({
        argv,
        redirects,
        via,
        wrappers,
        dynamicHead,
        indirect,
        pipeline,
        stage,
        cwd: ctx.cwd,
        cwdOptions: ctx.cwdOptions,
        environment: [...ctx.variables.entries()],
    });
    ctx.result.commands.push(command);
    if ((command.name === "return" || command.name === "exit") && !command.dynamicHead) {
        // `return`, `then return`, `command return`: the enclosing function or
        // sourced script ends here; `exit` ends the whole shell.
        ctx.returned = true;
        ctx.exited = ctx.exited || command.name === "exit";
    }
    recordWrittenFile(command, ctx);
    await recordCreatedPaths(command, ctx);
    await recordLink(command, ctx);
    await parsePayloads(command, ctx, depth);
    await callFunction(command, ctx, depth);
    if (outer !== undefined) {
        [ctx.cwd, ctx.cwdOptions] = outer; // the wrapper's directory applied to the child only
    } else {
        followDirectoryChange(command, ctx);
    }
}

/**
 * Whether the shell looks a command name up as a function: not behind
 * `command`/`builtin`, which skip functions, or a program such as `sudo`,
 * `env` or `xargs`, which runs an executable (`time` is a keyword).
 */
function findsFunctions(wrappers: readonly string[]): boolean {
    return wrappers.every((w) => w === "time");
}

/**
 * Calling a declared function runs its body here, in this shell, with the
 * call's arguments as $1..$n: `f(){ "$1" -rf x; }; f rm` runs rm.
 */
async function callFunction(command: SimpleCommand, ctx: Context, depth: number): Promise<void> {
    if (command.dynamicHead || !findsFunctions(command.wrappers)) {
        return;
    }
    const keys = ctx.variables.get(FUNCTION + command.name) ?? [];
    const bodies = declaredBodies(keys, ctx);
    if (bodies.length === 0) {
        await callNotFoundHandler(command, ctx, depth);
        return;
    }
    if (ctx.calling.has(command.name)) {
        return;
    }
    if (depth >= MAX_DEPTH) {
        ctx.result.truncated = true;
        return;
    }
    const conditional = ctx.conditional;
    // `f(){ rm; }; false && f(){ echo; }`: each body the name may run, each as a
    // run that may not happen.
    ctx.conditional = conditional || keys.length > 1;
    try {
        for (const body of bodies) {
            await replayBody(body, command, ctx, depth);
        }
    } finally {
        ctx.conditional = conditional;
    }
}

const NOT_FOUND_HANDLER = "command_not_found_handle";
// Names bash never looks up in PATH, so they never reach command_not_found_handle.
const BASH_BUILTINS: ReadonlySet<string> = new Set([
    ":",
    ".",
    "[",
    "alias",
    "bg",
    "bind",
    "break",
    "builtin",
    "caller",
    "cd",
    "command",
    "compgen",
    "complete",
    "compopt",
    "continue",
    "declare",
    "dirs",
    "disown",
    "echo",
    "enable",
    "eval",
    "exec",
    "exit",
    "export",
    "false",
    "fc",
    "fg",
    "getopts",
    "hash",
    "help",
    "history",
    "jobs",
    "kill",
    "let",
    "local",
    "logout",
    "mapfile",
    "popd",
    "printf",
    "pushd",
    "pwd",
    "read",
    "readarray",
    "readonly",
    "return",
    "set",
    "shift",
    "shopt",
    "source",
    "suspend",
    "test",
    "times",
    "trap",
    "true",
    "type",
    "typeset",
    "ulimit",
    "umask",
    "unalias",
    "unset",
    "wait",
]);

/**
 * A command bash cannot find runs `command_not_found_handle NAME ARGS...`,
 * in a separate environment: nothing it sets reaches the caller. Whether the
 * program exists is not known here, so every external command may run it.
 */
async function callNotFoundHandler(command: SimpleCommand, ctx: Context, depth: number): Promise<void> {
    const head = command.argv[0];
    if (head === undefined || head.includes("/") || BASH_BUILTINS.has(command.name)) {
        return;
    }
    const keys = ctx.variables.get(FUNCTION + NOT_FOUND_HANDLER) ?? [];
    const bodies = declaredBodies(keys, ctx);
    if (bodies.length === 0 || ctx.calling.has(NOT_FOUND_HANDLER)) {
        return;
    }
    if (depth >= MAX_DEPTH) {
        ctx.result.truncated = true;
        return;
    }
    const call = command.with({ argv: [NOT_FOUND_HANDLER, ...command.argv] });
    const saved = ctx.saveState();
    const savedExited = ctx.exited;
    const savedConditional = ctx.conditional;
    ctx.conditional = true; // only if the program is missing
    try {
        for (const body of bodies) {
            await replayBody(body, call, ctx, depth);
        }
    } finally {
        ctx.restoreState(saved);
        ctx.exited = savedExited;
        ctx.conditional = savedConditional;
    }
}

/** `[ctx.functions[key] for key in keys if key != UNSET]`: the bodies a function name may run. */
function declaredBodies(keys: readonly string[], ctx: Context): Array<readonly BodyStep[]> {
    return keys
        .filter((key) => key !== UNSET)
        .map((key) => ctx.functions.get(key))
        .filter((body): body is BodyStep[] => body !== undefined);
}

/** The lexer tokens of a declared body step (stored as `unknown` in the model). */
function bodyTokens(step: BodyStep): Token[] {
    return step.tokens.filter((t): t is Token => t instanceof Word || t instanceof Operator);
}

/** Run one function body for `command`'s call. */
async function replayBody(
    body: readonly BodyStep[],
    command: SimpleCommand,
    ctx: Context,
    depth: number,
): Promise<void> {
    const callerPositionals = ctx.variables.get(POSITIONALS);
    const conditional = ctx.conditional;
    const before = copyVariables(ctx.variables);
    ctx.variables.set(POSITIONALS, [command.args.join(FIELD)]);
    ctx.calling.add(command.name);
    ctx.localScopes.push(new Set());
    try {
        let mayHaveReturned = false;
        for (const step of body) {
            // After a `return` that may have run (`cmd && return`), the rest may not.
            ctx.conditional = conditional || step.conditional || mayHaveReturned;
            const saved = step.isolated ? ctx.saveState() : undefined;
            ctx.returned = false;
            await runSegment(
                bodyTokens(step),
                ctx,
                [...command.via, `${command.name}()`],
                depth + 1,
                command.indirect,
                ctx.nextPipeline(),
                0,
            );
            if (saved !== undefined) {
                ctx.restoreState(saved);
            }
            if ((ctx.returned || ctx.exited) && !step.isolated) {
                if (!step.conditional && !mayHaveReturned) {
                    break; // `return` / `exit`: nothing after it in the body runs
                }
                // One that may not have run (`false && exit`) leaves the rest possible,
                // in the body and, for `exit`, in the caller.
                ctx.exited = false;
                mayHaveReturned = true;
            } else if (step.isolated) {
                ctx.exited = false; // `exit` in a pipeline stage ends only that subshell
            }
        }
    } finally {
        // `local` variables give the caller its own values back.
        for (const name of ctx.localScopes.pop() ?? []) {
            for (const key of new Set([
                ...variableKeys(name, before),
                ...variableKeys(name, ctx.variables),
            ])) {
                const earlier = before.get(key);
                if (earlier !== undefined) {
                    ctx.variables.set(key, earlier);
                } else {
                    ctx.variables.delete(key);
                }
            }
        }
        ctx.calling.delete(command.name);
        ctx.conditional = conditional;
        ctx.returned = false;
        // The caller's positional parameters come back when the function returns.
        if (callerPositionals === undefined) {
            ctx.variables.delete(POSITIONALS);
        } else {
            ctx.variables.set(POSITIONALS, callerPositionals);
        }
    }
}
