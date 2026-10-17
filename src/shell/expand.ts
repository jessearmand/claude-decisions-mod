/**
 * Word expansion as bash does it, for values the parser knows: brace and
 * pathname expansion, parameters (`$X`, `${X:-d}`, `${X%.bak}`, `${!X}`),
 * word splitting by IFS, literal `$(echo ...)`/`$(printf ...)` output and
 * `$(mktemp)`. What stays unknown stays as written and marks the word dynamic.
 * Part of parse.ts; import from there.
 *
 * Functions that reach the disk (pathname expansion) or re-enter the parser
 * (`$(echo ...)`) are asynchronous; the pure ones stay synchronous.
 *
 * Ported from shell_expand.py.
 */

import type { Host } from "../host/host.ts";
import { expanduser, isAbsolute, join, normpath } from "../util/paths.ts";
import { evaluate } from "./arith.ts";
import { fnmatch, globPaths } from "./glob.ts";
import { DEFAULT as IFS_DEFAULT, split as ifsSplit } from "./ifs.ts";
import { nestedSubstitutions, Word } from "./lexer.ts";
import {
    ARRAY,
    arrayItems,
    assign as assignVariable,
    type Context,
    FIELD,
    NAME,
    type ParseResult,
    positionals,
    SHELL_OPTION,
    type SimpleCommand,
    targetName,
    UNRESOLVED,
    UNSET,
} from "./model.ts";
import { apply as applyParameter } from "./params.ts";
import { parse } from "./parse.ts";
import { printedText } from "./printf.ts";

// `${NAME<op>word}` forms whose result is NAME's value or `word`.
const BRACED = /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]+\])?)(:?[-=+?])([\s\S]*)$/;

export const MAX_BRACE_WORDS = 64;

export const GLOB_CHARS = /[*?[]/;

/** `_NAME.match(text, index)`: the name starting exactly at `index`, if any. */
const NAME_AT = /[A-Za-z_][A-Za-z0-9_]*/y;
function nameAt(text: string, index: number): string | undefined {
    NAME_AT.lastIndex = index;
    return NAME_AT.exec(text)?.[0];
}

/** Python `str.isdigit()` for the ASCII digits `int()` accepts. */
function isDigits(text: string): boolean {
    return /^[0-9]+$/.test(text);
}

/** Python `len(text)`: code points, not UTF-16 units. */
function charCount(text: string): number {
    return Array.from(text).length;
}

/** The arithmetic in a word: each `$((expr))`, or the whole of `((expr))`. */
export function arithmeticExpressions(text: string): string[] {
    const found: string[] = [];
    if (text.startsWith("((") && text.endsWith("))")) found.push(text.slice(2, -2));
    let start = text.indexOf("$((");
    while (start >= 0) {
        let depth = 2;
        let index = start + 3;
        while (index < text.length && depth) {
            depth += text[index] === "(" ? 1 : text[index] === ")" ? -1 : 0;
            index += 1;
        }
        found.push(text.slice(start + 3, Math.max(index - 2, start + 3)));
        start = text.indexOf("$((", index);
    }
    return found;
}

const UNMODELLED_TRANSFORM = /\$\{[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?@[A-Za-z]\}/;
const SUBSCRIPTED = /^([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]$/;
const ARRAY_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\[([@*])\]\}$/;
const INTEGER = /^-?\d+$/;

/**
 * `X[N]` (negative N counts back from the last element), `X[@]`/`X[*]`
 * (every element, space-joined) or `X[#]` (their count), when X is known.
 */
function elementValue(name: string, subscript: string, ctx: Context): string | undefined {
    const items = arrayItems(name, ctx.variables);
    if (items === null) return undefined;
    if (subscript === "@" || subscript === "*") {
        return items.map(([, v]) => v).join(subscript === "*" ? starSeparator(ctx) : " ");
    }
    if (subscript === "#") return String(items.length);
    if (!INTEGER.test(subscript)) return undefined;
    let index = Number(subscript);
    if (index < 0) {
        const last = items[items.length - 1];
        index = last !== undefined ? last[0] + 1 + index : -1;
    }
    return index >= 0 ? items.find(([i]) => i === index)?.[1] : undefined;
}

/**
 * `"${X[@]}"`: one word per element; `"${X[*]}"` one word joining them;
 * unquoted, each element is split further. undefined if not that shape or X unknown.
 */
export function arrayWords(token: Word, ctx: Context): Word[] | undefined {
    const match = ARRAY_REFERENCE.exec(token.text);
    const items = match ? arrayItems(targetName(match[1] as string, ctx), ctx.variables) : null;
    if (match === null || items === null) return undefined;
    const values = items.map(([, v]) => v);
    if (token.quoted) {
        return match[2] === "*"
            ? [new Word(values.join(starSeparator(ctx)))]
            : values.map((v) => new Word(v));
    }
    const ifs = ifsValues(ctx)[0] as string;
    return values.flatMap((v) => ifsSplit(v, ifs).map((part) => new Word(part)));
}

/** `value(name, atStart)`: a variable's value, or undefined when it is not known. */
export type Lookup = (name: string, atStart: boolean) => string | undefined;

/**
 * An array subscript's value: bash integer arithmetic over known variables
 * (`i`, `$i`, `n-1`, `1&1`); undefined if any part is not known.
 */
function arithmeticIndex(expression: string, value: Lookup): bigint | undefined {
    return evaluate(expression, (name) => value(name, false));
}

const ARITHMETIC_NAME = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Command substitutions bash runs while evaluating `expression`: a variable
 * named in arithmetic is itself evaluated as arithmetic, so `X='a[$(cmd)]';
 * $((X))` runs cmd. Every known value of every variable named is followed.
 */
export function arithmeticSubstitutions(
    expression: string,
    ctx: Context,
    seen: ReadonlySet<string> = new Set(),
): string[] {
    const found: string[] = [];
    const names = new Set([...expression.matchAll(ARITHMETIC_NAME)].map((m) => m[0]));
    for (const name of names) {
        const values = ctx.variables.get(name);
        if (seen.has(name) || values === undefined) continue;
        for (const value of values) {
            if (value === UNSET) continue;
            found.push(...nestedSubstitutions(value));
            if (seen.size < 8) found.push(...arithmeticSubstitutions(value, ctx, new Set([...seen, name])));
        }
    }
    return [...new Set(found)];
}

/**
 * `r"$@"x` with $1=a $2=b is two words, `ra` and `bx`: each parameter is its own
 * word, the surrounding text joins the first and last. undefined if not that shape.
 */
export function atWordPieces(token: Word, ctx: Context): Word[] | undefined {
    // Shell syntax, not a template
    const marker = ["${@}", "$@"].find((m) => token.text.includes(m));
    const params = marker !== undefined ? positionals(ctx) : null;
    if (marker === undefined || params === null || token.text.split(marker).length !== 2) return undefined;
    const [prefix, suffix] = token.text.split(marker) as [string, string];
    let texts: string[];
    if (params.length === 0) texts = prefix || suffix ? [prefix + suffix] : [];
    else if (params.length === 1) texts = [prefix + params[0] + suffix];
    else texts = [prefix + params[0], ...params.slice(1, -1), params[params.length - 1] + suffix];
    return texts.map(
        (text) =>
            new Word(text, { dynamic: UNRESOLVED.test(text), quoted: token.quoted, splits: token.splits }),
    );
}

/**
 * Pathname expansion of unquoted words, in the directory the command runs in:
 * `/bin/r[m]` runs /bin/rm, and `rm -* x` next to a file named `-rf` is
 * `rm -rf x`. A pattern matching nothing stays literal, as in bash.
 */
export async function globWords(words: readonly Word[], ctx: Context): Promise<Word[]> {
    if (ctx.cwd === null) return [...words];
    const expanded: Word[] = [];
    for (const [index, word] of words.entries()) expanded.push(...(await globWord(word, ctx, index === 0)));
    return expanded;
}

async function globWord(word: Word, ctx: Context, commandWord = false): Promise<Word[]> {
    const cwd = ctx.cwd || "/";
    if (word.quoted || word.dynamic || !GLOB_CHARS.test(word.text)) return [word];
    if (ctx.createdUnknown && (commandWord || word.text.startsWith("-"))) {
        // A file made earlier under a computed name may match: as the program run, or
        // as an option. Other positions only gain an operand, which changes no verdict.
        ctx.result.truncated = true;
    }
    const onDisk = await globPaths(expanduser(word.text, ctx.host.home), ctx.host, { rootDir: cwd });
    const matches = [...new Set([...onDisk, ...createdMatches(word.text, cwd, ctx)])].sort();
    if (matches.length === 0) return [word];
    if (matches.length > MAX_BRACE_WORDS) {
        // Too many to list: keep the pattern, plus any match that reads as an option,
        // and in command position the first match, which is what runs. Incomplete.
        ctx.result.truncated = true;
        const head = commandWord ? [new Word(matches[0] as string)] : [];
        return [...head, word, ...matches.filter((m) => m.startsWith("-")).map((m) => new Word(m))];
    }
    return matches.map((m) => new Word(m));
}

/** `os.path.relpath(path, start)` for two absolute, normalized paths. */
function relpath(path: string, start: string): string {
    const pathParts = normpath(path)
        .split("/")
        .filter((p) => p !== "");
    const startParts = normpath(start)
        .split("/")
        .filter((p) => p !== "");
    let common = 0;
    while (
        common < pathParts.length &&
        common < startParts.length &&
        pathParts[common] === startParts[common]
    ) {
        common += 1;
    }
    const ups = Array.from({ length: startParts.length - common }, () => "..");
    const parts = [...ups, ...pathParts.slice(common)];
    return parts.length === 0 ? "." : parts.join("/");
}

/**
 * Paths created earlier on the line that `pattern` matches, segment by segment
 * as pathname expansion does (a leading `.` must be matched explicitly).
 */
function createdMatches(pattern: string, cwd: string, ctx: Context): string[] {
    const expanded = expanduser(pattern, ctx.host.home);
    const absolute = isAbsolute(expanded);
    const wanted = normpath(join(cwd, expanded)).split("/");
    const found: string[] = [];
    for (const path of ctx.createdPaths) {
        const parts = path.split("/");
        const matches =
            parts.length === wanted.length &&
            parts.every((part, index) => {
                const want = wanted[index] as string;
                return fnmatch(part, want) && (!part.startsWith(".") || want.startsWith("."));
            });
        if (matches) {
            const relative = relpath(path, cwd);
            // Written as the pattern was: `./x*` gives `./x1`.
            found.push(absolute ? path : expanded.startsWith("./") ? `./${relative}` : relative);
        }
    }
    return found;
}

/**
 * Brace expansion, which bash does first: `{rm,-rf,~/x}` is three words,
 * `a{b,c}d` is `abd acd`. Only unquoted braces and commas count.
 *
 * Past MAX_BRACE_WORDS, every alternative's text becomes a word of its own
 * (nothing is dropped, so `rm {x,...,-rf} v` still shows `-rf`) and the
 * parse is marked truncated.
 */
export function braceExpand(word: Word, ctx: Context): Word[] {
    if (word.braces.length === 0) return [word];
    let texts = expandBraceText(word.text, new Set(word.braces));
    if (texts.length > MAX_BRACE_WORDS) {
        ctx.result.truncated = true;
        texts = braceFragments(word.text, word.braces);
    }
    if (texts.length === 1) return [word];
    return texts.map(
        (text, index) =>
            new Word(text, {
                dynamic: word.dynamic && UNRESOLVED.test(text),
                quoted: word.quoted,
                splits: word.splits,
                substitutions: index === 0 ? word.substitutions : [],
            }),
    );
}

/** The text between unquoted braces and commas, each piece once. */
function braceFragments(text: string, braces: readonly number[]): string[] {
    const pieces: string[] = [];
    let start = 0;
    for (const position of [...braces, text.length]) {
        pieces.push(text.slice(start, position));
        start = position + 1;
    }
    return [...new Set(pieces.filter((piece) => piece))];
}

function expandBraceText(text: string, active: ReadonlySet<number>): string[] {
    const sorted = [...active].sort((a, b) => a - b);
    for (const start of sorted.filter((p) => text[p] === "{")) {
        let depth = 0;
        const commas: number[] = [];
        let end: number | undefined;
        for (const index of sorted.filter((p) => p >= start)) {
            if (text[index] === "{") {
                depth += 1;
            } else if (text[index] === "}") {
                depth -= 1;
                if (depth === 0) {
                    end = index;
                    break;
                }
            } else if (depth === 1) {
                commas.push(index);
            }
        }
        if (end === undefined || commas.length === 0) continue; // `{}`, `{x}` and unbalanced braces stay literal
        const prefix = text.slice(0, start);
        const suffix = text.slice(end + 1);
        const expanded: string[] = [];
        const bounds = [start, ...commas, end];
        for (let b = 0; b + 1 < bounds.length; b += 1) {
            const left = bounds[b] as number;
            const right = bounds[b + 1] as number;
            const piece = text.slice(left + 1, right);
            const moved = new Set<number>([
                ...sorted.filter((p) => p < start),
                ...sorted.filter((p) => left < p && p < right).map((p) => p - left - 1 + prefix.length),
                ...sorted.filter((p) => p > end).map((p) => p - end - 1 + prefix.length + piece.length),
            ]);
            expanded.push(...expandBraceText(prefix + piece + suffix, moved));
            if (expanded.length > MAX_BRACE_WORDS) break; // the caller falls back to fragments
        }
        return expanded;
    }
    return [text];
}

/** `choice` picks the value of a variable that may hold several. */
export type Choice = Map<string, string>;

/**
 * `X=(r "a b" $Y)` as one assignment word: `X=` then the expanded elements,
 * marked as an array, which `assign` stores as X[0], X[1]...
 */
export async function compoundWord(token: Word, ctx: Context, choice: Choice | undefined): Promise<Word> {
    const items: string[] = [];
    for (const element of token.elements ?? []) {
        for (const piece of braceExpand(element, ctx)) {
            const expanded = await expandWord(piece, ctx, choice);
            items.push(...splitUnquoted(piece, expanded, ctx).map((w) => w.text));
        }
    }
    const text = token.text + ARRAY + items.join(FIELD);
    return new Word(text, { dynamic: UNRESOLVED.test(text), substitutions: token.substitutions });
}

/**
 * Word splitting: an unquoted expansion holding IFS characters becomes several
 * words (`X='rm -rf ~'; $X` runs rm with two arguments; so does `IFS=,; X=rm,-rf,~`).
 * Quoted `"$X"` stays one.
 */
export function splitUnquoted(original: Word, expanded: Word, ctx: Context): Word[] {
    if (!original.splits || !original.dynamic || expanded.text === original.text) return [expanded];
    const splits = ifsValues(ctx).map((ifs) => ifsSplit(expanded.text, ifs));
    if (new Set(splits.map((fields) => JSON.stringify(fields))).size > 1) {
        ctx.result.truncated = true; // IFS may hold several values that split this differently
    }
    const parts = splits[0] as string[];
    if (parts.length <= 1) {
        // `IFS=,; X=rm,; $X` runs `rm`: the delimiters go even when one word remains.
        const first = parts[0];
        return first === undefined || first === expanded.text
            ? [expanded]
            : [new Word(first, { dynamic: UNRESOLVED.test(first), substitutions: expanded.substitutions })];
    }
    return parts.map(
        (part, i) =>
            new Word(part, {
                dynamic: UNRESOLVED.test(part),
                substitutions: i === 0 ? expanded.substitutions : [],
            }),
    );
}

/** What `"$*"` puts between parameters: IFS's first character. */
export function starSeparator(ctx: Context): string {
    return (ifsValues(ctx)[0] as string).slice(0, 1);
}

/** Every value IFS may hold: `IFS=, read ...` sets it for one command; unset means the default. */
export function ifsValues(ctx: Context, environment: readonly string[] = []): readonly string[] {
    for (const text of [...environment].reverse()) {
        if (text.startsWith("IFS=")) return [text.slice(4)];
    }
    const values = ctx.variables.get("IFS") ?? [UNSET];
    return [...new Set(values.map((value) => (value === UNSET ? IFS_DEFAULT : value)))];
}

/**
 * Substitute parameters whose value is known at this point in the line.
 *
 * `P=$HOME/.claude/settings.json; echo x > "$P"` writes a known path; so
 * does `X=rm; $X -rf ~`. A word that still holds an expansion afterwards
 * (an unset variable, `${X:-d}`, `$(...)`) stays dynamic. `choice` picks the
 * value of a variable that may hold several.
 */
export async function expandWord(word: Word, ctx: Context, choice?: Choice): Promise<Word> {
    if (!word.dynamic) return word;

    const value: Lookup = (rawName, atStart) => {
        if (rawName.startsWith(WRITTEN_FILE)) return writtenText(rawName.slice(WRITTEN_FILE.length), ctx);
        if (isDigits(rawName) || rawName === "#" || rawName === "@" || rawName === "*") {
            const params = positionals(ctx);
            if (params === null || rawName === "0") return undefined;
            if (rawName === "@" || rawName === "*") {
                // Inside a longer word: `"$@"m` with $1=r is rm.
                return params.join(rawName === "*" ? starSeparator(ctx) : " ");
            }
            if (rawName === "#") return String(params.length);
            const position = Number(rawName);
            return position <= params.length ? (params[position - 1] as string) : "";
        }
        const name = targetName(rawName, ctx);
        if (choice?.has(name)) {
            const chosen = choice.get(name) as string;
            return chosen === UNSET ? undefined : chosen;
        }
        const known = ctx.variables.get(name);
        if (known !== undefined) {
            const current = known[0] as string;
            return current === UNSET ? undefined : current;
        }
        const subscripted = SUBSCRIPTED.exec(name);
        if (subscripted) {
            return elementValue(targetName(subscripted[1] as string, ctx), subscripted[2] as string, ctx);
        }
        if (name.includes("[")) return undefined;
        if (name === "HOME") return ctx.host.home;
        if (name === "PWD") {
            // `$PWD/x` is `./x`: relative paths are checked in every directory the
            // command might run in, which a single expanded value would lose.
            if (atStart) return ".";
            if (ctx.cwd !== null && new Set(ctx.cwdOptions).size <= 1) return ctx.cwd;
        }
        return undefined;
    };

    const assign: Assigner = (name, text, certain) => {
        // `${X:=word}` assigns word when X is unset (or empty). If X is not known
        // it may already be set, so both stay possible: word, or unknown.
        if (!certain && !ctx.variables.has(name)) ctx.variables.set(name, [UNSET]);
        assignVariable(`${name}=${text}`, ctx.variables, ctx.conditional || !certain);
        if (choice?.has(name)) choice.set(name, text);
    };

    const text = await expandText(word.text, value, true, assign, ctx.host);
    if (UNMODELLED_TRANSFORM.test(text)) {
        // `${X@P}`, `${X@A}`...: bash computes a value this parser cannot.
        ctx.result.truncated = true;
    }
    return new Word(text, {
        dynamic: UNRESOLVED.test(text),
        quoted: word.quoted,
        splits: word.splits,
        heredocBody: word.heredocBody,
        substitutions: word.substitutions,
    });
}

/** Records `${NAME:=word}`: (name, value, whether the assignment certainly happens). */
export type Assigner = (name: string, text: string, certain: boolean) => void;

/**
 * Replace `$NAME`/`${NAME}` whose value is known, and resolve `${NAME:-word}`,
 * `${NAME:=word}` and `${NAME:+word}` to the value they select. When NAME is not
 * known it may be unset, so the default or alternate `word` is the candidate:
 * `> "${OUT:-$HOME/.claude/settings.json}"` writes settings.json. Anything else
 * (`${#X}`, `${X/a/b}`, unknown names) stays as written. `assign` records
 * what `${NAME:=word}` assigns, which later expansions then see.
 * `host` is what re-parsing a `$(echo ...)` body needs.
 */
export async function expandText(
    text: string,
    value: Lookup,
    atStart: boolean,
    assign: Assigner | undefined,
    host: Host,
): Promise<string> {
    const out: string[] = [];
    let index = 0;
    while (index < text.length) {
        const xpgEcho = value(`${SHELL_OPTION}xpg_echo`, false) === "on";
        const literal = await literalSubstitution(text, index, xpgEcho, value, host);
        if (literal !== undefined) {
            // `$(printf git)` / `` `echo git` ``: the output of a literal echo is known.
            out.push(literal[0]);
            index = literal[1];
            continue;
        }
        if (text.startsWith("${", index)) {
            const end = closingBrace(text, index + 2);
            if (end === undefined) {
                out.push(text.slice(index));
                break;
            }
            out.push(
                await expandBraced(
                    text.slice(index + 2, end),
                    text.slice(index, end + 1),
                    value,
                    atStart && index === 0,
                    assign,
                    host,
                ),
            );
            index = end + 1;
            continue;
        }
        let name = text[index] === "$" ? nameAt(text, index + 1) : undefined;
        if (name === undefined && text[index] === "$" && index + 1 < text.length) {
            const next = text[index + 1] as string;
            if ("0123456789#@*".includes(next)) name = next; // `$1`, `$#`, `$@`
        }
        if (name !== undefined) {
            const found = value(name, atStart && index === 0);
            const end = index + 1 + name.length;
            out.push(found === undefined ? text.slice(index, end) : found);
            index = end;
            continue;
        }
        out.push(text[index] as string);
        index += 1;
    }
    return out.join("");
}

// `value("\0written:PATH")` is the text this line wrote to PATH, if it did.
export const WRITTEN_FILE = "\0written:";

/**
 * The text this line wrote to `path` (`printf r > f; printf m >> f`), when the
 * directory is known; files on disk are not read here.
 */
function writtenText(path: string, ctx: Context): string | undefined {
    if (ctx.cwd === null || new Set(ctx.cwdOptions).size > 1) return undefined;
    const entry = ctx.writtenFiles.get(normpath(join(ctx.cwd, expanduser(path, ctx.host.home))));
    return entry?.replaces ? entry.text : undefined;
}

const PRODUCERS: ReadonlySet<string> = new Set(["echo", "printf", "cat"]);

/**
 * (output, end) for a command substitution at `index` whose body only echoes
 * literal text; trailing newlines are dropped, as bash does. undefined otherwise.
 */
async function literalSubstitution(
    text: string,
    index: number,
    xpgEcho: boolean,
    value: Lookup | undefined,
    host: Host,
): Promise<readonly [string, number] | undefined> {
    let body: string;
    let end: number;
    if (text.startsWith("$(", index) && !text.startsWith("$((", index)) {
        let depth = 1;
        end = index + 2;
        while (end < text.length && depth) {
            depth += text[end] === "(" ? 1 : text[end] === ")" ? -1 : 0;
            end += 1;
        }
        if (depth) return undefined;
        body = text.slice(index + 2, end - 1);
    } else if (text[index] === "`") {
        const close = text.indexOf("`", index + 1);
        if (close < 0) return undefined;
        body = text.slice(index + 1, close);
        end = close + 1;
    } else {
        return undefined;
    }
    const producer = await parse(body, "/", host); // re-entry: parsed as a command list
    const temporary = mktempPath(producer, host);
    if (temporary !== undefined) return [temporary, end];
    const opaque = (c: SimpleCommand): boolean =>
        !PRODUCERS.has(c.name) ||
        c.dynamicHead ||
        c.via.length > 0 ||
        c.redirects.length > 0 ||
        c.argv.some((a) => a.includes("$") || a.includes("`"));
    if (producer.commands.length === 0 || producer.unparseable || producer.commands.some(opaque))
        return undefined;
    const printed = producer.commands.map((c) => printedOutput(c, xpgEcho, value));
    if (printed.some((p) => p === undefined)) return undefined;
    return [printed.join("").replace(/\n+$/, ""), end];
}

/**
 * What one producer command prints: echo/printf text, or `cat FILE...` of
 * files written earlier on the line (`printf r > f; "$(cat f)"`).
 */
function printedOutput(
    command: SimpleCommand,
    xpgEcho: boolean,
    value: Lookup | undefined,
): string | undefined {
    if (command.name !== "cat") return printedText(command.name, command.args, xpgEcho);
    if (value === undefined || command.args.length === 0 || command.args.some((a) => a.startsWith("-"))) {
        return undefined;
    }
    const texts = command.args.map((path) => value(WRITTEN_FILE + path, false));
    return texts.some((t) => t === undefined) ? undefined : texts.join("");
}

/**
 * `$(mktemp)`, `$(mktemp -d -p DIR)`, `$(mktemp -t name.XXXX)`: a new path in
 * a known directory. Its name is random, so the template stands for it.
 */
function mktempPath(producer: ParseResult, host: Host): string | undefined {
    const only = producer.commands[0];
    if (
        producer.commands.length !== 1 ||
        only === undefined ||
        only.name !== "mktemp" ||
        only.via.length > 0
    ) {
        return undefined;
    }
    const args = only.args;
    let directory: string | undefined;
    let template: string | undefined;
    let underTmpdir = false;
    let index = 0;
    while (index < args.length) {
        const arg = args[index] as string;
        if ((arg === "-p" || arg === "--tmpdir") && index + 1 < args.length) {
            directory = args[index + 1];
            index += 1;
        } else if (arg.startsWith("--tmpdir=")) {
            directory = arg.slice("--tmpdir=".length);
        } else if (arg === "-t") {
            underTmpdir = true;
        } else if (
            arg.startsWith("--suffix=") ||
            ["-d", "--directory", "-u", "--dry-run", "-q", "--quiet"].includes(arg)
        ) {
            // no effect on the path
        } else if (arg.startsWith("-")) {
            return undefined;
        } else {
            template = arg;
        }
        index += 1;
    }
    if ((directory ?? "").includes("$") || (template ?? "").includes("$")) return undefined;
    const temporaryRoot = host.env("TMPDIR") || "/tmp";
    if (template === undefined) return join(directory || temporaryRoot, "tmp.XXXXXXXXXX");
    if (directory === undefined && !underTmpdir) return template; // `mktemp out.XXXX`: relative to the current directory
    return join(directory || temporaryRoot, template);
}

function closingBrace(text: string, start: number): number | undefined {
    let depth = 1;
    for (let index = start; index < text.length; index += 1) {
        if (text.startsWith("${", index)) {
            depth += 1;
        } else if (text[index] === "}") {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return undefined;
}

async function expandBraced(
    body: string,
    original: string,
    value: Lookup,
    atStart: boolean,
    assign: Assigner | undefined,
    host: Host,
): Promise<string> {
    if (NAME.test(body) || isDigits(body) || body === "@" || body === "*") {
        return value(body, atStart) ?? original;
    }
    const element = SUBSCRIPTED.exec(body);
    if (element) {
        // `${X[0]}`, `${X[-1]}`, `${X[i+1]}`, `${X[@]}`: elements are stored as X[0],
        // X[1]...; X[0] is also plain $X. A subscript is arithmetic.
        const name = element[1] as string;
        let subscript = element[2] as string;
        if (subscript !== "@" && subscript !== "*") {
            const index = arithmeticIndex(subscript, value);
            if (index === undefined) return original;
            subscript = String(index);
        }
        return value(`${name}[${subscript}]`, false) ?? original;
    }
    const counted = body.startsWith("#") ? SUBSCRIPTED.exec(body.slice(1)) : null;
    if (counted && (counted[2] === "@" || counted[2] === "*")) {
        return value(`${counted[1]}[#]`, false) ?? original; // `${#X[@]}`: how many elements
    }
    if (body.startsWith("!") && NAME.test(body.slice(1))) {
        // `${!X}`: the value of the variable whose name X holds.
        const target = value(body.slice(1), false);
        const found = target && NAME.test(target) ? value(target, false) : undefined;
        return found ?? original;
    }
    if (body.startsWith("#") && NAME.test(body.slice(1))) {
        const found = value(body.slice(1), false);
        return found === undefined ? original : String(charCount(found)); // ${#X}
    }
    const match = BRACED.exec(body);
    if (!match) {
        // Substring, pattern removal/replacement, case: computable once X is known.
        const name = nameAt(body, 0);
        const current = name !== undefined ? value(name, false) : undefined;
        if (current === undefined || name === undefined) return original;
        const operator = await expandText(body.slice(name.length), value, false, assign, host);
        const result = applyParameter(current, operator, value(`${SHELL_OPTION}extglob`, false) === "on");
        return result ?? original;
    }
    const name = match[1] as string;
    const op = match[2] as string;
    const word = match[3] as string;
    const current = value(name, false);
    if (op.endsWith("?")) return current ?? original;
    const alternative = await expandText(word, value, atStart, assign, host);
    const setAndUsed = current !== undefined && (current !== "" || !op.startsWith(":"));
    if (op.endsWith("+")) {
        // Unknown NAME may be set: the alternate word is the value to check.
        return current === undefined || setAndUsed ? alternative : "";
    }
    if (op.endsWith("=") && !setAndUsed && assign !== undefined)
        assign(name, alternative, current !== undefined);
    return setAndUsed ? (current as string) : alternative;
}

/**
 * The text an `echo`/`printf` prints, when it is literal ("" if not modelled):
 * trailing newlines dropped. Python's `echoed_text` and `_echoed_text` both
 * spell `echoedText` here, so one export serves both imports.
 */
export function echoedText(command: SimpleCommand): string {
    const printed = commandOutput(command);
    return printed !== undefined ? printed.replace(/\n+$/, "") : "";
}

/** The exact bytes an echo/printf writes, honouring `shopt -s xpg_echo`. */
export function commandOutput(command: SimpleCommand): string | undefined {
    return printedText(command.name, command.args, command.optionOn("xpg_echo"));
}
