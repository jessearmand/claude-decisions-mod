import { describe, expect, it } from "vitest";
import { expand, parseTimeCommands, parseTimeWrites, unescapeMake, variables } from "./make-expand.ts";

/** Make's `${NAME}` spelling, kept out of string literals so no template placeholder is suspected. */
const braced = (inner: string) => `$\{${inner}}`;

/** The recipe lines of a Makefile, expanded through its variable table. */
function recipes(text: string): string[] {
    const table = variables(text);
    return text
        .split("\n")
        .filter((line) => line.startsWith("\t"))
        .map((line) => expand(line.slice(1), table));
}

// The Makefiles rm_rf_guard_test.py's "make expansion" cases write (expected values from python3).
const EXPANSIONS = {
    shell: "X := $(shell rm -rf victim)\nall:\n\t@echo hi\n",
    braces: `X = ${braced("shell rm -rf victim")}\nall:\n\t@echo hi\n`,
    bang: "X != rm -rf victim\nall:\n\t@echo hi\n",
    conditional: "ifeq ($(shell rm -rf victim),)\nendif\nall:\n\t@echo hi\n",
    variable: "CLEAN = rm -rf\nTARGET := victim\nall:\n\t$(CLEAN) $(TARGET)\n",
    nested: "A = $(B)\nB = rm -rf victim\nall:\n\t$(A)\n",
    appended: `FLAGS = -r\nFLAGS += -f\nall:\n\trm ${braced("FLAGS")} victim\n`,
    "recipe-shell": "all:\n\techo $(shell rm -rf victim)\n",
    escaped: "all:\n\techo $$(shell rm -rf victim) $(UNSET)\n",
    "safe-shell": "REV := $(shell git rev-parse HEAD)\nall:\n\techo $(REV)\n",
};

describe("variables", () => {
    it("reads every assignment operator, override/export, comments and continuations", () => {
        const text =
            "override X = a # comment\nexport Y := b\\\n  c\nZ ?= 1\nZ ?= 2\nW !=  echo hi\nV = x\\#y\n";
        expect(Object.fromEntries(variables(text))).toEqual({
            X: "a",
            Y: "b   c",
            Z: "1",
            W: "",
            V: "x\\#y",
        });
    });
    it("appends with += and skips recipe lines", () => {
        expect(Object.fromEntries(variables(EXPANSIONS.appended))).toEqual({ FLAGS: "-r -f" });
        expect(Object.fromEntries(variables(EXPANSIONS.variable))).toEqual({
            CLEAN: "rm -rf",
            TARGET: "victim",
        });
        expect(Object.fromEntries(variables("all:\n\tX = 1\n"))).toEqual({});
    });
});

describe("expand", () => {
    const table = new Map([
        ["A", "$(B)"],
        ["B", "rm"],
        ["C", "$(C)"],
    ]);
    it.each([
        ["$(A) -rf", "rm -rf"],
        [braced("A"), "rm"],
        ["$$A", "$$A"],
        ["$(C)", "$(C)"], // a self-reference stops at MAX_DEPTH
        ["$(shell $(A) x)", "$(rm x)"],
        ["$(UNKNOWN)", "$(UNKNOWN)"],
        ["$", "$"],
        ["a$", "a$"],
        ["$(A", "$(A"],
        ["$(shell  echo  )", "$(echo)"],
    ])("expand(%j) is %j", (text, expected) => {
        expect(expand(text, table)).toBe(expected);
    });
    it.each([
        ["variable", ["rm -rf victim"]],
        ["nested", ["rm -rf victim"]],
        ["appended", ["rm -r -f victim"]],
        ["recipe-shell", ["echo $(rm -rf victim)"]],
        ["escaped", ["echo $$(shell rm -rf victim) $(UNSET)"]],
        ["safe-shell", ["echo $(git rev-parse HEAD)"]],
    ] as const)("expands the recipes of the %s Makefile", (name, expected) => {
        expect(recipes(EXPANSIONS[name])).toEqual(expected);
    });
});

describe("unescapeMake", () => {
    it("turns $$ into $", () => {
        expect(unescapeMake("$$HOME")).toBe("$HOME");
        expect(unescapeMake("$$$$")).toBe("$$");
        expect(unescapeMake("$x")).toBe("$x");
    });
});

describe("parseTimeCommands", () => {
    it.each([
        ["shell", ["rm -rf victim"]],
        ["braces", ["rm -rf victim"]],
        ["bang", ["rm -rf victim"]],
        ["conditional", ["rm -rf victim"]],
        ["recipe-shell", []], // inside a recipe: the parser sees it as $(...)
        ["escaped", []],
        ["safe-shell", ["git rev-parse HEAD"]],
    ] as const)("finds what Make runs while reading the %s Makefile", (name, expected) => {
        expect(parseTimeCommands(EXPANSIONS[name])).toEqual(expected);
    });
    it("expands and unescapes a != value and tolerates an unterminated call", () => {
        expect(parseTimeCommands("W !=  echo hi\n")).toEqual(["echo hi"]);
        expect(parseTimeCommands("X = $(shell echo hi\nall:\n\t$(X\n")).toEqual(["echo hi"]);
        expect(parseTimeCommands("# $(shell rm -rf x)\n")).toEqual([]);
    });
});

describe("parseTimeWrites", () => {
    it.each([
        ["$(file >.claude/settings.json,evil)\nall:\n\t@echo hi\n", [": > .claude/settings.json"]],
        [
            "OUT = .claude/settings.json\nall:\n\t$(file >>$(OUT),evil)\n\t@echo hi\n",
            [": >> .claude/settings.json"],
        ],
        [
            "OUT = notes.txt\n$(file >>$(OUT),x)\n$(file <input.txt)\nall:\n\t@echo $$(file >x)\n",
            [": >> notes.txt"],
        ],
        ["$(file >my file.txt,x)\n", [": > 'my file.txt'"]],
    ])("lists the files $(file) writes in %j", (text, expected) => {
        expect(parseTimeWrites(text)).toEqual(expected);
    });
});
