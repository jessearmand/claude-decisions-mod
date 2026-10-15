/**
 * The parser's data: what it returns (SimpleCommand, ParseResult, ...), the
 * context it threads through a command line, and the variable table.
 *
 * Variables hold every value they may have, the latest first; `UNSET` means
 * "may be unset". Positional parameters live under `@`, joined with `\x1f`,
 * array elements under `X[N]`. Part of the parser; import from `parse.ts`.
 *
 * Ported from shell_model.py. Names follow the Python module: `_assign` is
 * `assign`, `_Context` is `Context`; everything a sibling stage imports is
 * exported here.
 */

import type { Host } from "../host/host.ts";
import { escapeRegExp } from "../util/text.ts";

export const MAX_DEPTH = 6;
export const MAX_UNWRAP = 16;
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
/** A parameter reference: `$NAME`, `${NAME}`, `${NAME:-default}` and the like. */
export const REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/;
/** `_NAME.fullmatch(x)` in Python: anchored here. */
export const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `_NAME` used to search inside text (not anchored). */
export const NAME_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/g;

export const ELEMENT = /^([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]$/;

export const UNRESOLVED = /\$|`/;

/** Program text a source resolver found but could not inspect (too large). */
export const SOURCE_TOO_LARGE = "\0too-large";
/**
 * Positional parameters (`set -- a b`) live in the variable table under this
 * name, joined by FIELD, so subshells and branches treat them like variables.
 */
export const POSITIONALS = "@";
export const FIELD = "\x1f";
/** Starts the value of a compound array assignment; the elements follow, FIELD-separated. */
export const ARRAY = "\x1e";

/** Shell options (`shopt -s xpg_echo`) live in the variable table under these names, value "on". */
export const SHELL_OPTION = "\0shopt:";
/** Descriptors `exec 3<<< text` opened for later reads: "\0fd:3" holds the text not read yet. */
export const DESCRIPTOR = "\0fd:";
/** `declare -u X` / `-l`: "\0case:X" holds "u" or "l", applied when X is assigned. */
export const CASE = "\0case:";
/** `readonly X` / `declare -r X`: "\0readonly:X" holds "on"; later assignments fail. */
export const READONLY = "\0readonly:";
/** `hash -p /bin/rm x`: "\0hash:x" holds the program x runs (UNSET: looked up in PATH). */
export const HASHED = "\0hash:";
/** `alias x=rm`: "\0alias:x" holds the replacement text (UNSET: no alias). */
export const ALIAS = "\0alias:";
/** `declare -n R=X`: "\0ref:R" holds X (UNSET: R is a plain variable). */
export const NAMEREF = "\0ref:";
/** `f() { ...; }`: "\0func:f" holds a key of Context.functions (UNSET: no function). */
export const FUNCTION = "\0func:";
// Each lives in the variable table, so a definition in a subshell does not reach
// the caller, and one in a branch that may not run leaves the earlier one possible.

/** A variable value meaning "may be unset" (`true || unset X`). */
export const UNSET = "\0unset";

/** Every value each variable may hold, the latest first. */
export type Variables = Map<string, readonly string[]>;

export function copyVariables(variables: Variables): Variables {
    return new Map(variables);
}

export interface Redirect {
    readonly op: string;
    readonly target: string;
    readonly dynamic: boolean;
    /** heredoc body, when op is << or <<- */
    readonly body?: string;
    /** `3< file`: the descriptor named; undefined is the default (0 or 1) */
    readonly fd?: number;
}

export function redirect(op: string, target: string, dynamic = false, body?: string, fd?: number): Redirect {
    return { op, target, dynamic, body, fd };
}

/** `cwd` is `null` when a `cd` target is computed at run time (`cd "$DIR"`). */
export type Directory = string | null;

/** `(name, values)` pairs: the values each variable may hold when a command starts. */
export type Environment = ReadonlyArray<readonly [string, readonly string[]]>;

export interface SimpleCommandFields {
    readonly argv: readonly string[];
    readonly redirects: readonly Redirect[];
    /** How this command was reached, outermost first: ("bash -c",), ("$(...)",). */
    readonly via: readonly string[];
    readonly wrappers: readonly string[];
    /** argv[0] is computed at run time (`$CMD -rf x`, `$(which rm) ...`). */
    readonly dynamicHead: boolean;
    /** Parsed from a file the command executes, not typed by the agent. */
    readonly indirect: boolean;
    readonly pipeline: number;
    readonly stage: number;
    /** Directory the command runs in, following `cd`/`pushd` earlier in the same line. */
    readonly cwd: Directory;
    /**
     * Every directory it might run in. A `cd` can fail (missing directory) and
     * `cd a || cd b` runs only one of them, so earlier directories stay possible.
     */
    readonly cwdOptions: readonly Directory[];
    /**
     * Values each variable may hold when the command starts: its prefix
     * assignments (`X=1 cmd`) and assignments earlier in the line. Programs that
     * read a variable by name (`git --config-env=key=VAR`) look it up here.
     */
    readonly environment: Environment;
}

/** One program invocation, wrappers removed. */
export class SimpleCommand implements SimpleCommandFields {
    readonly argv: readonly string[];
    readonly redirects: readonly Redirect[];
    readonly via: readonly string[];
    readonly wrappers: readonly string[];
    readonly dynamicHead: boolean;
    readonly indirect: boolean;
    readonly pipeline: number;
    readonly stage: number;
    readonly cwd: Directory;
    readonly cwdOptions: readonly Directory[];
    readonly environment: Environment;

    constructor(fields: Partial<SimpleCommandFields> & Pick<SimpleCommandFields, "argv">) {
        this.argv = fields.argv;
        this.redirects = fields.redirects ?? [];
        this.via = fields.via ?? [];
        this.wrappers = fields.wrappers ?? [];
        this.dynamicHead = fields.dynamicHead ?? false;
        this.indirect = fields.indirect ?? false;
        this.pipeline = fields.pipeline ?? 0;
        this.stage = fields.stage ?? 0;
        this.cwd = fields.cwd ?? null;
        this.cwdOptions = fields.cwdOptions ?? [];
        this.environment = fields.environment ?? [];
    }

    /** `dataclasses.replace(command, ...)`. */
    with(changes: Partial<SimpleCommandFields>): SimpleCommand {
        return new SimpleCommand({ ...this.fields(), ...changes });
    }

    fields(): SimpleCommandFields {
        return {
            argv: this.argv,
            redirects: this.redirects,
            via: this.via,
            wrappers: this.wrappers,
            dynamicHead: this.dynamicHead,
            indirect: this.indirect,
            pipeline: this.pipeline,
            stage: this.stage,
            cwd: this.cwd,
            cwdOptions: this.cwdOptions,
            environment: this.environment,
        };
    }

    get possibleCwds(): readonly Directory[] {
        return this.cwdOptions.length > 0 ? this.cwdOptions : [this.cwd];
    }

    get name(): string {
        return this.argv.length > 0 ? programName(this.argv[0] as string) : "";
    }

    get args(): readonly string[] {
        return this.argv.slice(1);
    }

    rendered(): string {
        return this.argv.join(" ");
    }

    origin(): string {
        return this.via.join(" → ");
    }

    /** Whether shell option `name` (`shopt -s name`) may be on for this command. */
    optionOn(name: string): boolean {
        return this.envValues(SHELL_OPTION + name).includes("on");
    }

    /** Every value `name` may hold in this command's environment; [] if unknown. */
    envValues(name: string): readonly string[] {
        const entry = this.environment.find(([key]) => key === name);
        return (entry?.[1] ?? []).filter((value) => value !== UNSET);
    }
}

/** A string parsed as shell code beyond the top level. */
export interface NestedSource {
    readonly text: string;
    readonly via: readonly string[];
    readonly indirect: boolean;
}

/** Literal text a command line wrote to a file before running it. */
export interface WrittenFile {
    readonly text: string;
    /** False when the line only appended (`>>`, `tee -a`): what was on disk comes first. */
    readonly replaces: boolean;
}

export type WrittenFiles = Map<string, WrittenFile>;

export class ParseResult {
    commands: SimpleCommand[] = [];
    /**
     * Every string that was parsed as shell code beyond the top level, with
     * how it was reached. Regex-based guards rescan these.
     */
    nestedSources: NestedSource[] = [];
    /** Files the line writes from literal text before using them (see Context.writtenFiles). */
    writtenFiles: WrittenFiles = new Map();
    /** Symlinks and hard links the line creates: absolute link path -> absolute target. */
    links: Map<string, string> = new Map();
    /** (command, label) for program text a command runs that was too large to read. */
    skippedSources: Array<readonly [SimpleCommand, string]> = [];
    unparseable = false;
    truncated = false;

    /** The command whose stdout feeds `command` through a pipe, if any. */
    previousStage(command: SimpleCommand): SimpleCommand | undefined {
        if (command.stage === 0) return undefined;
        return this.commands.find(
            (candidate) => candidate.pipeline === command.pipeline && candidate.stage === command.stage - 1,
        );
    }
}

/** `/usr/bin/sudo` -> `sudo`; `\rm` was already unescaped by the lexer. */
export function programName(token: string): string {
    const index = token.lastIndexOf("/");
    return index < 0 ? token : token.slice(index + 1);
}

/** `(program text, label)` pairs a command would execute from disk. */
export type SourceText = readonly [text: string, label: string];

/**
 * A source resolver maps (command, cwd, files written earlier in the same
 * command line) to program text it executes from disk, e.g. the body of
 * `./deploy.sh` or the `build` script in package.json. It reads through the
 * host, so it is asynchronous.
 */
export type SourceResolver = (
    command: SimpleCommand,
    cwd: string,
    written: WrittenFiles,
    host: Host,
) => Promise<SourceText[]>;

export const MAX_CWD_OPTIONS = 8;

/** A handler `trap` installed in a shell. */
export interface Trap {
    readonly handler: string;
    readonly via: readonly string[];
    readonly depth: number;
    readonly indirect: boolean;
    /** EXIT (or 0): runs when the shell ends */
    readonly onExit: boolean;
    /** a signal, ERR or RETURN: may run after any later command */
    readonly onSignal: boolean;
    /** DEBUG: runs before every later simple command */
    readonly onDebug: boolean;
    /**
     * The shell state it was last checked in (variables, directories, files the
     * line wrote, links and copies), serialized; checked again when any of that changes.
     */
    checked: string | null;
}

/** One command of a function body, as declared. `tokens` are lexer tokens (Word | Operator). */
export interface BodyStep<Token = unknown> {
    readonly tokens: readonly Token[];
    /** a pipeline stage or background command: its own subshell */
    readonly isolated: boolean;
    /** after && / || or inside an if/loop in the body */
    readonly conditional: boolean;
}

/** `(cwd, cwd_options, variables)` a shell saves and restores around a subshell or body. */
export interface ShellState {
    readonly cwd: Directory;
    readonly cwdOptions: readonly Directory[];
    readonly variables: Variables;
}

export class Context {
    result: ParseResult;
    /** Current directory as the line runs; null once a computed `cd` makes it unknown. */
    cwd: Directory;
    sources: SourceResolver | null;
    host: Host;
    /** Every directory the line might be in at this point (see possibleCwds). */
    cwdOptions: readonly Directory[];
    pipelineCounter = 0;
    /**
     * Every value each variable may hold, the latest assignment first. An
     * assignment that may not run (`A && X=1`, an `if` body) keeps the old values.
     */
    variables: Variables = new Map();
    /** The command being parsed may not run: assignments add values, not replace them. */
    conditional = false;
    /** Declared function bodies, replayed at each call: key -> the body's commands. */
    functions: Map<string, BodyStep[]> = new Map();
    /** functions being replayed (no recursion) */
    calling: Set<string> = new Set();
    /** Names declared `local` in each function call being replayed, innermost last. */
    localScopes: Array<Set<string>> = [];
    /**
     * Files this command line writes from literal text before running them:
     * `cat > x.sh <<'EOF' ... EOF; bash x.sh`. Absolute path -> content.
     */
    writtenFiles: WrittenFiles = new Map();
    /** aliases being expanded (no recursion) */
    expanding: Set<string> = new Set();
    /** `cp /bin/rm x`: x is now that program (absolute paths); links are in result.links. */
    copies: Map<string, string> = new Map();
    /**
     * What the previous pipeline stage prints, while a builtin in the next stage
     * reads it (`printf r | read X`); null when not known.
     */
    pipedText: string | null = null;
    /**
     * Absolute paths this line creates (`touch -- -rf`, `cp`, `ln`, `mkdir`, `> f`), which
     * later globs can match; `createdUnknown`: one was created under a computed name.
     */
    createdPaths: Set<string> = new Set();
    createdUnknown = false;
    /**
     * Names the parsed text uses other than as `$NAME` (`X=...`, `read X`,
     * `declare -A X`): variables this line sets, as opposed to the environment's.
     */
    setNames: Set<string> = new Set();
    /** A `return` ran in the step being parsed; the enclosing function call or sourced script decides what it ends. */
    returned = false;
    /** An `exit` ran: the shell it ends stops there (its EXIT traps then run). */
    exited = false;
    /** `set -x` is on: bash expands $PS4 (and any `$(...)` in it) before each command. */
    xtrace = false;
    /** PS4 values already parsed */
    tracedPrompts: Set<string> = new Set();
    /** Per shell, innermost last: the trap handlers it installed. */
    trapFrames: Trap[][] = [[]];
    /** a signal handler is being checked (no re-entry) */
    trapping = false;
    /**
     * The (index, line) records the last `mapfile` read, one list per stream it
     * may have read; null when its input is not known. Its -C callback runs on them.
     */
    mapfileRecords: Array<Array<readonly [number, string]>> | null = null;

    constructor(
        result: ParseResult,
        cwd: Directory,
        sources: SourceResolver | null,
        host: Host,
        cwdOptions: readonly Directory[] = [],
    ) {
        this.result = result;
        this.cwd = cwd;
        this.sources = sources;
        this.host = host;
        this.cwdOptions = cwdOptions;
    }

    /** What a signal handler's meaning can depend on, serialized to tell when it changed. */
    trapState(): string {
        return JSON.stringify([
            [...this.variables.entries()],
            this.cwd,
            this.cwdOptions,
            [...this.writtenFiles.entries()],
            [...this.copies.entries()],
            [...this.result.links.entries()],
        ]);
    }

    nextPipeline(): number {
        this.pipelineCounter += 1;
        return this.pipelineCounter;
    }

    saveState(): ShellState {
        return { cwd: this.cwd, cwdOptions: this.cwdOptions, variables: copyVariables(this.variables) };
    }

    restoreState(state: ShellState): void {
        this.cwd = state.cwd;
        this.cwdOptions = state.cwdOptions;
        this.variables = state.variables;
    }
}

/** The positional parameters `set --` gave this line, or null if unknown. */
export function positionals(ctx: Context): readonly string[] | null {
    const values = ctx.variables.get(POSITIONALS);
    if (!values || values.length === 0 || values[0] === UNSET) return null;
    const first = values[0] as string;
    return first === "" ? [] : first.split(FIELD);
}

/**
 * (index, current value) of every element of array `name`, by index; a
 * scalar is element 0. null when nothing about `name` is known.
 */
export function arrayItems(name: string, variables: Variables): Array<readonly [number, string]> | null {
    const prefix = `${name}[`;
    let items: Array<readonly [number, string]> = [];
    for (const [key, values] of variables) {
        if (key.startsWith(prefix) && key.endsWith("]")) {
            const index = key.slice(prefix.length, -1);
            if (/^\d+$/.test(index)) items.push([Number(index), values[0] as string]);
        }
    }
    items.sort((a, b) => a[0] - b[0]);
    if (items.length === 0 && variables.has(name)) {
        items = [[0, (variables.get(name) as readonly string[])[0] as string]];
    }
    if (items.length === 0) return null;
    return items.filter(([, value]) => value !== UNSET);
}

/**
 * The variable `name` stands for: through `declare -n` references. A
 * reference that may not have been made leaves the analysis incomplete; the
 * most recent possibility is followed.
 */
export function targetName(name: string, ctx: Context): string {
    let current = name;
    for (let step = 0; step < 8; step += 1) {
        const targets = settings(ctx.variables, NAMEREF + current);
        if (targets.length === 0) break;
        if ((ctx.variables.get(NAMEREF + current) as readonly string[]).length > 1)
            ctx.result.truncated = true;
        current = targets[0] as string;
    }
    return current;
}

/**
 * Every table entry that belongs to variable `name`: its value, its
 * elements, and its case attribute and `declare -n` reference.
 */
export function variableKeys(name: string, variables: Variables): string[] {
    return [...variables.keys()].filter(
        (key) => key === name || key === CASE + name || key === NAMEREF + name || key.startsWith(`${name}[`),
    );
}

/**
 * The values a pseudo-variable (ALIAS, NAMEREF, HASHED, FUNCTION) may hold
 * that are set: [] when it is surely unset.
 */
export function settings(variables: Variables, key: string): readonly string[] {
    return (variables.get(key) ?? []).filter((value) => value !== UNSET);
}

/**
 * Set a pseudo-variable whose absence means `defaultValue` (no attribute, no
 * alias): in a branch that may not run, the default stays possible.
 */
export function assignSetting(
    key: string,
    value: string,
    defaultValue: string,
    variables: Variables,
    conditional: boolean,
): void {
    if (conditional && !variables.has(key)) variables.set(key, [defaultValue]);
    assign(`${key}=${value}`, variables, conditional);
}

export function withCase(value: string, attribute: string): string {
    return attribute === "l" ? value.toLowerCase() : attribute === "u" ? value.toUpperCase() : value;
}

/**
 * Remember `NAME=value` (already expanded); `NAME+=value` appends.
 *
 * `keepPrevious` is for an assignment that may not run: the variable may
 * still hold any of its earlier values.
 */
export function assign(text: string, variables: Variables, keepPrevious = false): void {
    const separator = text.indexOf("=");
    let name = separator < 0 ? text : text.slice(0, separator);
    const value = separator < 0 ? "" : text.slice(separator + 1);
    const append = name.endsWith("+");
    name = append ? name.slice(0, -1) : name;
    if (value.startsWith(ARRAY) && NAME.test(name)) {
        const items = value.length > 1 ? value.slice(1).split(FIELD) : [];
        assignArray(name, items, append, variables, keepPrevious);
        return;
    }
    const element = ELEMENT.exec(name);
    // `X[2]=v` sets element X[2]; element 0 is also plain $X, as in bash.
    const keys: string[] = element ? [`${element[1]}[${Number(element[2])}]`] : [];
    if (!element || Number(element[2]) === 0) keys.push(name.split("[", 1)[0] as string);
    for (const key of keys) {
        let keep = keepPrevious;
        if (!key.startsWith("\0")) {
            const protectedValues = variables.get(READONLY + (key.split("[", 1)[0] as string)) ?? [];
            if (protectedValues.length === 1 && protectedValues[0] === "on") continue; // `readonly X; X=echo`: bash refuses
            if (protectedValues.includes("on")) keep = true; // may be readonly: the old value may remain
        }
        let values: string[] = append
            ? (variables.get(key) ?? [""]).map((earlier) => (earlier === UNSET ? "" : earlier) + value)
            : [value];
        if (value !== UNSET && !key.startsWith("\0")) {
            // `declare -u X; X=rm` stores RM: the case changes on assignment, once for each attribute X may have.
            const attributes = variables.get(CASE + (key.split("[", 1)[0] as string)) ?? [""];
            values = values.flatMap((v) => attributes.map((a) => withCase(v, a)));
        }
        if (keep) values = [...values, ...(variables.get(key) ?? [])];
        // Not capped: every value stays possible. Their number is bounded by the
        // assignments written in the command line itself.
        variables.set(key, [...new Set(values)]);
    }
}

const INDEXED = /^\[(\d+)\]=([\s\S]*)$/;

/**
 * `X=(a b)` sets X[0]=a, X[1]=b (and $X is X[0]); `X+=(c)` appends after the
 * last element; `[N]=v` sets element N.
 */
export function assignArray(
    name: string,
    items: readonly string[],
    append: boolean,
    variables: Variables,
    keepPrevious: boolean,
): void {
    const elementKey = new RegExp(`^${escapeRegExp(name)}\\[(\\d+)\\]$`);
    let indexes = [...variables.keys()].flatMap((key) => {
        const match = elementKey.exec(key);
        return match ? [Number(match[1])] : [];
    });
    if (!append && !keepPrevious) {
        for (const key of [...variables.keys()]) {
            if (key === name || key.startsWith(`${name}[`)) variables.delete(key);
        }
        indexes = [];
    }
    let position = append && indexes.length > 0 ? Math.max(...indexes) + 1 : 0;
    for (const original of items) {
        let item = original;
        const indexed = INDEXED.exec(item);
        if (indexed) {
            position = Number(indexed[1]);
            item = indexed[2] as string;
        }
        assign(`${name}[${position}]=${item}`, variables, keepPrevious);
        position += 1;
    }
}

/** Distinct directory options; past the limit, the rest become unknown (null). */
export function bounded(options: readonly Directory[]): readonly Directory[] {
    const distinct = [...new Set(options)];
    if (distinct.length > MAX_CWD_OPTIONS) return [...distinct.slice(0, MAX_CWD_OPTIONS - 1), null];
    return distinct;
}

export function at(args: readonly string[], index: number): string | undefined {
    return index < args.length ? args[index] : undefined;
}
