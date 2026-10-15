import { describe, expect, it } from "vitest";
import { memoryHost } from "../host/memory-host.ts";
import {
    clientInput,
    fileOptionValues,
    included,
    MAX_DEPTH,
    MAX_FILE_BYTES,
    MAX_FILES,
    optionValues,
    readFile,
} from "./db-client-files.ts";
import type { WrittenFiles } from "./model.ts";

describe("optionValues", () => {
    it("reads -f FILE, --file=FILE and attached -fFILE for getopt clients", () => {
        const args = ["-f", "q.sql", "--file=r.sql", "-fs.sql"];
        expect(optionValues(args, ["-f", "--file"])).toEqual(["q.sql", "r.sql", "s.sql"]);
        expect(optionValues(args, ["-f", "--file"], false)).toEqual(["q.sql", "r.sql"]);
    });
    it("keeps duckdb's -csv as one option and ignores a flag without a value", () => {
        expect(optionValues(["-csv", "-init", "i.sql"], ["-init"], false)).toEqual(["i.sql"]);
        expect(optionValues(["-f"], ["-f"])).toEqual([]);
        expect(optionValues(["--files", "x"], ["--file"])).toEqual([]);
    });
    it.each([
        ["psql", ["-fq.sql", "-c", "x"], ["q.sql"]],
        ["sqlite3", ["-init", "i.sql", ":memory:"], ["i.sql"]],
        ["duckdb", ["-init", "i.sql"], ["i.sql"]],
        ["mysql", ["-f", "x"], []],
        ["clickhouse-client", ["--queries-file=q.sql"], ["q.sql"]],
        ["cockroach", ["--file", "x.sql"], ["x.sql"]],
    ])("fileOptionValues(%s, %j)", (client, args, expected) => {
        expect(fileOptionValues(client, args)).toEqual(expected);
    });
});

describe("readFile", () => {
    const host = memoryHost({ files: { "/proj/q.sql": "SELECT 1;", "/home/user/h.sql": "SELECT 2;" } });
    it("prefers what the same line wrote, marked typed, with the file's directory", async () => {
        const written: WrittenFiles = new Map([["/proj/q.sql", { text: "DROP TABLE t;", replaces: true }]]);
        expect(await readFile("q.sql", ["/proj"], written, host)).toEqual(
            clientInput("DROP TABLE t;", true, "/proj"),
        );
    });
    it("reads the disk in the first directory where the file is, untyped", async () => {
        expect(await readFile("q.sql", [null, "/elsewhere", "/proj"], new Map(), host)).toEqual(
            clientInput("SELECT 1;", false, "/proj"),
        );
        expect(await readFile("~/h.sql", ["/proj"], new Map(), host)).toEqual(
            clientInput("SELECT 2;", false, "/home/user"),
        );
        expect(await readFile("missing.sql", ["/proj"], new Map(), host)).toBeUndefined();
    });
    it("skips a file larger than MAX_FILE_BYTES", async () => {
        const large = memoryHost({ files: { "/proj/big.sql": "x".repeat(MAX_FILE_BYTES + 1) } });
        expect(await readFile("big.sql", ["/proj"], new Map(), large)).toBeUndefined();
    });
});

describe("included", () => {
    const host = memoryHost({
        files: {
            "/proj/r.sql": ".shell rm -rf victim\n",
            "/proj/a.sql": "\\i b.sql\n",
            "/proj/b.sql": "\\ir sub/c.sql\n",
            "/proj/sub/c.sql": "SELECT 3;",
            "/proj/m.sql": "DROP TABLE t;",
            "/proj/s.sql": "GO",
        },
    });
    const none: WrittenFiles = new Map();
    it("follows sqlite .read, but not .read |CMD", async () => {
        const text = "SELECT 1;\n.read r.sql\n.read |rm -rf victim\n";
        expect(
            await included("sqlite3", [clientInput(text, true)], ["/proj"], none, undefined, host),
        ).toEqual([clientInput(".shell rm -rf victim\n", false, "/proj")]);
        expect(
            await included("duckdb", [clientInput(text, true)], ["/proj"], none, undefined, host),
        ).toHaveLength(1);
    });
    it("follows psql \\i and \\ir transitively, relative includes against the including file", async () => {
        const found = await included(
            "psql",
            [clientInput("\\include a.sql", true)],
            ["/proj"],
            none,
            undefined,
            host,
        );
        expect(found.map((entry) => entry.text)).toEqual(["\\i b.sql\n", "\\ir sub/c.sql\n", "SELECT 3;"]);
        expect(found.map((entry) => entry.directory)).toEqual(["/proj", "/proj", "/proj/sub"]);
    });
    it("reports a psql variable include as unknown", async () => {
        const unknown: string[] = [];
        const found = await included(
            "psql",
            [clientInput("\\i :file", true)],
            ["/proj"],
            none,
            (n) => unknown.push(n),
            host,
        );
        expect(found).toEqual([]);
        expect(unknown).toEqual([":file"]);
    });
    it("follows mysql source / \\. and sqlcmd :r", async () => {
        const mysql = await included(
            "mysql",
            [clientInput("SOURCE m.sql;\nselect 1 \\. m.sql", true)],
            ["/proj"],
            none,
            undefined,
            host,
        );
        expect(mysql.map((entry) => entry.text)).toEqual(["DROP TABLE t;"]); // the same file once
        const sqlcmd = await included(
            "sqlcmd",
            [clientInput(":r 's.sql'", true)],
            ["/proj"],
            none,
            undefined,
            host,
        );
        expect(sqlcmd).toEqual([clientInput("GO", false, "/proj")]);
    });
    it("marks an included file typed only when the whole chain was typed", async () => {
        const written: WrittenFiles = new Map([["/proj/w.sql", { text: "DROP x;", replaces: true }]]);
        const typed = await included(
            "sqlite3",
            [clientInput(".read w.sql", true)],
            ["/proj"],
            written,
            undefined,
            host,
        );
        expect(typed).toEqual([clientInput("DROP x;", true, "/proj")]);
        const untyped = await included(
            "sqlite3",
            [clientInput(".read w.sql", false)],
            ["/proj"],
            written,
            undefined,
            host,
        );
        expect(untyped).toEqual([clientInput("DROP x;", false, "/proj")]);
    });
    it("stops at MAX_DEPTH and MAX_FILES, reporting what it could not follow", async () => {
        const files: Record<string, string> = {};
        for (let index = 0; index < MAX_FILES + 5; index += 1)
            files[`/p/f${index}.sql`] = `.read f${index + 1}.sql`;
        const deep = memoryHost({ files });
        const unknown: string[] = [];
        const chain = await included(
            "sqlite3",
            [clientInput(".read f0.sql", true)],
            ["/p"],
            none,
            (n) => unknown.push(n),
            deep,
        );
        expect(chain).toHaveLength(MAX_DEPTH);
        expect(unknown).toEqual([`f${MAX_DEPTH}.sql`]);
        const wide = Object.fromEntries(
            Array.from({ length: MAX_FILES + 2 }, (_, index) => [`/p/w${index}.sql`, "SELECT 1;"]),
        );
        const many = memoryHost({ files: wide });
        const reads = Object.keys(wide)
            .map((path) => `.read ${path.slice(3)}`)
            .join("\n");
        const missed: string[] = [];
        const found = await included(
            "sqlite3",
            [clientInput(reads, true)],
            ["/p"],
            none,
            (n) => missed.push(n),
            many,
        );
        expect(found).toHaveLength(MAX_FILES);
        expect(missed).toHaveLength(2);
    });
    it("knows no includes for other clients", async () => {
        expect(
            await included(
                "clickhouse-client",
                [clientInput(".read x", true)],
                ["/proj"],
                none,
                undefined,
                host,
            ),
        ).toEqual([]);
    });
});
