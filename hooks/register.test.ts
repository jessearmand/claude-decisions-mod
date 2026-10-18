/**
 * The hooks module against the engine's own test kit (`claude plugin test .`).
 *
 * `$.tool.call` raises `classic.PreToolUse` beneath the plugin's hook: a deny
 * ends the call with an errored result the test reads; an ask, a pass or an
 * allow goes on to the test's own `tool.call` hook, which stands for the tool.
 */

import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";

const BASH_RESULT = { stdout: "", stderr: "", interrupted: false };

type Seen = { reached: boolean };

function stand(on: On): Seen {
    const seen: Seen = { reached: false };
    on("tool.call", { tool: "Bash" }, async () => {
        seen.reached = true;
        return { result: BASH_RESULT };
    });
    on("tool.call", { tool: "Read" }, async () => {
        seen.reached = true;
        return {
            result: {
                type: "text",
                file: { filePath: "x", content: "", numLines: 0, startLine: 1, totalLines: 0 },
            },
        };
    });
    return seen;
}

test("denies reading a .env file through the secrets guard", async ($, on) => {
    const seen = stand(on);
    const result = await $.tool.call({ tool: "Read", file_path: "/home/u/proj/.env" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("secrets-guard");
    expect(seen.reached).toBe(false);
});

test("denies a destructive git command", async ($, on) => {
    const seen = stand(on);
    const result = await $.tool.call({ tool: "Bash", command: "git reset --hard HEAD~3" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("dangerous-commands");
    expect(seen.reached).toBe(false);
});

test("denies editing the agent's own settings", async ($, on) => {
    const seen = stand(on);
    const result = await $.tool.call({
        tool: "Write",
        file_path: "/home/u/.claude/settings.json",
        content: "{}",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("config-guard");
    expect(seen.reached).toBe(false);
});

test("denies hand-editing a lockfile", async ($, on) => {
    const seen = stand(on);
    const result = await $.tool.call({
        tool: "Edit",
        file_path: "package-lock.json",
        old_string: "a",
        new_string: "b",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("file-protection");
    expect(seen.reached).toBe(false);
});

test("asks before rm -rf, which reaches the tool once answered", async ($, on) => {
    const seen = stand(on);
    const result = await $.tool.call({ tool: "Bash", command: "rm -rf build" });
    // An ask goes on to the mode's decider; in the kit that is the test's own hook.
    expect(result.deny).toBeUndefined();
    expect(seen.reached).toBe(true);
});

test("lets an ordinary command through", async ($, on) => {
    const seen = stand(on);
    const result = await $.tool.call({ tool: "Bash", command: "git status" });
    expect(result.isError).toBeUndefined();
    expect(seen.reached).toBe(true);
});

test("steers grep to ripgrep", async ($, on) => {
    const seen = stand(on);
    const result = await $.tool.call({ tool: "Bash", command: "grep foo file.txt" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("rg");
    expect(seen.reached).toBe(false);
});
