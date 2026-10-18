import { describe, expect, it } from "vitest";
import { ARRAY, arrayItems, assign, bounded, FIELD, READONLY, UNSET, type Variables } from "./model.ts";

describe("assign", () => {
    it("remembers the latest value and keeps earlier ones when conditional", () => {
        const variables: Variables = new Map();
        assign("X=1", variables);
        assign("X=2", variables, true);
        expect(variables.get("X")).toEqual(["2", "1"]);
    });
    it("appends to every possible value", () => {
        const variables: Variables = new Map([["X", ["a", UNSET]]]);
        assign("X+=b", variables);
        expect(variables.get("X")).toEqual(["ab", "b"]);
    });
    it("sets array elements and element 0 as the scalar", () => {
        const variables: Variables = new Map();
        assign(`X=${ARRAY}a${FIELD}b`, variables);
        expect(variables.get("X[0]")).toEqual(["a"]);
        expect(variables.get("X[1]")).toEqual(["b"]);
        expect(variables.get("X")).toEqual(["a"]);
        expect(arrayItems("X", variables)).toEqual([
            [0, "a"],
            [1, "b"],
        ]);
    });
    it("refuses to change a readonly variable", () => {
        const variables: Variables = new Map([
            ["X", ["echo"]],
            [`${READONLY}X`, ["on"]],
        ]);
        assign("X=rm", variables);
        expect(variables.get("X")).toEqual(["echo"]);
    });
});

describe("bounded", () => {
    it("caps directory options and marks the rest unknown", () => {
        const options = Array.from({ length: 12 }, (_, index) => `/d${index}`);
        const result = bounded(options);
        expect(result).toHaveLength(8);
        expect(result[7]).toBeNull();
    });
});
