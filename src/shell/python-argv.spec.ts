import { describe, expect, it } from "vitest";
import type { Environment } from "./model.ts";
import { pythonProgram } from "./python-argv.ts";

const NONE: Environment = [];

describe("pythonProgram", () => {
    it.each([
        [["-Im", "json.tool"], { kind: "module", target: "json.tool", inspect: false }],
        [["-imcode"], { kind: "module", target: "code", inspect: true }],
        [["-W", "-mjson.tool"], { kind: "stdin", target: undefined, inspect: false }], // -W takes the next word
        [["-c", "print(1)", "a"], { kind: "command", target: "print(1)", inspect: false }],
        [["--", "-x.py"], { kind: "script", target: "-x.py", inspect: false }],
        [["-"], { kind: "stdin", target: undefined, inspect: false }],
        [["script.py", "a"], { kind: "script", target: "script.py", inspect: false }],
        [["-X", "dev", "-m", "json.tool"], { kind: "module", target: "json.tool", inspect: false }],
        [["--check-hash-based-pycs", "always", "x.py"], { kind: "script", target: "x.py", inspect: false }],
        [["-i"], { kind: "stdin", target: undefined, inspect: true }],
        [["--"], { kind: "stdin", target: undefined, inspect: false }],
        [["-c"], { kind: "command", target: undefined, inspect: false }],
        [["-Wdefault", "-E", "-m", "pip"], { kind: "module", target: "pip", inspect: false }],
        [["-u", "-Bc", "import os"], { kind: "command", target: "import os", inspect: false }],
        [[], { kind: "stdin", target: undefined, inspect: false }],
    ])("python %j", (args, expected) => {
        expect(pythonProgram(args, NONE)).toEqual(expected);
    });
    it("reads PYTHONINSPECT from the environment", () => {
        expect(pythonProgram([], [["PYTHONINSPECT", ["1"]]]).inspect).toBe(true);
        expect(pythonProgram([], [["PYTHONINSPECT", [""]]]).inspect).toBe(false);
        expect(pythonProgram(["-c", "x"], [["PYTHONINSPECT", ["1"]]])).toEqual({
            kind: "command",
            target: "x",
            inspect: true,
        });
    });
});
