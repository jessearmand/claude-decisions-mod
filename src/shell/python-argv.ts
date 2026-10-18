/**
 * What a Python interpreter runs, read the way CPython reads its command line.
 *
 * Short options group (`-Im json.tool`, `-imcode`), and `-W`, `-X`, `-c` and
 * `-m` take the rest of the word or the next word as their value
 * (`-W -mjson.tool` sets a warning filter; no module runs). Option parsing ends
 * at `-c`, `-m`, `-`, `--` or the first operand, which is the script.
 *
 * Ported from python_argv.py.
 */

import type { Environment } from "./model.ts";

/** Short options whose value is the rest of the word or the next word. */
const VALUED: ReadonlySet<string> = new Set(["W", "X"]);
/** Long options that take the next word as their value. */
const VALUED_LONG: ReadonlySet<string> = new Set(["--check-hash-based-pycs"]);

export type PythonProgramKind = "stdin" | "script" | "command" | "module";

/**
 * `kind` is "stdin", "script", "command" or "module"; `target` is the
 * script path, command text or module name. `inspect` is set by `-i`: after
 * the program ends, an interactive prompt runs what remains on stdin.
 */
export interface PythonProgram {
    readonly kind: PythonProgramKind;
    readonly target?: string;
    readonly inspect: boolean;
}

function program(kind: PythonProgramKind, target: string | undefined, inspect: boolean): PythonProgram {
    return { kind, target, inspect };
}

/** `any(environment.get("PYTHONINSPECT", ()))`: PYTHONINSPECT may hold a non-empty value. */
function inspectRequested(environment: Environment): boolean {
    const entry = environment.find(([name]) => name === "PYTHONINSPECT");
    return (entry?.[1] ?? []).some((value) => value !== "");
}

/** The program a `python ARGS...` invocation runs. */
export function pythonProgram(args: readonly string[], environment: Environment): PythonProgram {
    let inspect = inspectRequested(environment);
    let index = 0;
    while (index < args.length) {
        const arg = args[index] as string;
        index += 1;
        if (arg === "-") return program("stdin", undefined, inspect);
        if (arg === "--" || !arg.startsWith("-")) {
            const script = arg !== "--" ? arg : index < args.length ? args[index] : undefined;
            return script ? program("script", script, inspect) : program("stdin", undefined, inspect);
        }
        if (arg.startsWith("--")) {
            if (VALUED_LONG.has(arg)) index += 1;
            continue;
        }
        for (let position = 1; position < arg.length; position += 1) {
            const flag = arg[position] as string;
            if (flag === "i") {
                inspect = true;
            } else if (VALUED.has(flag) || flag === "c" || flag === "m") {
                let value: string | undefined = arg.slice(position + 1);
                if (!value) {
                    value = index < args.length ? args[index] : undefined;
                    index += 1;
                }
                if (flag === "c") return program("command", value, inspect);
                if (flag === "m") return program("module", value, inspect);
                break;
            }
        }
    }
    return program("stdin", undefined, inspect);
}
