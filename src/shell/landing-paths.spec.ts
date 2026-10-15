import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunResult } from "../host/host.ts";
import { memoryHost } from "../host/memory-host.ts";
import { nodeHost } from "../host/node-host.ts";
import { landingPaths, MAX_ARCHIVE_BYTES, MAX_ENTRIES } from "./landing-paths.ts";
import { contents } from "./writes.ts";

function has(tool: string): boolean {
    try {
        execFileSync("which", [tool], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

const all = () => true;
const sorted = (paths: string[] | null) => (paths === null ? null : [...paths].sort());

describe("landingPaths for archives", () => {
    const host = nodeHost();
    let project: string;
    const tar = (name: string, cwd: string, ...args: string[]) =>
        execFileSync("tar", ["cf", join(project, name), ...args], { cwd });
    beforeAll(() => {
        project = mkdtempSync(join(tmpdir(), "landing-"));
        const src = join(project, "src");
        for (const dir of [".claude", "pkg-1.0/.git/hooks", "lib", "through/.claude"])
            mkdirSync(join(src, dir), { recursive: true });
        writeFileSync(join(src, ".claude/settings.json"), "{}");
        writeFileSync(join(src, "pkg-1.0/.git/hooks/pre-commit"), "x");
        writeFileSync(join(src, "lib/libx.so.1"), "x");
        symlinkSync("libx.so.1", join(src, "lib/libx.so"));
        symlinkSync("../..", join(src, "up"));
        symlinkSync(".claude", join(src, "through/link"));
        writeFileSync(join(src, "through/.claude/settings.json"), "{}");
        writeFileSync(join(src, "with space.txt"), "x");
        tar("payload.tar", src, ".claude/settings.json", "with space.txt");
        tar("nested.tar", src, "pkg-1.0");
        tar("link.tar", src, "up");
        // tar lists the link first, then the member written through it.
        execFileSync("tar", ["cf", join(project, "through.tar"), "link", ".claude/settings.json"], {
            cwd: join(src, "through"),
        });
        execFileSync("tar", ["czf", join(project, "library.tgz"), "lib"], { cwd: src });
        execFileSync("tar", ["cPf", join(project, "absolute.tar"), join(src, ".claude/settings.json")]);
        writeFileSync(join(project, "big.tar"), "");
        truncateSync(join(project, "big.tar"), MAX_ARCHIVE_BYTES + 1);
        writeFileSync(join(project, "not-a.tar"), "plain text");
        if (has("zip")) {
            execFileSync("zip", ["-q", join(project, "hook.zip"), "pkg-1.0/.git/hooks/pre-commit"], {
                cwd: src,
            });
            execFileSync("zip", ["-q", "-y", join(project, "zlink.zip"), "link", ".claude/settings.json"], {
                cwd: join(src, "through"),
            });
            execFileSync("zip", ["-q", "-y", join(project, "escape.zip"), "up"], { cwd: src });
        }
    });
    afterAll(() => rmSync(project, { recursive: true, force: true }));

    it("lists tar members, with --strip-components and leading slashes as tar writes them", async () => {
        expect(await landingPaths(contents({ archive: "payload.tar" }), project, all, host)).toEqual([
            ".claude/settings.json",
            "with space.txt",
        ]);
        expect(await landingPaths(contents({ archive: "nested.tar" }), project, all, host)).toEqual([
            "pkg-1.0",
            "pkg-1.0/.git",
            "pkg-1.0/.git/hooks",
            "pkg-1.0/.git/hooks/pre-commit",
        ]);
        expect(await landingPaths(contents({ archive: "nested.tar", strip: 1 }), project, all, host)).toEqual(
            [".git", ".git/hooks", ".git/hooks/pre-commit"],
        );
        const relative = await landingPaths(contents({ archive: "absolute.tar" }), project, all, host);
        expect(relative?.[0]?.startsWith("/")).toBe(false);
        const absolute = await landingPaths(
            contents({ archive: "absolute.tar", absoluteNames: true }),
            project,
            all,
            host,
        );
        expect(absolute?.[0]?.startsWith("/")).toBe(true);
    });
    it("writes later members through an earlier symlink member", async () => {
        expect(await landingPaths(contents({ archive: "through.tar" }), project, all, host)).toEqual([
            "link",
            ".claude/settings.json",
        ]);
        expect(sorted(await landingPaths(contents({ archive: "library.tgz" }), project, all, host))).toEqual([
            "lib",
            "lib/libx.so",
            "lib/libx.so.1",
        ]);
    });
    it("cannot know where a link out of the destination leads", async () => {
        expect(await landingPaths(contents({ archive: "link.tar" }), project, all, host)).toBeNull();
    });
    it.skipIf(!has("zip"))("lists zip members and follows unzip's restored symlinks", async () => {
        expect(
            await landingPaths(contents({ archive: "hook.zip", zipArchive: true }), project, all, host),
        ).toEqual(["pkg-1.0/.git/hooks/pre-commit"]);
        expect(
            await landingPaths(contents({ archive: "zlink.zip", zipArchive: true }), project, all, host),
        ).toEqual(["link", ".claude/settings.json"]);
        expect(
            await landingPaths(contents({ archive: "escape.zip", zipArchive: true }), project, all, host),
        ).toBeNull();
    });
    it("gives up on an archive it cannot read, and lands nothing for one that is not there", async () => {
        expect(
            await landingPaths(contents({ archive: "not-here.tgz" }), project, all, host, () => false),
        ).toEqual([]);
        expect(await landingPaths(contents({ archive: "not-here.tgz" }), project, all, host)).toBeNull(); // written earlier on the line
        expect(await landingPaths(contents({ archive: "$A.tar" }), project, all, host)).toBeNull();
        expect(await landingPaths(contents({ archive: "big.tar" }), project, all, host)).toBeNull();
        expect(await landingPaths(contents({ archive: "not-a.tar" }), project, all, host)).toBeNull();
        expect(await landingPaths(contents({ archive: "src" }), project, all, host)).toBeNull();
        expect(await landingPaths(undefined, project, all, host)).toBeNull();
    });
});

describe("landingPaths with a host that lists archives", () => {
    const gnu = (lines: string[]): RunResult => ({
        exitCode: 0,
        stdout: `${lines.join("\n")}\n`,
        stderr: "",
    });
    function hostListing(result: RunResult | undefined) {
        return memoryHost({ files: { "/p/a.tar": "x", "/p/a.zip": "x" }, run: () => result });
    }
    it("treats an archive the host cannot list as unknown", async () => {
        expect(
            await landingPaths(contents({ archive: "a.tar" }), "/p", all, hostListing(undefined)),
        ).toBeNull();
        expect(
            await landingPaths(
                contents({ archive: "a.tar" }),
                "/p",
                all,
                hostListing({ exitCode: 2, stdout: "", stderr: "bad" }),
            ),
        ).toBeNull();
    });
    it("reads GNU and bsdtar long listings, unescaping GNU's quoting", async () => {
        const listing = gnu([
            "drwxr-xr-x root/root         0 2026-10-15 15:00 ./",
            "lrwxrwxrwx root/root         0 2026-10-15 15:00 ./link -> .claude",
            "-rw-r--r-- root/root         1 2026-10-15 15:00 ./link/new\\nline",
            "hrw-r--r-- root/root         0 2026-10-15 15:00 ./.claude/hard link to ./link/new\\nline",
            "-rw-r--r-- root/root         1 2026-10-15 15:00 ./back\\\\slash",
            "-rw-r--r--  0 user  staff       2 Oct 15 15:00 bsd/with space",
        ]);
        expect(await landingPaths(contents({ archive: "a.tar" }), "/p", all, hostListing(listing))).toEqual([
            ".",
            "./link",
            "./link/new\nline", // as Python: the link was listed as `./link`, which no normalized prefix equals
            "./.claude/hard",
            "./back\\slash",
            "bsd/with space",
        ]);
    });
    it("refuses a line it cannot parse, a link line with several arrows, or too many entries", async () => {
        expect(
            await landingPaths(contents({ archive: "a.tar" }), "/p", all, hostListing(gnu(["garbage"]))),
        ).toBeNull();
        const arrows = gnu(["lrwxrwxrwx root/root 0 2026-10-15 15:00 a -> b -> c"]);
        expect(await landingPaths(contents({ archive: "a.tar" }), "/p", all, hostListing(arrows))).toBeNull();
        const many = gnu(
            Array.from(
                { length: MAX_ENTRIES + 1 },
                (_, i) => `-rw-r--r-- root/root 0 2026-10-15 15:00 f${i}`,
            ),
        );
        expect(await landingPaths(contents({ archive: "a.tar" }), "/p", all, hostListing(many))).toBeNull();
        const enough = gnu(
            Array.from({ length: MAX_ENTRIES }, (_, i) => `-rw-r--r-- root/root 0 2026-10-15 15:00 f${i}`),
        );
        expect(
            await landingPaths(contents({ archive: "a.tar" }), "/p", all, hostListing(enough)),
        ).toHaveLength(MAX_ENTRIES);
    });
    it("reads a zipinfo listing and the targets of its symlinks", async () => {
        const host = memoryHost({
            files: { "/p/a.zip": "x" },
            run: (argv) => {
                if (argv[1] === "-Z") {
                    return gnu([
                        "Archive:  a.zip",
                        "Zip file size: 464 bytes, number of entries: 3",
                        "-rw-r--r--  3.0 unx        1 tx stor 26-Oct-15 15:09 docs/index.md",
                        "lrwxrwxrwx  3.0 unx       10 bx stor 26-Oct-15 15:09 link",
                        "-rw-r--r--  3.0 unx        1 tx stor 26-Oct-15 15:09 link/pre-commit",
                        "3 files, 12 bytes uncompressed, 12 bytes compressed:  0.0%",
                    ]);
                }
                return argv[1] === "-p" && argv[3] === "link"
                    ? { exitCode: 0, stdout: ".git/hooks", stderr: "" }
                    : undefined;
            },
        });
        expect(await landingPaths(contents({ archive: "a.zip", zipArchive: true }), "/p", all, host)).toEqual(
            ["docs/index.md", "link", ".git/hooks/pre-commit"],
        );
    });
});

describe("landingPaths for copies", () => {
    const host = memoryHost({
        files: {
            "/p/template/.claude/settings.json": "{}",
            "/p/linked-source/actual/settings.json": "{}",
            "/p/assets/img/logo.png": "x",
            "/p/file.txt": "x",
        },
        dirs: ["/p/cyclic-source", "/p/empty"],
        links: { "/p/linked-source/.claude": "actual", "/p/cyclic-source/.claude": "." },
    });
    it("lands files under their names and copied directories under theirs or as their contents", async () => {
        expect(await landingPaths(contents({ sources: ["file.txt", "assets"] }), "/p", all, host)).toEqual([
            "file.txt",
        ]);
        expect(
            sorted(await landingPaths(contents({ sources: ["template"], recursive: true }), "/p", all, host)),
        ).toEqual(["template", "template/.claude", "template/.claude/settings.json"]);
        expect(
            sorted(
                await landingPaths(contents({ sources: ["template/."], recursive: true }), "/p", all, host),
            ),
        ).toEqual([".claude", ".claude/settings.json"]);
        expect(
            sorted(
                await landingPaths(
                    contents({ sources: ["template/"], recursive: true, slashCopiesContents: true }),
                    "/p",
                    all,
                    host,
                ),
            ),
        ).toEqual([".claude", ".claude/settings.json"]);
        expect(
            sorted(
                await landingPaths(contents({ sources: ["template/"], recursive: true }), "/p", all, host),
            ),
        ).toEqual(["template", "template/.claude", "template/.claude/settings.json"]);
        expect(
            sorted(
                await landingPaths(
                    contents({ sources: ["template"], recursive: true, copiesContents: true }),
                    "/p",
                    all,
                    host,
                ),
            ),
        ).toEqual([".claude", ".claude/settings.json"]);
    });
    it("walks only where descend says protected paths may lie", async () => {
        const descend = (dir: string) => dir.endsWith(".claude");
        expect(
            sorted(
                await landingPaths(
                    contents({ sources: ["template/.", "assets"], recursive: true }),
                    "/p",
                    descend,
                    host,
                ),
            ),
        ).toEqual([".claude", ".claude/settings.json", "assets", "assets/img"]); // a directory's own entries are always listed
    });
    it("follows linked directories only when the copy dereferences them", async () => {
        const source = contents({ sources: ["linked-source/."], recursive: true });
        expect(sorted(await landingPaths(source, "/p", all, host))).toEqual([
            ".claude",
            "actual",
            "actual/settings.json",
        ]);
        expect(sorted(await landingPaths({ ...source, followLinks: true }, "/p", all, host))).toEqual([
            ".claude",
            ".claude/settings.json",
            "actual",
            "actual/settings.json",
        ]);
        expect(
            await landingPaths(
                contents({ sources: ["cyclic-source/."], recursive: true, followLinks: true }),
                "/p",
                all,
                host,
            ),
        ).toBeNull();
        expect(
            await landingPaths(contents({ sources: ["cyclic-source/."], recursive: true }), "/p", all, host),
        ).toEqual([".claude"]);
    });
    it("keeps the source path for cp --parents and rsync -R", async () => {
        expect(
            await landingPaths(
                contents({ sources: ["template/.claude/settings.json"], keepParents: true }),
                "/p",
                all,
                host,
            ),
        ).toEqual(["template/.claude/settings.json"]);
        const relative = contents({
            sources: ["template/./.claude"],
            recursive: true,
            keepParents: true,
            rsyncRelative: true,
        });
        expect(await landingPaths(relative, "/p", all, host)).toEqual([".claude", ".claude/settings.json"]);
    });
    it("gives up on a computed or remote tree, skips a computed file and a directory copied flat", async () => {
        expect(
            await landingPaths(contents({ sources: ["$SRC"], recursive: true }), "/p", all, host),
        ).toBeNull();
        expect(
            await landingPaths(contents({ sources: ["host:dir"], recursive: true }), "/p", all, host),
        ).toBeNull();
        expect(await landingPaths(contents({ sources: ["$SRC", "file.txt"] }), "/p", all, host)).toEqual([
            "file.txt",
        ]);
        expect(await landingPaths(contents({ sources: ["template"] }), "/p", all, host)).toEqual([]);
        expect(await landingPaths(contents({ sources: ["missing"] }), "/p", all, host)).toEqual(["missing"]);
    });
    it("stops at MAX_ENTRIES", async () => {
        const files = Object.fromEntries(
            Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => [`/p/many/f${i}`, "x"]),
        );
        const wide = memoryHost({ files });
        expect(
            await landingPaths(contents({ sources: ["many"], recursive: true }), "/p", all, wide),
        ).toBeNull();
    });
});
