/**
 * Port of secrets_guard_test.py: every rule case of the corpora plus the hook
 * protocol checks, run in-process through `secretsGuard.run` (the Python test
 * spawned the hook as a subprocess). The one Python check without a port is
 * "bad stdin -> exit 1": there is no stdin here, the hooks module hands the
 * guard a parsed HookInput.
 */

import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.ts";
import type { HookInput } from "../decision.ts";
import { type MemoryHost, memoryHost } from "../host/memory-host.ts";
import { resolve } from "../shell/sources.ts";
import {
    COMMAND_CASES,
    LEVEL_COMMAND_CASES,
    LEVEL_PATH_CASES,
    PATH_CASES,
} from "./__fixtures__/secrets-cases.ts";
import type { GuardDeps } from "./guard.ts";
import {
    checkCommand,
    checkPath,
    DEFAULT_LEVEL,
    evaluate,
    findCommandRule,
    HANDLED_TOOLS,
    isAllowlisted,
    LEVEL_ORDER,
    secretsGuard,
} from "./secrets-guard.ts";
import { ALLOWLIST, EXEMPT_COMMAND_HEADS, SECRET_COMMANDS, SECRET_FILES } from "./secrets-guard-rules.ts";

const CWD = "/home/user/proj";
const LOG_DIR = "/logs/secrets-guard-test-logs";
const level = DEFAULT_LEVEL;

function deps(env: Record<string, string> = {}): GuardDeps & { host: MemoryHost } {
    const host = memoryHost({ home: "/home/user", env: { SECRETS_GUARD_LOG_DIR: LOG_DIR, ...env } });
    return { host, config: resolveConfig(host), sources: resolve };
}

function input(
    toolName: string,
    toolInput: Record<string, unknown>,
    extra: Partial<HookInput> = {},
): HookInput {
    return { toolName, toolInput, cwd: CWD, ...extra };
}

const host = memoryHost({ home: "/home/user" });

describe("rule tables", () => {
    it("compile and keep their ids unique", () => {
        const ids = [...SECRET_FILES, ...SECRET_COMMANDS].map((rule) => rule.ruleId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(SECRET_FILES.length).toBe(36);
        expect(SECRET_COMMANDS.length).toBe(32);
        for (const rule of [...SECRET_FILES, ...SECRET_COMMANDS]) {
            expect(rule.pattern.flags).toBe("im");
            expect(LEVEL_ORDER[rule.level]).toBeGreaterThan(0);
        }
        expect(ALLOWLIST.flags).toBe("im");
        expect(EXEMPT_COMMAND_HEADS.flags).toBe("im");
    });

    it("handles the read, write and Bash tools", () => {
        expect([...HANDLED_TOOLS].sort()).toEqual(
            ["Bash", "Edit", "Glob", "Grep", "MultiEdit", "NotebookEdit", "Read", "Write"].sort(),
        );
    });
});

describe(`paths (level=${level})`, () => {
    it.each(PATH_CASES.map(([path, expected]) => [path, expected] as const))("%s -> %s", (path, expected) => {
        expect(checkPath(path, level)?.ruleId ?? null).toBe(expected);
    });
});

describe("allowlist", () => {
    it.each([".env.example", ".env.sample", "config/.env.template", "example.env", ".env.dist"])(
        "allowlisted: %s",
        (path) => {
            expect(isAllowlisted(path)).toBe(true);
        },
    );
    it.each([".env", ".env.local", ".env.production"])("not allowlisted: %s", (path) => {
        expect(isAllowlisted(path)).toBe(false);
    });
});

describe(`commands (level=${level})`, () => {
    it.each(COMMAND_CASES.map(([command, expected]) => [command, expected] as const))(
        "%j -> %s",
        async (command, expected) => {
            const rule = await checkCommand(command, level, CWD, host);
            expect(rule?.ruleId ?? null).toBe(expected);
        },
    );

    it("finds a secret read in an interpreter string and asks about it", async () => {
        const found = await findCommandRule(
            "python3 -c \"import subprocess; subprocess.run(['echo', 'cat ~/.ssh/id_rsa'])\"",
            level,
            CWD,
            host,
        );
        expect(found?.[0].ruleId).toBe("read-private-key");
        expect(found?.[2]).toBe(true);
    });
});

describe("secret files named in interpreter code (asked about)", () => {
    it.each([
        "python3 -c \"print(open('/home/u/.ssh/id_rsa').read())\"",
        'node -e \'require("fs").readFileSync(process.env.HOME + "/.aws/credentials")\'',
    ])("%s", async (command) => {
        const found = await evaluate("Bash", { command }, level, "/tmp", host);
        expect(found).toBeDefined();
        expect(found?.[2]).toBe(true);
    });

    it("interpreter code without a secret path -> nothing", async () => {
        expect(
            await evaluate("Bash", { command: "python3 -c 'print(1)'" }, level, "/tmp", host),
        ).toBeUndefined();
    });
});

describe("level gating", () => {
    it.each(
        LEVEL_COMMAND_CASES.map(([threshold, command, expected]) => [threshold, command, expected] as const),
    )("[%s] %s -> %s", async (threshold, command, expected) => {
        const rule = await checkCommand(command, threshold, CWD, host);
        expect(rule?.ruleId ?? null).toBe(expected);
    });
    it.each(LEVEL_PATH_CASES.map(([threshold, path, expected]) => [threshold, path, expected] as const))(
        "[%s] %s -> %s",
        (threshold, path, expected) => {
            expect(checkPath(path, threshold)?.ruleId ?? null).toBe(expected);
        },
    );
});

describe("hook protocol", () => {
    it("Read .env -> deny, with the env remediation guidance", async () => {
        const d = deps();
        const out = await secretsGuard.run(input("Read", { file_path: ".env" }), d);
        expect(out?.decision).toBe("deny");
        expect(out?.hook).toBe("secrets-guard");
        expect(out?.reason).toContain("[env-file]");
        expect(out?.reason).toContain(
            "🔐 BLOCKED by secrets-guard [env-file] — cannot read: .env file contains secrets",
        );
        expect(out?.reason).toContain("env-safe");
        expect(out?.systemMessage).toBe("secrets-guard [env-file]: .env file contains secrets");
    });

    // Regression: the originals returned permissionDecision "allow" for every
    // non-matching call, which auto-approves unrelated tool use.
    it.each([
        [input("Read", { file_path: "README.md" }), "Read README.md"],
        [input("Bash", { command: "git status" }), "Bash git status"],
        [input("WebFetch", { url: "https://x.io" }), "unhandled tool"],
        [input("Write", { file_path: "src/lib.rs" }), "Write src/lib.rs"],
        [input("Write", { file_path: "Cargo.lock" }), "Write Cargo.lock"],
    ] as const)("%# %s -> defer (never 'allow')", async (call, _label) => {
        expect(await secretsGuard.run(call, deps())).toBeUndefined();
    });

    it("HOOK_ASK_CRITICAL=true -> ask", async () => {
        const out = await secretsGuard.run(
            input("Bash", { command: "cat .env" }),
            deps({ HOOK_ASK_CRITICAL: "true" }),
        );
        expect(out?.decision).toBe("ask");
        expect(out?.reason).toContain("🔐 Confirm by secrets-guard [read-env]");
    });

    it("the askInsteadOfDeny option -> ask for every tier", async () => {
        const base = deps();
        const options = { ...base, config: resolveConfig(base.host, { askInsteadOfDeny: true }) };
        const read = await secretsGuard.run(input("Read", { file_path: "/home/user/.env" }), options);
        expect(read?.decision).toBe("ask");
        const bash = await secretsGuard.run(input("Bash", { command: "cat .env" }), options);
        expect(bash?.decision).toBe("ask");
        expect(
            (await secretsGuard.run(input("Read", { file_path: "/home/user/.env" }), deps()))?.decision,
        ).toBe("deny");
    });

    it("SECRETS_GUARD_DISABLE=1 -> defer", async () => {
        expect(
            await secretsGuard.run(
                input("Read", { file_path: ".env" }),
                deps({ SECRETS_GUARD_DISABLE: "1" }),
            ),
        ).toBeUndefined();
    });

    it("SECRETS_GUARD_LEVEL=strict escalates coverage", async () => {
        const out = await secretsGuard.run(
            input("Read", { file_path: "config/database.yml" }),
            deps({ SECRETS_GUARD_LEVEL: "strict" }),
        );
        expect(out?.decision).toBe("deny");
        expect(out?.reason).toContain("⚠️ BLOCKED by secrets-guard [database-config]");
    });

    it("NotebookEdit notebook_path is checked", async () => {
        const out = await secretsGuard.run(input("NotebookEdit", { notebook_path: ".env" }), deps());
        expect(out?.decision).toBe("deny");
        expect(out?.reason).toContain("cannot modify");
    });

    it("Grep path is checked", async () => {
        const out = await secretsGuard.run(input("Grep", { pattern: ".", path: ".env" }), deps());
        expect(out?.decision).toBe("deny");
        expect(out?.reason).toContain("cannot search");
    });

    it("a secret access found only in a file the command runs -> ask", async () => {
        const d = deps();
        d.host.writeFile(`${CWD}/show.sh`, "#!/bin/sh\ncat .env\n");
        const out = await secretsGuard.run(input("Bash", { command: "bash show.sh" }), d);
        expect(out?.decision).toBe("ask");
        expect(out?.reason).toContain("Confirm by secrets-guard [read-env]");
    });

    // A long word (an inline base64 blob) is checked well inside the hook timeout (live-session review).
    it("a 80 kB word is checked quickly", async () => {
        const started = performance.now();
        const out = await secretsGuard.run(
            input("Bash", { command: `echo ${"QUJD".repeat(20_000)} | wc -c` }),
            deps(),
        );
        expect(out).toBeUndefined();
        expect(performance.now() - started).toBeLessThan(5000);
    });

    it("writes a JSONL audit log with the Python payload keys", async () => {
        const d = deps();
        await secretsGuard.run(
            input("Bash", { command: "cat .env" }, { sessionId: "s1", permissionMode: "default" }),
            d,
        );
        const [logPath, line] = (d.host.appended[0] ?? "").split("\n");
        expect(logPath).toMatch(new RegExp(`^${LOG_DIR}/\\d{4}-\\d{2}-\\d{2}\\.jsonl$`));
        expect(JSON.parse(line ?? "")).toMatchObject({
            hook: "secrets-guard",
            outcome: "deny",
            rule: "read-env",
            level: "critical",
            tool: "Bash",
            target: "cat .env",
            threshold: "high",
            indirect: false,
            session_id: "s1",
            cwd: CWD,
            permission_mode: "default",
        });
    });
});
