/**
 * Parity with shell_expand.py (scripts/parity/gen-expand-fixture.py): every word
 * of each case runs through the pipeline parse.ts uses (arrayWords /
 * atWordPieces, then braceExpand -> expandWord -> splitUnquoted; compoundWord
 * for arrays), then pathname expansion over a memoryHost tree.
 */

import { describe, expect, it } from "vitest";
import { memoryHost } from "../host/memory-host.ts";
import fixture from "./__fixtures__/expand-parity.json" with { type: "json" };
import {
    arithmeticExpressions,
    arithmeticSubstitutions,
    arrayWords,
    atWordPieces,
    braceExpand,
    commandOutput,
    compoundWord,
    echoedText,
    expandWord,
    globWords,
    ifsValues,
    splitUnquoted,
} from "./expand.ts";
import { lex, Operator, type Token, Word } from "./lexer.ts";
import { Context, ParseResult, SimpleCommand, UNSET } from "./model.ts";

interface WordJson {
    text: string;
    dynamic: boolean;
    quoted: boolean;
    splits: boolean;
    substitutions: string[];
}

type TokenJson =
    | { op: string }
    | { compound: WordJson }
    | {
          arrayWords: WordJson[] | null;
          atWordPieces: WordJson[] | null;
          expanded: WordJson[];
          arithmetic: string[];
      };

interface ExpandCase {
    variables: Record<string, string[]>;
    command: string;
    words: TokenJson[];
    truncated: boolean;
    variablesAfter: Record<string, string[]>;
    ifsValues: string[];
    ifsValuesEnv: string[];
    arithmeticSubstitutions: Record<string, string[]>;
}

interface GlobCase {
    created: string[];
    createdUnknown?: boolean;
    command: string;
    truncated: boolean;
    words: Array<{ text: string; dynamic: boolean; quoted: boolean }>;
}

interface ExpandFixture {
    cwd: string;
    root: string;
    tree: string[];
    cases: ExpandCase[];
    glob: GlobCase[];
}

const data = fixture as unknown as ExpandFixture;

function wordJson(word: Word): WordJson {
    return {
        text: word.text,
        dynamic: word.dynamic,
        quoted: word.quoted,
        splits: word.splits,
        substitutions: [...word.substitutions],
    };
}

function makeContext(variables: Record<string, string[]>, cwd: string): Context {
    const host = memoryHost({});
    const ctx = new Context(new ParseResult(), cwd, null, host, [cwd]);
    ctx.variables = new Map(Object.entries(variables));
    ctx.writtenFiles.set(`${cwd}/f`, { text: "r", replaces: true });
    ctx.writtenFiles.set(`${cwd}/g`, { text: "m", replaces: false });
    return ctx;
}

async function expandTokens(tokens: readonly Token[], ctx: Context): Promise<TokenJson[]> {
    const out: TokenJson[] = [];
    for (const token of tokens) {
        if (token instanceof Operator) {
            out.push({ op: token.op });
            continue;
        }
        if (token.elements !== undefined) {
            out.push({ compound: wordJson(await compoundWord(token, ctx, new Map())) });
            continue;
        }
        const array = arrayWords(token, ctx);
        const pieces = array === undefined ? atWordPieces(token, ctx) : undefined;
        const expanded: Word[] = [];
        for (const piece of braceExpand(token, ctx)) {
            expanded.push(...splitUnquoted(piece, await expandWord(piece, ctx), ctx));
        }
        out.push({
            arrayWords: array ? array.map(wordJson) : null,
            atWordPieces: pieces ? pieces.map(wordJson) : null,
            expanded: expanded.map(wordJson),
            arithmetic: arithmeticExpressions(token.text),
        });
    }
    return out;
}

describe("word expansion parity with shell_expand.py", () => {
    it.each(data.cases.map((c) => [c.command, c] as const))("%j", async (command, expected) => {
        const ctx = makeContext(expected.variables, data.cwd);
        const words = await expandTokens(lex(command).tokens, ctx);
        expect(words).toEqual(expected.words);
        expect(ctx.result.truncated).toBe(expected.truncated);
        expect(Object.fromEntries(ctx.variables)).toEqual(expected.variablesAfter);
        expect([...ifsValues(ctx)]).toEqual(expected.ifsValues);
        expect([...ifsValues(ctx, ["A=1", "IFS=:", "B=2"])]).toEqual(expected.ifsValuesEnv);
        for (const [expression, bodies] of Object.entries(expected.arithmeticSubstitutions)) {
            expect(arithmeticSubstitutions(expression, ctx)).toEqual(bodies);
        }
    });
});

describe("pathname expansion parity with glob.glob", () => {
    const host = memoryHost({
        files: Object.fromEntries(data.tree.map((path) => [`${data.root}/${path}`, ""])),
    });
    it.each(data.glob.map((c) => [c.command, c] as const))("%j", async (command, expected) => {
        const ctx = new Context(new ParseResult(), data.root, null, host, [data.root]);
        ctx.variables = new Map(Object.entries(data.cases[0]?.variables ?? {}));
        ctx.createdPaths = new Set(
            expected.created.map((p) => (p.startsWith("/") ? p : `${data.root}/${p}`)),
        );
        ctx.createdUnknown = expected.createdUnknown ?? false;
        const words: Word[] = [];
        for (const token of lex(command).tokens) {
            if (token instanceof Operator) continue;
            for (const piece of braceExpand(token, ctx)) {
                words.push(...splitUnquoted(piece, await expandWord(piece, ctx), ctx));
            }
        }
        const globbed = await globWords(words, ctx);
        expect(globbed.map((w) => ({ text: w.text, dynamic: w.dynamic, quoted: w.quoted }))).toEqual(
            expected.words,
        );
        expect(ctx.result.truncated).toBe(expected.truncated);
    });
    it("leaves words alone when the directory is unknown", async () => {
        const ctx = new Context(new ParseResult(), null, null, host, [null]);
        const words = [new Word("*.txt")];
        expect(await globWords(words, ctx)).toEqual(words);
    });
});

describe("commandOutput and echoedText", () => {
    it("print what echo/printf write, honouring xpg_echo", () => {
        const plain = new SimpleCommand({ argv: ["echo", "\\0162"] });
        expect(commandOutput(plain)).toBe("\\0162\n");
        expect(echoedText(plain)).toBe("\\0162");
        const xpg = new SimpleCommand({
            argv: ["echo", "\\0162"],
            environment: [["\0shopt:xpg_echo", ["on"]]],
        });
        expect(commandOutput(xpg)).toBe("r\n");
        expect(echoedText(new SimpleCommand({ argv: ["printf", "%s\\n\\n", "rm"] }))).toBe("rm");
        expect(commandOutput(new SimpleCommand({ argv: ["cat", "x"] }))).toBeUndefined();
        expect(echoedText(new SimpleCommand({ argv: ["cat", "x"] }))).toBe("");
    });
});

describe("expandWord", () => {
    it("remembers a default assignment and keeps unknown names dynamic", async () => {
        const ctx = makeContext({}, "/work");
        const word = await expandWord(
            // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
            new Word("${OUT:=$HOME/.claude/settings.json}", { dynamic: true }),
            ctx,
        );
        expect(word.text).toBe("/home/user/.claude/settings.json");
        expect(ctx.variables.get("OUT")).toEqual(["/home/user/.claude/settings.json", UNSET]);
        const unknown = await expandWord(new Word("$NOPE", { dynamic: true, splits: true }), ctx);
        expect(unknown.text).toBe("$NOPE");
        expect(unknown.dynamic).toBe(true);
    });
});
