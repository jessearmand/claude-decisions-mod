/**
 * The exact text `echo` and `printf` print, for the parser's literal-output cases.
 *
 * `printf '\162\155'` prints `rm`, `printf %b '\x72m'` prints `rm`, and
 * `echo -n r` prints `r` with no newline; files built from such output by
 * `>`/`>>` and the substitutions `$(printf ...)` hold exactly these bytes.
 * Formats the parser does not model (`%5.2f`, `%q`) give undefined: unknown.
 *
 * Ported from shell_printf.py.
 */

const CONVERSION = /%[-+ #0]*\d*(?:\.\d+)?([sbdiuxXocq])/y;
// Characters bash's `%q` escapes with a backslash (`~` and `#` only first).
const QUOTED = " \t'\"\\|&;()<>!{}*[]?^$`,";
const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
    ["\\", "\\"],
    ["n", "\n"],
    ["t", "\t"],
    ["r", "\r"],
    ["a", "\x07"],
    ["b", "\b"],
    ["f", "\f"],
    ["v", "\v"],
    ['"', '"'],
    ["'", "'"],
    ["e", "\x1b"],
    ["E", "\x1b"],
]);
const ECHO_OPTION = /^-[neE]+$/;
const HEX_PAIR = /^[0-9a-fA-F]{1,2}/;
/** Python `str.isprintable()`: no control, format, surrogate, private, unassigned or separator characters but space. */
const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}\p{Zs}]/u;

type EscapeMode = "format" | "echo" | "b";

/**
 * What `name args...` writes to stdout, newlines included; undefined if unknown.
 * `xpgEcho` (bash's `shopt -s xpg_echo`, and sh/dash): echo expands escapes
 * unless told `-E`.
 */
export function printedText(name: string, args: readonly string[], xpgEcho = false): string | undefined {
    if (name === "echo") return echo([...args], xpgEcho);
    if (name === "printf") return printf([...args]);
    return undefined;
}

function echo(initial: readonly string[], xpgEcho = false): string {
    let args = initial;
    let newline = true;
    let escapes = xpgEcho;
    while (args.length > 0 && ECHO_OPTION.test(args[0] as string)) {
        const option = args[0] as string;
        newline = newline && !option.includes("n");
        escapes = option.includes("e") || option.includes("E") ? option.includes("e") : escapes;
        args = args.slice(1);
    }
    let text = args.join(" ");
    if (escapes) {
        const [unescaped, stop] = expandEscapes(text, "echo");
        text = unescaped;
        if (stop) return text; // `\c`: print nothing more, not even the newline
    }
    return text + (newline ? "\n" : "");
}

function printf(args: readonly string[]): string | undefined {
    if (args.length === 0) return "";
    const fmt = args[0] as string;
    const values = args.slice(1);
    const out: string[] = [];
    for (;;) {
        let consumed = false;
        let index = 0;
        while (index < fmt.length) {
            const char = fmt[index];
            if (char === "\\") {
                const [text, end] = escapeAt(fmt, index, "format");
                out.push(text);
                index = end;
            } else if (fmt.startsWith("%%", index)) {
                out.push("%");
                index += 2;
            } else if (char === "%") {
                CONVERSION.lastIndex = index;
                const match = CONVERSION.exec(fmt);
                if (!match) return undefined;
                const value = values.length > 0 ? (values.shift() as string) : "";
                consumed = true;
                if (match[1] === "b") {
                    const [unescaped, stop] = expandEscapes(value, "b");
                    out.push(unescaped);
                    if (stop) return out.join("");
                } else if (match[1] === "q") {
                    const quoted = shellQuoted(value);
                    if (quoted === undefined) return undefined;
                    out.push(quoted);
                } else {
                    out.push(value);
                }
                index = CONVERSION.lastIndex;
            } else {
                out.push(char as string);
                index += 1;
            }
        }
        // The format is reused while arguments remain, as in bash.
        if (values.length === 0 || !consumed) return out.join("");
    }
}

/**
 * `printf %q`: `value` quoted so the shell reads it back (`a b` is `a\ b`).
 * undefined for text bash would write as `$'...'` (control characters), not modelled.
 */
function shellQuoted(value: string): string | undefined {
    if (!value) return "''";
    const chars = Array.from(value);
    if (chars.some((char) => char !== " " && UNPRINTABLE.test(char))) return undefined;
    return chars
        .map((char, index) =>
            QUOTED.includes(char) || (index === 0 && "~#".includes(char)) ? `\\${char}` : char,
        )
        .join("");
}

/** Expand backslash escapes in `text`; also whether `\c` stopped the output. */
function expandEscapes(text: string, mode: EscapeMode): readonly [string, boolean] {
    const out: string[] = [];
    let index = 0;
    while (index < text.length) {
        if (text.startsWith("\\c", index)) return [out.join(""), true];
        if (text[index] === "\\") {
            const [piece, end] = escapeAt(text, index, mode);
            out.push(piece);
            index = end;
        } else {
            out.push(text[index] as string);
            index += 1;
        }
    }
    return [out.join(""), false];
}

const OCTAL: Readonly<Record<EscapeMode, RegExp>> = {
    format: /()([0-7]{1,3})/y,
    echo: /(0)([0-7]{0,3})/y,
    b: /(0)([0-7]{0,3})|()([0-7]{1,3})/y,
};

/**
 * The character the escape at text[index] stands for, and where it ends.
 * printf's format takes `\NNN`, `echo -e` takes `\0NNN`, and `%b` takes both.
 */
function escapeAt(text: string, index: number, mode: EscapeMode): readonly [string, number] {
    const following = text.slice(index + 1, index + 2);
    const simple = SIMPLE_ESCAPES.get(following);
    if (simple !== undefined) return [simple, index + 2];
    if (following === "x") {
        const digits = HEX_PAIR.exec(text.slice(index + 2));
        if (digits)
            return [String.fromCharCode(Number.parseInt(digits[0], 16)), index + 2 + digits[0].length];
    }
    const octal = OCTAL[mode];
    octal.lastIndex = index + 1;
    const matched = octal.exec(text);
    if (matched) {
        const digits = matched[2] ?? matched[4] ?? "";
        return [String.fromCharCode(Number.parseInt(digits || "0", 8) & 0xff), octal.lastIndex];
    }
    return [`\\${following}`, index + 1 + following.length]; // not an escape: kept as written
}
