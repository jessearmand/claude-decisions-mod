/**
 * Redaction of credentials from text sent to the model judge.
 *
 * Everything bash-risk-judge.ts sends to a third-party evaluator (the command,
 * the user's prompt, recent commands, script bodies) passes through `redact`
 * first. Redaction is what makes it acceptable to send that text at all, so it
 * stays deterministic and errs toward removing too much.
 *
 * Only literals are redacted. A value that starts with `$`, a backtick, `<` or
 * `(` is a reference or substitution: it holds no secret itself, and removing it
 * hides exactly the behaviour the model is being asked about.
 *
 * The secrets guard remains the real gate on credential access; this module
 * only keeps credentials that already appear in the text from leaving the machine.
 *
 * Ported from judge_redact.py: every pattern and the multi-pass order are kept
 * exactly. The patterns are built from `String.raw` fragments so a backslash
 * reads as it did in the Python source.
 */

import { isAlpha, splitWhitespace, stripChars } from "../util/text.ts";

export const REDACTED = "<redacted>";

// A credential term, possibly inside a longer name (`AWS_SECRET_ACCESS_KEY`,
// `GITHUB_PAT`, `SLACK_WEBHOOK_URL`), but not one naming where the secret lives
// (`PASSWORD_FILE`, `SECRET_NAME`). `pat` must not start inside a word (`expat`)
// or a file extension (`brush.pat`); `PATH` and `PATTERN` fail on the next letter.
const SECRET_KEY =
    "(?:token|secret|password|passwd|pwd|passphrase|api[_-]?key|authorization|bearer|cookie|" +
    "(?<![A-Za-z.])pat|credentials?|webhook|" +
    "(?:private|access|signing|license|encryption|master|session|ssh|gpg|deploy|service)[_-]?key)" +
    "(?:[_-][A-Za-z0-9]+)*(?<![_-]file)(?<![_-]path)(?<![_-]dir)(?<![_-]name)";
// HTTP auth schemes are kept so the model still sees what kind of credential it is.
const AUTH_SCHEME = "(?:bearer|basic|token|digest|negotiate)";
// What may start a value that is a reference, not a literal.
const REFERENCE = String.raw`[$\`<(]`;

const SECRET_VALUE = new RegExp(
    // The key bare (`TOKEN=`) or quoted on both sides (`"api_key":`, `'github_token':`).
    String.raw`(?<key>(?:["'][\w-]*?${SECRET_KEY}["']|${SECRET_KEY})` +
        // An auth scheme is kept, quoted or not: `"authorization":"Basic <redacted>"`.
        String.raw`(?:[\s:=]+["']?${AUTH_SCHEME}\b)?[\s:=]+)(?![\s:=]|["']?(?:${REFERENCE}|${AUTH_SCHEME}\b|${REDACTED}))` +
        // A quoted value is redacted through its closing quote (spaces included).
        // Backslash escapes inside it (`"a\\"b"`) do not end it; nor does `\ ` in a bare value.
        String.raw`(?:"(?<double>(?:[^"\\]|\\.)*)"|'(?<single>(?:[^'\\]|\\.)*)'|["']?(?:\\.|[^\s"'\\])+)` +
        String.raw`|\b(?:sk|ghp|gho|ghs|ghu|ghr|github_pat|xox[abpe]|xapp|AKIA|AIza|hf|npm_|pypi-|glpat-|dop_v1_)` +
        String.raw`[A-Za-z0-9_\-]{16,}` +
        String.raw`|\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}`,
    "gi",
);

// Inside one shell-quoted word, a credential whose value is not itself quoted:
// `-H 'X-Api-Key: correct horse'`, `"Authorization: Token a b"`, `'password=a b&x=1'`.
// The value runs to the end of the quoted word, not to the first space. Quoted
// words nested inside it are redacted first, so their result is not swallowed.
const SECRET_IN_QUOTED_WORD = new RegExp(
    String.raw`(?<key>${SECRET_KEY}\s*[:=][\s:=]*(?:${AUTH_SCHEME}\s+)?)(?![\s:="']|${REFERENCE}|${REDACTED}|${AUTH_SCHEME}\b).+`,
    "is",
);

// Prose labels have no shell-word boundary: a passphrase may contain spaces.
// Consume the rest of that line rather than leaking all but its first word.
// Colon and spaced-`=` are always prose. No-space `password=correct horse …`
// is prose too. Env-style assignments (`TOKEN=value cmd`) and option flags
// (`--password=value host`) stay token-scoped so a following command remains visible.
const PROSE_SECRET_VALUE = new RegExp(
    String.raw`(?<key>(?<![\w=.-])[\w-]*?${SECRET_KEY}(?:[ \t]*:[ \t]*|[ \t]+=[ \t]*))` +
        String.raw`(?![ \t"']|${REFERENCE}|${REDACTED}|${AUTH_SCHEME}\b)[^\r\n]+`,
    "gim",
);
// The name and the `=` only. Whether the rest of the line is the value is
// decided per match, so a shell assignment does not swallow a later label.
const PROSE_NO_SPACE = new RegExp(
    String.raw`(?<key>(?<![\w=.-])(?<name>[\w-]*?${SECRET_KEY})=[ \t]*)` +
        String.raw`(?!["']|${REFERENCE}|${REDACTED}|${AUTH_SCHEME}\b)(?=\S)`,
    "gim",
);
const ENV_ASSIGNMENT = /^[A-Z_][A-Z0-9_]*$/;
const ASSIGN_INTRODUCER =
    /\b(?:export|declare|local|readonly|typeset|env|command|sudo|nice|nohup|builtin|time)\s+$/i;
const PRIOR_ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_]*=(?:\\.|[^\s"'\\])+)\s+$/;
const ASSIGNMENT_SITE = /(?:^|[\n;&|({]|&&|\|\|)\s*$/;

// Incoming-webhook URLs: the path is the credential (PR review).
const WEBHOOK_URL =
    /(https?:\/\/(?:hooks\.slack\.com\/services\/|discord(?:app)?\.com\/api\/webhooks\/|[\w.-]*webhook\.office\.com\/webhookb2\/|api\.telegram\.org\/bot|hooks\.zapier\.com\/hooks\/catch\/|events\.pagerduty\.com\/))[^\s"'<>]+/g;
// `https://user:pass@host`: the password in a URL's userinfo.
const URL_USERINFO = /(\b[a-zA-Z][\w+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/g;
// The password half of Basic-auth credentials given to curl's -u / --user (spaced,
// attached or with =), -U / --proxy-user, and httpie's -a / --auth.
const BASIC_AUTH_OPTION =
    // A quoted credential is redacted through its closing quote (spaces included).
    // Inside double quotes a backslash escapes the next character (`\\"` does not end it).
    /((?:\s-u|\s--user|\s--proxy-user|\s-U|\s--auth|\s-a)(?:\s+|=)?)(?:'([^':]+:)[^']*'|"((?:[^"\\:]|\\.)+:)(?:[^"\\]|\\.)*"|([^\s:"']+:)[^\s"']+)/g;
// A PEM/OpenSSH/PGP private key block, or one cut off before its END line.
const PRIVATE_KEY = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----.*?(?:-----END \1-----|$)/gs;

/**
 * (start, end) of each top-level shell-quoted region's contents, quotes excluded.
 *
 * Follows bash quoting: a backslash outside quotes escapes the next character
 * (so `it\'s` opens nothing), `'…'` has no escapes, `$'…'` and `"…"` do.
 * An unterminated quote runs to the end of the text.
 */
export function* quotedSpans(text: string): Generator<[number, number]> {
    const n = text.length;
    let i = 0;
    while (i < n) {
        const char = text[i];
        if (char === "\\") {
            i += 2;
            continue;
        }
        if (char !== "'" && char !== '"') {
            i += 1;
            continue;
        }
        const escapes = char === '"' || (i > 0 && text[i - 1] === "$");
        const start = i + 1;
        let j = start;
        while (j < n && text[j] !== char) {
            j += escapes && text[j] === "\\" ? 2 : 1;
        }
        const end = Math.min(j, n);
        yield [start, end];
        i = end + 1;
    }
}

function redactQuotedWords(text: string): string {
    const pieces: string[] = [];
    let last = 0;
    for (const [start, end] of quotedSpans(text)) {
        pieces.push(text.slice(last, start));
        const inner = redactQuotedWords(text.slice(start, end));
        // Python `count=1`: the regex carries no `g` flag, so one replacement.
        pieces.push(
            inner.replace(SECRET_IN_QUOTED_WORD, (...args) => `${groupsOf(args).key ?? ""}${REDACTED}`),
        );
        last = end;
    }
    pieces.push(text.slice(last));
    return pieces.join("");
}

/** The named groups of a `String.replace` callback's arguments. */
function groupsOf(args: unknown[]): Record<string, string | undefined> {
    const groups = args[args.length - 1];
    return typeof groups === "object" && groups !== null
        ? (groups as Record<string, string | undefined>)
        : {};
}

/** `-u 'user:pass words'` -> `-u 'user:<redacted>'`, keeping the quoting. */
function basicAuthRedacted(
    _match: string,
    option: string,
    single: string | undefined,
    double: string | undefined,
    bare: string | undefined,
): string {
    if (single !== undefined) return `${option}'${single}${REDACTED}'`;
    if (double !== undefined) return `${option}"${double}${REDACTED}"`;
    return `${option}${bare ?? ""}${REDACTED}`;
}

/** How many leading words are alphabetic, ignoring one punctuation mark each. */
function leadingPlainCount(value: string): number {
    let count = 0;
    for (const word of splitWhitespace(value)) {
        const cleaned = stripChars(word, ".,;:!?");
        if (cleaned === "" || !isAlpha(cleaned)) break;
        count += 1;
    }
    return count;
}

/** True where bash would accept `NAME=value` as a prefix assignment. */
function shellAssignmentSite(text: string, nameStart: number, depth = 0): boolean {
    if (depth > 6) return false;
    const prefix = text.slice(0, nameStart);
    if (ASSIGNMENT_SITE.test(prefix)) return true;
    const introducer = ASSIGN_INTRODUCER.exec(prefix);
    if (introducer && shellAssignmentSite(text, introducer.index, depth + 1)) return true;
    const prior = PRIOR_ASSIGNMENT.exec(prefix);
    // Group 1 opens the pattern, so its start is the match's start.
    return Boolean(prior && shellAssignmentSite(text, prior.index, depth + 1));
}

function precededByOption(text: string, nameStart: number): boolean {
    const prefix = text.slice(0, nameStart).replace(/[ \t]+$/, "");
    const words = splitWhitespace(prefix);
    const token = prefix ? (words[words.length - 1] ?? "") : "";
    return token.startsWith("-") && token !== "-";
}

/**
 * Leave one shell word for `SECRET_VALUE` instead of consuming the line.
 *
 * `TOKEN=value cmd` and `--password=value host` are one token plus a command.
 * `password=correct horse battery staple` is a passphrase, including when it
 * sits where an assignment could: three or more plain words are the value.
 * A single trailing word (`password=secret cmd`) stays the command.
 */
function keepShellToken(text: string, nameStart: number, name: string, value: string): boolean {
    if (name.startsWith("-")) return true;
    const plain = leadingPlainCount(value);
    // Three plain words are a passphrase even when the line continues (`… staple for user42`).
    const passphrase = plain >= 3;
    const assignment = shellAssignmentSite(text, nameStart);
    if (ENV_ASSIGNMENT.test(name)) {
        // An all-caps name in a sentence can still introduce a passphrase.
        // `TOKEN=value cmd` at an assignment site stays one token.
        return !(passphrase && !assignment);
    }
    if (passphrase) return false;
    if (assignment || precededByOption(text, nameStart)) return true;
    return splitWhitespace(value).length < 2;
}

function redactNospaceProse(text: string): string {
    const pieces: string[] = [];
    let last = 0;
    for (const match of text.matchAll(PROSE_NO_SPACE)) {
        const start = match.index;
        if (start < last) continue;
        const key = match.groups?.key ?? "";
        const name = match.groups?.name ?? "";
        const end = start + match[0].length;
        let lineEnd = text.indexOf("\n", end);
        if (lineEnd === -1) lineEnd = text.length;
        const value = text.slice(end, lineEnd);
        // The `name` group opens the match (the lookbehind is zero-width), so it starts at `start`.
        if (keepShellToken(text, start, name, value)) continue;
        pieces.push(text.slice(last, start));
        pieces.push(key + REDACTED);
        last = lineEnd;
    }
    pieces.push(text.slice(last));
    return pieces.join("");
}

function secretValueRedacted(...args: unknown[]): string {
    const whole = String(args[0]);
    const groups = groupsOf(args);
    const key = groups.key;
    if (!key) return REDACTED;
    let quote = groups.double !== undefined ? '"' : groups.single !== undefined ? "'" : "";
    const first = whole.slice(key.length).slice(0, 1);
    if (!quote && "\"'".includes(first)) {
        quote = whole[key.length] ?? ""; // an unclosed quote stays in place
        return `${key}${quote}${REDACTED}`;
    }
    return `${key}${quote}${REDACTED}${quote}`;
}

/** `text` with every recognisable credential literal replaced by `<redacted>`. */
export function redact(text: string): string {
    let result = text.replace(PRIVATE_KEY, "<redacted private key>");
    result = result.replace(URL_USERINFO, `$1${REDACTED}@`);
    result = result.replace(WEBHOOK_URL, `$1${REDACTED}`);
    result = result.replace(BASIC_AUTH_OPTION, basicAuthRedacted);
    result = redactQuotedWords(result);
    result = result.replace(PROSE_SECRET_VALUE, (...args) => `${groupsOf(args).key ?? ""}${REDACTED}`);
    result = redactNospaceProse(result);
    return result.replace(SECRET_VALUE, secretValueRedacted);
}
