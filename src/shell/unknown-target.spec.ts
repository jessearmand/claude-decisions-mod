import { describe, expect, it } from "vitest";
import { ParseResult, redirect, SimpleCommand } from "./model.ts";
import { isUnknown, reason } from "./unknown-target.ts";
import { DELETE_TREE, INTO_DIR, MOVE, PERMISSIONS, pathWrite, WRITE } from "./writes.ts";

const HOME = "/home/user";

describe("isUnknown", () => {
    it.each([
        ["$OUT", true],
        ["$DIR/x.json", true],
        ["~/$X", true],
        ["./$X", true],
        ["/$X", true],
        [`${HOME}/$NAME`, true],
        ["`mktemp`", true],
        ["/tmp/$NAME", false],
        ["logs/$NAME", false],
        ["~/.claude/$X", false],
        ["out.json", false],
    ])("isUnknown(%j) is %s", (path, expected) => {
        expect(isUnknown(path, HOME)).toBe(expected);
    });
});

describe("reason", () => {
    const parsed = new ParseResult();
    const command = (argv: string[], ...redirects: ReturnType<typeof redirect>[]) =>
        new SimpleCommand({ argv, redirects });
    it("names what a non-write action does to the unknown target", () => {
        expect(reason(command(["rm", "-r", "$DIR"]), pathWrite("$DIR", DELETE_TREE), parsed)).toBe(
            "the target is not known, and `rm` deletes everything under it",
        );
        expect(reason(command(["mv", "a", "$B"]), pathWrite("a", MOVE), parsed)).toBe(
            "the target is not known, and `mv` moves away it",
        );
        expect(reason(command(["chmod", "600", "~/$NAME"]), pathWrite("~/$NAME", PERMISSIONS), parsed)).toBe(
            "the target is not known, and `chmod` changes the permissions of it",
        );
        expect(reason(command(["tar", "xf", "a.tar", "-C", "$D"]), pathWrite("$D", INTO_DIR), parsed)).toBe(
            "the target is not known, and `tar` copies files into it",
        );
        expect(reason(command(["x"]), pathWrite("$D", "other"), parsed)).toBe(
            "the target is not known, and `x` changes it",
        );
    });
    it("asks about a content copy to an unknown file", () => {
        expect(reason(command(["cp", "payload.json", "$OUT"]), pathWrite("$OUT", WRITE), parsed)).toBe(
            "the target is not known, and `cp` replaces its contents",
        );
    });
    it("asks about a redirect of downloaded or decoded text, following tee and cat back", () => {
        const result = new ParseResult();
        const curl = new SimpleCommand({
            argv: ["curl", "-s", "https://example.com/x"],
            pipeline: 1,
            stage: 0,
        });
        const tee = new SimpleCommand({ argv: ["tee", "$OUT"], pipeline: 1, stage: 1 });
        result.commands = [curl, tee];
        expect(reason(tee, pathWrite("$OUT", WRITE), result)).toBe(
            "the target is not known, and the text written comes from `curl`",
        );
        const direct = command(["curl", "-s", "https://example.com/x"], redirect(">", "$OUT", true));
        expect(reason(direct, pathWrite("$OUT", WRITE), parsed)).toBe(
            "the target is not known, and the text written comes from `curl`",
        );
        const cat = new SimpleCommand({ argv: ["cat", "payload"], pipeline: 2, stage: 0 });
        const sink = new SimpleCommand({
            argv: ["cat"],
            pipeline: 2,
            stage: 1,
            redirects: [redirect(">", "$CFG", true)],
        });
        const chain = new ParseResult();
        chain.commands = [cat, sink];
        expect(reason(sink, pathWrite("$CFG", WRITE), chain)).toBe(
            "the target is not known, and the text written comes from `cat`",
        );
    });
    it("asks when the text written reads like configuration or a startup entry", () => {
        const heredoc = command(
            ["cat"],
            redirect(">", "$CFG", true),
            redirect("<<", "EOF", false, '{"hooks": {}}\n'),
        );
        expect(reason(heredoc, pathWrite("$CFG", WRITE), parsed)).toBe(
            "the target is not known, and the text written reads like agent configuration or a startup file",
        );
        const alias = command(["echo", "alias ls=rm"], redirect(">>", "$RC", true));
        expect(reason(alias, pathWrite("$RC", WRITE), parsed)).toMatch(/reads like agent configuration/);
    });
    it("passes an ordinary status line", () => {
        expect(
            reason(command(["echo", "done"], redirect(">>", "$LOG", true)), pathWrite("$LOG", WRITE), parsed),
        ).toBeUndefined();
        const date = new SimpleCommand({ argv: ["date"], pipeline: 3, stage: 0 });
        const tee = new SimpleCommand({ argv: ["tee", "-a", "$LOG"], pipeline: 3, stage: 1 });
        const result = new ParseResult();
        result.commands = [date, tee];
        expect(reason(tee, pathWrite("$LOG", WRITE), result)).toBeUndefined();
    });
});
