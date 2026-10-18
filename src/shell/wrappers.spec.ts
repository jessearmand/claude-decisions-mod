/**
 * Parity with shell_wrappers.py (scripts/parity/gen-wrappers-fixture.py): the
 * option tables, `shellInvocation` over many argument lists and `sourceArguments`.
 */

import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/wrappers-parity.json" with { type: "json" };
import {
    CLI_OPTIONS_WITH_VALUE,
    PREFIX_WRAPPERS,
    RESERVED_PREFIXES,
    SHELL_COMMAND_OPTIONS,
    SHELL_EXTRA_OPTIONS_WITH_ARG,
    SHELL_OPTIONS_WITH_ARG,
    SHELLS,
    type ShellInvocation,
    SSH_OPTIONS_WITH_ARG,
    STDIN_PATHS,
    STRING_RUNNERS,
    SUBCOMMAND_RUNNERS,
    type SubcommandRunner,
    shellInvocation,
    sourceArguments,
    type WrapperSpec,
} from "./wrappers.ts";

interface InvocationJson {
    commands: string[];
    commandArgs: string[];
    script: string | null;
    scriptArgs: string[];
    readsStdin: boolean;
    syntaxOnly: boolean;
    interactive: boolean;
    startupFile: string | null;
}

interface SpecJson {
    withArg: string[];
    positionals: number;
    noExec?: string[];
    commandOptions: string[];
    chdirOptions: string[];
    subcommands?: string[];
}

interface WrappersFixture {
    invocations: Array<{ name: string; args: string[]; result: InvocationJson }>;
    tables: {
        PREFIX_WRAPPERS: Record<string, SpecJson>;
        STRING_RUNNERS: Record<string, SpecJson>;
        SUBCOMMAND_RUNNERS: Record<string, SpecJson>;
        CLI_OPTIONS_WITH_VALUE: Record<string, string[]>;
        SHELL_COMMAND_OPTIONS: Record<string, string[]>;
        SHELL_EXTRA_OPTIONS_WITH_ARG: Record<string, string[]>;
        SHELL_OPTIONS_WITH_ARG: string[];
        SSH_OPTIONS_WITH_ARG: string[];
        STDIN_PATHS: string[];
        SHELLS: string[];
        RESERVED_PREFIXES: string[];
    };
    sources: Array<{ args: string[]; result: string[] }>;
}

const data = fixture as WrappersFixture;

function invocationJson(invocation: ShellInvocation): InvocationJson {
    return {
        commands: [...invocation.commands],
        commandArgs: [...invocation.commandArgs],
        script: invocation.script ?? null,
        scriptArgs: [...invocation.scriptArgs],
        readsStdin: invocation.readsStdin,
        syntaxOnly: invocation.syntaxOnly,
        interactive: invocation.interactive,
        startupFile: invocation.startupFile ?? null,
    };
}

const sorted = (set: ReadonlySet<string>): string[] => [...set].sort();

function wrapperJson(spec: WrapperSpec): SpecJson {
    return {
        withArg: sorted(spec.withArg),
        positionals: spec.positionals,
        noExec: sorted(spec.noExec),
        commandOptions: sorted(spec.commandOptions),
        chdirOptions: sorted(spec.chdirOptions),
    };
}

function runnerJson(runner: SubcommandRunner): SpecJson {
    return {
        subcommands: sorted(runner.subcommands),
        withArg: sorted(runner.withArg),
        positionals: runner.positionals,
        chdirOptions: sorted(runner.chdirOptions),
        commandOptions: sorted(runner.commandOptions),
    };
}

function tableJson<T, J>(table: ReadonlyMap<string, T>, convert: (value: T) => J): Record<string, J> {
    return Object.fromEntries([...table].map(([key, value]) => [key, convert(value)]));
}

describe("shellInvocation parity with shell_wrappers.py", () => {
    it.each(data.invocations.map((c) => [c.name, c.args, c] as const))("%s %j", (name, args, expected) => {
        expect(invocationJson(shellInvocation(name, args))).toEqual(expected.result);
    });
});

describe("the wrapper tables match the Python ones", () => {
    it("PREFIX_WRAPPERS", () =>
        expect(tableJson(PREFIX_WRAPPERS, wrapperJson)).toEqual(data.tables.PREFIX_WRAPPERS));
    it("STRING_RUNNERS", () =>
        expect(tableJson(STRING_RUNNERS, wrapperJson)).toEqual(data.tables.STRING_RUNNERS));
    it("SUBCOMMAND_RUNNERS", () =>
        expect(tableJson(SUBCOMMAND_RUNNERS, runnerJson)).toEqual(data.tables.SUBCOMMAND_RUNNERS));
    it("CLI_OPTIONS_WITH_VALUE", () =>
        expect(tableJson(CLI_OPTIONS_WITH_VALUE, sorted)).toEqual(data.tables.CLI_OPTIONS_WITH_VALUE));
    it("SHELL_COMMAND_OPTIONS", () =>
        expect(tableJson(SHELL_COMMAND_OPTIONS, sorted)).toEqual(data.tables.SHELL_COMMAND_OPTIONS));
    it("SHELL_EXTRA_OPTIONS_WITH_ARG", () =>
        expect(tableJson(SHELL_EXTRA_OPTIONS_WITH_ARG, sorted)).toEqual(
            data.tables.SHELL_EXTRA_OPTIONS_WITH_ARG,
        ));
    it("the sets", () => {
        expect(sorted(SHELL_OPTIONS_WITH_ARG)).toEqual(data.tables.SHELL_OPTIONS_WITH_ARG);
        expect(sorted(SSH_OPTIONS_WITH_ARG)).toEqual(data.tables.SSH_OPTIONS_WITH_ARG);
        expect(sorted(STDIN_PATHS)).toEqual(data.tables.STDIN_PATHS);
        expect(sorted(SHELLS)).toEqual(data.tables.SHELLS);
        expect(sorted(RESERVED_PREFIXES)).toEqual(data.tables.RESERVED_PREFIXES);
    });
});

describe("sourceArguments", () => {
    it.each(data.sources.map((c) => [c.args, c.result] as const))("%j", (args, expected) => {
        expect([...sourceArguments(args)]).toEqual(expected);
    });
});
