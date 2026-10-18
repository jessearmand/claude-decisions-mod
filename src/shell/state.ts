/**
 * Builtins and assignments that change the shell's state for later commands:
 * `X=v` (and before special builtins), `export`/`declare` with attributes,
 * `alias`, `read`, `set --`, `shift`, `unset`, `printf -v`, `for` variables.
 * Part of shell_parse; import from there.
 *
 * Ported from shell_state.py.
 */

import { expanduser, join, unique } from "../util/paths.ts";
import { isDigit, partition, rstripChars, shellQuote, stripChars } from "../util/text.ts";
import { echoedText, GLOB_CHARS, ifsValues } from "./expand.ts";
import { globPaths } from "./glob.ts";
import * as shellIfs from "./ifs.ts";
import { HEREDOC_OPERATORS, lex, Word } from "./lexer.ts";
import {
    ALIAS,
    ASSIGNMENT,
    assign,
    assignSetting,
    at,
    CASE,
    type Context,
    DESCRIPTOR,
    ELEMENT,
    FIELD,
    FUNCTION,
    HASHED,
    NAME,
    NAMEREF,
    POSITIONALS,
    positionals,
    READONLY,
    type Redirect,
    SHELL_OPTION,
    SimpleCommand,
    targetName,
    UNSET,
    type Variables,
    variableKeys,
} from "./model.ts";
import { parseInto } from "./parse.ts";
import { inputFileText, producedText } from "./streams.ts";
import { RESERVED_PREFIXES } from "./wrappers.ts";

/** `(words, assignments)`: what is left of a command and its prefix assignments. */
export type Prelude = readonly [words: Word[], assignments: readonly string[]];

/**
 * Drop reserved words and leading assignments.
 *
 * `X=rm` on its own sets X for the rest of the line. `X=echo true` only puts
 * X in `true`'s environment: it is returned, applied to what `true` runs,
 * and not remembered afterwards.
 */
export function stripPrelude(words: readonly Word[], ctx: Context): Prelude {
    let index = 0;
    const assignments: string[] = [];
    while (index < words.length) {
        const word = words[index] as Word;
        const reserved = RESERVED_PREFIXES.has(word.text) && !word.quoted;
        const timeFlag = word.text === "-p" && index > 0 && (words[index - 1] as Word).text === "time";
        if (word.text === "function" && !word.quoted) {
            // `function name { body; }`: the body is parsed like any other command list.
            index += 2;
        } else if (reserved || timeFlag) {
            index += 1;
        } else if (ASSIGNMENT.test(word.text)) {
            assignments.push(word.text);
            index += 1;
        } else {
            break;
        }
    }
    const rest = words.slice(index);
    if (rest.length === 0) {
        for (const text of assignments) {
            assign(throughNameref(text, ctx), ctx.variables, ctx.conditional);
        }
        return [rest, []];
    }
    const first = rest[0] as Word;
    if (SPECIAL_BUILTINS.has(first.text) && !first.quoted) {
        persistPrefix(assignments, rest, ctx);
    }
    // `export X=rm` / `readonly X=...` / `declare X=...`: also an assignment.
    if (["export", "readonly", "declare", "typeset", "local"].includes(first.text)) {
        const flags = rest
            .slice(1)
            .filter((w) => w.text.startsWith("-") && !w.quoted)
            .map((w) => w.text.slice(1))
            .join("");
        // `declare -g X=v` in a function sets the global X, not a local one.
        if (
            ctx.localScopes.length > 0 &&
            (first.text === "local" || (["declare", "typeset"].includes(first.text) && !flags.includes("g")))
        ) {
            declareLocals(rest.slice(1), ctx);
        }
        for (const word of declareAttributes(first.text, rest.slice(1), ctx)) {
            if (ASSIGNMENT.test(word.text)) {
                assign(throughNameref(word.text, ctx), ctx.variables, ctx.conditional);
            }
        }
        markReadonly(first.text, rest.slice(1), ctx);
    }
    return [rest, assignments];
}

/** `readonly X=v` / `declare -r X`: X keeps its value from here on. */
function markReadonly(builtin: string, words: readonly Word[], ctx: Context): void {
    const flags = words
        .filter((w) => w.text.startsWith("-"))
        .map((w) => w.text.slice(1))
        .join("");
    if (
        builtin !== "readonly" &&
        !(["declare", "typeset", "local"].includes(builtin) && flags.includes("r"))
    ) {
        return;
    }
    if (builtin === "readonly" && (flags.includes("f") || flags.includes("p"))) {
        return; // `readonly -f NAME` marks a function; `-p` only prints
    }
    for (const word of words) {
        const name = rstripChars(word.text.split("=", 1)[0] as string, "+");
        if (!word.text.startsWith("-") && NAME.test(name)) {
            // `declare -r R` on a nameref makes the variable R names readonly;
            // `declare -rn R=X` makes the reference itself readonly.
            const target = flags.includes("n") ? name : targetName(name, ctx);
            assignSetting(`${READONLY}${target}`, "on", "", ctx.variables, ctx.conditional);
        }
    }
}

// POSIX special builtins: assignments before them stay in the shell (sh, dash,
// bash --posix). Plain bash keeps them only when `export`/`readonly` names them.
const SPECIAL_BUILTINS: ReadonlySet<string> = new Set([
    ":",
    ".",
    "source",
    "break",
    "continue",
    "eval",
    "exec",
    "exit",
    "export",
    "readonly",
    "return",
    "set",
    "shift",
    "times",
    "trap",
    "unset",
]);

/**
 * `X=r export X` keeps X=r in every shell; `X=r :` keeps it in POSIX shells
 * only, so there the value is one possibility beside the old one.
 */
function persistPrefix(assignments: readonly string[], rest: readonly Word[], ctx: Context): void {
    const first = rest[0] as Word;
    const named = new Set<string>(
        first.text === "export" || first.text === "readonly"
            ? rest.slice(1).map((w) => w.text.split("=", 1)[0] as string)
            : [],
    );
    for (const text of assignments) {
        const name = rstripChars(text.split("=", 1)[0] as string, "+");
        const certain = named.has(name);
        if (!certain && !ctx.variables.has(name)) {
            ctx.variables.set(name, [UNSET]);
        }
        assign(throughNameref(text, ctx), ctx.variables, ctx.conditional || !certain);
    }
}

/**
 * `local X`, `local -u X`, `declare -n R=Y` inside a function: each name
 * shadows the caller's variable (elements and attributes included) until the
 * function returns; without a value it starts out unset.
 */
function declareLocals(words: readonly Word[], ctx: Context): void {
    const scope = ctx.localScopes[ctx.localScopes.length - 1];
    if (scope === undefined) return;
    for (const word of words) {
        if (word.text.startsWith("-") || word.text.startsWith("+")) {
            continue;
        }
        const name = rstripChars((word.text.split("=", 1)[0] as string).split("[", 1)[0] as string, "+");
        if (!NAME.test(name)) {
            continue;
        }
        scope.add(name);
        if (!word.text.includes("=")) {
            for (const key of variableKeys(name, ctx.variables)) {
                ctx.variables.set(key, key.startsWith(CASE) ? [""] : [UNSET]);
            }
            ctx.variables.set(name, [UNSET]); // `local X`: a new, unset X
        }
    }
}

/** `NAME=value` with NAME replaced by the variable it refers to (`declare -n`). */
function throughNameref(text: string, ctx: Context): string {
    const [name, equals, value] = partition(text, "=");
    const base = rstripChars(name.split("[", 1)[0] as string, "+");
    const target = targetName(base, ctx);
    return target === base ? text : target + name.slice(base.length) + equals + value;
}

/**
 * `alias x=/bin/rm; x -rf v` runs `/bin/rm -rf v`. Bash expands aliases only
 * with `expand_aliases` (sh, zsh and interactive shells always do), so a known
 * alias is applied whatever the mode. An alias that is a plain word list
 * replaces the command word; one holding operators or expansions is parsed as
 * command text with the arguments appended (undefined: nothing left to emit).
 */
export async function expandAlias(
    words: Word[],
    ctx: Context,
    via: readonly string[],
    depth: number,
    indirect: boolean,
): Promise<Word[] | undefined> {
    // re-entry: parsed as a command list
    const first = words[0];
    if (first === undefined || first.quoted || first.dynamic) {
        return words;
    }
    const name = first.text;
    const replacements = ctx.variables.get(ALIAS + name) ?? [UNSET];
    if ((replacements.length === 1 && replacements[0] === UNSET) || ctx.expanding.has(name)) {
        return words;
    }
    if (replacements.length > 1) {
        // `alias x=rm; false && alias x=echo`: each definition may be the one in force.
        await expandEachAlias(name, replacements, words, ctx, via, depth, indirect);
        return undefined;
    }
    const replacement = replacements[0] as string;
    const lexed = lex(replacement);
    const tokens = lexed.tokens;
    ctx.expanding.add(name);
    try {
        const plain = tokens.filter((t): t is Word => t instanceof Word);
        if (
            tokens.length > 0 &&
            !lexed.unterminated &&
            lexed.substitutions.length === 0 &&
            plain.length === tokens.length &&
            plain.every((t) => !t.dynamic)
        ) {
            return await expandAlias([...plain, ...words.slice(1)], ctx, via, depth, indirect);
        }
        await parseInto(
            [replacement, ...words.slice(1).map((w) => shellQuote(w.text))].join(" "),
            ctx,
            [...via, `alias ${name}`],
            depth + 1,
            indirect,
            { sharesShell: true },
        );
    } finally {
        ctx.expanding.delete(name);
    }
    return undefined;
}

/**
 * Parse the command once per definition the alias may have (the plain
 * command when it may have none), each as a run that may not happen.
 */
async function expandEachAlias(
    name: string,
    replacements: readonly string[],
    words: readonly Word[],
    ctx: Context,
    via: readonly string[],
    depth: number,
    indirect: boolean,
): Promise<void> {
    // re-entry: parsed as a command list
    const args = words.slice(1).map((w) => shellQuote(w.text));
    const conditional = ctx.conditional;
    ctx.expanding.add(name);
    ctx.conditional = true;
    try {
        for (const replacement of replacements) {
            const head = replacement === UNSET ? shellQuote(name) : replacement;
            await parseInto([head, ...args].join(" "), ctx, [...via, `alias ${name}`], depth + 1, indirect, {
                sharesShell: true,
            });
        }
    } finally {
        ctx.expanding.delete(name);
        ctx.conditional = conditional;
    }
}

/** `alias NAME=VALUE...` defines; `unalias NAME...` / `unalias -a` removes. */
function defineAliases(args: readonly string[], ctx: Context): void {
    for (const arg of args) {
        const [name, equals, value] = partition(arg, "=");
        if (equals && name && !name.startsWith("-")) {
            assignSetting(`${ALIAS}${name}`, value, UNSET, ctx.variables, ctx.conditional);
        }
    }
}

/**
 * Apply `declare`/`typeset`/`local` attribute flags; the words left to assign.
 *
 * `-n` makes a name refer to another variable, `-l`/`-u` change the case of
 * every value, `-i` makes it a number (never a command name). Other flags
 * (arrays, export, readonly, scope) do not change what a value expands to.
 * A computed flag word is not known, so the analysis is incomplete.
 */
function declareAttributes(builtin: string, words: readonly Word[], ctx: Context): Word[] {
    let flags = "";
    let rest = [...words];
    while (rest.length > 0) {
        const head = rest[0] as Word;
        const leading = head.text.slice(0, 1);
        if (!((leading === "-" || leading === "+") && head.text.length > 1 && !head.text.includes("=")))
            break;
        if (head.dynamic) {
            ctx.result.truncated = true;
        }
        if (head.text.startsWith("-")) {
            flags += head.text.slice(1);
        }
        rest = rest.slice(1);
    }
    if (builtin === "export" || !flags) {
        return rest;
    }
    const remaining: Word[] = [];
    for (const word of rest) {
        const [rawName, equals, value] = partition(word.text, "=");
        const name = rstripChars(rawName.split("[", 1)[0] as string, "+");
        if (!NAME.test(name)) {
            remaining.push(word);
            continue;
        }
        if (flags.includes("n")) {
            if (equals && NAME.test(value)) {
                assignSetting(`${NAMEREF}${name}`, value, UNSET, ctx.variables, ctx.conditional);
            } else {
                // The referenced name is not known (a function body before its call
                // binds `$1`): what the reference reads is unknown.
                assign(`${NAMEREF}${name}=${UNSET}`, ctx.variables, ctx.conditional);
                ctx.variables.delete(name);
            }
            continue;
        }
        // Attributes on a nameref apply to the variable it names (`declare -l R`).
        const target = targetName(name, ctx);
        for (const letter of "lu") {
            if (flags.includes(letter)) {
                assignSetting(`${CASE}${target}`, letter, "", ctx.variables, ctx.conditional);
            }
        }
        if (flags.includes("i")) {
            ctx.variables.delete(target); // integer: whatever is assigned evaluates to a number
            continue;
        }
        remaining.push(word);
    }
    return remaining;
}

/**
 * Builtins that set or clear a variable: `printf -v X FMT ARGS`, `unset X`,
 * `set -- ARGS`, `read X <<< TEXT`. `environment` is the command's own
 * prefix assignments (`IFS=, read A B`).
 */
export async function builtinMutation(
    argv: readonly string[],
    redirects: readonly Redirect[],
    ctx: Context,
    environment: readonly string[] = [],
): Promise<void> {
    const head = argv[0];
    if (head === "read") {
        await readBuiltin(argv.slice(1), redirects, ctx, ifsValues(ctx, environment));
    } else if (head === "mapfile" || head === "readarray") {
        await mapfileBuiltin(argv.slice(1), redirects, ctx);
    } else if (head === "alias") {
        defineAliases(argv.slice(1), ctx);
    } else if (head === "unalias") {
        const names = argv.slice(1).includes("-a")
            ? [...ctx.variables.keys()].filter((k) => k.startsWith(ALIAS)).map((k) => k.slice(ALIAS.length))
            : argv.slice(1);
        for (const name of names) {
            assign(`${ALIAS}${name}=${UNSET}`, ctx.variables, ctx.conditional);
        }
    } else if (argv.length >= 2 && (head === "for" || head === "select") && NAME.test(argv[1] as string)) {
        // `for X in a b; do ... done`: X takes each word, or keeps its value if the
        // list is empty (or the loop may not run). `select` sets X to "" for an
        // invalid choice. Without `in`, the words are the positional parameters.
        const name = argv[1] as string;
        const items: readonly string[] | null =
            argv.length >= 3 && argv[2] === "in" ? argv.slice(3) : positionals(ctx);
        if (items === null) {
            ctx.variables.delete(name);
        } else {
            const earlier = items.length === 0 || ctx.conditional ? (ctx.variables.get(name) ?? [UNSET]) : [];
            const invalid = head === "select" ? [""] : [];
            ctx.variables.set(name, unique([...items, ...invalid, ...earlier]));
        }
    } else if (
        argv.length >= 4 &&
        head === "printf" &&
        argv[1] === "-v" &&
        (NAME.test(argv[2] as string) || ELEMENT.test(argv[2] as string))
    ) {
        // `printf -v X ...` or an array element, `printf -v 'X[0]' ...`.
        const variable = argv[2] as string;
        const text = echoedText(new SimpleCommand({ argv: ["printf", ...argv.slice(3)] }));
        const target = NAME.test(variable) ? targetName(variable, ctx) : variable;
        if (text || !(argv[3] as string).includes("%")) {
            assign(`${target}=${text}`, ctx.variables, ctx.conditional);
        } else {
            // A format we do not model: the value is unknown, and so is what runs with it.
            ctx.variables.delete(target);
            ctx.result.truncated = true;
        }
    } else if (head === "getopts" && argv.length >= 3) {
        getoptsBuiltin(argv[1] as string, argv[2] as string, argv.slice(3), ctx);
    } else if (argv.length === 1 && head === "exec") {
        await execRedirects(redirects, ctx);
    } else if (head === "shopt") {
        shoptBuiltin(argv.slice(1), ctx);
    } else if (head === "hash") {
        await hashBuiltin(argv.slice(1), ctx);
    } else if (head === "shift") {
        // `shift N`: $N+1 becomes $1; past the last parameter nothing changes.
        const params = positionals(ctx);
        const count = argv.length > 1 ? (argv[1] as string) : "1";
        if (!isDigit(count)) {
            ctx.variables.delete(POSITIONALS);
        } else if (params !== null && Number(count) <= params.length) {
            assign(
                `${POSITIONALS}=${params.slice(Number(count)).join(FIELD)}`,
                ctx.variables,
                ctx.conditional,
            );
        }
    } else if (head === "set") {
        const params = setPositionals(argv.slice(1));
        if (params !== undefined) {
            assign(`${POSITIONALS}=${params.join(FIELD)}`, ctx.variables, ctx.conditional);
        }
    } else if (head === "unset" && argv.slice(1).includes("-f")) {
        for (const name of argv.slice(1).filter((a) => !a.startsWith("-"))) {
            assign(`${FUNCTION}${name}=${UNSET}`, ctx.variables, ctx.conditional); // `unset -f f`
        }
    } else if (head === "unset") {
        for (const name of argv.slice(1)) {
            const protection = ctx.variables.get(READONLY + name);
            if (ELEMENT.test(name)) {
                assign(`${name}=${UNSET}`, ctx.variables, ctx.conditional); // `unset 'X[0]'`: that element
            } else if (
                NAME.test(name) &&
                protection !== undefined &&
                protection.length === 1 &&
                protection[0] === "on"
            ) {
                // a readonly variable cannot be unset
            } else if (NAME.test(name)) {
                // `unset X`: the variable, every element if it is an array, and its case attribute.
                const keys = [...ctx.variables.keys()].filter(
                    (k) => k === name || k === CASE + name || k.startsWith(`${name}[`),
                );
                for (const key of keys) {
                    assign(`${key}=${UNSET}`, ctx.variables, ctx.conditional);
                }
                assign(`${name}=${UNSET}`, ctx.variables, ctx.conditional);
            }
        }
    }
}

const READ_OPTIONS_WITH_VALUE = new Set("adinNptu");

type Options = Map<string, string>;

/**
 * `read`'s options (letter -> value, "" for flags) and its variable names.
 * Clusters take their value from the rest of the word or the next one: `-rn1`.
 */
function readOptions(args: readonly string[]): [Options, string[]] {
    const options: Options = new Map();
    let index = 0;
    while (index < args.length) {
        const arg = args[index] as string;
        if (arg === "--") {
            return [options, args.slice(index + 1)];
        }
        if (!arg.startsWith("-") || arg === "-") {
            return [options, args.slice(index)];
        }
        for (let offset = 2; offset <= arg.length; offset += 1) {
            const letter = arg[offset - 1] as string;
            if (READ_OPTIONS_WITH_VALUE.has(letter)) {
                let rest = arg.slice(offset);
                if (!rest) {
                    index += 1;
                    rest = at(args, index) || "";
                }
                options.set(letter, rest);
                break;
            }
            options.set(letter, "");
        }
        index += 1;
    }
    return [options, []];
}

/**
 * `read A B <<< "x y z"` sets A=x, B="y z", splitting by each value IFS may
 * hold. Input that is not literal text (a pipe, the terminal) makes the
 * variables unknown.
 */
async function readBuiltin(
    args: readonly string[],
    redirects: readonly Redirect[],
    ctx: Context,
    ifs: readonly string[],
): Promise<void> {
    const [options, found] = readOptions(args);
    const delimiter = options.has("d") ? (options.get("d") as string).slice(0, 1) || "\0" : "\n";
    const given = [...found];
    if (options.has("a")) {
        given.unshift(options.get("a") as string);
    }
    // A name, or an array element (`read 'X[0]'`).
    let names = given
        .filter((n) => NAME.test(n) || ELEMENT.test(n))
        .map((n) => (NAME.test(n) ? targetName(n, ctx) : n));
    if (names.length === 0) names = ["REPLY"];
    const timeout = options.get("t");
    if (timeout !== undefined && /^0*\.?0*$/.test(timeout) && stripChars(timeout, ".")) {
        return; // `read -t 0`: only tests for input; nothing is read or assigned
    }
    const saved = ctx.conditional;
    if (timeout !== undefined && !/^(?:\d*\.?\d+|\d+\.)$/.test(timeout)) {
        ctx.conditional = true; // a computed timeout may be 0: the variables may keep their values
    }
    try {
        await eachStream(execDescriptor(redirects, ctx, descriptorOption(options)), ctx, () =>
            readAssign(args, options, names, delimiter, redirects, ctx, ifs),
        );
    } finally {
        ctx.conditional = saved;
    }
}

/** The assignments `read` makes once its options are known. */
async function readAssign(
    _args: readonly string[],
    options: Options,
    names: readonly string[],
    delimiter: string,
    redirects: readonly Redirect[],
    ctx: Context,
    ifs: readonly string[],
): Promise<void> {
    const countOption = options.has("N") ? "N" : options.has("n") ? "n" : undefined;
    if (countOption !== undefined && !isDigit(options.get(countOption) as string)) {
        for (const name of names) {
            ctx.variables.delete(name); // `read -n "$K"`: how much is read is not known
        }
        return;
    }
    const [text, persisted] = await stdinText(redirects, ctx, descriptorOption(options));
    const array = options.has("a");
    if (text === undefined) {
        for (const name of names) {
            ctx.variables.delete(name);
        }
        return;
    }
    // `-n K`: at most K characters of the line; `-N K`: exactly K, delimiter or not.
    const limit = countOption !== undefined ? Number(options.get(countOption)) : undefined;
    const [line, consumed] = readLine(text, delimiter, options.has("r"), limit, countOption === "N");
    if (persisted !== undefined) {
        // Reading from a descriptor `exec` opened takes what was read off it.
        assign(`${DESCRIPTOR}${persisted}=${text.slice(consumed)}`, ctx.variables, ctx.conditional);
    }
    if (countOption === "N") {
        // No field splitting: the first name takes it all.
        names.forEach((name, position) => {
            assign(`${name}=${position === 0 ? line : ""}`, ctx.variables, ctx.conditional);
        });
        return;
    }
    ifs.forEach((value, reading) => {
        // Another possible IFS gives another possible value; earlier readings stay possible.
        const keep = ctx.conditional || reading > 0;
        if (array) {
            // `read -a X <<< "a b"`: X[0]=a, X[1]=b (and $X is X[0]).
            const name = names[0] as string;
            if (reading === 0) {
                for (const key of [...ctx.variables.keys()]) {
                    if (key === name || key.startsWith(`${name}[`)) ctx.variables.delete(key);
                }
            }
            shellIfs.split(line, value).forEach((item, position) => {
                assign(`${name}[${position}]=${item}`, ctx.variables, keep);
            });
            return;
        }
        const fields = shellIfs.split(line, value, names.length);
        names.forEach((name, position) => {
            assign(`${name}=${position < fields.length ? fields[position] : ""}`, ctx.variables, keep);
        });
    });
}

// Where getopts is inside a cluster such as `-rf`: "OPTIND:offset".
const GETOPTS_POSITION = "\0getopts";

/**
 * `getopts OPTSTRING NAME [ARGS]`: the next option from ARGS (or the
 * positional parameters) into NAME, its argument into OPTARG, and OPTIND
 * past it, as bash does (`set -- -r; getopts r X` sets X=r). Unknown
 * parameters or OPTIND make NAME unknown.
 */
function getoptsBuiltin(optstring: string, name: string, args: readonly string[], ctx: Context): void {
    const params = args.length > 0 ? args : positionals(ctx);
    const optindValues = ctx.variables.get("OPTIND") ?? ["1"];
    if (
        params === null ||
        !NAME.test(name) ||
        optindValues.length !== 1 ||
        !isDigit(optindValues[0] as string)
    ) {
        for (const key of [name, "OPTARG", "OPTIND"]) {
            ctx.variables.delete(key);
        }
        return;
    }
    const optind = Number(optindValues[0]);
    const stored = ((ctx.variables.get(GETOPTS_POSITION) ?? [""])[0] as string).split(":");
    const offset = stored.length === 2 && stored[0] === String(optind) ? Number(stored[1]) : 1;
    const silent = optstring.startsWith(":");
    const keep = ctx.conditional;
    const index = optind - 1;
    const current = params[index];
    if (current === undefined || !current.startsWith("-") || current === "-" || current === "--") {
        // No more options: NAME=?, OPTARG unset, OPTIND past `--` or at most $#+1.
        const end = current === "--" ? optind + 1 : Math.min(optind, params.length + 1);
        assign(`${name}=?`, ctx.variables, keep);
        assign(`OPTARG=${UNSET}`, ctx.variables, keep);
        assign(`OPTIND=${end}`, ctx.variables, keep);
        return;
    }
    const word = current;
    const letter = offset < word.length ? (word[offset] as string) : "?";
    const known = letter !== ":" && optstring.includes(letter);
    const takesArgument =
        known && optstring.slice(optstring.indexOf(letter) + 1, optstring.indexOf(letter) + 2) === ":";
    let result = known ? letter : "?";
    let optarg: string | undefined;
    let nextOptind = optind;
    let nextOffset = offset + 1;
    if (takesArgument) {
        nextOffset = 1;
        if (offset + 1 < word.length) {
            optarg = word.slice(offset + 1);
            nextOptind = optind + 1;
        } else if (index + 1 < params.length) {
            optarg = params[index + 1];
            nextOptind = optind + 2;
        } else {
            result = silent ? ":" : "?";
            optarg = silent ? letter : undefined;
            nextOptind = optind + 1;
        }
    } else if (!known && silent) {
        optarg = letter;
    }
    if (!takesArgument && nextOffset >= word.length) {
        nextOptind = optind + 1;
        nextOffset = 1;
    }
    assign(`${name}=${result}`, ctx.variables, keep);
    assign(`OPTARG=${optarg === undefined ? UNSET : optarg}`, ctx.variables, keep);
    assign(`OPTIND=${nextOptind}`, ctx.variables, keep);
    assign(`${GETOPTS_POSITION}=${nextOptind}:${nextOffset}`, ctx.variables, keep);
}

/**
 * `shopt -s NAME...` / `-u`: options that change what later commands do
 * (`xpg_echo`, `lastpipe`), kept in the variable table.
 */
function shoptBuiltin(args: readonly string[], ctx: Context): void {
    const flags = args.filter((a) => a.startsWith("-"));
    const setting = flags.includes("-s") ? "on" : flags.includes("-u") ? "off" : undefined;
    if (setting === undefined || flags.includes("-o")) {
        return;
    }
    for (const name of args.filter((a) => !a.startsWith("-"))) {
        assign(`${SHELL_OPTION}${name}=${setting}`, ctx.variables, ctx.conditional);
    }
}

/**
 * `hash -p PATH NAME...` makes NAME run PATH; `-d NAME` forgets it, `-r` all.
 * Kept in the variable table, so a mapping in a branch that may not run
 * leaves the earlier one possible too.
 */
async function hashBuiltin(args: readonly string[], ctx: Context): Promise<void> {
    if (args.includes("-r")) {
        for (const key of [...ctx.variables.keys()].filter((k) => k.startsWith(HASHED))) {
            assign(`${key}=${UNSET}`, ctx.variables, ctx.conditional);
        }
    }
    if (args.includes("-d")) {
        for (const name of args.slice(args.indexOf("-d") + 1)) {
            assign(`${HASHED}${name}=${UNSET}`, ctx.variables, ctx.conditional);
        }
    }
    if (args.includes("-p") && args.indexOf("-p") + 1 < args.length) {
        let path = args[args.indexOf("-p") + 1] as string;
        if (GLOB_CHARS.test(path) && ctx.cwd !== null) {
            // `hash -p /bin/r[m] x`: the path is globbed like any argument.
            const matches = [
                ...(await globPaths(join(ctx.cwd, expanduser(path, ctx.host.home)), ctx.host, {
                    rootDir: ctx.cwd,
                })),
            ].sort();
            path = matches.length > 0 ? (matches[0] as string) : path;
        }
        for (const name of args.slice(args.indexOf("-p") + 2)) {
            if (!name.startsWith("-")) {
                assignSetting(`${HASHED}${name}`, path, UNSET, ctx.variables, ctx.conditional);
            }
        }
    }
}

const INPUT_OPERATORS: ReadonlySet<string> = new Set(["<", "<<<", "<&", "<>", ...HEREDOC_OPERATORS]);

/** The descriptor `read -u N` / `mapfile -u N` reads; 0 by default, undefined if computed. */
function descriptorOption(options: Options): number | undefined {
    const value = options.get("u");
    if (value === undefined) {
        return 0;
    }
    return isDigit(value) ? Number(value) : undefined;
}

/** `(text, descriptor)`: what a builtin reads, and the `exec`-opened descriptor it came from. */
type StreamText = readonly [text: string | undefined, descriptor: number | undefined];

/**
 * What a builtin reads from descriptor `fd`, when it is literal text, and
 * which descriptor `exec` opened it came from (undefined if from this command's own
 * redirects or a pipe). Sources: a here-string or heredoc, `< <(producer)`,
 * a file (written earlier on the line or on disk), `<&N`, the pipe feeding
 * stdin, or a descriptor `exec 3<<< text` opened earlier.
 *
 * Redirections apply in order, so the last one to `fd` is what is read:
 * `read X <<< echo <<< rm` reads rm.
 */
async function stdinText(
    redirects: readonly Redirect[],
    ctx: Context,
    fd: number | undefined = 0,
): Promise<StreamText> {
    if (fd === undefined) {
        return [undefined, undefined];
    }
    const opened = execDescriptor(redirects, ctx, fd);
    if (opened !== undefined) {
        return openedText(opened, ctx);
    }
    const inputs = redirects.filter((r) => INPUT_OPERATORS.has(r.op) && (r.fd ?? 0) === fd);
    const last = inputs[inputs.length - 1];
    if (last !== undefined) {
        return [await redirectText(last, ctx), undefined];
    }
    return [fd === 0 ? (ctx.pipedText ?? undefined) : undefined, undefined]; // `printf r | read X`
}

/**
 * The descriptor `exec` opened that reading `fd` takes from, if it is one:
 * `read -u3`, `read <&3`; undefined for this command's own input or a pipe.
 */
function execDescriptor(
    redirects: readonly Redirect[],
    ctx: Context,
    fd: number | undefined,
): number | undefined {
    if (fd === undefined) {
        return undefined;
    }
    const inputs = redirects.filter((r) => INPUT_OPERATORS.has(r.op) && (r.fd ?? 0) === fd);
    const last = inputs[inputs.length - 1];
    if (last !== undefined) {
        return last.op === "<&" && isDigit(last.target)
            ? sharedDescriptor(Number(last.target), ctx)
            : undefined;
    }
    if (fd === 0 && ctx.pipedText !== null) {
        return undefined;
    }
    return sharedDescriptor(fd, ctx);
}

/**
 * Run `read` against each stream descriptor `fd` may hold
 * (`false && exec 3<<< x` leaves the earlier one possible), each as a read
 * that may not happen; afterwards the descriptor holds what each left.
 */
async function eachStream(fd: number | undefined, ctx: Context, read: () => Promise<void>): Promise<void> {
    const key = `${DESCRIPTOR}${fd}`;
    const streams = fd !== undefined ? (ctx.variables.get(key) ?? []) : [];
    if (streams.length < 2) {
        await read();
        return;
    }
    const conditional = ctx.conditional;
    const remainders: string[] = [];
    ctx.conditional = true;
    try {
        for (const stream of streams) {
            ctx.variables.set(key, [stream]);
            await read();
            remainders.push((ctx.variables.get(key) ?? [UNSET])[0] as string);
        }
    } finally {
        ctx.conditional = conditional;
    }
    ctx.variables.set(key, unique(remainders));
}

// A descriptor `exec 4<&3` made holds "\0dup:3": it shares fd 3's stream and
// position, so reading either advances both.
const DUPLICATE = "\0dup:";

/** The descriptor whose stream `fd` reads: itself, or the one it duplicates. */
function sharedDescriptor(fd: number, ctx: Context): number {
    let current = fd;
    for (let step = 0; step < 8; step += 1) {
        const values = ctx.variables.get(`${DESCRIPTOR}${current}`) ?? [];
        if (values.length !== 1 || !(values[0] as string).startsWith(DUPLICATE)) {
            break;
        }
        current = Number((values[0] as string).slice(DUPLICATE.length));
    }
    return current;
}

export function openedText(fd: number, ctx: Context): StreamText {
    const shared = sharedDescriptor(fd, ctx);
    const values = ctx.variables.get(`${DESCRIPTOR}${shared}`);
    if (
        !values ||
        values.length === 0 ||
        values.length > 1 ||
        values[0] === UNSET ||
        (values[0] as string).startsWith(DUPLICATE)
    ) {
        // Closed, or several streams may be open (`false && exec 3<<< x`): unknown.
        return [undefined, undefined];
    }
    return [values[0] as string, shared];
}

/** The text an input redirection supplies, when it is known. */
async function redirectText(redirect: Redirect, ctx: Context): Promise<string | undefined> {
    if (redirect.op === "<<<") {
        return redirect.dynamic ? undefined : `${redirect.target}\n`;
    }
    if (HEREDOC_OPERATORS.has(redirect.op)) {
        return redirect.body;
    }
    if (redirect.op === "<" || redirect.op === "<>") {
        return redirect.dynamic ? undefined : inputText(redirect.target, ctx);
    }
    return undefined;
}

/**
 * `exec 3<<< text` / `exec < file` / `exec 3<&-`: with no command, exec's
 * redirections change this shell's descriptors for every later command.
 */
async function execRedirects(redirects: readonly Redirect[], ctx: Context): Promise<void> {
    for (const redirect of redirects) {
        if (!INPUT_OPERATORS.has(redirect.op) && redirect.op !== ">&") {
            continue;
        }
        const fd = redirect.fd ?? 0;
        if (redirect.op === ">&" && redirect.target !== "-") {
            continue;
        }
        let value: string;
        if (redirect.op === "<&" && isDigit(redirect.target)) {
            const source = sharedDescriptor(Number(redirect.target), ctx);
            if (source === fd) {
                continue; // `exec 3<&3`: unchanged
            }
            value = `${DUPLICATE}${source}`;
        } else {
            // `exec 3<&-` closes; anything else opens new text.
            const closing = redirect.target === "-" && (redirect.op === "<&" || redirect.op === ">&");
            const text = closing ? undefined : await redirectText(redirect, ctx);
            value = text === undefined ? UNSET : text;
        }
        detachDuplicates(fd, ctx);
        assign(`${DESCRIPTOR}${fd}=${value}`, ctx.variables, ctx.conditional);
    }
}

/**
 * Before `fd` is closed or reopened, its duplicates keep the stream they
 * share: the first takes it over and the rest now duplicate that one.
 */
function detachDuplicates(fd: number, ctx: Context): void {
    const marker = `${DUPLICATE}${fd}`;
    const duplicates = [...ctx.variables.entries()]
        .filter(([key, values]) => key.startsWith(DESCRIPTOR) && values.length === 1 && values[0] === marker)
        .map(([key]) => key);
    const owner = duplicates[0];
    if (owner === undefined) {
        return;
    }
    ctx.variables.set(owner, ctx.variables.get(`${DESCRIPTOR}${fd}`) ?? [UNSET]);
    for (const key of duplicates.slice(1)) {
        ctx.variables.set(key, [`${DUPLICATE}${owner.slice(DESCRIPTOR.length)}`]);
    }
}

/** `< <(echo rm)`: what the producer prints; `< file`: the file's text. */
async function inputText(target: string, ctx: Context): Promise<string | undefined> {
    const produced = await producedText(target, ctx);
    return produced !== undefined ? produced : inputFileText(target, ctx);
}

export const MAPFILE_WITH_VALUE: ReadonlySet<string> = new Set("dnOsucC");

/**
 * `mapfile -t X < <(printf 'a\\nb')` sets X[0]=a, X[1]=b. Without -O the array
 * is cleared first; -O N starts at N and keeps the rest; -s skips lines,
 * -n caps their number, -t drops each line's delimiter.
 */
async function mapfileBuiltin(
    args: readonly string[],
    redirects: readonly Redirect[],
    ctx: Context,
): Promise<void> {
    const options: Options = new Map();
    let index = 0;
    while (index < args.length && (args[index] as string).startsWith("-") && args[index] !== "-") {
        const arg = args[index] as string;
        if (arg === "--") {
            index += 1;
            break;
        }
        for (let offset = 2; offset <= arg.length; offset += 1) {
            const letter = arg[offset - 1] as string;
            if (MAPFILE_WITH_VALUE.has(letter)) {
                let value = arg.slice(offset);
                if (!value) {
                    index += 1;
                    value = index < args.length ? (args[index] as string) : "";
                }
                options.set(letter, value);
                break;
            }
            options.set(letter, "");
        }
        index += 1;
    }
    const name = index < args.length ? (args[index] as string) : "MAPFILE";
    if (!NAME.test(name)) {
        return;
    }
    ctx.mapfileRecords = [];
    await eachStream(execDescriptor(redirects, ctx, descriptorOption(options)), ctx, () =>
        mapfileAssign(name, options, redirects, ctx),
    );
}

/** The elements `mapfile` sets once its options are known. */
async function mapfileAssign(
    name: string,
    options: Options,
    redirects: readonly Redirect[],
    ctx: Context,
): Promise<void> {
    const numbers = new Map<string, string>();
    for (const k of "nOs") {
        const value = options.get(k);
        if (value !== undefined) numbers.set(k, value);
    }
    const [text, persisted] = await stdinText(redirects, ctx, descriptorOption(options));
    if (text !== undefined && persisted !== undefined) {
        assign(`${DESCRIPTOR}${persisted}=`, ctx.variables, ctx.conditional); // read to the end
    }
    if (text === undefined || ![...numbers.values()].every((v) => isDigit(v))) {
        // Input or counts not known: so are the elements.
        ctx.mapfileRecords = null;
        for (const key of [...ctx.variables.keys()]) {
            if (key === name || key.startsWith(`${name}[`)) ctx.variables.delete(key);
        }
        return;
    }
    const delimiter = options.has("d") ? (options.get("d") as string).slice(0, 1) || "\0" : "\n";
    let lines = text.split(delimiter).map((part) => part + delimiter);
    lines[lines.length - 1] = (lines[lines.length - 1] as string).slice(0, -1);
    lines = lines.filter((line) => line !== "").slice(Number(numbers.get("s") ?? "0"));
    const cap = numbers.get("n");
    if (cap !== undefined && Number(cap) > 0) {
        lines = lines.slice(0, Number(cap));
    }
    if (options.has("t")) {
        lines = lines.map((line) => (line.endsWith(delimiter) ? line.slice(0, -1) : line));
    }
    const origin = Number(numbers.get("O") ?? "0");
    if (!numbers.has("O") && !ctx.conditional) {
        for (const key of [...ctx.variables.keys()]) {
            if (key === name || key.startsWith(`${name}[`)) ctx.variables.delete(key);
        }
    }
    lines.forEach((line, offset) => {
        assign(`${name}[${origin + offset}]=${line}`, ctx.variables, ctx.conditional);
    });
    if (ctx.mapfileRecords !== null) {
        ctx.mapfileRecords.push(lines.map((line, offset) => [origin + offset, line] as const));
    }
}

/**
 * The line `read` takes from `text` and how many characters of input it
 * consumes: up to and including the first delimiter. Without -r a backslash
 * escapes the next character, an escaped delimiter does not end the line,
 * and backslash-newline joins the next line (`r\\<newline>m` is rm).
 * `limit` stops after that many characters of the line (`-n K`, an escape
 * counts once); `whole` also reads past delimiters (`-N K`).
 */
function readLine(
    text: string,
    delimiter: string,
    raw: boolean,
    limit?: number,
    whole = false,
): [string, number] {
    const out: string[] = [];
    let index = 0;
    while (index < text.length && (limit === undefined || out.length < limit)) {
        const char = text[index] as string;
        if (!raw && char === "\\" && index + 1 < text.length) {
            if (text[index + 1] !== "\n") {
                out.push(text[index + 1] as string);
            }
            index += 2;
            continue;
        }
        index += 1;
        if (char === delimiter && !whole) {
            break;
        }
        out.push(char);
    }
    return [out.join(""), index];
}

/** The new positional parameters of `set [options] [--] args`, or undefined if unchanged. */
function setPositionals(args: readonly string[]): string[] | undefined {
    let index = 0;
    while (index < args.length) {
        const arg = args[index] as string;
        if (arg === "--") {
            return args.slice(index + 1);
        }
        if (arg === "-o" || arg === "+o") {
            index += 2;
        } else if ((arg.startsWith("-") || arg.startsWith("+")) && arg.length > 1) {
            index += 1;
        } else {
            return args.slice(index);
        }
    }
    return undefined;
}

/**
 * Put `text` in the current command's environment only, copying the shell's
 * variables the first time so the caller's stay untouched.
 */
export function ownAssign(text: string, ctx: Context, caller: Variables[]): void {
    if (caller.length === 0) {
        caller.push(ctx.variables);
        ctx.variables = new Map(ctx.variables);
    }
    assign(text, ctx.variables);
}
