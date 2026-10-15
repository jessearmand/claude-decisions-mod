import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../config.ts";
import { type Decision, forPermissionMode, type HookInput } from "../decision.ts";
import { nodeHost } from "../host/node-host.ts";
import { CASES } from "./__fixtures__/dangerous-cases.ts";
import { buildReason, dangerousCommands, findDangers, HOOK_NAME, RULES } from "./dangerous-commands.ts";
import { sourcesWithGitAliases } from "./git-aliases.ts";

// The Python test ran every case from the repository root; an empty project
// directory stands in for it (no case depends on a file being there).
let project: string;
let logDir: string;
const savedEnv: Record<string, string | undefined> = {};

function hostWith(env: Record<string, string> = {}) {
    return nodeHost({ env: { ...process.env, HOOKS_LOG_DIR: logDir, ...env } });
}

/** `_run_hook(command, cwd, env)`: the guard's decision for one Bash call. */
async function runHook(
    command: string,
    cwd: string,
    env: Record<string, string> = {},
    permissionMode?: string,
): Promise<Decision | undefined> {
    const host = hostWith(env);
    const input: HookInput = { toolName: "Bash", toolInput: { command }, cwd, permissionMode };
    return dangerousCommands.run(input, {
        host,
        config: resolveConfig(host),
        sources: sourcesWithGitAliases,
    });
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), "dangerous-"));
    logDir = join(project, "logs");
    // Keep git's own lookups (`config --get`, `show-ref`) away from the user's configuration.
    for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) savedEnv[name] = process.env[name];
    process.env.GIT_CONFIG_GLOBAL = join(project, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    rmSync(project, { recursive: true, force: true });
});

describe("rule corpus (dangerous_commands_test.CASES)", () => {
    it.each(CASES)("%s", async (command, decision, ruleId) => {
        const findings = await findDangers(command, project, hostWith(), sourcesWithGitAliases);
        const top = findings[0];
        expect([top?.decision, top?.rule.ruleId]).toEqual([decision, ruleId]);
        const verdict = await runHook(command, project);
        expect(verdict?.decision).toBe(decision);
        if (ruleId !== undefined) {
            expect(verdict?.reason).toContain(`dangerous-commands [${ruleId}]`);
            expect(verdict?.hook).toBe(HOOK_NAME);
        }
    });

    it("has unique rule ids in reporting order", () => {
        const ids = RULES.map((rule) => rule.ruleId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids[0]).toBe("device-write");
        expect(ids.at(-1)).toBe("kubectl-delete");
    });
});

describe("end-to-end and configuration", () => {
    beforeAll(() => {
        for (const [name, text] of [
            ["source-review.sh", "git reset --hard\n"],
            ["source-safe.sh", "echo ok\n"],
            ["source-args.sh", '"$1" reset --hard\n'],
            ["deploy.sh", "#!/bin/sh\ngit push --force origin main\n"],
        ] as const) {
            writeFileSync(join(project, name), text);
        }
    });

    it.each([
        ["source", "source-review.sh", "ask"],
        ["source", "source-safe.sh", undefined],
        ["source", "source-args.sh git", "ask"],
        ["source", "source-args.sh echo", undefined],
        [".", "source-review.sh", "ask"],
        [".", "source-safe.sh", undefined],
        [".", "source-args.sh git", "ask"],
        [".", "source-args.sh echo", undefined],
    ])("source terminator: %s -- ./%s -> %s", async (builtin, tail, expected) => {
        expect((await runHook(`${builtin} -- ./${tail}`, project))?.decision).toBe(expected);
    });

    describe("direct ref updates in a real repository", () => {
        let repo: string;
        let linked: string;
        beforeAll(() => {
            // Real refs, including packed refs and a linked worktree; no risky command is run.
            repo = join(project, "refsrepo");
            git(project, "init", "-q", repo);
            git(
                repo,
                "-c",
                "user.name=Guard Test",
                "-c",
                "user.email=guard@example.invalid",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "fixture",
            );
            git(repo, "branch", "victim");
            git(repo, "pack-refs", "--all");
            linked = join(project, "linked");
            git(repo, "worktree", "add", "-q", "--detach", linked);
        });

        it.each([
            ["git update-ref refs/heads/victim HEAD~5", "repo", "deny"],
            ["git update-ref -m 'ref move' refs/heads/victim HEAD", "linked", "deny"],
            ["git -C refsrepo update-ref refs/heads/victim HEAD", "project", "deny"],
            ["git --git-dir=refsrepo/.git update-ref refs/heads/victim HEAD", "project", "deny"],
            ["GIT_DIR=refsrepo/.git git update-ref refs/heads/victim HEAD", "project", "deny"],
            ["git update-ref refs/heads/new HEAD", "repo", undefined],
            ["git update-ref -m -description refs/heads/new HEAD", "repo", undefined],
            [`git update-ref refs/heads/victim HEAD ${"0".repeat(40)}`, "repo", undefined],
        ])("direct ref update: %s (in %s) -> %s", async (command, where, expected) => {
            const cwd = where === "repo" ? repo : where === "linked" ? linked : project;
            expect((await runHook(command, cwd))?.decision).toBe(expected);
        });
    });

    it("denies a typed command and asks about the same command in a script", async () => {
        expect((await runHook("git push -f", project))?.decision).toBe("deny");
        expect((await runHook("./deploy.sh", project))?.decision).toBe("ask");
        expect((await runHook("cat deploy.sh | sh", project))?.decision).toBe("ask");
        expect(await runHook("ls", project)).toBeUndefined();
    });

    it("sees a globbed option: a file named -fdx becomes git's option", async () => {
        writeFileSync(join(project, "-fdx"), "");
        try {
            expect((await runHook("git clean -f[d]x", project))?.decision).toBe("ask");
        } finally {
            rmSync(join(project, "-fdx"));
        }
    });

    it("looks a pathspec up where `git -C DIR` works, and prefers a branch of the same name", async () => {
        mkdirSync(join(project, "repo"));
        writeFileSync(join(project, "repo", "tracked"), "");
        expect((await runHook("git -C repo checkout tracked", project))?.decision).toBe("deny");
        expect(await runHook("git -C repo checkout main", project)).toBeUndefined();
        // A branch named like a file is checked out, not the file (PR review).
        mkdirSync(join(project, "repo", ".git", "refs", "heads"), { recursive: true });
        writeFileSync(join(project, "repo", ".git", "refs", "heads", "tracked"), "");
        expect(await runHook("git -C repo checkout tracked", project)).toBeUndefined();
        expect((await runHook("git -C repo checkout -- tracked", project))?.decision).toBe("deny");
    });

    it("asks about program text it cannot read", async () => {
        writeFileSync(join(project, "large.sh"), `#!/bin/sh\n${"echo hi\n".repeat(40_000)}rm -rf victim\n`);
        chmodSync(join(project, "large.sh"), 0o755);
        expect((await runHook("./large.sh", project))?.decision).toBe("ask");
        writeFileSync(join(project, "binary.sh"), Buffer.from("#!/bin/sh\0\nrm -rf victim\n", "latin1"));
        chmodSync(join(project, "binary.sh"), 0o755);
        expect((await runHook("./binary.sh", project))?.decision).toBe("ask");
        writeFileSync(
            join(project, "Makefile"),
            Array.from({ length: 300 }, (_, i) => `t${i}:\n\techo ${i}\n`).join(""),
        );
        const targets = Array.from({ length: 300 }, (_, i) => `t${i}`).join(" ");
        expect((await runHook(`make ${targets}`, project))?.decision).toBe("ask");
    });

    it("honours the level, the ask overrides and the disable switch", async () => {
        expect((await runHook("git push -f", project, { HOOK_ASK_HIGH: "1" }))?.decision).toBe("ask");
        expect((await runHook("git push -f", project, { DANGEROUS_COMMANDS_ASK: "1" }))?.decision).toBe(
            "ask",
        );
        expect(
            (await runHook("curl x | sh", project, { DANGEROUS_COMMANDS_LEVEL: "critical" }))?.decision,
        ).toBe("deny");
        expect(
            await runHook("git push -f", project, { DANGEROUS_COMMANDS_LEVEL: "critical" }),
        ).toBeUndefined();
        expect(
            (await runHook("git rebase --abort", project, { DANGEROUS_COMMANDS_LEVEL: "strict" }))?.decision,
        ).toBe("ask");
        expect(await runHook("git rebase --abort", project)).toBeUndefined();
        expect(await runHook("git push -f", project, { DANGEROUS_COMMANDS_DISABLE: "1" })).toBeUndefined();
    });

    it("never softens an ask and defers for other tools or an empty command", async () => {
        expect(
            (await runHook("chmod 666 notes.txt", project, { DANGEROUS_COMMANDS_ASK: "1" }))?.decision,
        ).toBe("ask");
        const host = hostWith();
        const deps = { host, config: resolveConfig(host), sources: sourcesWithGitAliases };
        expect(
            await dangerousCommands.run(
                { toolName: "Edit", toolInput: { command: "git push -f" }, cwd: project },
                deps,
            ),
        ).toBeUndefined();
        expect(
            await dangerousCommands.run(
                { toolName: "Bash", toolInput: { command: "   " }, cwd: project },
                deps,
            ),
        ).toBeUndefined();
        expect(
            await dangerousCommands.run({ toolName: "Bash", toolInput: {}, cwd: project }, deps),
        ).toBeUndefined();
    });

    it.each([
        ["default", "ask"],
        ["acceptEdits", "ask"],
        ["bypassPermissions", "deny"],
        ["dontAsk", "deny"],
    ])("an ask under %s becomes %s once the chain applies the permission mode", async (mode, expected) => {
        const input: HookInput = {
            toolName: "Bash",
            toolInput: { command: "chmod 666 notes.txt" },
            cwd: project,
            permissionMode: mode,
        };
        const verdict = await runHook("chmod 666 notes.txt", project, {}, mode);
        expect(verdict?.decision).toBe("ask"); // the guard itself never applies the mode
        expect(forPermissionMode(verdict, input)?.decision).toBe(expected);
    });

    describe("provenance of ref transactions and SQL files", () => {
        beforeAll(() => {
            mkdirSync(join(project, "sql"));
            for (const [name, text] of [
                ["delete.refs", "delete refs/heads/victim\n"],
                ["verify.refs", "verify refs/heads/victim\n"],
                ["drop.sql", "DROP TABLE users;\n"],
                ["sql/main.sql", "\\ir ../drop.sql\n"],
                ["select.sql", "SELECT 1;\n"],
            ] as const) {
                writeFileSync(join(project, name), text);
            }
        });

        it.each([
            ["git update-ref --stdin < delete.refs", "ask"],
            ["cat delete.refs | git update-ref --stdin", "ask"],
            ["cat delete.refs < verify.refs | git update-ref --stdin", "ask"],
            ["cat verify.refs < delete.refs | git update-ref --stdin", undefined],
            ["cat - < delete.refs | git update-ref --stdin", "ask"],
            ["git update-ref --stdin < verify.refs", undefined],
            [
                "printf 'delete refs/heads/victim\\n' > typed.refs; git update-ref --stdin < typed.refs",
                "deny",
            ],
        ])("ref transaction provenance: %s -> %s", async (command, expected) => {
            expect((await runHook(command, project))?.decision).toBe(expected);
        });

        it.each([
            ["sqlite3 db '.read drop.sql'", "ask"],
            ["psql -f sql/main.sql", "ask"],
            ["psql -c '\\i sql/main.sql'", "ask"],
            ["mysql -e 'source drop.sql'", "ask"],
            ["sqlite3 db '.read select.sql'", undefined],
            ["psql -c '\\ir drop.sql'", "ask"],
            ["psql -c '\\ir ../drop.sql'", undefined],
            ["psql < sql/main.sql", undefined],
        ])("included file: %s -> %s", async (command, expected) => {
            expect((await runHook(command, project))?.decision).toBe(expected);
        });

        it.each([
            ["psql -f drop.sql", "ask"],
            ["cat drop.sql | cat | psql", "ask"],
            ["cat select.sql | cat | psql", undefined],
            ["printf 'DROP TABLE users;' > typed.sql; cat typed.sql | cat | psql", "deny"],
            ["psql < drop.sql", "ask"],
            ["cat drop.sql | psql", "ask"],
            ["cat < drop.sql | psql", "ask"],
            ["psql -c 'DROP TABLE users' -f drop.sql", "deny"],
            ["psql -f select.sql", undefined],
            ["printf 'DROP TABLE users;' > typed.sql; psql -f typed.sql", "deny"],
            ["printf 'DROP TABLE users;' > typed.sql; cat typed.sql | psql", "deny"],
        ])("SQL provenance: %s -> %s", async (command, expected) => {
            expect((await runHook(command, project))?.decision).toBe(expected);
        });
    });

    it("names how the command was reached and what to do instead", async () => {
        const verdict = await runHook("bash -c 'git push -f'", project);
        expect(verdict?.reason).toContain("reached via: bash -c");
        expect(verdict?.reason).toContain("⛔ BLOCKED — dangerous-commands [git-push-force]");
        expect(verdict?.reason).toContain("Do not retry it another way");
        expect(verdict?.systemMessage).toBe(
            "dangerous-commands [git-push-force]: force push overwrites remote history",
        );
        const asked = await runHook("./deploy.sh", project);
        expect(asked?.reason).toContain("Confirm with the user — dangerous-commands [git-push-force]");
        expect(asked?.reason).toContain("(not typed as a command in this call");
        expect(asked?.reason).not.toContain("Do not retry it another way");
    });

    it("renders a finding's reason from its parts", async () => {
        const [top] = await findDangers(
            "git push -f && git clean -fdx",
            project,
            hostWith(),
            sourcesWithGitAliases,
        );
        expect(top?.rule.ruleId).toBe("git-push-force");
        const text = buildReason(top as NonNullable<typeof top>);
        expect(text.split("\n")[0]).toBe(
            "⛔ BLOCKED — dangerous-commands [git-push-force]: force push overwrites remote history.",
        );
        expect(text).toContain("    matched: git push --force");
        expect(text).toContain("    command: git push -f");
    });

    it("writes one audit record per decision with the Python payload keys", async () => {
        await runHook("git push -f && git clean -fdx", project, {}, "default");
        const files = readdirSync(logDir).filter((name) => name.endsWith(".jsonl"));
        expect(files.length).toBe(1);
        const records = readFileSync(join(logDir, files[0] as string), "utf-8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const record = records.at(-1) as Record<string, unknown>;
        expect(record.hook).toBe(HOOK_NAME);
        expect(record.outcome).toBe("deny");
        expect(record.rule).toBe("git-push-force");
        expect(record.also).toEqual(["git-clean-force"]);
        expect(record.threshold).toBe("high");
        expect(record.permission_mode).toBe("default");
        expect(Object.keys(record).sort()).toEqual(
            [
                "also",
                "command",
                "cwd",
                "detail",
                "hook",
                "indirect",
                "level",
                "outcome",
                "permission_mode",
                "rule",
                "session_id",
                "threshold",
                "ts",
                "via",
            ].sort(),
        );
    });
});
