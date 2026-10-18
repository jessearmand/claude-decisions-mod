/**
 * Replay cc-safety-net's harvested verdict labels through the deterministic
 * guards, in-process, the way scripts/replay_ccsafety.py did for the Python
 * hooks. Nothing is executed and no decision model is called; deferred
 * commands are only checked for model eligibility (the judge's pre-filter).
 *
 * The upstream checkout is not vendored. Clone it at the pinned commit:
 *
 *   git clone https://github.com/kenryu42/cc-safety-net.git scratchpad/cc-safety-net
 *   git -C scratchpad/cc-safety-net checkout 0626be7a791c17a0daa67ae90a899372c667056d
 *
 * Usage:
 *   bun scripts/replay-ccsafety.ts [--upstream PATH] [--out DIR] [--compare PYTHON_REPLAY.jsonl] [--limit N]
 *
 * `--compare` diffs each literal's decision against the Python replay's JSONL
 * (python3 scripts/replay_ccsafety.py in claude-code-rules) and lists the
 * mismatches: the parity check of the port.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { resolveConfig } from "../src/config.ts";
import type { Decision, HookInput } from "../src/decision.ts";
import { configGuard } from "../src/guards/config-guard.ts";
import { dangerousCommands } from "../src/guards/dangerous-commands.ts";
import { sourcesWithGitAliases } from "../src/guards/git-aliases.ts";
import type { Guard, GuardDeps } from "../src/guards/guard.ts";
import { rmRfGuard } from "../src/guards/rm-rf-guard.ts";
import { secretsGuard } from "../src/guards/secrets-guard.ts";
import { nodeHost } from "../src/host/node-host.ts";
import { shouldJudge } from "../src/judge/bash-risk-judge.ts";
import { parse } from "../src/shell/parse.ts";

const FIXTURE = "tests/fixtures/gate/harvested-verdicts.jsonl";
const LABEL_COLUMN = "work/standard";
const LABELS = ["allow", "deny", "fail-closed"] as const;
const GUARDS: ReadonlyArray<readonly [string, Guard]> = [
    ["config", configGuard],
    ["dangerous", dangerousCommands],
    ["rm", rmRfGuard],
    ["secrets", secretsGuard],
];

interface Row {
    readonly index: number;
    readonly upstream: string;
    readonly decision: "deny" | "ask" | "defer";
    readonly verdicts: Record<string, string>;
    readonly model_candidate: boolean;
    readonly errors: Record<string, string>;
}

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function decideOne(
    command: string,
    cwd: string,
    deps: GuardDeps,
): Promise<Omit<Row, "index" | "upstream">> {
    const input: HookInput = { toolName: "Bash", toolInput: { command }, cwd, permissionMode: "default" };
    const verdicts: Record<string, string> = {};
    const errors: Record<string, string> = {};
    for (const [name, guard] of GUARDS) {
        let verdict: Decision | undefined;
        try {
            verdict = await guard.run(input, deps);
        } catch (error) {
            errors[name] = error instanceof Error ? error.constructor.name : String(error);
            continue;
        }
        if (verdict) verdicts[name] = verdict.decision;
    }
    const decisions = Object.values(verdicts);
    const decision = decisions.includes("deny") ? "deny" : decisions.includes("ask") ? "ask" : "defer";
    const routed =
        decision === "defer" && shouldJudge(command, await parse(command, cwd, deps.host, deps.sources));
    return { decision, verdicts, model_candidate: routed, errors };
}

function summarize(rows: readonly Row[]): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const label of LABELS) {
        const selected = rows.filter((row) => row.upstream.split(/\s+/)[0] === label);
        const decisions: Record<string, number> = {};
        for (const row of selected) decisions[row.decision] = (decisions[row.decision] ?? 0) + 1;
        summary[label] = {
            total: selected.length,
            decisions,
            deferred_model_candidates: selected.filter((row) => row.model_candidate).length,
            errors: selected.filter((row) => Object.keys(row.errors).length > 0).length,
        };
    }
    return summary;
}

async function main(): Promise<void> {
    const root = resolvePath(import.meta.dirname, "..");
    const upstream = resolvePath(argument("--upstream") ?? `${root}/scratchpad/cc-safety-net`);
    const out = resolvePath(argument("--out") ?? `${root}/scratchpad`);
    const limit = Number(argument("--limit") ?? Number.POSITIVE_INFINITY);
    const fixture = `${upstream}/${FIXTURE}`;
    let text: string;
    try {
        text = readFileSync(fixture, "utf-8");
    } catch {
        console.error(`missing ${fixture}; clone cc-safety-net as shown in this script's header`);
        process.exit(1);
    }
    const rows = text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .slice(0, limit);
    const cwd = `${out}/corpus-work`;
    mkdirSync(cwd, { recursive: true });
    const host = nodeHost({ env: { ...process.env, HOOKS_LOG_DIR: `${out}/corpus-logs` } });
    const deps: GuardDeps = { host, config: resolveConfig(host), sources: sourcesWithGitAliases };

    const results: Row[] = [];
    const started = Date.now();
    for (const [index, row] of rows.entries()) {
        const result = await decideOne(String(row.literal), cwd, deps);
        results.push({ index, upstream: String(row[LABEL_COLUMN]), ...result });
        if (index % 500 === 499)
            console.error(`${index + 1}/${rows.length} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
    writeFileSync(
        `${out}/cc-safety-net-replay.jsonl`,
        `${results.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const summary = summarize(results);
    writeFileSync(`${out}/cc-safety-net-replay-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary));

    const compare = argument("--compare");
    if (compare) {
        const python = readFileSync(compare, "utf-8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as Row);
        let mismatches = 0;
        for (const row of results) {
            const other = python[row.index];
            if (!other) continue;
            const same =
                other.decision === row.decision &&
                JSON.stringify(other.verdicts) === JSON.stringify(row.verdicts) &&
                other.model_candidate === row.model_candidate;
            if (same) continue;
            mismatches += 1;
            if (mismatches <= 200) {
                console.log(
                    `#${row.index} python=${other.decision} ${JSON.stringify(other.verdicts)} cand=${other.model_candidate} ` +
                        `ts=${row.decision} ${JSON.stringify(row.verdicts)} cand=${row.model_candidate} :: ${JSON.stringify(
                            String(rows[row.index]?.literal).slice(0, 160),
                        )}`,
                );
            }
        }
        console.log(`compared ${results.length} rows against ${compare}: ${mismatches} mismatch(es)`);
        if (mismatches > 0) process.exitCode = 2;
    }
}

await main();
