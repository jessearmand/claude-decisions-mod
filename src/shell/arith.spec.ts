/**
 * Port of shell_arith_test.py: bash integer arithmetic, checked against bash 5.2.
 * Values are bigint; `undefined` means "not known".
 */

import { describe, expect, it } from "vitest";
import { evaluate } from "./arith.ts";

// (expression, expected value; undefined when not known)
const CASES: ReadonlyArray<readonly [string, bigint | undefined]> = [
    ["1&1", 1n],
    ["1|2", 3n],
    ["2^3", 1n],
    ["1<<4", 16n],
    ["-16>>2", -4n],
    ["~-3", 2n],
    ["!0", 1n],
    ["!5", 0n],
    ["2**10", 1024n],
    ["1?2:3", 2n],
    ["0?2:3", 3n],
    ["1,2", 2n],
    ["(1+2)*3", 9n],
    ["7/-2", -3n],
    ["-7%3", -1n],
    ["0x1f", 31n],
    ["010", 8n],
    ["2#101", 5n],
    ["36#z", 35n],
    ["64#_", 63n],
    ["3>2&&2>3", 0n],
    ["0||4", 1n],
    ["i+1", 2n],
    // Shell syntax, not a template
    ["$i*${n}", 3n],
    ["j", 2n],
    ["e+1", 1n],
    ["$((i+1))", 2n],
    ["9223372036854775807+1", -9223372036854775808n],
    ["x+1", undefined],
    ["i++", undefined],
    ["i=2", undefined],
    ["1/0", undefined],
    ["1+", undefined],
    ["2**-1", undefined],
];
const VARIABLES = new Map([
    ["i", "1"],
    ["n", "3"],
    ["j", "i+1"],
    ["e", ""],
]);
const lookup = (name: string): string | undefined => VARIABLES.get(name);

describe("evaluate", () => {
    it.each(CASES)("%s", (expression, expected) => {
        expect(evaluate(expression, lookup)).toBe(expected);
    });
    it("wraps multiplication and shifts at 64 bits", () => {
        expect(evaluate("4611686018427387904*4", lookup)).toBe(0n);
        expect(evaluate("1<<63", lookup)).toBe(-9223372036854775808n);
        expect(evaluate("1<<64", lookup)).toBe(1n); // the shift count is taken modulo 64
        expect(evaluate("2**64", lookup)).toBe(0n);
        expect(evaluate("3**40", lookup)).toBe(BigInt.asIntN(64, 3n ** 40n));
    });
    it("rejects malformed numbers the way int() does", () => {
        expect(evaluate("09", lookup)).toBeUndefined(); // not octal
        expect(evaluate("2#102", lookup)).toBeUndefined();
        expect(evaluate("1#1", lookup)).toBeUndefined();
        expect(evaluate("0x", lookup)).toBeUndefined();
    });
    it("stops following variables past the depth limit", () => {
        const loop = (name: string): string | undefined => (name === "a" ? "a" : undefined);
        expect(evaluate("a", loop)).toBeUndefined();
    });
    it("treats whitespace-only input as an incomplete expression", () => {
        expect(evaluate("  ", lookup)).toBeUndefined();
        expect(evaluate(" 1 + 1 ", lookup)).toBe(2n);
    });
});
