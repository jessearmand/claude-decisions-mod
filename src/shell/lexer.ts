/**
 * A small lexer for the subset of bash syntax that the guards need to see through.
 *
 * `shlex` is not enough for a security check. It treats a newline as plain
 * whitespace, so `echo hi<newline>rm -rf ~` looks like one `echo` command; it
 * starts a comment at a `#` in the middle of a word, so `echo a#b; rm -rf ~`
 * hides everything after `a`; and it has no idea that `$(...)`, backticks or
 * `<(...)` run a command list of their own.
 *
 * This lexer produces words with quotes removed, operator tokens (newline
 * included), every command substitution body, and every heredoc body. It never
 * raises: input it cannot finish (an unterminated quote or substitution) sets
 * `unterminated` so a caller can fall back to a conservative check.
 *
 * It is deliberately not a full shell. It does no expansion beyond quote
 * removal; a word that contains a parameter expansion or substitution is
 * flagged `dynamic` so a caller knows its runtime value is unknown.
 *
 * Ported from shell_lexer.py.
 */

// Longest first, so `&&` wins over `&` and `<<-` over `<<`.
const OPERATORS: readonly string[] = [
    ";;&",
    "<<-",
    "<<<",
    "&>>",
    "&&",
    "||",
    ";;",
    ";&",
    "|&",
    "&>",
    "<<",
    ">>",
    ">|",
    "<&",
    ">&",
    "<>",
    "(",
    ")",
    ";",
    "|",
    "&",
    "<",
    ">",
    "\n",
];
export const REDIRECT_OPERATORS: ReadonlySet<string> = new Set([
    "<<-",
    "<<<",
    "&>>",
    "&>",
    "<<",
    ">>",
    ">|",
    "<&",
    ">&",
    "<>",
    "<",
    ">",
]);
export const HEREDOC_OPERATORS: ReadonlySet<string> = new Set(["<<", "<<-"]);
// Only space and tab are blanks to the shell; a carriage return is part of a word.
const METACHARACTERS = " \t\n|&;()<>";
// `${NAME<op>word}` where the operator decides whether `word` is expanded.
const GUARDED_WORD = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(:?[-=+?])/s;
// The text before `(` in a compound array assignment: `X=`, `X+=`.
const COMPOUND_TARGET = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/;
const ANSI_C_ESCAPES: ReadonlyMap<string, string> = new Map([
    ["n", "\n"],
    ["t", "\t"],
    ["r", "\r"],
    ["a", "\x07"],
    ["b", "\b"],
    ["e", "\x1b"],
    ["f", "\f"],
    ["v", "\v"],
    ["\\", "\\"],
    ["'", "'"],
    ['"', '"'],
    ["?", "?"],
]);

const BARE_NAME_TAIL = /\$([A-Za-z_][A-Za-z0-9_]*)$/;
const HEX_DIGITS = "0123456789abcdefABCDEF";
const OCTAL_DIGITS = "01234567";
const COMMAND_SEPARATOR = /[;&|\n]/;
const NESTED_COMMAND = /\$\([^)]*\)|`[^`]*`/g;

/** Python `str.isalnum()` for one character (Unicode letters and numbers). */
function isAlnumChar(char: string): boolean {
    return /^[\p{L}\p{N}]$/u.test(char);
}

/** Python `str.isalpha()` for one character. */
function isAlphaChar(char: string): boolean {
    return /^\p{L}$/u.test(char);
}

/** Python `str.isdigit()` restricted to ASCII digits (the only ones `int()` accepts here). */
function isDigits(text: string): boolean {
    return /^[0-9]+$/.test(text);
}

/** `str.lstrip("\t")`. */
function stripTabs(line: string): string {
    return line.replace(/^\t+/, "");
}

/** `${X:-$(cmd)}`: (X, operator) guarding a substitution. */
export type Guard = readonly [name: string, operator: string];

export interface WordFields {
    dynamic: boolean;
    quoted: boolean;
    heredocBody: string | undefined;
    substitutions: string[];
    splits: boolean;
    braces: number[];
    elements: Word[] | undefined;
    guards: Map<number, Guard>;
}

/** A shell word after quote removal. `dynamic` means its runtime value is unknown. */
export class Word {
    text: string;
    dynamic: boolean;
    quoted: boolean;
    heredocBody: string | undefined;
    /**
     * Command lists this word runs while it is expanded ($(...), backticks,
     * <(...), and $(...) inside ${...}, $((...)) or an unquoted heredoc), in
     * order. They run when the command holding the word runs, not before.
     */
    substitutions: string[];
    /** An unquoted expansion (`$X`, not `"$X"`): its value is split into words. */
    splits: boolean;
    /**
     * Offsets in `text` of the unquoted `{`, `,` and `}`: only those take part in
     * brace expansion (`{rm,-rf,x}` is three words; `'{a,b}'` is one).
     */
    braces: number[];
    /** `X=(a "b c")`: the elements of a compound array assignment; undefined otherwise. */
    elements: Word[] | undefined;
    /**
     * `${X:-$(cmd)}`: substitution index -> (X, operator). Bash runs such a
     * substitution only when the operator selects that word.
     */
    guards: Map<number, Guard>;

    constructor(text: string, fields: Partial<WordFields> = {}) {
        this.text = text;
        this.dynamic = fields.dynamic ?? false;
        this.quoted = fields.quoted ?? false;
        this.heredocBody = fields.heredocBody;
        this.substitutions = fields.substitutions ?? [];
        this.splits = fields.splits ?? false;
        this.braces = fields.braces ?? [];
        this.elements = fields.elements;
        this.guards = fields.guards ?? new Map();
    }
}

export class Operator {
    readonly op: string;
    /** `3<<<x`: the descriptor a redirect names, if any */
    readonly fd: number | undefined;

    constructor(op: string, fd?: number) {
        this.op = op;
        this.fd = fd;
    }
}

export type Token = Word | Operator;

export class LexResult {
    tokens: Token[] = [];
    /** Bodies of $(...), `...`, <(...) and >(...): each runs as its own command list. */
    substitutions: string[] = [];
    unterminated = false;
}

class Lexer {
    s: string;
    i = 0;
    n: number;
    result = new LexResult();
    private pendingHeredocs: Array<readonly [Word, boolean]> = [];
    /** digits just read that name the next redirect's descriptor */
    private fd: number | undefined = undefined;

    constructor(text: string) {
        this.s = text;
        this.n = text.length;
    }

    // ------------------------------------------------------------------ //
    // Driver
    // ------------------------------------------------------------------ //

    run(): LexResult {
        while (this.i < this.n) {
            const c = this.s[this.i] as string;
            if (c === " " || c === "\t") {
                this.i += 1;
            } else if (c === "\\" && this.peek(1) === "\n") {
                this.i += 2;
            } else if (c === "#") {
                this.skipComment();
            } else if ((c === "<" || c === ">") && this.peek(1) === "(") {
                this.word();
            } else if (c === "(" && this.peek(1) === "(" && this.arithmeticCommand()) {
                // consumed as one word
            } else if (c === "\n") {
                this.result.tokens.push(new Operator("\n"));
                this.i += 1;
                this.readHeredocBodies();
            } else {
                const op = this.matchOperator();
                if (op !== undefined) {
                    this.i += op.length;
                    this.result.tokens.push(new Operator(op, this.fd));
                    this.fd = undefined;
                    if (HEREDOC_OPERATORS.has(op)) this.heredocDelimiter(op === "<<-");
                } else {
                    this.word();
                }
            }
        }
        return this.result;
    }

    peek(offset: number): string {
        const index = this.i + offset;
        return index < this.n ? (this.s[index] as string) : "";
    }

    private matchOperator(): string | undefined {
        return OPERATORS.find((op) => this.s.startsWith(op, this.i));
    }

    private skipComment(): void {
        const end = this.s.indexOf("\n", this.i);
        this.i = end < 0 ? this.n : end;
    }

    // ------------------------------------------------------------------ //
    // Words
    // ------------------------------------------------------------------ //

    private word(): void {
        const word = this.readWord();
        // `2>file`: digits glued to a redirect are a file descriptor, not an argument.
        if (
            isDigits(word.text) &&
            !word.quoted &&
            this.i < this.n &&
            "<>".includes(this.s[this.i] as string)
        ) {
            this.fd = Number(word.text);
            return;
        }
        this.result.tokens.push(word);
    }

    private readWord(): Word {
        const parts: string[] = [];
        // Whether each part can end in a bare `$NAME` (an expansion, or text in
        // double quotes), so a following part must not extend the name.
        const expands: boolean[] = [];
        const word = new Word("");

        const add = (text: string, expansion = false): void => {
            const first = text[0];
            if (
                parts.length > 0 &&
                expands[expands.length - 1] &&
                first &&
                (isAlnumChar(first) || first === "_")
            ) {
                // `$X'm'` is $X then m: write it `${X}m` so the name stays X.
                parts[parts.length - 1] = (parts[parts.length - 1] as string).replace(
                    BARE_NAME_TAIL,
                    (_, name: string) => `\${${name}}`,
                );
            }
            parts.push(text);
            expands.push(expansion);
        };

        while (this.i < this.n) {
            const c = this.s[this.i] as string;
            if ((c === "<" || c === ">") && this.peek(1) === "(") {
                add(this.processSubstitution(word));
                continue;
            }
            if (METACHARACTERS.includes(c)) break;
            if (c === "\\") {
                const nxt = this.peek(1);
                if (nxt === "\n") {
                    this.i += 2;
                    continue;
                }
                add(nxt);
                word.quoted = true;
                this.i += 2;
            } else if (c === "'") {
                word.quoted = true;
                add(this.singleQuoted());
            } else if (c === "$" && this.peek(1) === "'") {
                word.quoted = true;
                add(this.ansiCQuoted());
            } else if (c === '"') {
                word.quoted = true;
                add(this.doubleQuoted(word), true);
            } else if (c === "$" || c === "`") {
                word.splits = true;
                add(this.expansion(word), true);
            } else {
                if (c === "{" || c === "," || c === "}") {
                    word.braces.push(parts.reduce((total, part) => total + part.length, 0));
                }
                add(c);
                this.i += 1;
            }
        }
        word.text = parts.join("");
        if (this.i < this.n && this.s[this.i] === "(" && !word.quoted && COMPOUND_TARGET.test(word.text)) {
            this.compoundElements(word);
        }
        return word;
    }

    /** `NAME=(...)` / `NAME+=(...)`: read the element words up to the closing `)`. */
    private compoundElements(word: Word): void {
        this.i += 1;
        const elements: Word[] = [];
        word.elements = elements;
        while (this.i < this.n) {
            const c = this.s[this.i] as string;
            if (c === ")") {
                this.i += 1;
                return;
            }
            if (c === " " || c === "\t" || c === "\n") {
                this.i += 1;
            } else if (c === "#") {
                const end = this.s.indexOf("\n", this.i);
                this.i = end < 0 ? this.n : end;
            } else if (METACHARACTERS.includes(c)) {
                this.i += 1; // not valid inside an array; bash rejects the line
            } else {
                const element = this.readWord();
                elements.push(element);
                word.dynamic = word.dynamic || element.dynamic;
                word.substitutions.push(...element.substitutions);
            }
        }
        this.result.unterminated = true;
    }

    private singleQuoted(): string {
        const end = this.s.indexOf("'", this.i + 1);
        if (end < 0) {
            this.result.unterminated = true;
            const text = this.s.slice(this.i + 1);
            this.i = this.n;
            return text;
        }
        const text = this.s.slice(this.i + 1, end);
        this.i = end + 1;
        return text;
    }

    private ansiCQuoted(): string {
        this.i += 2;
        const out: string[] = [];
        while (this.i < this.n) {
            const c = this.s[this.i] as string;
            if (c === "'") {
                this.i += 1;
                return out.join("");
            }
            if (c === "\\" && this.i + 1 < this.n) {
                out.push(this.ansiCEscape());
                continue;
            }
            out.push(c);
            this.i += 1;
        }
        this.result.unterminated = true;
        return out.join("");
    }

    private ansiCEscape(): string {
        const nxt = this.s[this.i + 1] as string;
        const simple = ANSI_C_ESCAPES.get(nxt);
        if (simple !== undefined) {
            this.i += 2;
            return simple;
        }
        if (nxt === "x") {
            const digits = this.takeWhile(this.i + 2, HEX_DIGITS, 2);
            this.i += 2 + digits.length;
            return digits ? String.fromCodePoint(Number.parseInt(digits, 16)) : "x";
        }
        if (OCTAL_DIGITS.includes(nxt)) {
            const digits = this.takeWhile(this.i + 1, OCTAL_DIGITS, 3);
            this.i += 1 + digits.length;
            return String.fromCodePoint(Number.parseInt(digits, 8));
        }
        if (nxt === "u" || nxt === "U") {
            // `\uHHHH` / `\UHHHHHHHH`: a Unicode character (`$'rm'` is rm).
            const digits = this.takeWhile(this.i + 2, HEX_DIGITS, nxt === "u" ? 4 : 8);
            if (digits && Number.parseInt(digits, 16) <= 0x10ffff) {
                this.i += 2 + digits.length;
                return String.fromCodePoint(Number.parseInt(digits, 16));
            }
        }
        if (nxt === "c" && this.i + 2 < this.n) {
            // `\cX`: the control character for X.
            this.i += 3;
            return String.fromCodePoint((this.s.codePointAt(this.i - 1) as number) & 0x1f);
        }
        this.i += 2;
        return `\\${nxt}`;
    }

    private takeWhile(start: number, allowed: string, limit: number): string {
        let end = start;
        while (end < this.n && end - start < limit && allowed.includes(this.s[end] as string)) end += 1;
        return this.s.slice(start, end);
    }

    private doubleQuoted(word: Word): string {
        this.i += 1;
        const out: string[] = [];
        while (this.i < this.n) {
            const c = this.s[this.i] as string;
            if (c === '"') {
                this.i += 1;
                return out.join("");
            }
            const nxt = this.peek(1);
            // Python's `peek(1) in "..."` is true at the end of the text: `"".includes` is too.
            if (c === "\\" && '$`"\\\n'.includes(nxt)) {
                if (nxt !== "\n") out.push(nxt);
                this.i += 2;
            } else if (c === "$" || c === "`") {
                out.push(this.expansion(word));
            } else {
                out.push(c);
                this.i += 1;
            }
        }
        this.result.unterminated = true;
        return out.join("");
    }

    // ------------------------------------------------------------------ //
    // Expansions and substitutions
    // ------------------------------------------------------------------ //

    /** Consume a `$...` or backtick expansion; return its source text verbatim. */
    expansion(word: Word): string {
        const start = this.i;
        const c = this.s[this.i];
        if (c === "`") {
            const body = this.backtickBody();
            this.substitute(word, [body]);
            word.dynamic = true;
            return this.s.slice(start, this.i);
        }

        const nxt = this.peek(1);
        if (nxt === "(" && this.peek(2) === "(") {
            this.i += 3;
            // Arithmetic runs any command substitution inside it: `$(( $(cmd) + 1 ))`.
            const body = this.balanced(")", "(");
            if (this.i < this.n && this.s[this.i] === ")") this.i += 1; // the second `)` of `))`
            this.substitute(word, nestedSubstitutions(body));
            word.dynamic = true;
            return this.s.slice(start, this.i);
        }
        if (nxt === "(") {
            this.i += 2;
            const body = this.balanced(")", "(");
            this.substitute(word, [body]);
            word.dynamic = true;
            return this.s.slice(start, this.i);
        }
        if (nxt === "{") {
            this.i += 2;
            const body = this.balanced("}", "{");
            const first = word.substitutions.length;
            this.substitute(word, nestedSubstitutions(body));
            const guarded = GUARDED_WORD.exec(body);
            if (guarded) {
                for (let index = first; index < word.substitutions.length; index += 1) {
                    if (!word.guards.has(index))
                        word.guards.set(index, [guarded[1] as string, guarded[2] as string]);
                }
            }
            word.dynamic = true;
            return this.s.slice(start, this.i);
        }
        if (nxt && (isAlnumChar(nxt) || "_@*#?$!-".includes(nxt))) {
            this.i += 2;
            if (isAlphaChar(nxt) || nxt === "_") {
                while (this.i < this.n && (isAlnumChar(this.s[this.i] as string) || this.s[this.i] === "_")) {
                    this.i += 1;
                }
            }
            word.dynamic = true;
            return this.s.slice(start, this.i);
        }
        this.i += 1;
        return "$";
    }

    /**
     * `(( expr ))` as one word, when it closes with `))` and holds no command
     * separators; otherwise it is two subshells, `((cd x; ls))`, and nothing is read.
     */
    private arithmeticCommand(): boolean {
        const start = this.i;
        const unterminated = this.result.unterminated;
        this.i += 2;
        const body = this.balanced(")", "(");
        const closes = this.i < this.n && this.s[this.i] === ")";
        if (!closes || COMMAND_SEPARATOR.test(body.replace(NESTED_COMMAND, ""))) {
            this.i = start;
            this.result.unterminated = unterminated;
            return false;
        }
        this.i += 1;
        const word = new Word(`((${body}))`, { dynamic: true });
        this.substitute(word, nestedSubstitutions(body));
        this.result.tokens.push(word);
        return true;
    }

    private backtickBody(): string {
        this.i += 1;
        const out: string[] = [];
        while (this.i < this.n) {
            const c = this.s[this.i] as string;
            const nxt = this.peek(1);
            if (c === "\\" && "`$\\".includes(nxt)) {
                out.push(nxt);
                this.i += 2;
                continue;
            }
            if (c === "`") {
                this.i += 1;
                return out.join("");
            }
            out.push(c);
            this.i += 1;
        }
        this.result.unterminated = true;
        return out.join("");
    }

    /**
     * Consume up to the matching `close`, honouring quotes and heredocs.
     *
     * Returns the inner text. Heredoc bodies are skipped as data, so an
     * apostrophe in `$(cat <<'EOF' ... it's ... EOF)` does not open a quote.
     */
    private balanced(close: string, open: string): string {
        const start = this.i;
        let depth = 1;
        let pendingHeredocs: Array<readonly [string, boolean]> = [];
        while (this.i < this.n) {
            const c = this.s[this.i] as string;
            if (c === "\\") {
                this.i += 2;
                continue;
            }
            if (c === "<" && this.s.startsWith("<<", this.i) && !this.s.startsWith("<<<", this.i)) {
                pendingHeredocs.push(this.scanHeredocDelimiter());
                continue;
            }
            if (c === "\n" && pendingHeredocs.length > 0) {
                this.i += 1;
                for (const [delimiter, stripTabsFlag] of pendingHeredocs)
                    this.skipHeredocBody(delimiter, stripTabsFlag);
                pendingHeredocs = [];
                continue;
            }
            if (c === "'") {
                const end = this.s.indexOf("'", this.i + 1);
                this.i = end < 0 ? this.n : end + 1;
                continue;
            }
            if (c === '"') {
                this.skipDoubleQuoted();
                continue;
            }
            if (c === "`") {
                const end = this.s.indexOf("`", this.i + 1);
                this.i = end < 0 ? this.n : end + 1;
                continue;
            }
            if (c === open) {
                depth += 1;
            } else if (c === close) {
                depth -= 1;
                if (depth === 0) {
                    const body = this.s.slice(start, this.i);
                    this.i += 1;
                    return body;
                }
            }
            this.i += 1;
        }
        this.result.unterminated = true;
        return this.s.slice(start);
    }

    /** At `<<`: consume the operator and delimiter word; return (delimiter, strip_tabs). */
    private scanHeredocDelimiter(): readonly [string, boolean] {
        this.i += 2;
        const stripTabsFlag = this.peek(0) === "-";
        if (stripTabsFlag) this.i += 1;
        while (this.i < this.n && (this.s[this.i] === " " || this.s[this.i] === "\t")) this.i += 1;
        const start = this.i;
        while (this.i < this.n && !METACHARACTERS.includes(this.s[this.i] as string)) this.i += 1;
        const raw = this.s.slice(start, this.i);
        return [raw.replaceAll("'", "").replaceAll('"', "").replaceAll("\\", ""), stripTabsFlag];
    }

    private skipHeredocBody(delimiter: string, stripTabsFlag: boolean): void {
        while (this.i < this.n) {
            const end = this.s.indexOf("\n", this.i);
            const line = end < 0 ? this.s.slice(this.i) : this.s.slice(this.i, end);
            this.i = end < 0 ? this.n : end + 1;
            if ((stripTabsFlag ? stripTabs(line) : line) === delimiter) return;
        }
    }

    private skipDoubleQuoted(): void {
        this.i += 1;
        while (this.i < this.n) {
            const c = this.s[this.i];
            if (c === "\\") {
                this.i += 2;
                continue;
            }
            this.i += 1;
            if (c === '"') return;
        }
        this.result.unterminated = true;
    }

    private substitute(word: Word, bodies: readonly string[]): void {
        word.substitutions.push(...bodies);
        this.result.substitutions.push(...bodies);
    }

    private processSubstitution(word: Word): string {
        const start = this.i;
        this.i += 2;
        const body = this.balanced(")", "(");
        word.dynamic = true;
        this.substitute(word, [body]);
        return this.s.slice(start, this.i);
    }

    // ------------------------------------------------------------------ //
    // Heredocs
    // ------------------------------------------------------------------ //

    private heredocDelimiter(stripTabsFlag: boolean): void {
        while (this.i < this.n && (this.s[this.i] === " " || this.s[this.i] === "\t")) this.i += 1;
        if (this.i >= this.n || METACHARACTERS.includes(this.s[this.i] as string)) return;
        const start = this.i;
        const delimiter = this.readWord();
        const raw = this.s.slice(start, this.i);
        // The delimiter is literal text; any `$` in it is not an expansion.
        const word = new Word(delimiter.dynamic ? raw : delimiter.text, { quoted: delimiter.quoted });
        this.result.tokens.push(word);
        this.pendingHeredocs.push([word, stripTabsFlag]);
    }

    private readHeredocBodies(): void {
        const pending = this.pendingHeredocs;
        this.pendingHeredocs = [];
        for (const [word, stripTabsFlag] of pending) {
            const lines: string[] = [];
            let terminated = false;
            while (this.i < this.n) {
                const end = this.s.indexOf("\n", this.i);
                const line = end < 0 ? this.s.slice(this.i) : this.s.slice(this.i, end);
                this.i = end < 0 ? this.n : end + 1;
                if ((stripTabsFlag ? stripTabs(line) : line) === word.text) {
                    terminated = true;
                    break;
                }
                lines.push(stripTabsFlag ? stripTabs(line) : line);
            }
            word.heredocBody = lines.join("\n");
            if (!terminated) this.result.unterminated = true;
            if (!word.quoted) {
                // An unquoted heredoc expands $(...) and backticks in its body.
                this.substitute(word, nestedSubstitutions(word.heredocBody));
            }
        }
    }
}

/** Command substitution bodies found anywhere in `text` (e.g. a heredoc or ${...}). */
export function nestedSubstitutions(text: string): string[] {
    if (!text.includes("$(") && !text.includes("`")) return [];
    const found: string[] = [];
    const lexer = new Lexer(text);
    while (lexer.i < lexer.n) {
        const c = lexer.s[lexer.i];
        if (c === "\\") {
            lexer.i += 2;
        } else if (c === "$" || c === "`") {
            lexer.expansion(new Word(""));
        } else {
            lexer.i += 1;
        }
    }
    found.push(...lexer.result.substitutions);
    return found;
}

/** Tokenize `text`. Never raises. */
export function lex(text: string): LexResult {
    return new Lexer(text).run();
}
