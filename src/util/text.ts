/**
 * Python `str` helpers the port leans on, so a translated line reads like the
 * original: `isspace`, `partition`, `split()` on runs of whitespace, and
 * `shlex.quote`.
 */

const SPACE = /^\s+$/;
const ALPHA = /^[A-Za-z]+$/;
const DIGITS = /^[0-9]+$/;
const ALNUM = /^[A-Za-z0-9]+$/;

/** `str.isspace()`: non-empty and all whitespace. */
export function isSpace(text: string): boolean {
    return SPACE.test(text);
}

/** `str.isalpha()` for ASCII letters. */
export function isAlpha(text: string): boolean {
    return ALPHA.test(text);
}

/** `str.isdigit()` for ASCII digits. */
export function isDigit(text: string): boolean {
    return DIGITS.test(text);
}

/** `str.isalnum()` for ASCII letters and digits. */
export function isAlnum(text: string): boolean {
    return ALNUM.test(text);
}

/** `str.split()` with no separator: runs of whitespace, no empty fields. */
export function splitWhitespace(text: string, maxSplit?: number): string[] {
    const fields = text
        .trim()
        .split(/\s+/)
        .filter((field) => field !== "");
    if (maxSplit === undefined || fields.length <= maxSplit + 1) return fields;
    // Keep the remainder as one field, as Python does, with its own spacing.
    const head = fields.slice(0, maxSplit);
    let rest = text.replace(/^\s+/, "");
    for (const field of head) rest = rest.slice(rest.indexOf(field) + field.length).replace(/^\s+/, "");
    return [...head, rest];
}

/** `str.partition(sep)`. */
export function partition(text: string, separator: string): [string, string, string] {
    const index = text.indexOf(separator);
    if (index < 0) return [text, "", ""];
    return [text.slice(0, index), separator, text.slice(index + separator.length)];
}

/** `str.rpartition(sep)`. */
export function rpartition(text: string, separator: string): [string, string, string] {
    const index = text.lastIndexOf(separator);
    if (index < 0) return ["", "", text];
    return [text.slice(0, index), separator, text.slice(index + separator.length)];
}

/** `str.rsplit(sep, 1)`. */
export function rsplitOnce(text: string, separator: string): [string] | [string, string] {
    const index = text.lastIndexOf(separator);
    return index < 0 ? [text] : [text.slice(0, index), text.slice(index + separator.length)];
}

/** `str.strip(chars)` with an explicit character set. */
export function stripChars(text: string, chars: string): string {
    let start = 0;
    let end = text.length;
    while (start < end && chars.includes(text[start] as string)) start += 1;
    while (end > start && chars.includes(text[end - 1] as string)) end -= 1;
    return text.slice(start, end);
}

/** `str.lstrip(chars)` with an explicit character set. */
export function lstripChars(text: string, chars: string): string {
    let start = 0;
    while (start < text.length && chars.includes(text[start] as string)) start += 1;
    return text.slice(start);
}

/** `str.rstrip(chars)` with an explicit character set. */
export function rstripChars(text: string, chars: string): string {
    let end = text.length;
    while (end > 0 && chars.includes(text[end - 1] as string)) end -= 1;
    return text.slice(0, end);
}

/** `str.startswith(tuple)`. */
export function startsWithAny(text: string, prefixes: readonly string[]): boolean {
    return prefixes.some((prefix) => text.startsWith(prefix));
}

/** `str.endswith(tuple)`. */
export function endsWithAny(text: string, suffixes: readonly string[]): boolean {
    return suffixes.some((suffix) => text.endsWith(suffix));
}

/** `str.splitlines()`: universal newlines, no trailing empty line. */
export function splitLines(text: string): string[] {
    const lines = text.split(/\r\n|\r|\n|\v|\f|\x1c|\x1d|\x1e|\u0085|\u2028|\u2029/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
}

const SAFE_WORD = /^[A-Za-z0-9@%+=:,./_-]+$/;

/** `shlex.quote`. */
export function shellQuote(text: string): string {
    if (text === "") return "''";
    if (SAFE_WORD.test(text)) return text;
    return `'${text.replaceAll("'", `'"'"'`)}'`;
}

/** Python `re.escape` for the characters that matter in a JavaScript RegExp. */
export function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** `text if len(text) <= limit else text[: limit - 3] + "..."` (hook_protocol.truncate). */
export function truncate(text: string, limit = 160): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

/** Python `str.casefold()` approximated with lower-casing. */
export function casefold(text: string): string {
    return text.toLowerCase();
}

/** `s.swapcase()`-free helper: `str.lower()`/`upper()` keep their JS names. */
export function countOf(text: string, needle: string): number {
    if (needle === "") return 0;
    let count = 0;
    let index = text.indexOf(needle);
    while (index >= 0) {
        count += 1;
        index = text.indexOf(needle, index + needle.length);
    }
    return count;
}
