/**
 * Tests for config-guard.ts, ported from config_guard_test.py: every Bash,
 * landing and file-tool case, the live-source and script checks, and the
 * configuration checks (CONFIG_GUARD_ASK/DISABLE, CLAUDE_CONFIG_DIR and the
 * HOME_ALIASES moves). The project and the home are temporary directories;
 * the archives the landing cases extract are built with `tar` and `zip`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../config.ts";
import type { Decision } from "../decision.ts";
import type { Host } from "../host/host.ts";
import { memoryHost } from "../host/memory-host.ts";
import { nodeHost } from "../host/node-host.ts";
import { resolve } from "../shell/sources.ts";
import { DELETE_TREE, WRITE } from "../shell/writes.ts";
import { BASH_CASES, LANDING_CASES, type Outcome, PATH_CASES } from "./__fixtures__/config-guard-cases.ts";
import {
    buildReason,
    CONFIG_DIR_RULE,
    candidatePaths,
    checkCommand,
    checkPath,
    configGuard,
    HOOK_NAME,
    homeForms,
    LIVE_SOURCE_RULE,
    liveSourceDirs,
    MAX_GLOB_MATCHES,
} from "./config-guard.ts";
import type { GuardDeps } from "./guard.ts";

function has(tool: string): boolean {
    try {
        execFileSync("which", [tool], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

const hasZip = has("zip");

/** `(decision, rule id)` the way the Python test read them off the reason text. */
type Verdict = readonly [Outcome, string | undefined];

function verdict(result: Decision | undefined): Verdict {
    if (result === undefined) return [undefined, undefined];
    const ruleId = result.reason.split("[", 2)[1]?.split("]", 1)[0];
    return [result.decision, ruleId];
}

function write(path: string, text = "x"): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf-8");
}

function tar(archive: string, cwd: string, ...members: string[]): void {
    const flags = archive.endsWith(".tgz") ? "czf" : "cf";
    execFileSync("tar", [flags, archive, "-C", cwd, ...members]);
}

function zip(archive: string, cwd: string, ...members: string[]): void {
    execFileSync("zip", ["-q", "-y", archive, ...members], { cwd });
}

/**
 * Archives and trees whose contents land in the project when extracted or
 * copied (`_make_archives`). The Python test wrote archive members from
 * memory; here each archive is built by `tar`/`zip` from a tree under
 * `source`, outside the project, with the same member names and link targets.
 */
function makeArchives(project: string, source: string): void {
    write(join(source, "payload", ".claude", "settings.json"), "{}");
    tar(join(project, "payload.tar"), join(source, "payload"), ".claude/settings.json");
    write(join(source, "release", "release", "bin", "app"));
    tar(join(project, "release.tgz"), join(source, "release"), "release/bin/app");
    write(join(source, "nested", "pkg-1.0", ".git", "hooks", "pre-commit"));
    tar(join(project, "nested.tar"), join(source, "nested"), "pkg-1.0/.git/hooks/pre-commit");
    mkdirSync(join(source, "link"), { recursive: true });
    symlinkSync("../..", join(source, "link", "up"));
    tar(join(project, "link.tar"), join(source, "link"), "up");
    write(join(source, "through", ".claude", "settings.json"), "{}");
    symlinkSync(".claude", join(source, "through", "link"));
    // The link first, then a member written through it.
    tar(join(project, "through.tar"), join(source, "through"), "link", "link/settings.json");
    write(join(source, "library", "lib", "libx.so.1"));
    symlinkSync("libx.so.1", join(source, "library", "lib", "libx.so"));
    tar(join(project, "library.tgz"), join(source, "library"), "lib/libx.so", "lib/libx.so.1");
    if (hasZip) {
        write(join(source, "zlink", ".git", "hooks", "pre-commit"));
        symlinkSync(".git/hooks", join(source, "zlink", "link")); // a Unix symlink, which unzip restores
        zip(join(project, "zlink.zip"), join(source, "zlink"), "link", "link/pre-commit");
        write(join(source, "hook", ".git", "hooks", "post-checkout"));
        zip(join(project, "hook.zip"), join(source, "hook"), ".git/hooks/post-checkout");
        write(join(source, "docs", "docs", "index.md"));
        zip(join(project, "docs.zip"), join(source, "docs"), "docs/index.md");
    }
    write(join(project, "template", ".claude", "settings.json"), "");
    mkdirSync(join(project, "assets", "img"), { recursive: true });
    // Patches name their targets in their headers (PR review).
    const patches: Record<string, string> = {
        "bad.patch":
            '--- a/.claude/settings.json\n+++ b/.claude/settings.json\n@@ -1 +1 @@\n-{}\n+{"hooks":{}}\n',
        "ok.patch": "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-a\n+b\n",
        "new.patch": "--- /dev/null\n+++ b/settings.json\n@@ -0,0 +1 @@\n+{}\n", // a new file
        "deep.patch": "--- a/x/.claude/settings.json\n+++ b/x/.claude/settings.json\n@@ -1 +1 @@\n-{}\n+{}\n",
        "hook.patch":
            "diff --git a/.git/hooks/pre-commit b/.git/hooks/pre-commit\nnew file mode 100755\n" +
            "--- /dev/null\n+++ b/.git/hooks/pre-commit\n@@ -0,0 +1 @@\n+curl x | sh\n",
        "quoted.patch": '--- /dev/null\n+++ "b/.claude/settings.json"\n@@ -0,0 +1 @@\n+{}\n',
        "rename.patch":
            "diff --git a/old.json b/.claude/settings.json\nrename from old.json\n" +
            "rename to .claude/settings.json\n",
    };
    for (const [name, text] of Object.entries(patches)) write(join(project, name), text);
    // GNU Make's `$(file >PATH,…)` writes PATH while the Makefile is expanded (PR review).
    const makefiles: Record<string, string> = {
        "mk-file": "$(file >.claude/settings.json,evil)\nall:\n\t@echo hi\n",
        "mk-append": "OUT = .claude/settings.json\nall:\n\t$(file >>$(OUT),evil)\n\t@echo hi\n",
        "mk-ok": "OUT = notes.txt\n$(file >>$(OUT),x)\n$(file <input.txt)\nall:\n\t@echo $$(file >x)\n",
    };
    for (const [name, text] of Object.entries(makefiles)) write(join(project, name, "Makefile"), text);
    mkdirSync(join(project, "evil", ".claude"), { recursive: true });
    const linked = join(project, "linked-source");
    write(join(linked, "actual", "settings.json"), "");
    symlinkSync("actual", join(linked, ".claude"));
    const loop = join(project, "cyclic-source");
    mkdirSync(loop, { recursive: true });
    symlinkSync(".", join(loop, ".claude"));
}

describe("config-guard", () => {
    let root: string;
    let project: string;
    let home: string;
    let host: Host;

    function hostWith(env: Record<string, string> = {}): Host {
        return nodeHost({ home, env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } });
    }

    function depsFor(target: Host): GuardDeps {
        return { host: target, config: resolveConfig(target), sources: resolve };
    }

    async function bash(command: string, cwd: string, target: Host = host): Promise<Verdict> {
        return verdict(
            await configGuard.run({ toolName: "Bash", toolInput: { command }, cwd }, depsFor(target)),
        );
    }

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "config-guard-"));
        project = join(root, "project");
        home = join(root, "home");
        // A machine with Claude Code installed: the hooks directory exists under ~/.claude.
        mkdirSync(join(project, ".git", "hooks"), { recursive: true });
        mkdirSync(join(home, ".claude", "hooks"), { recursive: true });
        host = hostWith();
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    describe("Bash writes", () => {
        for (const [command, decision, ruleId] of BASH_CASES) {
            it(`${JSON.stringify(command)} -> ${decision ?? "pass"}`, async () => {
                const actual = await bash(command, project);
                expect(actual[0]).toBe(decision);
                if (ruleId !== undefined) expect(actual[1]).toBe(ruleId);
            });
        }
    });

    describe("Copies and extractions", () => {
        beforeAll(() => makeArchives(project, join(root, "archive-sources")));
        for (const [command, decision, ruleId] of LANDING_CASES) {
            const needsZip = command.includes(".zip");
            it.skipIf(needsZip && !hasZip)(
                `${JSON.stringify(command)} -> ${decision ?? "pass"}`,
                async () => {
                    const actual = await bash(command, project);
                    expect(actual[0]).toBe(decision);
                    if (ruleId !== undefined) expect(actual[1]).toBe(ruleId);
                },
            );
        }
    });

    describe("File tools", () => {
        for (const [path, decision] of PATH_CASES) {
            for (const tool of ["Write", "Edit"]) {
                it(`${tool} ${path} -> ${decision ?? "pass"}`, async () => {
                    const result = await configGuard.run(
                        { toolName: tool, toolInput: { file_path: path }, cwd: project },
                        depsFor(host),
                    );
                    expect(result?.decision).toBe(decision);
                });
            }
        }

        it("Read of settings is not this hook's concern", async () => {
            const result = await configGuard.run(
                { toolName: "Read", toolInput: { file_path: "~/.claude/settings.json" }, cwd: project },
                depsFor(host),
            );
            expect(result).toBeUndefined();
        });
    });

    describe("Live guard sources and scripts", () => {
        let liveDir: string;
        let own: string;
        beforeAll(() => {
            // The checkout the running guard code lives in (the Python hook's own directory).
            liveDir = join(project, "guard-src", "hooks");
            own = join(liveDir, "rm-rf-guard.ts");
            write(own, "export {};\n");
        });

        it("write into running guard code -> ask", async () => {
            const live = hostWith({ CONFIG_GUARD_LIVE_DIRS: liveDir });
            expect(await bash(`echo x >> ${own}`, project, live)).toEqual(["ask", "guard-sources"]);
            // Without the live directory configured it is an ordinary file.
            expect(await bash(`echo x >> ${own}`, project)).toEqual([undefined, undefined]);
        });

        it("removing the guard checkout -> ask", async () => {
            const live = hostWith({ CONFIG_GUARD_LIVE_DIRS: liveDir });
            expect((await bash(`rm -r ${dirname(liveDir)}`, project, live))[0]).toBe("ask");
            const found = await checkCommand(`rm -r ${dirname(liveDir)}`, project, host, resolve, [liveDir]);
            expect(found?.rule).toBe(LIVE_SOURCE_RULE);
            expect(found?.action).toBe(DELETE_TREE);
        });

        it("checkPath takes the live directories directly", async () => {
            expect(await checkPath(own, project, host, WRITE, [liveDir])).toBe(LIVE_SOURCE_RULE);
            expect(await checkPath(own, project, host)).toBeUndefined();
            expect(await checkPath(dirname(liveDir), project, host, DELETE_TREE, [liveDir])).toBe(
                LIVE_SOURCE_RULE,
            );
            expect(await checkPath(dirname(liveDir), project, host, WRITE, [liveDir])).toBeUndefined();
        });

        it("the target of a symlinked ~/.claude/hooks is live", async () => {
            const linkedHome = join(root, "linked-home");
            const checkout = join(linkedHome, "checkout", "hooks");
            write(join(checkout, "guard.py"), "");
            mkdirSync(join(linkedHome, ".claude"), { recursive: true });
            symlinkSync(join(linkedHome, "checkout", "hooks"), join(linkedHome, ".claude", "hooks"));
            const linked = nodeHost({ home: linkedHome, env: { HOME: linkedHome } });
            expect(await liveSourceDirs(linked)).toEqual([checkout]);
            expect(await liveSourceDirs(linked, [checkout, "~/checkout/hooks", " "])).toEqual([checkout]);
            expect(await bash(`echo x >> ${checkout}/guard.py`, project, linked)).toEqual([
                "ask",
                "guard-sources",
            ]);
            // Through the link it is the hooks directory itself: denied before the live check.
            expect(await bash("echo x >> ~/.claude/hooks/guard.py", project, linked)).toEqual([
                "deny",
                "claude-hooks",
            ]);
        });

        it("settings write inside a script -> ask", async () => {
            write(join(project, "setup.sh"), "#!/bin/bash\necho '{}' > ~/.claude/settings.json\n");
            expect(await bash("./setup.sh", project)).toEqual(["ask", "claude-settings"]);
        });

        it("glob past the match limit -> ask", async () => {
            // Both the parser and the guard stop listing matches past their limits: the
            // parser leaves the pattern as written, and the guard finds more matches than
            // it inspects.
            const files: Record<string, string> = {};
            for (let index = 0; index <= MAX_GLOB_MATCHES; index += 1) files[`/proj/crowded/.f${index}`] = "";
            const crowded = memoryHost({ files });
            const found = await checkCommand("rm -r .??*", "/proj/crowded", crowded, resolve);
            expect(found?.rule).toBe(CONFIG_DIR_RULE);
            expect(found?.uncertain).toBe("a glob matching more files than can be checked");
            expect(
                verdict(
                    await configGuard.run(
                        { toolName: "Bash", toolInput: { command: "rm -r .??*" }, cwd: "/proj/crowded" },
                        depsFor(crowded),
                    ),
                ),
            ).toEqual(["ask", "agent-config-dir"]);
            // A few matches are all inspected and pass.
            const few = memoryHost({ files: { "/proj/crowded/.aa": "", "/proj/crowded/.bb": "" } });
            expect(await checkCommand("rm -r .??*", "/proj/crowded", few, resolve)).toBeUndefined();
        });

        it("script written and run in one command -> deny", async () => {
            expect((await bash("cat > s.sh <<'EOF'\necho x > ~/.zshrc\nEOF\nbash s.sh", project))[0]).toBe(
                "deny",
            );
        });
    });

    describe("Configuration", () => {
        const command = "rm ~/.claude/settings.json";

        it.each([
            [{}, "deny"],
            [{ CONFIG_GUARD_ASK: "1" }, "ask"],
            [{ CONFIG_GUARD_DISABLE: "1" }, undefined],
        ] as const)("%o -> %s", async (env, expected) => {
            expect((await bash(command, project, hostWith({ ...env })))[0]).toBe(expected);
        });

        it("CLAUDE_CONFIG_DIR is protected", async () => {
            const configDir = join(project, "alt-claude");
            const moved = hostWith({ CLAUDE_CONFIG_DIR: configDir });
            expect((await bash(`echo x > ${configDir}/anything.json`, project, moved))[0]).toBe("deny");
            // An inherited $CLAUDE_CONFIG_DIR resolves (PR review).
            expect((await bash('printf x > "$CLAUDE_CONFIG_DIR/settings.json"', project, moved))[0]).toBe(
                "deny",
            );
            // Unset, the variable's value is not known and the text written (`x`) does not
            // read like configuration, so the write passes as `echo hi > "$OUT"` does.
            expect(await bash('printf x > "$CLAUDE_CONFIG_DIR/settings.json"', project)).toEqual([
                undefined,
                undefined,
            ]);
        });

        it("locations the environment moves are checked as their defaults (PR review)", async () => {
            const moved = {
                CODEX_HOME: join(project, "codex-home"),
                XDG_CONFIG_HOME: join(project, "xdg"),
                GIT_CONFIG_GLOBAL: join(project, "global.gitconfig"),
            };
            const target = hostWith(moved);
            const cases: ReadonlyArray<readonly [string, string | undefined]> = [
                ['echo x > "$CODEX_HOME/skills/foo/SKILL.md"', "agent-instructions"],
                [`cp evil.toml ${moved.CODEX_HOME}/config.toml`, "codex-config"],
                [`rm -r ${moved.CODEX_HOME}`, undefined],
                [`echo x >> ${moved.XDG_CONFIG_HOME}/git/config`, "git-config"],
                [`echo x > ${moved.XDG_CONFIG_HOME}/opencode/opencode.json`, "opencode-config"],
                [`echo x >> ${moved.GIT_CONFIG_GLOBAL}`, "git-config"],
            ];
            for (const [line, ruleId] of cases) {
                const actual = await bash(line, project, target);
                expect(actual[0], line).toBe("deny");
                if (ruleId !== undefined) expect(actual[1], line).toBe(ruleId);
            }
            expect(await bash(`echo x > ${moved.XDG_CONFIG_HOME}/notes.txt`, project, target)).toEqual([
                undefined,
                undefined,
            ]);
        });
    });

    describe("Path forms", () => {
        it("spells an absolute path the way the rules do", async () => {
            expect(await homeForms(`${home}/.gitconfig`, host)).toEqual(["~/.gitconfig"]);
            expect(await homeForms("relative/path", host)).toEqual([]);
            const moved = hostWith({ CODEX_HOME: join(project, "codex-home") });
            expect(await homeForms(join(project, "codex-home", "skills", "x"), moved)).toEqual([
                "~/.codex/skills/x",
            ]);
        });

        it("lists a path as written, expanded, resolved and in its home form", async () => {
            expect(await candidatePaths("~/.claude/settings.json", project, host)).toEqual([
                "~/.claude/settings.json",
                `${home}/.claude/settings.json`,
            ]);
            expect(await candidatePaths("$HOME/.zshrc", project, host)).toEqual([
                "$HOME/.zshrc",
                `${home}/.zshrc`,
                "~/.zshrc",
            ]);
            expect(await candidatePaths("notes.txt", project, host)).toEqual([
                "notes.txt",
                `${project}/notes.txt`,
            ]);
        });
    });

    describe("Output and audit", () => {
        it("writes the reason the Python hook wrote", async () => {
            const result = await configGuard.run(
                { toolName: "Write", toolInput: { file_path: "~/.claude/settings.json" }, cwd: project },
                depsFor(host),
            );
            expect(result?.hook).toBe(HOOK_NAME);
            expect(result?.systemMessage).toBe(
                "config-guard [claude-settings]: Claude Code settings hold permissions, hooks and env for the agent itself",
            );
            expect(result?.reason.split("\n")[0]).toBe(
                "🧷 BLOCKED by config-guard [claude-settings] — cannot write (write): " +
                    "Claude Code settings hold permissions, hooks and env for the agent itself.",
            );
            expect(result?.reason.split("\n")[1]).toBe("    target: ~/.claude/settings.json");
            const asked = buildReason(
                { rule: CONFIG_DIR_RULE, target: "x", action: "into-dir", indirect: false, uncertain: "why" },
                "Bash",
                "ask",
            );
            expect(asked.split("\n")[0]).toBe(
                `🧷 Confirm by config-guard [agent-config-dir] — cannot run (into-dir) (why): ${CONFIG_DIR_RULE.reason}.`,
            );
            const indirect = buildReason(
                { rule: CONFIG_DIR_RULE, target: "x", action: "write", indirect: true },
                "Bash",
                "ask",
            );
            expect(indirect).toContain(
                "(write) (inside a script, or an interpreter program's string, this command runs):",
            );
        });

        it("logs one record with the Python payload keys", async () => {
            const memory = memoryHost({ env: { CONFIG_GUARD_LOG_DIR: "/logs" } });
            const result = await configGuard.run(
                {
                    toolName: "Bash",
                    toolInput: { command: "rm ~/.claude/settings.json" },
                    cwd: "/home/user/proj",
                    sessionId: "s1",
                    permissionMode: "default",
                },
                depsFor(memory),
            );
            expect(result?.decision).toBe("deny");
            expect(memory.appended).toHaveLength(1);
            const [path, line] = (memory.appended[0] as string).split("\n", 2);
            expect(path).toMatch(/^\/logs\/\d{4}-\d{2}-\d{2}\.jsonl$/);
            expect(JSON.parse(line as string)).toEqual({
                ts: expect.any(String),
                hook: HOOK_NAME,
                outcome: "deny",
                rule: "claude-settings",
                level: "critical",
                action: "delete",
                indirect: false,
                tool: "Bash",
                target: "~/.claude/settings.json",
                session_id: "s1",
                cwd: "/home/user/proj",
                permission_mode: "default",
            });
        });
    });
});
