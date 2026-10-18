/**
 * Parity with the Python parser: every command string of the guard test
 * corpora, parsed by `shell_parse.parse(command, "/home/u/proj")` with no
 * source resolver and recorded by scripts/parity/gen-parse-fixture.py, must
 * come out of the TypeScript `parse` with the same commands, nested sources,
 * links and flags.
 *
 * Both sides see an empty project: the Python run probes the real disk at
 * /home/u/proj (which does not exist) and the TypeScript run a memory host
 * with the same home, so `cd` targets, globs and `< file` reads agree. The
 * one real path the corpora glob is `/bin/r[m]`, which matched /bin/rm on the
 * generating machine; the memory host carries that file so the glob resolves
 * the same way here. Regenerate the fixture after a change to the Python hooks:
 *
 *   python3 scripts/parity/gen-parse-fixture.py /path/to/claude-code-rules/hooks
 */

import { describe, expect, it } from "vitest";
import { memoryHost } from "../host/memory-host.ts";
import fixture from "./__fixtures__/parse-parity.json";
import { type ParseResult, parse } from "./parse.ts";

interface RedirectSummary {
    readonly op: string;
    readonly target: string;
    readonly dynamic: boolean;
    readonly fd: number | null;
}

interface CommandSummary {
    readonly argv: readonly string[];
    readonly via: readonly string[];
    readonly wrappers: readonly string[];
    readonly dynamicHead: boolean;
    readonly indirect: boolean;
    readonly pipeline: number;
    readonly stage: number;
    readonly cwd: string | null;
    readonly cwdOptions: ReadonlyArray<string | null>;
    readonly redirects: readonly RedirectSummary[];
}

interface Summary {
    readonly commands: readonly CommandSummary[];
    readonly nestedSources: ReadonlyArray<{ text: string; via: readonly string[]; indirect: boolean }>;
    readonly links: Readonly<Record<string, string>>;
    readonly unparseable: boolean;
    readonly truncated: boolean;
}

interface Fixture {
    readonly cwd: string;
    readonly home: string;
    readonly cases: ReadonlyArray<{ command: string; expected: Summary }>;
}

// The JSON import is typed from its literal shape; the fixture interface names what the test reads.
const data = fixture as unknown as Fixture;

function summarize(result: ParseResult): Summary {
    return {
        commands: result.commands.map((c) => ({
            argv: [...c.argv],
            via: [...c.via],
            wrappers: [...c.wrappers],
            dynamicHead: c.dynamicHead,
            indirect: c.indirect,
            pipeline: c.pipeline,
            stage: c.stage,
            cwd: c.cwd,
            cwdOptions: [...c.cwdOptions],
            redirects: c.redirects.map((r) => ({
                op: r.op,
                target: r.target,
                dynamic: r.dynamic,
                fd: r.fd ?? null,
            })),
        })),
        nestedSources: result.nestedSources.map((s) => ({
            text: s.text,
            via: [...s.via],
            indirect: s.indirect,
        })),
        links: Object.fromEntries(result.links),
        unparseable: result.unparseable,
        truncated: result.truncated,
    };
}

describe("parse parity with the Python parser", () => {
    // `/bin/rm` exists where the fixture was generated: `/bin/r[m]` globs to it on both sides.
    const host = memoryHost({ home: data.home, files: { "/bin/rm": "" } });
    it.each(data.cases.map((c) => [c.command, c.expected] as const))("%j", async (command, expected) => {
        const actual = summarize(await parse(command, data.cwd, host));
        expect(actual).toEqual(expected);
    });
});
