/**
 * Parity with shell_lexer.py: every command of the guard corpora and the edge
 * cases in scripts/parity/gen-lexer-fixture.py, lexed by the Python oracle and
 * compared token for token (regenerate with that script).
 */

import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/lexer-parity.json" with { type: "json" };
import {
    HEREDOC_OPERATORS,
    lex,
    nestedSubstitutions,
    Operator,
    REDIRECT_OPERATORS,
    type Token,
    Word,
} from "./lexer.ts";

interface WordJson {
    type: "word";
    text: string;
    dynamic: boolean;
    quoted: boolean;
    heredocBody: string | null;
    substitutions: string[];
    splits: boolean;
    braces: number[];
    elements: WordJson[] | null;
    guards: Record<string, string[]>;
}

interface OperatorJson {
    type: "op";
    op: string;
    fd: number | null;
}

interface LexCase {
    command: string;
    tokens: Array<WordJson | OperatorJson>;
    substitutions: string[];
    unterminated: boolean;
    nested: string[];
}

function wordJson(word: Word): WordJson {
    return {
        type: "word",
        text: word.text,
        dynamic: word.dynamic,
        quoted: word.quoted,
        heredocBody: word.heredocBody ?? null,
        substitutions: [...word.substitutions],
        splits: word.splits,
        braces: [...word.braces],
        elements: word.elements ? word.elements.map(wordJson) : null,
        guards: Object.fromEntries([...word.guards].map(([index, guard]) => [String(index), [...guard]])),
    };
}

function tokenJson(token: Token): WordJson | OperatorJson {
    if (token instanceof Operator) return { type: "op", op: token.op, fd: token.fd ?? null };
    return wordJson(token);
}

const cases = fixture as LexCase[];

describe("lex parity with shell_lexer.py", () => {
    it.each(cases.map((c) => [c.command, c] as const))("lex(%j)", (_command, expected) => {
        const result = lex(expected.command);
        expect(result.tokens.map(tokenJson)).toEqual(expected.tokens);
        expect(result.substitutions).toEqual(expected.substitutions);
        expect(result.unterminated).toBe(expected.unterminated);
        expect(nestedSubstitutions(expected.command)).toEqual(expected.nested);
    });
});

describe("lex", () => {
    it("splits on newlines and keeps the operator", () => {
        const result = lex("echo hi\nrm -rf ~");
        expect(result.tokens.map((t) => (t instanceof Word ? t.text : `<${t.op}>`))).toEqual([
            "echo",
            "hi",
            "<\n>",
            "rm",
            "-rf",
            "~",
        ]);
    });
    it("gives Word and Operator as classes for instanceof checks", () => {
        const [word, op] = lex("x;").tokens;
        expect(word).toBeInstanceOf(Word);
        expect(op).toBeInstanceOf(Operator);
    });
    it("reads a heredoc body and its substitutions", () => {
        const result = lex("cat <<EOF\nhello $(rm x)\nEOF\n");
        const delimiter = result.tokens[2] as Word;
        expect(delimiter.text).toBe("EOF");
        expect(delimiter.heredocBody).toBe("hello $(rm x)");
        expect(result.substitutions).toEqual(["rm x"]);
        expect(result.unterminated).toBe(false);
    });
    it("flags unterminated input instead of throwing", () => {
        expect(lex("echo 'open").unterminated).toBe(true);
        expect(lex("echo $(open").unterminated).toBe(true);
        expect(lex("cat <<EOF\nno end").unterminated).toBe(true);
    });
    it("exports the operator sets", () => {
        expect(REDIRECT_OPERATORS.has("<<<")).toBe(true);
        expect(HEREDOC_OPERATORS.has("<<-")).toBe(true);
        expect(HEREDOC_OPERATORS.has("<<<")).toBe(false);
    });
});
