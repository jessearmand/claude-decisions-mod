/**
 * Bash pattern matching, as in `${X#pattern}`, `${X/pattern/s}` and `${X^^pattern}`.
 *
 * Python's fnmatch differs from bash: it has no POSIX character classes
 * (`[[:upper:]]`), treats `^` as a literal at the start of a bracket expression,
 * and does not honour backslash escapes. This converts a bash pattern to a
 * regular expression instead: `*`, `?`, bracket expressions with `!`/`^`
 * negation, ranges, `[:class:]` names, and `\x` escapes. extglob is off in
 * non-interactive bash, so `+(...)` and the like are literal text unless the
 * caller says `shopt -s extglob` is on; then `?( )`, `*( )`, `+( )` and `@( )`
 * match, and `!( )` throws Unsupported.
 *
 * Also here: `fnmatch` (Python's `fnmatch.fnmatchcase`) and `globPaths`, the
 * port of `glob.glob(pattern, root_dir=...)` over a `Host`.
 *
 * Ported from shell_glob.py.
 */

import type { Host } from "../host/host.ts";
import { join } from "../util/paths.ts";

const CLASSES: ReadonlyMap<string, string> = new Map([
    ["alnum", "a-zA-Z0-9"],
    ["alpha", "a-zA-Z"],
    ["ascii", "\\x00-\\x7f"],
    ["blank", " \\t"],
    ["cntrl", "\\x00-\\x1f\\x7f"],
    ["digit", "0-9"],
    ["graph", "!-~"],
    ["lower", "a-z"],
    ["print", " -~"],
    ["punct", "!-/:-@\\[-`{-~"],
    ["space", " \\t\\n\\r\\f\\v"],
    ["upper", "A-Z"],
    ["word", "a-zA-Z0-9_"],
    ["xdigit", "0-9A-Fa-f"],
]);

/** A pattern this module cannot match the way bash would (`!(...)`). */
export class Unsupported extends Error {
    constructor(pattern: string) {
        super(pattern);
        this.name = "Unsupported";
    }
}

/** The module-level stand-in for Python's ContextVar: whether `shopt -s extglob` is on. */
let extglobOn = false;

/** Match with `shopt -s extglob` on (or off) inside `fn` (Python's `with extglob(enabled):`). */
export function withExtglob<T>(enabled: boolean, fn: () => T): T {
    const previous = extglobOn;
    extglobOn = enabled;
    try {
        return fn();
    } finally {
        extglobOn = previous;
    }
}

/** Whether all of `text` matches the bash pattern `pattern`. `extglob` defaults to the `withExtglob` flag. */
export function match(text: string, pattern: string, extglob?: boolean): boolean {
    return compiled(pattern, extglob ?? extglobOn).test(text);
}

const CACHE_SIZE = 512;
const cache = new Map<string, RegExp>();

/** `lru_cache(maxsize=512)` on the compiled pattern (cleared, not evicted, when full). */
function compiled(pattern: string, extglob: boolean): RegExp {
    const key = `${extglob ? "1" : "0"}${pattern}`;
    const cached = cache.get(key);
    if (cached) return cached;
    if (cache.size >= CACHE_SIZE) cache.clear();
    const regex = compile(pattern, extglob);
    cache.set(key, regex);
    return regex;
}

function compile(pattern: string, extglob: boolean): RegExp {
    try {
        return new RegExp(`^(?:${translate(pattern, extglob)})$`, "su");
    } catch (error) {
        if (error instanceof Unsupported) throw error;
        // Python's re would raise re.error (`[z-a]`); here it is reported as unsupported.
        throw new Unsupported(pattern);
    }
}

// `?(a|b)` zero or one, `*( )` any number, `+( )` one or more, `@( )` exactly one.
const EXTGLOB: ReadonlyMap<string, string> = new Map([
    ["?", "?"],
    ["*", "*"],
    ["+", "+"],
    ["@", ""],
]);

/** `re.escape` for one character, outside a bracket expression (the `u` flag rejects stray escapes). */
function escapeChar(char: string): string {
    return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char;
}

/** `re.escape` for one character inside a bracket expression. */
function escapeInBracket(char: string): string {
    return /[\\\]^-]/.test(char) ? `\\${char}` : char;
}

function translate(pattern: string, extglob: boolean): string {
    const out: string[] = [];
    let index = 0;
    while (index < pattern.length) {
        const char = pattern[index] as string;
        if (extglob && "?*+@!".includes(char) && pattern.startsWith("(", index + 1)) {
            const close = groupEnd(pattern, index + 1);
            if (close !== undefined) {
                if (char === "!") throw new Unsupported(pattern);
                const alternatives = splitAlternatives(pattern.slice(index + 2, close));
                const body = alternatives.map((alt) => translate(alt, extglob)).join("|");
                out.push(`(?:${body})${EXTGLOB.get(char) ?? ""}`);
                index = close + 1;
                continue;
            }
        }
        if (char === "\\" && index + 1 < pattern.length) {
            out.push(escapeChar(pattern[index + 1] as string));
            index += 2;
        } else if (char === "*") {
            out.push(".*");
            index += 1;
        } else if (char === "?") {
            out.push(".");
            index += 1;
        } else if (char === "[") {
            const bracket = bracketExpression(pattern, index);
            if (bracket === undefined) {
                out.push("\\["); // no closing `]`: a literal bracket
                index += 1;
            } else {
                out.push(bracket[0]);
                index = bracket[1];
            }
        } else {
            out.push(escapeChar(char));
            index += 1;
        }
    }
    return out.join("");
}

/** The index of the `)` closing the group that opens at `openIndex`. */
function groupEnd(pattern: string, openIndex: number): number | undefined {
    let depth = 0;
    let index = openIndex;
    while (index < pattern.length) {
        const char = pattern[index];
        if (char === "\\") {
            index += 2;
            continue;
        }
        depth += char === "(" ? 1 : char === ")" ? -1 : 0;
        if (depth === 0) return index;
        index += 1;
    }
    return undefined;
}

/** `a|b(c|d)` -> [`a`, `b(c|d)`]: split on `|` outside nested groups. */
function splitAlternatives(body: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    let index = 0;
    while (index < body.length) {
        const char = body[index];
        if (char === "\\") {
            index += 2;
            continue;
        }
        depth += char === "(" ? 1 : char === ")" ? -1 : 0;
        if (char === "|" && depth === 0) {
            parts.push(body.slice(start, index));
            start = index + 1;
        }
        index += 1;
    }
    return [...parts, body.slice(start)];
}

/** The regex for the bracket expression at `start`, and where it ends. */
function bracketExpression(pattern: string, start: number): readonly [string, number] | undefined {
    let index = start + 1;
    const negate = index < pattern.length && "!^".includes(pattern[index] as string);
    if (negate) index += 1;
    const parts: string[] = [];
    let first = true;
    while (index < pattern.length) {
        const char = pattern[index] as string;
        if (char === "]" && !first) {
            const body = parts.join("");
            return [negate ? `[^${body}]` : `[${body}]`, index + 1];
        }
        first = false;
        if (pattern.startsWith("[:", index)) {
            const close = pattern.indexOf(":]", index + 2);
            const name = close > 0 ? pattern.slice(index + 2, close) : "";
            const named = CLASSES.get(name);
            if (named !== undefined) {
                parts.push(named);
                index = close + 2;
                continue;
            }
        }
        if (char === "\\" && index + 1 < pattern.length) {
            parts.push(escapeInBracket(pattern[index + 1] as string));
            index += 2;
            continue;
        }
        if (char === "-" && parts.length > 0 && index + 1 < pattern.length && pattern[index + 1] !== "]") {
            parts.push("-");
            index += 1;
            continue;
        }
        parts.push(char === "-" ? "\\-" : escapeInBracket(char));
        index += 1;
    }
    return undefined;
}

// --------------------------------------------------------------------------- //
// Python's fnmatch and glob.glob
// --------------------------------------------------------------------------- //

/** Python `glob.has_magic`. */
const GLOB_MAGIC = /[*?[]/;

/**
 * The bracket expression at `pattern[start]` as Python's fnmatch reads it:
 * `[!...]` negates, a leading `]` is literal, `a-z` is a range (a reversed
 * range matches nothing), a backslash is literal. `undefined` when no `]`
 * closes it, in which case the `[` is literal.
 */
function fnmatchBracket(
    pattern: readonly string[],
    start: number,
): { readonly matches: (char: string) => boolean; readonly end: number } | undefined {
    let j = start + 1;
    const negate = pattern[j] === "!";
    if (negate) j += 1;
    if (pattern[j] === "]") j += 1;
    while (j < pattern.length && pattern[j] !== "]") j += 1;
    if (j >= pattern.length) return undefined;
    const body = pattern.slice(start + 1 + (negate ? 1 : 0), j);
    const singles = new Set<string>();
    const ranges: Array<readonly [number, number]> = [];
    let k = 0;
    while (k < body.length) {
        const char = body[k] as string;
        if (body[k + 1] === "-" && k + 2 < body.length) {
            const low = char.codePointAt(0) as number;
            const high = (body[k + 2] as string).codePointAt(0) as number;
            if (low <= high) ranges.push([low, high]);
            k += 3;
        } else {
            singles.add(char);
            k += 1;
        }
    }
    const inSet = (char: string): boolean => {
        const code = char.codePointAt(0) as number;
        return singles.has(char) || ranges.some(([low, high]) => low <= code && code <= high);
    };
    return { matches: (char) => inSet(char) !== negate, end: j + 1 };
}

/**
 * Python `fnmatch.fnmatchcase(name, pattern)`: `*`, `?` and `[...]`, no escapes,
 * case-sensitive, a `*` matching anything (`/` and a leading `.` included).
 */
export function fnmatch(name: string, pattern: string): boolean {
    const text = Array.from(name);
    const pat = Array.from(pattern);
    return fnmatchFrom(text, 0, pat, 0);
}

function fnmatchFrom(
    text: readonly string[],
    textIndex: number,
    pat: readonly string[],
    patIndex: number,
): boolean {
    let t = textIndex;
    let p = patIndex;
    while (p < pat.length) {
        const char = pat[p] as string;
        if (char === "*") {
            while (pat[p] === "*") p += 1;
            if (p === pat.length) return true;
            for (let rest = t; rest <= text.length; rest += 1) {
                if (fnmatchFrom(text, rest, pat, p)) return true;
            }
            return false;
        }
        if (t >= text.length) return false;
        if (char === "?") {
            t += 1;
            p += 1;
            continue;
        }
        if (char === "[") {
            const bracket = fnmatchBracket(pat, p);
            if (bracket !== undefined) {
                if (!bracket.matches(text[t] as string)) return false;
                t += 1;
                p = bracket.end;
                continue;
            }
        }
        if (char !== text[t]) return false;
        t += 1;
        p += 1;
    }
    return t === text.length;
}

export interface GlobOptions {
    /** `glob.glob(pattern, root_dir=rootDir)`: where a relative pattern starts; "/" when absent. */
    readonly rootDir?: string;
    /** Stop after this many matches (`itertools.islice(glob.iglob(...), limit)`). */
    readonly limit?: number;
}

/**
 * Python `glob.glob(pattern, root_dir=rootDir)`: the paths `pattern` matches,
 * sorted. Non-recursive (`**` is `*`); `*`, `?` and `[` do not match a leading
 * `.` unless the segment starts with one; an absolute pattern gives absolute
 * paths, a relative one gives paths spelled like the pattern (`./x*` gives
 * `./x1`), relative to `rootDir`; a trailing `/` matches only directories and is
 * kept. A segment with no glob character is probed with `host.stat` instead of
 * listing its directory. Names match with Python's fnmatch semantics.
 */
export async function globPaths(pattern: string, host: Host, options: GlobOptions = {}): Promise<string[]> {
    const rootDir = options.rootDir ?? "/";
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    if (pattern === "" || limit <= 0) return [];
    const leading = /^\/+/.exec(pattern)?.[0] ?? "";
    const root = leading === "" ? "" : leading === "//" ? "//" : "/";
    const segments = pattern.slice(leading.length).split("/");
    // `a//b` reads as `a/b`; a trailing `/` stays as an empty last segment.
    const trailingSlash = segments.length > 1 && segments[segments.length - 1] === "";
    const names = segments.filter((segment) => segment !== "");
    if (names.length === 0 && root === "") return [];
    const found: string[] = [];
    const spelledStart = root;
    const realStart = root === "" ? rootDir : root;
    await globWalk(names, 0, spelledStart, realStart, trailingSlash, host, found, limit);
    return found.sort();
}

async function globWalk(
    names: readonly string[],
    index: number,
    spelled: string,
    real: string,
    trailingSlash: boolean,
    host: Host,
    found: string[],
    limit: number,
): Promise<void> {
    if (found.length >= limit) return;
    if (index === names.length) {
        if (trailingSlash) {
            // `dir*/`: only directories, written with the slash.
            if ((await host.stat(real))?.kind === "dir") found.push(spelled === "" ? "/" : `${spelled}/`);
            return;
        }
        // Python's lexists: a dangling link still counts.
        if ((await host.stat(real)) !== undefined) found.push(spelled);
        return;
    }
    const segment = names[index] as string;
    if (!GLOB_MAGIC.test(segment)) {
        await globWalk(
            names,
            index + 1,
            join(spelled, segment),
            join(real, segment),
            trailingSlash,
            host,
            found,
            limit,
        );
        return;
    }
    const entries = await host.list(real === "" ? "." : real);
    if (entries === undefined) return;
    const hidden = segment.startsWith(".");
    for (const entry of entries) {
        if (found.length >= limit) return;
        if (!hidden && entry.name.startsWith(".")) continue;
        if (!fnmatch(entry.name, segment)) continue;
        const last = index + 1 === names.length;
        if (!last && entry.kind !== "dir") continue; // only a directory has a next segment
        const nextSpelled = join(spelled, entry.name);
        const nextReal = join(real, entry.name);
        if (last && !trailingSlash) {
            found.push(nextSpelled);
            continue;
        }
        await globWalk(names, index + 1, nextSpelled, nextReal, trailingSlash, host, found, limit);
    }
}
