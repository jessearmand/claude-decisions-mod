/**
 * Parity with shell_interpreters.py (scripts/parity/gen-interpreters-fixture.py):
 * the literal scanners over one-liners and every corpus command, inline program
 * detection over argument lists, heredoc/herestring programs and awk commands.
 */

import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/interpreters-parity.json" with { type: "json" };
import {
    awkCommands,
    directShellStrings,
    inlinePrograms,
    interpreterKind,
    shellStrings,
    stringLiterals,
} from "./interpreters.ts";
import { redirect } from "./model.ts";

interface InterpretersFixture {
    programs: Array<{
        program: string;
        shellStrings: string[];
        stringLiterals: string[];
        directShellStrings: Record<string, string[]>;
    }>;
    argv: Array<{ name: string; args: string[]; kind: string | null; programs: string[]; awk?: string[] }>;
    redirects: Array<{
        redirects: Array<{ op: string; target: string; body: string | null }>;
        programs: string[];
    }>;
    awk: Array<{ name: string; args: string[]; commands: string[] }>;
}

const data = fixture as InterpretersFixture;

describe("literal scanners parity with shell_interpreters.py", () => {
    it.each(data.programs.map((c) => [c.program, c] as const))("%j", (program, expected) => {
        expect(shellStrings(program)).toEqual(expected.shellStrings);
        expect(stringLiterals(program)).toEqual(expected.stringLiterals);
        for (const [kind, direct] of Object.entries(expected.directShellStrings)) {
            expect(directShellStrings(program, kind === "None" ? undefined : kind)).toEqual(direct);
        }
    });
});

describe("inlinePrograms and interpreterKind parity", () => {
    it.each(data.argv.map((c) => [c.name, c.args, c] as const))("%s %j", (name, args, expected) => {
        expect(interpreterKind(name) ?? null).toBe(expected.kind);
        expect(inlinePrograms(name, args)).toEqual(expected.programs);
        if (expected.awk !== undefined) expect(awkCommands(name, args)).toEqual(expected.awk);
    });
    it.each(data.redirects.map((c) => [c.redirects, c.programs] as const))(
        "python3 -c x with redirects %j",
        (redirects, expected) => {
            const converted = redirects.map((r) => redirect(r.op, r.target, false, r.body ?? undefined));
            expect(inlinePrograms("python3", ["-c", "x"], converted)).toEqual(expected);
        },
    );
});

describe("awkCommands parity", () => {
    it.each(data.awk.map((c) => [c.name, c.args, c.commands] as const))("%s %j", (name, args, expected) => {
        expect(awkCommands(name, args)).toEqual(expected);
    });
});

describe("interpreterKind", () => {
    it("recognises every python spelling", () => {
        expect(interpreterKind("python")).toBe("python");
        expect(interpreterKind("python3")).toBe("python");
        expect(interpreterKind("python3.12")).toBe("python");
        expect(interpreterKind("pythonw")).toBeUndefined();
        expect(interpreterKind("node")).toBe("node");
        expect(interpreterKind("bash")).toBeUndefined();
    });
});
