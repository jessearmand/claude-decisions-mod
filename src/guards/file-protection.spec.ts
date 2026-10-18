/**
 * Port of file_protection_test.py: the path corpus plus the hook protocol
 * checks, run in-process through `fileProtection.run` (the Python test spawned
 * the hook as a subprocess). "bad stdin -> exit 1" has no port: there is no
 * stdin here, the hooks module hands the guard a parsed HookInput.
 */

import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.ts";
import type { HookInput } from "../decision.ts";
import { type MemoryHost, memoryHost } from "../host/memory-host.ts";
import { PATH_CASES } from "./__fixtures__/file-protection-cases.ts";
import { checkPath, fileProtection, PROTECTED_FILES } from "./file-protection.ts";
import type { GuardDeps } from "./guard.ts";

const CWD = "/home/user/proj";
const LOG_DIR = "/logs/file-protection-test-logs";

function deps(env: Record<string, string> = {}): GuardDeps & { host: MemoryHost } {
    const host = memoryHost({ home: "/home/user", env: { FILE_PROTECTION_LOG_DIR: LOG_DIR, ...env } });
    return { host, config: resolveConfig(host), sources: async () => [] };
}

function input(
    toolName: string,
    toolInput: Record<string, unknown>,
    extra: Partial<HookInput> = {},
): HookInput {
    return { toolName, toolInput, cwd: CWD, ...extra };
}

describe("rule table", () => {
    it("keeps its ids unique and its patterns case-insensitive", () => {
        const ids = PROTECTED_FILES.map((rule) => rule.ruleId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(PROTECTED_FILES.length).toBe(19);
        for (const rule of PROTECTED_FILES) expect(rule.pattern.flags).toBe("i");
    });
});

describe("paths", () => {
    it.each(PATH_CASES.map(([path, expected]) => [path, expected] as const))("%s -> %s", (path, expected) => {
        expect(checkPath(path)?.ruleId ?? null).toBe(expected);
    });
});

describe("hook protocol", () => {
    it.each(["Write", "Edit", "MultiEdit"])("%s uv.lock -> deny", async (tool) => {
        const out = await fileProtection.run(input(tool, { file_path: "uv.lock" }), deps());
        expect(out?.decision).toBe("deny");
        expect(out?.hook).toBe("file-protection");
        expect(out?.reason).toContain("📦 BLOCKED by file-protection [uv-lock]");
    });

    it("denial names the right regeneration command", async () => {
        const out = await fileProtection.run(input("Write", { file_path: "poetry.lock" }), deps());
        expect(out?.reason).toContain("poetry lock");
        expect(out?.reason).toContain("cannot write: lockfile is generated and carries integrity hashes.");
        expect(out?.reason).toContain("Regenerate it with poetry instead:");
        expect(out?.systemMessage).toBe(
            "file-protection [poetry-lock]: lockfile is generated and carries integrity hashes",
        );
    });

    it("deno.lock -> `deno install`", async () => {
        const out = await fileProtection.run(input("Write", { file_path: "deno.lock" }), deps());
        expect(out?.reason).toContain("deno install");
    });

    // Reads must pass through: inspecting a resolved version is normal.
    it.each([
        [input("Read", { file_path: "package-lock.json" }), "Read package-lock.json"],
        [input("Read", { file_path: "Cargo.lock" }), "Read Cargo.lock"],
        [input("Grep", { path: "yarn.lock" }), "Grep yarn.lock"],
        [input("Bash", { command: "cat go.sum" }), "Bash cat go.sum"],
        [input("Write", { file_path: "Cargo.toml" }), "Write Cargo.toml"],
        [input("Write", { file_path: ".env" }), "Write .env (secrets hook's job)"],
    ] as const)("%# %s -> defer (never 'allow')", async (call, _label) => {
        expect(await fileProtection.run(call, deps())).toBeUndefined();
    });

    it("NotebookEdit notebook_path is checked", async () => {
        const out = await fileProtection.run(
            input("NotebookEdit", { notebook_path: "node_modules/x/a.ipynb" }),
            deps(),
        );
        expect(out?.decision).toBe("deny");
        expect(out?.reason).toContain("[node-modules] — cannot modify");
    });

    it("FILE_PROTECTION_ASK=true -> ask", async () => {
        const out = await fileProtection.run(
            input("Write", { file_path: "uv.lock" }),
            deps({ FILE_PROTECTION_ASK: "true" }),
        );
        expect(out?.decision).toBe("ask");
    });

    it("FILE_PROTECTION_DISABLE=1 -> defer", async () => {
        expect(
            await fileProtection.run(
                input("Write", { file_path: "uv.lock" }),
                deps({ FILE_PROTECTION_DISABLE: "1" }),
            ),
        ).toBeUndefined();
    });

    it("writes a JSONL audit log with the Python payload keys", async () => {
        const d = deps();
        await fileProtection.run(
            input("Write", { file_path: "uv.lock" }, { sessionId: "s1", permissionMode: "default" }),
            d,
        );
        const [logPath, line] = (d.host.appended[0] ?? "").split("\n");
        expect(logPath).toMatch(new RegExp(`^${LOG_DIR}/\\d{4}-\\d{2}-\\d{2}\\.jsonl$`));
        expect(JSON.parse(line ?? "")).toMatchObject({
            hook: "file-protection",
            outcome: "deny",
            rule: "uv-lock",
            ecosystem: "uv",
            tool: "Write",
            target: "uv.lock",
            session_id: "s1",
            cwd: CWD,
            permission_mode: "default",
        });
    });
});
