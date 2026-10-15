import { describe, expect, it, vi } from "vitest";
import { memoryHost } from "../host/memory-host.ts";
import { ParseResult, redirect, SimpleCommand } from "./model.ts";

// expand.ts (shell_expand.command_output) belongs to another port wave; the
// stand-in prints echo/printf arguments joined, with echo's newline.
vi.mock("./expand.ts", () => ({
    commandOutput: (command: SimpleCommand) =>
        command.name === "echo" ? `${command.args.join(" ")}\n` : command.args.join(""),
}));

import { knownStdin } from "./command-stdin.ts";

const host = memoryHost({ files: { "/proj/q.sql": "SELECT 1;", "/proj/i.sql": ".shell rm -rf victim\n" } });

function pipeline(
    ...stages: Array<Partial<ConstructorParameters<typeof SimpleCommand>[0]> & { argv: string[] }>
) {
    const parsed = new ParseResult();
    parsed.commands = stages.map(
        (fields, stage) => new SimpleCommand({ ...fields, pipeline: 1, stage, cwd: fields.cwd ?? "/proj" }),
    );
    return { parsed, last: parsed.commands[parsed.commands.length - 1] as SimpleCommand };
}

describe("knownStdin", () => {
    it("takes a heredoc or here-string body, typed unless the command is indirect", async () => {
        const { parsed, last } = pipeline({
            argv: ["sqlite3", "db"],
            redirects: [redirect("<<<", ".system rm -rf victim")],
        });
        expect(await knownStdin(last, parsed, undefined, host)).toEqual({
            text: ".system rm -rf victim",
            typed: true,
        });
        const heredoc = pipeline({
            argv: ["psql"],
            redirects: [redirect("<<", "EOF", false, "DROP TABLE t;\n")],
            indirect: true,
        });
        expect(await knownStdin(heredoc.last, heredoc.parsed, undefined, host)).toEqual({
            text: "DROP TABLE t;\n",
            typed: false,
        });
    });
    it("reads a redirected file from the line's writes or the disk, without a directory", async () => {
        const { parsed, last } = pipeline({
            argv: ["sqlite3", ":memory:"],
            redirects: [redirect("<", "i.sql")],
        });
        expect(await knownStdin(last, parsed, undefined, host)).toEqual({
            text: ".shell rm -rf victim\n",
            typed: false,
        });
        const written = new Map([["/proj/i.sql", { text: "typed", replaces: true }]]);
        expect(await knownStdin(last, parsed, written, host)).toEqual({ text: "typed", typed: true });
        parsed.writtenFiles = written;
        expect(await knownStdin(last, parsed, undefined, host)).toEqual({ text: "typed", typed: true });
        const missing = pipeline({ argv: ["psql"], redirects: [redirect("<", "none.sql")] });
        expect(await knownStdin(missing.last, missing.parsed, undefined, host)).toBeUndefined();
    });
    it("gives up on a computed redirect, a descriptor dup or a later stdin redirect", async () => {
        const dynamic = pipeline({ argv: ["psql"], redirects: [redirect("<", "$F", true)] });
        expect(await knownStdin(dynamic.last, dynamic.parsed, undefined, host)).toBeUndefined();
        const dup = pipeline({ argv: ["psql"], redirects: [redirect("<&", "3")] });
        expect(await knownStdin(dup.last, dup.parsed, undefined, host)).toBeUndefined();
        const other = pipeline({ argv: ["psql"], redirects: [redirect("<", "q.sql", false, undefined, 3)] });
        expect(await knownStdin(other.last, other.parsed, undefined, host)).toBeUndefined();
    });
    it("reads what echo or printf pipe in, unless they expand something", async () => {
        const { parsed, last } = pipeline(
            { argv: ["printf", ".shell rm -rf victim\\n"] },
            { argv: ["sqlite3", ":memory:"] },
        );
        expect(await knownStdin(last, parsed, undefined, host)).toEqual({
            text: ".shell rm -rf victim\\n",
            typed: true,
        });
        const expanded = pipeline({ argv: ["echo", "$X"] }, { argv: ["sqlite3"] });
        expect(await knownStdin(expanded.last, expanded.parsed, undefined, host)).toBeUndefined();
        const redirected = pipeline(
            { argv: ["echo", "x"], redirects: [redirect(">", "log")] },
            { argv: ["sqlite3"] },
        );
        expect(await knownStdin(redirected.last, redirected.parsed, undefined, host)).toBeUndefined();
        const computed = pipeline({ argv: ["echo", "x"], dynamicHead: true }, { argv: ["sqlite3"] });
        expect(await knownStdin(computed.last, computed.parsed, undefined, host)).toBeUndefined();
    });
    it("follows cat through its files, a bare cat and `-`, within MAX_DEPTH", async () => {
        const files = pipeline({ argv: ["cat", "q.sql", "i.sql"] }, { argv: ["sqlite3"] });
        expect(await knownStdin(files.last, files.parsed, undefined, host)).toEqual({
            text: "SELECT 1;.shell rm -rf victim\n",
            typed: false,
        });
        const bare = pipeline({ argv: ["printf", "x"] }, { argv: ["cat"] }, { argv: ["sqlite3"] });
        expect(await knownStdin(bare.last, bare.parsed, undefined, host)).toEqual({ text: "x", typed: true });
        const dash = pipeline(
            { argv: ["printf", "x"] },
            { argv: ["cat", "-", "q.sql"] },
            { argv: ["sqlite3"] },
        );
        expect(await knownStdin(dash.last, dash.parsed, undefined, host)).toEqual({
            text: "xSELECT 1;",
            typed: false,
        });
        const option = pipeline({ argv: ["cat", "-n", "q.sql"] }, { argv: ["sqlite3"] });
        expect(await knownStdin(option.last, option.parsed, undefined, host)).toBeUndefined();
        const missing = pipeline({ argv: ["cat", "none"] }, { argv: ["sqlite3"] });
        expect(await knownStdin(missing.last, missing.parsed, undefined, host)).toBeUndefined();
        const other = pipeline({ argv: ["sort", "q.sql"] }, { argv: ["sqlite3"] });
        expect(await knownStdin(other.last, other.parsed, undefined, host)).toBeUndefined();
        expect(await knownStdin(bare.last, bare.parsed, undefined, host, 8)).toBeUndefined();
    });
});
