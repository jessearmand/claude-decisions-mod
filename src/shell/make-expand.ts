/**
 * GNU Make expansion, as far as the guards need it: which shell commands a
 * Makefile runs besides the literal recipe text.
 *
 *   * Variables. A recipe line `$(CLEAN)` runs whatever CLEAN holds, so recipes
 *     are expanded through the Makefile's variable table (`=`, `:=`, `::=`,
 *     `:::=`, `?=`, `+=`, with `override`/`export`) before they are parsed.
 *   * `$(shell CMD)` / `${shell CMD}`. Make runs CMD itself, at parse time for
 *     immediate assignments and top-level text, or when a recipe is expanded.
 *     Inside a recipe it becomes the shell substitution `$(CMD)`, so the parser
 *     sees CMD run. Anywhere else it is returned on its own by `parseTimeCommands`.
 *   * `VAR != CMD`. A shell assignment: CMD runs when the Makefile is read.
 *   * `$(file >PATH,TEXT)` / `$(file >>PATH,TEXT)`. Make itself writes PATH when
 *     the call is expanded, with no shell involved. `parseTimeWrites` returns
 *     each as the shell write it amounts to, `: > PATH` or `: >> PATH`.
 *
 * Everything here is text in, text out: no file access. It errs toward running
 * too much: every `$(shell …)` outside a recipe counts, even in a variable that
 * is never used, because the guards only ask about Makefile text.
 *
 * Ported from make_expand.py.
 */

import { shellQuote } from "../util/text.ts";

export const MAX_DEPTH = 8;

const ASSIGNMENT =
    /^(?:(?:override|export|private)\s+)*([A-Za-z_][\w.-]*)\s*(:::=|::=|:=|\?=|\+=|!=|=)\s*(.*)$/;
const SHELL_CALL = /\$([({])shell\s/;
const FILE_CALL = /\$([({])file\s+(>>?|<)\s*/;
const CLOSE: Readonly<Record<string, string>> = { "(": ")", "{": "}" };
/** A `#` that is not escaped: what ends a value (`re.split(r"(?<!\\)#", value, maxsplit=1)`). */
const COMMENT = /(?<!\\)#/;

export type VariableTable = Map<string, string>;

function logicalLines(text: string): string[] {
    return text.replaceAll("\\\n", " ").split("\n");
}

/**
 * name -> value for the Makefile's global variable assignments.
 *
 * Values stay unexpanded (as for `=`); `expand` resolves references when the
 * value is used. A `!=` value is command output, which is unknown here.
 */
export function variables(text: string): VariableTable {
    const table: VariableTable = new Map();
    for (const line of logicalLines(text)) {
        if (line.startsWith("\t")) continue;
        const match = ASSIGNMENT.exec(line.trim());
        if (!match) continue;
        const name = match[1] as string;
        const operator = match[2] as string;
        const rawValue = match[3] as string;
        const comment = COMMENT.exec(rawValue);
        const value = (comment ? rawValue.slice(0, comment.index) : rawValue).trim();
        if (operator === "?=") {
            if (!table.has(name)) table.set(name, value);
        } else if (operator === "+=") {
            table.set(name, table.has(name) ? `${table.get(name)} ${value}`.trim() : value);
        } else if (operator === "!=") {
            table.set(name, "");
        } else {
            table.set(name, value);
        }
    }
    return table;
}

/** Index just past the `$(…)`/`${…}` reference whose `$` is at `start`, or -1. */
function referenceEnd(text: string, start: number): number {
    const opening = text[start + 1] as string;
    const closing = CLOSE[opening];
    let depth = 0;
    for (let index = start + 1; index < text.length; index += 1) {
        const char = text[index];
        if (char === opening) depth += 1;
        else if (char === closing) {
            depth -= 1;
            if (depth === 0) return index + 1;
        }
    }
    return -1;
}

/** `pattern.match(text, pos)`: whether `pattern` matches at exactly `index`. */
function matchesAt(pattern: RegExp, text: string, index: number): boolean {
    const sticky = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}y`);
    sticky.lastIndex = index;
    return sticky.test(text);
}

/**
 * `text` with `$(NAME)`/`${NAME}` replaced from `table` and `$(shell CMD)`
 * turned into the shell substitution `$(CMD)`. `$$`, automatic variables,
 * unknown names and other Make functions are left as written.
 */
export function expand(text: string, table: VariableTable, depth = 0): string {
    if (depth > MAX_DEPTH || !text.includes("$")) return text;
    const out: string[] = [];
    let index = 0;
    while (index < text.length) {
        const char = text[index] as string;
        if (char !== "$" || index + 1 >= text.length) {
            out.push(char);
            index += 1;
            continue;
        }
        const following = text[index + 1] as string;
        if (following === "$") {
            out.push("$$");
            index += 2;
            continue;
        }
        if (!(following in CLOSE)) {
            out.push(char);
            index += 1;
            continue;
        }
        const end = referenceEnd(text, index);
        if (end < 0) {
            out.push(text.slice(index));
            break;
        }
        const inner = text.slice(index + 2, end - 1);
        if (matchesAt(SHELL_CALL, text, index)) {
            const command = expand(inner.slice("shell".length).trim(), table, depth + 1);
            out.push(`$(${command})`);
        } else if (table.has(inner)) {
            out.push(expand(table.get(inner) as string, table, depth + 1));
        } else {
            out.push(text.slice(index, end));
        }
        index = end;
    }
    return out.join("");
}

/** What Make hands the shell for already-expanded text: `$$` becomes `$`. */
export function unescapeMake(text: string): string {
    return text.replaceAll("$$", "$");
}

/**
 * Shell commands Make runs while reading the Makefile, outside any recipe:
 * `$(shell …)` calls in assignments, conditionals or top-level functions, and
 * the right-hand side of `VAR != …`. Each is expanded and unescaped.
 */
export function parseTimeCommands(text: string): string[] {
    const table = variables(text);
    const commands: string[] = [];
    for (const line of logicalLines(text)) {
        if (line.startsWith("\t") || line.trimStart().startsWith("#")) continue;
        const assignment = ASSIGNMENT.exec(line.trim());
        if (assignment && assignment[2] === "!=") {
            commands.push(unescapeMake(expand(assignment[3] as string, table)));
        }
        for (const match of line.matchAll(new RegExp(SHELL_CALL.source, "g"))) {
            if (escaped(line, match.index)) continue; // `$$(shell …)` is a literal for the shell, not a Make call
            const end = referenceEnd(line, match.index);
            const inner = line.slice(match.index + match[0].length, end > 0 ? end - 1 : line.length);
            commands.push(unescapeMake(expand(inner.trim(), table)));
        }
    }
    return commands.filter((command) => command.trim() !== "");
}

/**
 * Files GNU Make's `$(file >PATH,…)` writes while expanding the Makefile,
 * in recipes or outside them, as shell commands with the same effect:
 * `: > PATH` (truncate) or `: >> PATH` (append). `$(file <PATH)` only reads.
 */
export function parseTimeWrites(text: string): string[] {
    const table = variables(text);
    const writes: string[] = [];
    for (const line of logicalLines(text)) {
        if (line.trimStart().startsWith("#")) continue;
        for (const match of line.matchAll(new RegExp(FILE_CALL.source, "g"))) {
            if (escaped(line, match.index) || match[2] === "<") continue;
            const end = referenceEnd(line, match.index);
            const inner = line.slice(match.index + match[0].length, end > 0 ? end - 1 : line.length);
            const path = unescapeMake(expand((inner.split(",", 1)[0] as string).trim(), table));
            if (path) writes.push(`: ${match[2]} ${shellQuote(path)}`);
        }
    }
    return writes;
}

/** True when the `$` at `dollar` is the second half of a `$$` escape. */
function escaped(line: string, dollar: number): boolean {
    let run = 0;
    while (dollar - run - 1 >= 0 && line[dollar - run - 1] === "$") run += 1;
    return run % 2 === 1;
}
