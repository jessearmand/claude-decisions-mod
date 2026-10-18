/** The `_context_tests` of bash_risk_judge_test.py, adapted to the transcript reader. */

import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.ts";
import type { HookInput } from "../decision.ts";
import type { Transcript, TranscriptReader } from "../guards/guard.ts";
import { memoryHost } from "../host/memory-host.ts";
import {
    clip,
    emptyContext,
    gather,
    type LabelledSource,
    PROMPT_LIMIT,
    RECENT_COMMAND_LIMIT,
    RECENT_COMMANDS,
    render,
    SOURCE_LIMIT,
} from "./context.ts";
import { REDACTED, redact } from "./redact.ts";

const PLACEHOLDER = "z".repeat(12);
const INPUT: HookInput = { toolName: "Bash", toolInput: { command: "git clean -xdf" }, cwd: "/work" };
const COMMAND = "git clean -xdf";

function configFor(env: Record<string, string> = {}) {
    return resolveConfig(memoryHost({ env: { HOOK_JEV_ENABLE: "1", ...env } }));
}

function reader(transcript: Transcript | undefined): TranscriptReader {
    return async () => transcript;
}

const SESSION: Transcript = {
    latestPrompt: "Bump the version in pyproject.toml",
    recentBashCommands: ["git status", COMMAND],
};

describe("gather", () => {
    it("carries the task and the recent commands, skipping the command being judged", async () => {
        const context = await gather(INPUT, COMMAND, [], redact, configFor(), reader(SESSION));
        expect(context.task).toBe("Bump the version in pyproject.toml");
        expect(context.recentCommands).toEqual(["git status"]);
        expect(context.sources).toEqual([]);
        expect(context.truncated).toBe(false);
        const state = render(context, "/work", COMMAND);
        expect(state).toContain("Bump the version");
        expect(state).toContain("$ git status");
    });

    it("sends the command alone when BASH_RISK_JUDGE_CONTEXT=0, without reading the transcript", async () => {
        let reads = 0;
        const counting: TranscriptReader = async () => {
            reads += 1;
            return SESSION;
        };
        const config = configFor({ BASH_RISK_JUDGE_CONTEXT: "0" });
        const sources: LabelledSource[] = [["script ./deploy.sh", "rsync -a dist/ prod:/srv/app/\n"]];
        const context = await gather(INPUT, COMMAND, sources, redact, config, counting);
        expect(context).toEqual(emptyContext());
        expect(reads).toBe(0);
        expect(render(context, "/work", COMMAND)).toBe("cwd: /work\ncommand:\ngit clean -xdf\n");
    });

    it("works without a reader", async () => {
        const context = await gather(INPUT, COMMAND, [], redact, configFor());
        expect(context).toEqual(emptyContext());
    });

    it("leaves the context empty when the reader fails or answers nothing", async () => {
        const failing: TranscriptReader = async () => {
            throw new Error("session gone");
        };
        expect(await gather(INPUT, COMMAND, [], redact, configFor(), failing)).toEqual(emptyContext());
        expect(await gather(INPUT, COMMAND, [], redact, configFor(), reader(undefined))).toEqual(
            emptyContext(),
        );
    });

    it("redacts the user's prompt like the command", async () => {
        const transcript: Transcript = {
            latestPrompt: "token=hunter2hunter2 please",
            recentBashCommands: [],
        };
        const context = await gather(INPUT, COMMAND, [], redact, configFor(), reader(transcript));
        expect(render(context, "/work", COMMAND)).not.toContain("hunter2");
        expect(context.task).toContain(REDACTED);
    });

    it("redacts no-space prose secrets in the prompt and keeps a PASSWORD_FILE path", async () => {
        const transcript: Transcript = {
            latestPrompt: "Here is my password=correct horse battery staple\nPASSWORD_FILE=/path",
            recentBashCommands: [],
        };
        const context = await gather(INPUT, COMMAND, [], redact, configFor(), reader(transcript));
        const state = render(context, "/work", COMMAND);
        for (const word of ["correct", "horse", "battery", "staple"]) expect(state).not.toContain(word);
        expect(state).toContain("PASSWORD_FILE=/path");
    });

    it("redacts a PAT in the prompt and a webhook URL in an earlier command", async () => {
        const transcript: Transcript = {
            latestPrompt: `Use GITHUB_PAT=${PLACEHOLDER}pat1 for the API`,
            recentBashCommands: [
                `export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T0/B0/${PLACEHOLDER}hook`,
            ],
        };
        const context = await gather(INPUT, COMMAND, [], redact, configFor(), reader(transcript));
        const state = render(context, "/work", COMMAND);
        expect(state).not.toContain(`${PLACEHOLDER}pat1`);
        expect(state).not.toContain(`${PLACEHOLDER}hook`);
        expect(state.split(REDACTED).length - 1).toBeGreaterThanOrEqual(2);
    });

    it("ignores a prompt the engine injected rather than the user typed", async () => {
        for (const prefix of [
            "[Request interrupted",
            "<command-name>",
            "<local-command-stdout>",
            "  <system-reminder>",
            "Caveat: x",
        ]) {
            const transcript: Transcript = { latestPrompt: `${prefix} rest`, recentBashCommands: [] };
            const context = await gather(INPUT, COMMAND, [], redact, configFor(), reader(transcript));
            expect(context.task).toBeUndefined();
        }
    });

    it("drops a blank prompt", async () => {
        const transcript: Transcript = { latestPrompt: "  \n", recentBashCommands: [] };
        const context = await gather(INPUT, COMMAND, [], redact, configFor(), reader(transcript));
        expect(context.task).toBeUndefined();
    });

    it("clips the prompt and each recent command, keeping only the newest commands", async () => {
        const transcript: Transcript = {
            latestPrompt: `  ${"p".repeat(PROMPT_LIMIT + 10)}  `,
            recentBashCommands: ["c0", "c1", "c2", "c3", "c4", "c5", "x".repeat(RECENT_COMMAND_LIMIT + 1)],
        };
        const context = await gather(INPUT, COMMAND, [], redact, configFor(), reader(transcript));
        expect(context.task).toBe(`${"p".repeat(PROMPT_LIMIT)}\n[... truncated]`);
        expect(context.recentCommands).toHaveLength(RECENT_COMMANDS);
        expect(context.recentCommands[0]).toBe("c2");
        expect(context.recentCommands[4]).toBe(`${"x".repeat(RECENT_COMMAND_LIMIT)}\n[... truncated]`);
        expect(context.truncated).toBe(false); // only program text sets the flag
    });

    it("keeps script bodies inside the source budget and flags what was cut", async () => {
        const small: LabelledSource = ["script ./deploy.sh", "#!/bin/sh\nrsync -a dist/ prod:/srv/app/\n"];
        const one = await gather(INPUT, "./deploy.sh", [small], redact, configFor());
        expect(one.sources).toEqual([small]);
        expect(one.truncated).toBe(false);
        expect(render(one, "/work", "./deploy.sh")).toContain(
            "this command executes (script ./deploy.sh):\n#!/bin/sh\nrsync -a dist/",
        );

        const big: LabelledSource = ["script ./big.sh", "echo filler line\n".repeat(900)];
        const cut = await gather(INPUT, "./big.sh", [big], redact, configFor());
        expect(cut.truncated).toBe(true);
        expect(cut.sources[0]?.[1]).toBe(
            `${"echo filler line\n".repeat(900).slice(0, SOURCE_LIMIT)}\n[... truncated]`,
        );

        const exact: LabelledSource = ["script ./a.sh", "a".repeat(SOURCE_LIMIT)];
        const spent = await gather(INPUT, "./a.sh", [exact, small], redact, configFor());
        expect(spent.sources).toHaveLength(1); // the budget was spent before the second source
        expect(spent.truncated).toBe(true);
    });

    it("redacts secrets inside program text", async () => {
        const source: LabelledSource = ["script ./run.sh", `export API_KEY=${PLACEHOLDER}\n./app\n`];
        const context = await gather(INPUT, "./run.sh", [source], redact, configFor());
        expect(context.sources[0]?.[1]).toBe(`export API_KEY=${REDACTED}\n./app\n`);
    });
});

describe("render", () => {
    it("lays the state out exactly as the Python hook did", () => {
        const context = {
            task: "Bump the version",
            recentCommands: ["git status", "git diff"],
            sources: [["script ./deploy.sh", "rsync -a dist/ prod:/srv/app/\n"]] as LabelledSource[],
            truncated: false,
        };
        expect(render(context, "/work", "./deploy.sh")).toBe(
            "user's latest request:\nBump the version\n\n" +
                "commands the agent ran just before this one:\n$ git status\n$ git diff\n\n" +
                "cwd: /work\ncommand:\n./deploy.sh\n\n" +
                "this command executes (script ./deploy.sh):\nrsync -a dist/ prod:/srv/app/\n\n",
        );
    });

    it("renders the command alone for an empty context", () => {
        expect(render(emptyContext(), "/work", "rm -rf build")).toBe("cwd: /work\ncommand:\nrm -rf build\n");
    });
});

describe("clip", () => {
    it("marks what it cut", () => {
        expect(clip("abc", 3)).toEqual(["abc", false]);
        expect(clip("abcd", 3)).toEqual(["abc\n[... truncated]", true]);
    });
});
