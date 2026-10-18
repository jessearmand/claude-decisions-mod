/**
 * Parity with shell_params.apply (scripts/parity/gen-params-fixture.py), plus
 * the docstring examples.
 */

import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/params-parity.json" with { type: "json" };
import { apply } from "./params.ts";

interface ParamsCase {
    value: string;
    operator: string;
    extglob: boolean;
    result: string | null;
}

const cases = fixture as ParamsCase[];

describe("apply parity with shell_params.py", () => {
    it.each(cases.map((c) => [c.value, c.operator, c.extglob, c] as const))(
        "apply(%j, %j) (extglob %s)",
        (value, operator, extglob, expected) => {
            expect(apply(value, operator, extglob) ?? null).toBe(expected.result);
        },
    );
});

describe("apply", () => {
    it("computes the docstring examples", () => {
        expect(apply("rm", ":0:2")).toBe("rm");
        expect(apply("~/.claude/x.bak", "%.bak")).toBe("~/.claude/x");
        expect(apply("RM", ",,")).toBe("rm");
        expect(apply("rmdir", "%dir")).toBe("rm");
        expect(apply("CMD", "@L")).toBe("cmd");
        expect(apply("it's", "@Q")).toBe("'it'\\''s'");
        expect(apply("\\x72m", "@E")).toBe("rm");
    });
    it("answers undefined for operators it cannot compute", () => {
        expect(apply("x", "@P")).toBeUndefined();
        expect(apply("x", "!y")).toBeUndefined();
        expect(apply("rM", "/!(r)/m", true)).toBeUndefined(); // extglob !( ) is not modelled
        expect(apply("rM", "/!(r)/m")).toBe("rM"); // without extglob, `!(r)` is literal text
    });
    it("honours patsub_replacement's & in replacements", () => {
        expect(apply("abc", "/b/[&]")).toBe("a[b]c");
        expect(apply("abc", "/b/\\&")).toBe("a&c");
        expect(apply("abc", "/b/'&'")).toBe("a&c");
    });
});
