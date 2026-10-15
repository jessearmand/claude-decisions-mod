/**
 * Port of shell_ifs_test.py. Every expectation is what bash 5 gives for the
 * same input, both for word splitting of an unquoted `$X` and for `read` with
 * one to three names.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT, split } from "./ifs.ts";

// (text, IFS, fields of an unquoted expansion)
const SPLIT_CASES: ReadonlyArray<readonly [string, string, string[]]> = [
    ["rm -rf  ~", DEFAULT, ["rm", "-rf", "~"]],
    ["  a  ", DEFAULT, ["a"]],
    ["", DEFAULT, []],
    ["rm,-rf,/", ",", ["rm", "-rf", "/"]],
    ["a,,b", ",", ["a", "", "b"]],
    [",a", ",", ["", "a"]],
    ["a,", ",", ["a"]],
    ["a , b", " ,", ["a", "b"]],
    ["a ,, b", " ,", ["a", "", "b"]],
    ["rxm", "x", ["r", "m"]],
    ["a b", "", ["a b"]],
];

// (text, IFS, names, what each name gets)
const READ_CASES: ReadonlyArray<readonly [string, string, number, string[]]> = [
    ["rxm", "x", 2, ["r", "m"]],
    ["x y z", DEFAULT, 2, ["x", "y z"]],
    ["a,b,", ",", 1, ["a,b,"]],
    ["a,b,", ",", 2, ["a", "b"]],
    ["a,b,,", ",", 2, ["a", "b,,"]],
    ["a,", ",", 1, ["a"]],
    ["a,,", ",", 2, ["a", ""]],
    ["a,b ,", ",", 2, ["a", "b "]],
    ["a,b ,", " ,", 2, ["a", "b"]],
    ["a, b,  ", ",", 2, ["a", " b,  "]],
    ["a,b,c,", ",", 3, ["a", "b", "c"]],
    ["a a", "a", 1, ["a a"]],
];

describe("split", () => {
    it.each(SPLIT_CASES)("split(%j) by %j", (text, ifs, expected) => {
        expect(split(text, ifs)).toEqual(expected);
    });
    it.each(READ_CASES)("read from %j by %j into %i names", (text, ifs, names, expected) => {
        const actual = split(text, ifs, names);
        while (actual.length < names) actual.push("");
        expect(actual).toEqual(expected);
    });
    it("uses the default IFS when none is given", () => {
        expect(split("\ta\nb c\n")).toEqual(["a", "b", "c"]);
    });
    it("does not split at all on an empty IFS", () => {
        expect(split("", "")).toEqual([]);
        expect(split("a\tb", "")).toEqual(["a\tb"]);
    });
});
