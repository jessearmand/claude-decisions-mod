/**
 * Shell commands embedded in interpreter one-liners and awk programs.
 *
 * `python3 -c "import os; os.system('rm -rf ~')"` and
 * `awk 'BEGIN { system("rm -rf ~") }'` run a shell command just as surely as
 * `bash -c` does. This module finds the inline program of an interpreter
 * invocation and, when that program can hand a string to a shell (os.system,
 * subprocess, child_process, backticks, Perl system/qx, awk system/pipes),
 * returns the string literals in it so the parser can analyze them as shell.
 *
 * Only literal strings are visible. Commands assembled at run time
 * (`"r" + "m"`, chr(), base64) are not; the model judge sees the whole program.
 * Native file APIs such as shutil.rmtree are likewise left to the judge.
 *
 * Ported from shell_interpreters.py.
 */

import { shellQuote } from "../util/text.ts";
import { HEREDOC_OPERATORS } from "./lexer.ts";
import type { Redirect } from "./model.ts";

type CodeFlags = readonly [codeFlags: ReadonlySet<string>, withArg: ReadonlySet<string>];

// Inline-code flags per interpreter, and flags that consume a value.
const CODE_FLAGS: ReadonlyMap<string, CodeFlags> = new Map<string, CodeFlags>([
    ["python", [new Set(["-c"]), new Set(["-W", "-X", "-m"])]],
    [
        "node",
        [
            new Set(["-e", "--eval", "-p", "--print"]),
            new Set([
                "-r",
                "--require",
                "-C",
                "--conditions",
                "--import",
                "--loader",
                "--input-type",
                "--env-file",
            ]),
        ],
    ],
    ["bun", [new Set(["-e", "--eval", "-p", "--print"]), new Set(["-r", "--preload"])]],
    ["deno", [new Set(["eval"]), new Set()]],
    ["ruby", [new Set(["-e"]), new Set(["-C", "-E", "-F", "-I", "-r"])]],
    ["perl", [new Set(["-e", "-E"]), new Set(["-F", "-I", "-M", "-m"])]],
    ["php", [new Set(["-r"]), new Set(["-c", "-d", "-f"])]],
    ["osascript", [new Set(["-e"]), new Set(["-l"])]],
]);
const PYTHON = /^python(?:\d+(?:\.\d+)?)?$/;
const AWKS: ReadonlySet<string> = new Set(["awk", "gawk", "mawk", "nawk"]);

// Calls that pass a string to a shell or exec.
const EXEC_SINK =
    /`|%x|\bsystem\b|\bexec(?:Sync|File|FileSync|vp?|lp?)?\b|\bspawn(?:Sync)?\b|\bpopen\b|\bsubprocess\b|\bchild_process\b|\bopen3\b|\bqx\b|\bcheck_output\b|\bcheck_call\b|\bgetoutput\b|\bshell_exec\b|\bpassthru\b|\bproc_open\b|\bdo shell script\b|\bDeno\.Command\b|\bBun\.spawn\b|\$\(/;
const STRING_LITERAL_SOURCE =
    "\"\"\"(.*?)\"\"\"|'''(.*?)'''|\"((?:[^\"\\\\\\n]|\\\\.)*)\"|'((?:[^'\\\\\\n]|\\\\.)*)'|`((?:[^`\\\\]|\\\\.)*)`|\\bqx\\s*\\{([^}]*)\\}|\\bqx\\s*\\(([^)]*)\\)";
const STRING_LITERAL = new RegExp(STRING_LITERAL_SOURCE, "gs");
/** `_STRING_LITERAL.match(rest)`: anchored at the start. */
const STRING_LITERAL_AT_START = new RegExp(`^(?:${STRING_LITERAL_SOURCE})`, "s");
const AWK_COMMANDS =
    /\bsystem\s*\(\s*"((?:[^"\\]|\\.)*)"|\|\s*"((?:[^"\\]|\\.)*)"|"((?:[^"\\]|\\.)*)"\s*\|\s*getline/g;

/** The first capture group that took part in the match (Python `next(g for g in groups if g is not None)`). */
function firstGroup(match: RegExpMatchArray, from = 1): string | undefined {
    return match.slice(from).find((group) => group !== undefined);
}

export function interpreterKind(name: string): string | undefined {
    if (PYTHON.test(name)) return "python";
    return CODE_FLAGS.has(name) ? name : undefined;
}

/** The program text an interpreter runs from its arguments or a heredoc. */
export function inlinePrograms(
    name: string,
    args: readonly string[],
    redirects: readonly Redirect[] = [],
): string[] {
    const kind = interpreterKind(name);
    if (kind === undefined) return [];
    const [codeFlags, withArg] = CODE_FLAGS.get(kind) as CodeFlags;
    const programs: string[] = [];
    let index = 0;
    while (index < args.length) {
        const arg = args[index] as string;
        if (codeFlags.has(arg) && index + 1 < args.length) {
            programs.push(args[index + 1] as string);
            index += 2;
            continue;
        }
        const equals = arg.indexOf("=");
        if (arg.startsWith("--") && equals >= 0 && codeFlags.has(arg.slice(0, equals))) {
            programs.push(arg.slice(equals + 1));
            index += 1;
            continue;
        }
        const attached = [...codeFlags].find(
            (f) => f.startsWith("-") && !f.startsWith("--") && arg.startsWith(f) && arg.length > f.length,
        );
        if (attached !== undefined) {
            programs.push(arg.slice(attached.length));
        } else if (
            arg.startsWith("-") &&
            arg.length > 2 &&
            "ce".includes(arg[arg.length - 1] as string) &&
            arg[1] !== "-"
        ) {
            // Clusters such as `perl -ne`, `ruby -pe`, `python -Bc`.
            if (codeFlags.has(`-${arg[arg.length - 1]}`) && index + 1 < args.length) {
                programs.push(args[index + 1] as string);
                index += 2;
                continue;
            }
        } else if (withArg.has(arg)) {
            index += 1;
        }
        index += 1;
    }
    for (const redirect of redirects) {
        if (HEREDOC_OPERATORS.has(redirect.op) && redirect.body) programs.push(redirect.body);
        else if (redirect.op === "<<<") programs.push(redirect.target);
    }
    return programs;
}

/** String literals in `program` that could reach a shell, if it has an exec sink. */
export function shellStrings(program: string): string[] {
    if (!EXEC_SINK.test(program)) return [];
    const found: string[] = [];
    for (const match of program.matchAll(STRING_LITERAL)) {
        const literal = unescaped(firstGroup(match) ?? "");
        if (literal.trim() && !found.includes(literal)) found.push(literal);
    }
    return withArgvJoins(program, found);
}

// A call whose first argument a shell (or exec) runs: `os.system("...")`,
// `execSync("...")`, `system("...")`, `subprocess.run([...])`, `do shell script "..."`.
const SINK_CALL =
    /\b(?:os\.(?:system|popen|exec\w*|spawn\w*)|subprocess\.\w+|commands\.getoutput|check_output|check_call|getoutput|system|popen|exec(?:Sync|File|FileSync)?|spawn(?:Sync)?|shell_exec|passthru|proc_open|Open3\.\w+|IO\.popen|Kernel\.(?:system|exec|spawn)|Deno\.Command|Bun\.spawn(?:Sync)?)\s*\(\s*|\bdo shell script\s+/g;
// Interpreters where a backtick string (or qx//, %x()) runs a shell command.
const BACKTICK_RUNS: ReadonlySet<string> = new Set(["ruby", "perl", "php"]);
const PERCENT_X = /%x\(([^)]*)\)/g;

/** Every string literal in `program`, unescaped, in order (no duplicates). */
export function stringLiterals(program: string): string[] {
    const found = [...program.matchAll(STRING_LITERAL)].map((m) => unescaped(firstGroup(m) ?? ""));
    return [...new Set(found)].filter((text) => text.trim());
}

/**
 * The literals in `program` that a shell or exec certainly receives: the
 * first argument of a sink call (a string, or a list joined into argv), and
 * backtick/qx/%x strings where those run commands. Other literals
 * `shellStrings` returns may only be data (`["echo", "rm -rf x"]`).
 */
export function directShellStrings(program: string, kind: string | undefined): string[] {
    const found: string[] = [];
    for (const call of program.matchAll(SINK_CALL)) {
        const rest = program.slice((call.index ?? 0) + call[0].length);
        const literal = STRING_LITERAL_AT_START.exec(rest);
        if (literal) {
            found.push(unescaped(firstGroup(literal) ?? ""));
        } else if (rest.startsWith("[")) {
            const joined = withArgvJoins(rest, []);
            found.push(...joined.slice(0, 1));
        }
    }
    if (kind !== undefined && BACKTICK_RUNS.has(kind)) {
        for (const match of program.matchAll(STRING_LITERAL)) {
            const command = firstGroup(match, 5); // `...`, qx{...}, qx(...)
            if (command !== undefined) found.push(unescaped(command));
        }
        found.push(...[...program.matchAll(PERCENT_X)].map((m) => unescaped(m[1] as string)));
    }
    return [...new Set(found)].filter((text) => text.trim());
}

function unescaped(literal: string): string {
    return literal.replaceAll("\\'", "'").replaceAll('\\"', '"').replaceAll("\\n", "\n");
}

const ARGV_LIST = /\[\s*((?:(['"])[^'"]*\2\s*,\s*)+(?:(['"])[^'"]*\3)?)/g;
const ARGV_WORD = /['"]([^'"]*)['"]/g;

/** Also join list-form argv (`['rm', '-rf', p]`) so `rm -rf` is visible as one command. */
function withArgvJoins(program: string, literals: readonly string[]): string[] {
    const joined: string[] = [];
    for (const match of program.matchAll(ARGV_LIST)) {
        const words = [...(match[1] as string).matchAll(ARGV_WORD)].map((m) => m[1] as string);
        if (words.length > 1) {
            // An argv list reaches no shell: each element stays one word (`>` is text).
            joined.push(words.map(shellQuote).join(" "));
        }
    }
    return [...literals, ...joined.filter((text) => !literals.includes(text))];
}

/** Literal commands an awk program runs through system(), `| "cmd"` or getline. */
export function awkCommands(name: string, args: readonly string[]): string[] {
    if (!AWKS.has(name)) return [];
    const program = awkProgram(args);
    if (!program) return [];
    const found: string[] = [];
    for (const match of program.matchAll(AWK_COMMANDS)) {
        const literal = (firstGroup(match) as string).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
        if (literal.trim()) found.push(literal);
    }
    return found;
}

function awkProgram(args: readonly string[]): string | undefined {
    let index = 0;
    while (index < args.length) {
        const arg = args[index] as string;
        if ((arg === "-e" || arg === "--source") && index + 1 < args.length) return args[index + 1];
        if (["-f", "--file", "-F", "-v", "--assign", "--field-separator"].includes(arg)) {
            index += 2;
            continue;
        }
        if (arg.startsWith("-") && arg !== "-") {
            index += 1;
            continue;
        }
        return arg;
    }
    return undefined;
}
