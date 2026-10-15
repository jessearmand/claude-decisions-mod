/**
 * Bash parameter-expansion operators applied to a value the parser knows.
 *
 * `X=rm; ${X:0:2} -rf v` runs `rm`; `P=~/.claude/x.bak; > "${P%.bak}"` writes
 * `~/.claude/x`. shell_parse resolves the variable; this module applies the
 * operator: substring, length, prefix/suffix removal, replacement and case
 * modification. Patterns are shell globs, matched as bash does (glob.ts).
 *
 * Ported from shell_params.py.
 */

import { match, Unsupported, withExtglob } from "./glob.ts";
import { lex } from "./lexer.ts";

const SUBSTRING = /^:\s*(-?\d+)\s*(?::\s*(-?\d+)\s*)?$/;

/**
 * `${NAME<operator>}` when NAME holds `value`; undefined if `operator` is not one
 * whose result can be computed (indirection, arrays, `@P`/`@A`/`@K`/`@a`, an
 * extglob `!(...)` pattern). `extglob`: `shopt -s extglob` is on.
 */
export function apply(value: string, operator: string, extglob = false): string | undefined {
    return withExtglob(extglob, () => {
        try {
            return applyOperator(value, operator);
        } catch (error) {
            if (error instanceof Unsupported) return undefined;
            throw error;
        }
    });
}

function applyOperator(value: string, operator: string): string | undefined {
    if (operator.startsWith("@")) return transform(value, operator.slice(1));
    const substring = SUBSTRING.exec(operator);
    if (substring) return substringOf(value, Number(substring[1]), substring[2]);
    for (const [prefix, fn] of OPERATORS) {
        if (operator.startsWith(prefix)) return fn(value, operator.slice(prefix.length));
    }
    return undefined;
}

/**
 * `${X@E}` expands backslash escapes as `$'...'` does; `@U`, `@u`, `@L`
 * change case; `@Q` quotes. The others depend on state not modelled.
 */
function transform(value: string, letter: string): string | undefined {
    if (letter === "E") {
        const decoded = lex(`$'${value.replaceAll("'", "\\'")}'`).tokens;
        const first = decoded[0];
        return decoded.length === 1 && first !== undefined && "text" in first ? first.text : undefined;
    }
    if (letter === "Q") return `'${value.replaceAll("'", "'\\''")}'`;
    const chars = Array.from(value);
    switch (letter) {
        case "U":
            return value.toUpperCase();
        case "u":
            return chars.slice(0, 1).join("").toUpperCase() + chars.slice(1).join("");
        case "L":
            return value.toLowerCase();
        default:
            return undefined;
    }
}

/** Python slicing by code points, `value[start:end]`. */
function substringOf(value: string, offset: number, length: string | undefined): string {
    const chars = Array.from(value);
    const start = offset < 0 ? Math.max(chars.length + offset, 0) : offset;
    if (length === undefined) return chars.slice(start).join("");
    const count = Number(length);
    const end = count < 0 ? chars.length + count : start + count;
    return chars.slice(start, Math.max(end, start)).join("");
}

type PatternOperator = (value: string, pattern: string) => string;

function removePrefix(longest: boolean): PatternOperator {
    return (value, pattern) => {
        const ends = longest ? range(value.length, -1, -1) : range(0, value.length + 1, 1);
        for (const end of ends) if (match(value.slice(0, end), pattern)) return value.slice(end);
        return value;
    };
}

function removeSuffix(longest: boolean): PatternOperator {
    return (value, pattern) => {
        const starts = longest ? range(0, value.length + 1, 1) : range(value.length, -1, -1);
        for (const start of starts) if (match(value.slice(start), pattern)) return value.slice(0, start);
        return value;
    };
}

/** Python `range(start, stop, step)`. */
function range(start: number, stop: number, step: number): number[] {
    const values: number[] = [];
    for (let value = start; step > 0 ? value < stop : value > stop; value += step) values.push(value);
    return values;
}

/** Leftmost, then longest, match of `pattern` at or after `start`. */
function firstMatch(value: string, pattern: string, start: number): readonly [number, number] | undefined {
    for (let left = start; left <= value.length; left += 1) {
        for (let right = value.length; right >= left; right -= 1) {
            if (right > left && match(value.slice(left, right), pattern)) return [left, right];
        }
    }
    return undefined;
}

/**
 * bash 5.2's `patsub_replacement` (on by default): an unescaped, unquoted `&`
 * in the replacement stands for the matched text; `\&` and `'&'` are a literal `&`.
 */
function substituted(replacement: string, matched: string): string {
    const out: string[] = [];
    let index = 0;
    while (index < replacement.length) {
        const char = replacement[index] as string;
        if (char === "'" || char === '"') {
            // Quoted text is literal, `&` included; the quotes are removed.
            let close = replacement.indexOf(char, index + 1);
            if (close < 0) close = replacement.length;
            out.push(replacement.slice(index + 1, close));
            index = close + 1;
        } else if (replacement.startsWith("\\&", index)) {
            out.push("&");
            index += 2;
        } else if (char === "&") {
            out.push(matched);
            index += 1;
        } else {
            out.push(char);
            index += 1;
        }
    }
    return out.join("");
}

function replace(every: boolean): PatternOperator {
    return (value, spec) => {
        const separator = spec.indexOf("/");
        const pattern = separator < 0 ? spec : spec.slice(0, separator);
        const replacement = separator < 0 ? "" : spec.slice(separator + 1);
        if (pattern.startsWith("#")) {
            const matched = anchored(value, pattern.slice(1), true);
            return matched === undefined
                ? value
                : substituted(replacement, matched) + value.slice(matched.length);
        }
        if (pattern.startsWith("%")) {
            const matched = anchored(value, pattern.slice(1), false);
            return matched === undefined
                ? value
                : value.slice(0, value.length - matched.length) + substituted(replacement, matched);
        }
        const out: string[] = [];
        let index = 0;
        for (
            let found = firstMatch(value, pattern, index);
            found !== undefined;
            found = firstMatch(value, pattern, index)
        ) {
            const [left, right] = found;
            out.push(value.slice(index, left), substituted(replacement, value.slice(left, right)));
            index = right;
            if (!every) break;
        }
        return out.join("") + value.slice(index);
    };
}

/** The longest part of `value` matching `pattern` at its start (or end). */
function anchored(value: string, pattern: string, atStart: boolean): string | undefined {
    for (let size = value.length; size >= 0; size -= 1) {
        const part = atStart ? value.slice(0, size) : value.slice(value.length - size);
        if (match(part, pattern)) return part;
    }
    return undefined;
}

/**
 * `${X^^P}` / `${X,,P}` change the case of each character matching the
 * pattern P (any character when P is empty); `${X^P}` / `${X,P}` only the first.
 */
function changeCase(upper: boolean, every: boolean): PatternOperator {
    return (value, patternText) => {
        const pattern = patternText || "?";
        const convert = (char: string): string => (upper ? char.toUpperCase() : char.toLowerCase());
        return Array.from(value)
            .map((char, index) => ((every || index === 0) && match(char, pattern) ? convert(char) : char))
            .join("");
    };
}

// Longer prefixes first: `##` before `#`.
const OPERATORS: ReadonlyArray<readonly [string, PatternOperator]> = [
    ["##", removePrefix(true)],
    ["#", removePrefix(false)],
    ["%%", removeSuffix(true)],
    ["%", removeSuffix(false)],
    ["//", replace(true)],
    ["/", replace(false)],
    ["^^", changeCase(true, true)],
    ["^", changeCase(true, false)],
    [",,", changeCase(false, true)],
    [",", changeCase(false, false)],
];
