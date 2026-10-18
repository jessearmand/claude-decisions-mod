/**
 * Text a command reads that the parser can know: a file written earlier on the
 * line or on disk (`< file`), and what a `<(producer)` prints when the producer
 * only echoes literal text or `cat`s known files. Part of shell_parse.
 *
 * Ported from shell_streams.py.
 */

import { expanduser, join, normpath } from "../util/paths.ts";
import { commandOutput } from "./expand.ts";
import { type Context, type ParseResult, SHELL_OPTION } from "./model.ts";
import { parse } from "./parse.ts";

const MAX_INPUT_FILE = 256 * 1024;

/** A file a command reads on stdin: its text from this line's writes, or from disk. */
export async function inputFileText(path: string, ctx: Context): Promise<string | undefined> {
    if (ctx.cwd === null || path.startsWith("<(")) {
        return undefined;
    }
    const absolute = normpath(join(ctx.cwd, expanduser(path, ctx.host.home)));
    const entry = ctx.writtenFiles.get(absolute);
    if (entry !== undefined) {
        return entry.text;
    }
    // `readText` answers undefined for a missing file, a directory, or one larger
    // than the limit, the way the Python code skipped on OSError.
    return ctx.host.readText(absolute, MAX_INPUT_FILE);
}

/** What `<(producer)` prints, when every command in it prints known text. */
export async function producedText(operand: string, ctx: Context): Promise<string | undefined> {
    if (!(operand.startsWith("<(") && operand.endsWith(")"))) {
        return undefined;
    }
    return producerOutput(await parseProducer(operand, ctx.cwd, ctx), ctx);
}

/**
 * The commands of `<(producer)`. They run in this shell's process
 * substitution, so its `shopt -s xpg_echo` applies to their echo.
 */
export async function parseProducer(operand: string, cwd: string | null, ctx: Context): Promise<ParseResult> {
    // re-entry: parsed as a command list
    const xpg = (ctx.variables.get(`${SHELL_OPTION}xpg_echo`) ?? []).includes("on");
    return parse((xpg ? "shopt -s xpg_echo\n" : "") + operand.slice(2, -1), cwd ?? "/", ctx.host);
}

/**
 * The exact bytes a producer list writes, one command's output straight
 * after the other's (`printf r; printf m` gives `rm`): echo/printf of literal
 * text and `cat` of files whose text is known. undefined if any part is unknown.
 */
export async function producerOutput(producer: ParseResult, ctx: Context): Promise<string | undefined> {
    if (producer.commands.length === 0 || producer.unparseable || producer.truncated) {
        return undefined;
    }
    const parts: string[] = [];
    for (const command of producer.commands) {
        if (command.name === "shopt") {
            continue; // the shell options the producer starts with
        }
        if (
            command.via.length > 0 ||
            command.dynamicHead ||
            command.redirects.length > 0 ||
            command.args.some((a) => a.includes("$") || a.includes("`"))
        ) {
            return undefined;
        }
        let part: string | undefined;
        if (command.name === "echo" || command.name === "printf") {
            part = commandOutput(command) ?? undefined;
        } else if (
            command.name === "cat" &&
            command.args.length > 0 &&
            !command.args.some((a) => a.startsWith("-"))
        ) {
            const texts: string[] = [];
            for (const path of command.args) {
                const text = await inputFileText(path, ctx);
                if (text === undefined) {
                    return undefined;
                }
                texts.push(text);
            }
            part = texts.join("");
        } else {
            return undefined;
        }
        if (part === undefined) {
            return undefined;
        }
        parts.push(part);
    }
    return parts.join("");
}
