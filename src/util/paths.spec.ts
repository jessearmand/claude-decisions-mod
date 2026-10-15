import { describe, expect, it } from "vitest";
import { abspath, basename, dirname, expanduser, isInside, join, normpath } from "./paths.ts";

describe("normpath", () => {
    it.each([
        ["", "."],
        ["/", "/"],
        ["/a//b/./c/..", "/a/b"],
        ["a/../..", ".."],
        ["/..", "/"],
        ["./x/", "x"],
        ["//x", "//x"],
    ])("normpath(%j) is %j", (input, expected) => {
        expect(normpath(input)).toBe(expected);
    });
});

describe("join, dirname, basename", () => {
    it("joins like os.path.join", () => {
        expect(join("/a", "b")).toBe("/a/b");
        expect(join("/a/", "b")).toBe("/a/b");
        expect(join("a", "/b")).toBe("/b");
        expect(join("", "b")).toBe("b");
    });
    it("splits like os.path", () => {
        expect(dirname("/a/b/c")).toBe("/a/b");
        expect(dirname("/a")).toBe("/");
        expect(dirname("a")).toBe("");
        expect(basename("/a/b/c")).toBe("c");
        expect(basename("/a/b/")).toBe("");
    });
});

describe("expanduser, abspath, isInside", () => {
    it("expands ~ against a home", () => {
        expect(expanduser("~", "/home/u")).toBe("/home/u");
        expect(expanduser("~/x", "/home/u")).toBe("/home/u/x");
        expect(expanduser("~other/x", "/home/u")).toBe("~other/x");
    });
    it("resolves against a cwd", () => {
        expect(abspath("x/../y", "/w")).toBe("/w/y");
        expect(abspath("/z", "/w")).toBe("/z");
    });
    it("tests containment", () => {
        expect(isInside("/a/b", "/a")).toBe(true);
        expect(isInside("/ab", "/a")).toBe(false);
        expect(isInside("/a", "/a/")).toBe(false);
    });
});
