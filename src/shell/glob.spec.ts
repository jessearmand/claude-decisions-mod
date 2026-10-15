/**
 * Port of shell_glob_test.py plus parity with shell_glob.match and Python's
 * glob.glob over a fixed file tree (scripts/parity/gen-glob-fixture.py).
 */

import { describe, expect, it } from "vitest";
import { memoryHost } from "../host/memory-host.ts";
import fixture from "./__fixtures__/glob-parity.json" with { type: "json" };
import { fnmatch, globPaths, match, Unsupported, withExtglob } from "./glob.ts";

interface MatchCase {
    text: string;
    pattern: string;
    extglob: boolean;
    /** true/false, or why the oracle raised: "unsupported" (`!( )`) or "error" (re rejects `[z-a]`). */
    matches: boolean | "unsupported" | "error";
}

interface PathCase {
    pattern: string;
    rootDir: string | null;
    results: string[];
    limit?: number;
}

interface GlobFixture {
    match: MatchCase[];
    tree: { files: string[]; dirs: string[]; links: Record<string, string>; root: string };
    paths: PathCase[];
}

const data = fixture as GlobFixture;

describe("match parity with shell_glob.py", () => {
    it.each(data.match.map((c) => [c.text, c.pattern, c.extglob, c] as const))(
        "%j ~ %j (extglob %s)",
        (text, pattern, extglob, expected) => {
            if (typeof expected.matches === "string") {
                // Deliberate deviation: a pattern Python's `re` rejects (`[z-a]`) raised re.error
                // in the oracle; here it is Unsupported, like `!( )`, so params.apply answers unknown.
                expect(() => match(text, pattern, extglob)).toThrow(Unsupported);
            } else {
                expect(match(text, pattern, extglob)).toBe(expected.matches);
            }
        },
    );
});

describe("withExtglob", () => {
    it("sets the flag match() reads by default and restores it afterwards", () => {
        expect(match("x", "+(x)")).toBe(false);
        const inside = withExtglob(true, () => match("x", "+(x)"));
        expect(inside).toBe(true);
        expect(match("x", "+(x)")).toBe(false);
        expect(() => withExtglob(true, () => match("a", "!(b)"))).toThrow(Unsupported);
        expect(match("+(x)", "+(x)")).toBe(true);
    });
    it("lets an explicit argument override the flag", () => {
        withExtglob(true, () => expect(match("+(x)", "+(x)", false)).toBe(true));
    });
});

describe("fnmatch (Python fnmatchcase)", () => {
    it.each([
        ["a.txt", "*.txt", true],
        [".hidden", "*", true],
        ["a/b", "*", true],
        ["abc", "a?c", true],
        ["abc", "a[bx]c", true],
        ["abc", "a[!b]c", false],
        ["a]c", "a[]]c", true],
        ["a-c", "a[a-]c", true],
        ["abc", "a[", false],
        ["a[", "a[", true],
        ["a\\b", "a\\b", true],
        ["ab", "a\\b", false],
        ["a^c", "a[^]c", true],
        ["b", "[^a]", false],
        ["m", "[z-a]", false],
        ["", "*", true],
        ["", "?", false],
        ["x", "", false],
    ])("fnmatch(%j, %j) is %s", (name, pattern, expected) => {
        expect(fnmatch(name, pattern)).toBe(expected);
    });
});

describe("globPaths parity with glob.glob", () => {
    const host = memoryHost({
        files: Object.fromEntries(data.tree.files.map((path) => [`${data.tree.root}/${path}`, ""])),
        dirs: data.tree.dirs.map((path) => `${data.tree.root}/${path}`),
        links: Object.fromEntries(
            Object.entries(data.tree.links).map(([link, target]) => [`${data.tree.root}/${link}`, target]),
        ),
    });
    it.each(data.paths.map((c) => [c.pattern, c.rootDir, c] as const))(
        "globPaths(%j, rootDir %j)",
        async (pattern, rootDir, expected) => {
            const options = { rootDir: rootDir ?? undefined, limit: expected.limit };
            expect(await globPaths(pattern, host, options)).toEqual(expected.results);
        },
    );
    it("stops listing at the limit", async () => {
        const all = await globPaths("*", host, { rootDir: data.tree.root });
        expect(all.length).toBeGreaterThan(3);
        expect(await globPaths("*", host, { rootDir: data.tree.root, limit: 3 })).toHaveLength(3);
        expect(await globPaths("*", host, { rootDir: data.tree.root, limit: 0 })).toEqual([]);
    });
    it("probes a literal path with stat rather than listing", async () => {
        const probing = memoryHost({ files: { "/p/a.txt": "" } });
        const seen: string[] = [];
        const original = probing.list.bind(probing);
        probing.list = async (path) => {
            seen.push(path);
            return original(path);
        };
        expect(await globPaths("/p/a.txt", probing)).toEqual(["/p/a.txt"]);
        expect(await globPaths("/p/missing.txt", probing)).toEqual([]);
        expect(seen).toEqual([]);
        expect(await globPaths("/p/*.txt", probing)).toEqual(["/p/a.txt"]);
        expect(seen).toEqual(["/p"]);
    });
});
