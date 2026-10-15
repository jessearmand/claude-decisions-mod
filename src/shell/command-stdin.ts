/**
 * Bounded, provenance-preserving literal stdin for deterministic command rules.
 *
 * Ported from command_stdin.py. `knownStdin` reads files through the host
 * (db-client-files), so it is asynchronous; the host follows the Python
 * parameters (`writtenFiles` may be undefined: the parse result's files are used).
 */

import type { Host } from "../host/host.ts";
import { type ClientInput, clientInput, MAX_DEPTH, readFile } from "./db-client-files.ts";
import { commandOutput } from "./expand.ts";
import type { ParseResult, SimpleCommand, WrittenFiles } from "./model.ts";

const STDIN_REDIRECTS: ReadonlySet<string> = new Set(["<", "<<", "<<-", "<<<", "<&"]);
const HEREDOC_LIKE: ReadonlySet<string> = new Set(["<<", "<<-", "<<<"]);
const STDOUT_REDIRECTS: ReadonlySet<string> = new Set([">", ">>", ">|", "&>", "&>>", ">&"]);

/** Literal heredoc/pipe/file input, or undefined when its contents are unknown. */
export async function knownStdin(
    command: SimpleCommand,
    parsed: ParseResult,
    writtenFiles: WrittenFiles | undefined,
    host: Host,
    depth = 0,
): Promise<ClientInput | undefined> {
    if (depth >= MAX_DEPTH) return undefined;
    const written = writtenFiles === undefined ? parsed.writtenFiles : writtenFiles;
    const redirects = command.redirects.filter(
        (r) => (r.fd === undefined || r.fd === 0) && STDIN_REDIRECTS.has(r.op),
    );
    if (redirects.length > 0) {
        const redirect = redirects[redirects.length - 1] as (typeof redirects)[number];
        if (redirect.dynamic) return undefined;
        if (HEREDOC_LIKE.has(redirect.op)) {
            return clientInput(
                redirect.body !== undefined ? redirect.body : redirect.target,
                !command.indirect,
            );
        }
        if (redirect.op === "<") {
            const entry = await readFile(redirect.target, command.possibleCwds, written, host);
            // The consumer sees stdin, not a client-opened filename. In particular,
            // psql's relative includes resolve against its cwd rather than this file.
            return entry ? clientInput(entry.text, entry.typed) : undefined;
        }
        return undefined;
    }
    const feeder = parsed.previousStage(command);
    if (feeder === undefined || feeder.dynamicHead) return undefined;
    // Output redirection replaces the pipe's producer output; do not infer bytes it won't send.
    if (feeder.redirects.some((r) => STDOUT_REDIRECTS.has(r.op) && (r.fd === undefined || r.fd === 1))) {
        return undefined;
    }
    if (feeder.name === "echo" || feeder.name === "printf") {
        if (feeder.args.some((arg) => arg.includes("$") || arg.includes("`"))) return undefined;
        const text = commandOutput(feeder);
        return text !== undefined ? clientInput(text, !feeder.indirect) : undefined;
    }
    if (feeder.name !== "cat") return undefined;
    if (feeder.args.length === 0) return knownStdin(feeder, parsed, written, host, depth + 1);
    if (feeder.args.some((a) => a.startsWith("-") && a !== "-")) return undefined;
    const entries: Array<ClientInput | undefined> = [];
    for (const name of feeder.args) {
        entries.push(
            name === "-"
                ? await knownStdin(feeder, parsed, written, host, depth + 1)
                : await readFile(name, feeder.possibleCwds, written, host),
        );
    }
    if (entries.some((entry) => entry === undefined)) return undefined;
    const known = entries.filter((entry): entry is ClientInput => entry !== undefined);
    return clientInput(
        known.map((entry) => entry.text).join(""),
        !feeder.indirect && known.every((entry) => entry.typed),
    );
}
