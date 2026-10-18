/**
 * Parity with shell_printf.printed_text (scripts/parity/gen-printf-fixture.py),
 * plus the docstring examples.
 */

import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/printf-parity.json" with { type: "json" };
import { printedText } from "./printf.ts";

interface PrintfCase {
    name: string;
    args: string[];
    xpgEcho: boolean;
    printed: string | null;
}

const cases = fixture as PrintfCase[];

describe("printedText parity with shell_printf.py", () => {
    it.each(cases.map((c) => [c.name, c.args, c.xpgEcho, c] as const))(
        "%s %j (xpg_echo %s)",
        (name, args, xpgEcho, expected) => {
            expect(printedText(name, args, xpgEcho) ?? null).toBe(expected.printed);
        },
    );
});

describe("printedText", () => {
    it("prints rm from octal and %b hex escapes", () => {
        expect(printedText("printf", ["\\162\\155"])).toBe("rm");
        expect(printedText("printf", ["%b", "\\x72m"])).toBe("rm");
        expect(printedText("echo", ["-n", "r"])).toBe("r");
        expect(printedText("echo", ["r"])).toBe("r\n");
    });
    it("does not model widths and precisions", () => {
        expect(printedText("printf", ["%5.2f", "1"])).toBeUndefined();
        expect(printedText("printf", ["%q", "a\x01b"])).toBeUndefined();
    });
    it("expands echo escapes only with xpg_echo or -e", () => {
        expect(printedText("echo", ["\\0162"])).toBe("\\0162\n");
        expect(printedText("echo", ["\\0162"], true)).toBe("r\n");
        expect(printedText("echo", ["-E", "\\0162"], true)).toBe("\\0162\n");
    });
    it("knows nothing about other programs", () => {
        expect(printedText("cat", ["x"])).toBeUndefined();
    });
});
