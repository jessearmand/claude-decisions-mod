/**
 * Files a database client runs: those its command line names, and those its
 * input tells it to read.
 *
 * Both the destructive-SQL rule (dangerous_infra) and the shell-escape scan
 * (shell_payloads) need the statements a client runs, wherever they come from.
 * Besides its arguments, a client runs:
 *
 * - a command file named on the line (`sqlite3 -init FILE`, `psql -f FILE`,
 *   `< FILE`), read as written earlier on the same line or from disk;
 * - every file an include meta-command names, as if its lines were typed there
 *   (PR review): sqlite3 and duckdb `.read FILE`, psql and cockroach `\i FILE` /
 *   `\include FILE` and `\ir FILE` / `\include_relative FILE` (relative to the
 *   including file), mysql and mariadb `source FILE` / `\. FILE`, sqlcmd
 *   `:r FILE`. Included files are followed in turn, within MAX_DEPTH and MAX_FILES.
 *
 * A file is "typed" when the same command line wrote it and everything that led
 * to it was typed, so a guard may treat its contents as the agent's own command.
 *
 * Ported from db_client_files.py. Reading goes through the host, so `readFile`
 * and `included` are asynchronous.
 */

import type { Host } from "../host/host.ts";
import { dirname, expanduser, join, normpath } from "../util/paths.ts";
import type { Directory, WrittenFiles } from "./model.ts";

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_DEPTH = 8;
export const MAX_FILES = 32;

export interface ClientInput {
    readonly text: string;
    /** on the command line, or in a file the same line wrote */
    readonly typed: boolean;
    /** the directory of the file it came from */
    readonly directory?: string;
}

/** `ClientInput(text, typed, directory)`. */
export function clientInput(text: string, typed: boolean, directory?: string): ClientInput {
    return { text, typed, directory };
}

/** A quoted or bare file name: the value of an include meta-command. */
const NAME = `(?:'([^']*)'|"([^"]*)"|([^\\s'"]\\S*))`;

/** (pattern, whether a name is relative to the including file). */
type IncludePattern = readonly [pattern: RegExp, relative: boolean];

// `.read |CMD` runs a command, which shell_payloads parses instead.
const SQLITE_INCLUDE: readonly IncludePattern[] = [
    [new RegExp(`^[ \\t]*\\.read[ \\t]+(?!['"]?\\|)${NAME}`, "m"), false],
];
const PSQL_INCLUDE: readonly IncludePattern[] = [
    // psql meta-commands may follow SQL on a line; their arguments end at a backslash.
    [/\\(?:include|i)[ \t]+(?:'([^']*)'|([^\s\\']+))/, false],
    [/\\(?:include_relative|ir)[ \t]+(?:'([^']*)'|([^\s\\']+))/, true],
];
const INCLUDES: ReadonlyMap<string, readonly IncludePattern[]> = new Map([
    ["sqlite", SQLITE_INCLUDE],
    ["psql", PSQL_INCLUDE],
    ["cockroach", PSQL_INCLUDE],
    // mysql: `source FILE` on its own line (an optional `;`), or `\. FILE` anywhere.
    [
        "mysql",
        [[/(?:^[ \t]*source[ \t]+|\\\.[ \t]*)(?:'([^']*)'|"([^"]*)"|([^\n;]*?))[ \t]*;?[ \t]*$/im, false]],
    ],
    ["sqlcmd", [[new RegExp(`^[ \\t]*:r[ \\t]+${NAME}`, "im"), false]]],
]);
/** Each client's dialect of meta-commands. */
export const DIALECTS: ReadonlyMap<string, string> = new Map([
    ["sqlite3", "sqlite"],
    ["sqlite", "sqlite"],
    ["duckdb", "sqlite"],
    ["psql", "psql"],
    ["cockroach", "cockroach"],
    ["mysql", "mysql"],
    ["mariadb", "mysql"],
    ["sqlcmd", "sqlcmd"],
]);
/** Options naming a file of statements the client runs. */
export const FILE_OPTIONS: ReadonlyMap<string, readonly string[]> = new Map([
    ["psql", ["-f", "--file"]],
    ["sqlite3", ["-init", "--init"]],
    ["sqlite", ["-init", "--init"]],
    ["duckdb", ["-init"]],
    ["sqlcmd", ["-i"]],
    ["clickhouse-client", ["--queries-file"]],
    ["cockroach", ["-f", "--file"]],
]);
/**
 * Clients whose single-letter options take an attached value (`psql -c'DROP …'`),
 * as getopt allows (PR review). duckdb and clickhouse use `-csv`-style words.
 */
export const GETOPT_CLIENTS: ReadonlySet<string> = new Set([
    "psql",
    "mysql",
    "mariadb",
    "cockroach",
    "sqlcmd",
]);

/**
 * Values given to `flags`, as `-f FILE`, `--file=FILE` or, for getopt-style
 * clients (`attached`), `-fFILE`. duckdb's `-csv` is one option, not `-c sv`.
 */
export function optionValues(args: readonly string[], flags: readonly string[], attached = true): string[] {
    const values: string[] = [];
    args.forEach((arg, index) => {
        for (const flag of flags) {
            if (arg === flag && index + 1 < args.length) {
                values.push(args[index + 1] as string);
            } else if (flag.startsWith("--") && arg.startsWith(`${flag}=`)) {
                values.push(arg.slice(flag.length + 1));
            } else if (
                attached &&
                !flag.startsWith("--") &&
                flag.length === 2 &&
                arg.startsWith(flag) &&
                arg.length > 2
            ) {
                values.push(arg.slice(2));
            }
        }
    });
    return values;
}

/** The names of the command files `client`'s options give (`psql -f q.sql`). */
export function fileOptionValues(client: string, args: readonly string[]): string[] {
    return optionValues(args, FILE_OPTIONS.get(client) ?? [], GETOPT_CLIENTS.has(client));
}

/**
 * The file `name` as the same line wrote it (typed), else as on disk, in
 * the first of `cwds` where it is found. undefined when it is not there or too large.
 */
export async function readFile(
    name: string,
    cwds: Iterable<Directory>,
    written: WrittenFiles,
    host: Host,
): Promise<ClientInput | undefined> {
    for (const directory of cwds) {
        if (directory === null) continue;
        const absolute = normpath(join(directory, expanduser(name, host.home)));
        const entry = written.get(absolute);
        if (entry !== undefined) return clientInput(entry.text, true, dirname(absolute));
        // A missing, oversized or unreadable file answers undefined, as the OSError branch skipped it.
        const text = await host.readText(absolute, MAX_FILE_BYTES);
        if (text !== undefined) return clientInput(text, false, dirname(absolute));
    }
    return undefined;
}

/**
 * Every file `inputs` include, transitively, for the client `client`.
 *
 * `cwds`: the directories the client may run in, which a name not relative
 * to its including file is resolved against. `unknown(name)` is called for an
 * include that cannot be followed: a psql `:variable`, or past the bounds.
 * The host comes last, after the Python parameters.
 */
export async function included(
    client: string,
    inputs: Iterable<ClientInput>,
    cwds: readonly Directory[],
    written: WrittenFiles,
    unknown: ((name: string) => void) | undefined,
    host: Host,
): Promise<ClientInput[]> {
    const report = unknown ?? (() => undefined);
    const patterns = INCLUDES.get(DIALECTS.get(client) ?? "") ?? [];
    const found: ClientInput[] = [];
    const seen = new Set<string>();
    const frontier: Array<readonly [ClientInput, number]> = [...inputs].map((source) => [source, 0]);
    while (frontier.length > 0) {
        const [source, depth] = frontier.shift() as readonly [ClientInput, number];
        for (const [pattern, relative] of patterns) {
            for (const match of source.text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
                const name = (match.slice(1).find((group) => group) ?? "").trim();
                if (!name) continue;
                if (client === "psql" && name.startsWith(":")) {
                    report(name); // `\i :file`: a psql variable
                    continue;
                }
                const base: readonly Directory[] = relative && source.directory ? [source.directory] : cwds;
                const key = JSON.stringify([base[0] ?? null, name]);
                if (seen.has(key)) continue;
                seen.add(key);
                if (depth >= MAX_DEPTH || found.length >= MAX_FILES) {
                    report(name);
                    continue;
                }
                const read = await readFile(name, base, written, host);
                if (read === undefined) continue;
                const entry = clientInput(read.text, read.typed && source.typed, read.directory);
                found.push(entry);
                frontier.push([entry, depth + 1]);
            }
        }
    }
    return found;
}
