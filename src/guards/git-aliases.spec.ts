import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryHost } from "../host/memory-host.ts";
import { nodeHost } from "../host/node-host.ts";
import { SimpleCommand } from "../shell/model.ts";
import { findDangers } from "./dangerous-commands.ts";
import { BUILTINS, LOOKUP_TIMEOUT_SECONDS, resolveGitAliases, sourcesWithGitAliases } from "./git-aliases.ts";

let project: string;
let aliased: string;
const savedEnv: Record<string, string | undefined> = {};
const host = nodeHost();

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
const command = (cwd: string, ...argv: string[]) => new SimpleCommand({ argv, cwd, cwdOptions: [cwd] });

beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), "git-aliases-"));
    // Aliases from repository or global config run what they expand to (PR review).
    for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) savedEnv[name] = process.env[name];
    process.env.GIT_CONFIG_GLOBAL = join(project, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    aliased = join(project, "aliased");
    git(project, "init", "-q", aliased);
    for (const [scope, key, value] of [
        ["--local", "alias.wipe", "!git push -f origin main"],
        ["--local", "alias.nuke", "reset --hard HEAD~1"],
        ["--global", "alias.yolo", "push --force"],
        ["--local", "alias.lg", "log --oneline"],
    ]) {
        git(aliased, "config", scope as string, key as string, value as string);
    }
});

afterAll(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    rmSync(project, { recursive: true, force: true });
});

describe("resolveGitAliases", () => {
    it("expands a `!` alias to its shell command with the arguments quoted after it", async () => {
        expect(await resolveGitAliases(command(aliased, "git", "wipe", "a b"), host)).toEqual([
            ["git push -f origin main 'a b'", "git alias wipe"],
        ]);
    });

    it("expands a git alias to a git command line", async () => {
        expect(await resolveGitAliases(command(aliased, "git", "nuke"), host)).toEqual([
            ["git reset --hard HEAD~1", "git alias nuke"],
        ]);
        expect(await resolveGitAliases(command(aliased, "git", "lg", "-5"), host)).toEqual([
            ["git log --oneline -5", "git alias lg"],
        ]);
    });

    it("reads the global config too, from wherever the repository is named", async () => {
        expect(await resolveGitAliases(command(aliased, "git", "yolo", "origin", "main"), host)).toEqual([
            ["git push --force origin main", "git alias yolo"],
        ]);
        expect(await resolveGitAliases(command(project, "git", "-C", "aliased", "nuke"), host)).toEqual([
            ["git reset --hard HEAD~1", "git alias nuke"],
        ]);
        // Outside the repository only the global alias is visible.
        expect(await resolveGitAliases(command(project, "git", "nuke"), host)).toEqual([]);
        expect(await resolveGitAliases(command(project, "git", "yolo"), host)).toEqual([
            ["git push --force", "git alias yolo"],
        ]);
    });

    it("lets an inline `-c alias.x=…` win over the config files and marks it written", async () => {
        expect(
            await resolveGitAliases(command(aliased, "git", "-c", "alias.nuke=status", "nuke"), host),
        ).toEqual([["git status", "written git alias nuke"]]);
        expect(
            await resolveGitAliases(command(aliased, "git", "-c", "alias.x=!rm -rf ~", "x"), host),
        ).toEqual([["rm -rf ~", "written git alias x"]]);
    });

    it("skips builtins, missing aliases and anything but a literal git", async () => {
        expect(await resolveGitAliases(command(aliased, "git", "status"), host)).toEqual([]);
        expect(await resolveGitAliases(command(aliased, "git", "undefined-alias"), host)).toEqual([]);
        expect(await resolveGitAliases(command(aliased, "git"), host)).toEqual([]);
        expect(await resolveGitAliases(command(aliased, "ls", "wipe"), host)).toEqual([]);
        expect(BUILTINS.has("reset")).toBe(true);
        expect(BUILTINS.has("wipe")).toBe(false);
    });

    it("answers nothing when git cannot be run, with the lookup bounded in time", async () => {
        const calls: Array<{ argv: readonly string[]; timeoutMs: number | undefined }> = [];
        const silent = memoryHost({
            run: (argv, options) => {
                calls.push({ argv, timeoutMs: options?.timeoutMs });
                return undefined;
            },
        });
        expect(await resolveGitAliases(command("/proj", "git", "wipe"), silent)).toEqual([]);
        expect(calls).toEqual([
            {
                argv: ["git", "-C", "/proj", "config", "--get", "alias.wipe"],
                timeoutMs: LOOKUP_TIMEOUT_SECONDS * 1000,
            },
        ]);
        const failing = memoryHost({ run: () => ({ exitCode: 1, stdout: "", stderr: "" }) });
        expect(await resolveGitAliases(command("/proj", "git", "wipe"), failing)).toEqual([]);
    });
});

describe("sourcesWithGitAliases through the guard", () => {
    it.each([
        ["git wipe", "aliased", "ask"],
        ["git nuke", "aliased", "ask"],
        ["git yolo origin main", "aliased", "ask"],
        ["cd aliased && git nuke", "project", "ask"],
        ["git -C aliased nuke", "project", "ask"],
        ["git lg -5", "aliased", undefined],
        ["git status", "aliased", undefined],
        ["git undefined-alias", "aliased", undefined],
    ])("configured alias: %s (in %s) -> %s", async (text, where, expected) => {
        const cwd = where === "project" ? project : aliased;
        const findings = await findDangers(text, cwd, host, sourcesWithGitAliases);
        expect(findings[0]?.decision).toBe(expected);
        if (expected !== undefined) expect(findings[0]?.command.indirect).toBe(true);
    });
});
