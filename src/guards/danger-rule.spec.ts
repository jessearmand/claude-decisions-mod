import { describe, expect, it } from "vitest";
import { SimpleCommand } from "../shell/model.ts";
import {
    CRITICAL,
    dangerRule,
    expand,
    HIGH,
    has,
    isBroadTarget,
    isInside,
    LEVEL_ORDER,
    longFlag,
    matchDetail,
    operands,
    positionalWords,
    STRICT,
    shortFlag,
} from "./danger-rule.ts";

const HOME = "/home/user";

describe("shortFlag", () => {
    it("finds a letter alone or in a cluster", () => {
        expect(shortFlag(["-f"], "f")).toBe(true);
        expect(shortFlag(["-fdx"], "f")).toBe(true);
        expect(shortFlag(["-xdf"], "f")).toBe(true);
        expect(shortFlag(["-d"], "f")).toBe(false);
        expect(shortFlag(["-dx"], "fF")).toBe(false);
    });

    it("ignores long options, lone dashes and everything after --", () => {
        expect(shortFlag(["--force"], "f")).toBe(false);
        expect(shortFlag(["-"], "f")).toBe(false);
        expect(shortFlag(["--", "-f"], "f")).toBe(false);
        expect(shortFlag(["file", "-f"], "f")).toBe(true);
    });

    it("treats the rest of a cluster after a valued letter as its value", () => {
        expect(shortFlag(["-cfeature"], "f", "c")).toBe(false);
        expect(shortFlag(["-qbfeature"], "f", "b")).toBe(false);
        expect(shortFlag(["-c", "-f"], "f", "c")).toBe(false); // -f is the value of -c
        expect(shortFlag(["-c", "x", "-f"], "f", "c")).toBe(true);
        expect(shortFlag(["-fc", "x"], "f", "c")).toBe(true);
        expect(shortFlag(["-aalice", "serde"], "ar", "ar")).toBe(true);
    });
});

describe("longFlag", () => {
    it("matches the name, a =value form and an unambiguous prefix", () => {
        expect(longFlag(["--force"], "--force")).toBe(true);
        expect(longFlag(["--force=1"], "--force")).toBe(true);
        expect(longFlag(["--forc"], "--force")).toBe(true);
        expect(longFlag(["--for"], "--force")).toBe(true); // five characters: the default minimum
        expect(longFlag(["--fo"], "--force")).toBe(false);
        expect(longFlag(["--hard"], "--hard", 4)).toBe(true);
        expect(longFlag(["--har"], "--hard", 4)).toBe(true);
    });

    it("never matches a longer option, a short option or anything after --", () => {
        expect(longFlag(["--force-with-lease"], "--force")).toBe(false);
        expect(longFlag(["-f"], "--force")).toBe(false);
        expect(longFlag(["--", "--force"], "--force")).toBe(false);
        expect(longFlag(["--volumes"], ["--all", "--volumes"])).toBe(true);
        expect(longFlag(["--all=1"], ["--all", "--volumes"])).toBe(true);
    });
});

describe("has and operands", () => {
    it("has: any argument equal to one of the tokens", () => {
        expect(has(["a", "--dry-run"], "--dry-run", "-n")).toBe(true);
        expect(has(["a", "--dry-run=1"], "--dry-run")).toBe(false);
        expect(has([], "x")).toBe(false);
    });

    it("operands: non-option words, honouring -- and valued options", () => {
        expect(operands(["-n", "x", "--", "-y"])).toEqual(["x", "-y"]);
        expect(operands(["-C", "dir", "sub"], new Set(["-C"]))).toEqual(["sub"]);
        expect(operands(["-C", "dir", "sub"])).toEqual(["dir", "sub"]);
        expect(operands(["-"])).toEqual(["-"]);
        expect(operands(["--", "--"])).toEqual(["--"]);
        expect(operands(["-f"], new Set(["-f"]))).toEqual([]);
    });
});

describe("expand, isInside and isBroadTarget", () => {
    it("expands ~ and $HOME and normalizes against the working directory", () => {
        expect(expand("~", "/proj", HOME)).toBe(HOME);
        expect(expand("~/x", "/proj", HOME)).toBe(`${HOME}/x`);
        expect(expand("$HOME/x", "/proj", HOME)).toBe(`${HOME}/x`);
        // A shell spelling of HOME, not a template
        expect(expand("${HOME}/x/../y", "/proj", HOME)).toBe(`${HOME}/y`);
        expect(expand("a/../b", "/proj", HOME)).toBe("/proj/b");
        expect(expand(".", "/proj", HOME)).toBe("/proj");
        expect(expand("/etc//passwd", "/proj", HOME)).toBe("/etc/passwd");
    });

    it("isInside: the root itself or anything under it", () => {
        expect(isInside("/proj", "/proj")).toBe(true);
        expect(isInside("/proj/a", "/proj/")).toBe(true);
        expect(isInside("/project", "/proj")).toBe(false);
    });

    it("isBroadTarget: system roots, home, top-level directories and ancestors of cwd", () => {
        expect(isBroadTarget("/", "/proj/sub", HOME)).toBe(true);
        expect(isBroadTarget("/usr", "/proj/sub", HOME)).toBe(true);
        expect(isBroadTarget("/anything", "/proj/sub", HOME)).toBe(true); // directly under /
        expect(isBroadTarget("~", "/proj/sub", HOME)).toBe(true);
        expect(isBroadTarget("$HOME", "/proj/sub", HOME)).toBe(true);
        expect(isBroadTarget("..", "/proj/sub", HOME)).toBe(true); // a strict ancestor of cwd
        expect(isBroadTarget("/proj", "/proj/sub", HOME)).toBe(true);
        expect(isBroadTarget(".", "/proj/sub", HOME)).toBe(false);
        expect(isBroadTarget("/proj/sub", "/proj/sub", HOME)).toBe(false);
        expect(isBroadTarget("build", "/proj/sub", HOME)).toBe(false);
        expect(isBroadTarget("/opt/tool", "/proj/sub", HOME)).toBe(false);
        expect(isBroadTarget(`${HOME}/work`, "/proj/sub", HOME)).toBe(false);
    });
});

describe("positionalWords", () => {
    const words = (...argv: string[]) => positionalWords(new SimpleCommand({ argv }));

    it("skips the values of the CLI's own options, wherever they appear", () => {
        expect(words("npm", "-w", "web", "publish")).toEqual(["publish"]);
        expect(words("npm", "--registry", "https://r.example.com", "publish")).toEqual(["publish"]);
        expect(words("pnpm", "-C", "packages/ui", "publish")).toEqual(["publish"]);
        expect(words("helm", "-n", "prod", "uninstall", "web")).toEqual(["uninstall", "web"]);
    });

    it("skips cargo's +toolchain word", () => {
        expect(words("cargo", "+nightly", "publish")).toEqual(["publish"]);
        expect(words("cargo", "--manifest-path", "crates/a/Cargo.toml", "publish")).toEqual(["publish"]);
    });

    it("knows no options for an unknown CLI", () => {
        expect(words("tool", "-x", "value", "verb")).toEqual(["value", "verb"]);
    });
});

describe("rule construction", () => {
    it("defaults a rule's decision to deny and a detail to a typed SQL command file", () => {
        const rule = dangerRule("x", HIGH, "reason", "fix", () => undefined);
        expect(rule.decision).toBe("deny");
        expect(dangerRule("y", STRICT, "r", "f", () => undefined, "ask").decision).toBe("ask");
        expect(matchDetail("text")).toEqual({ text: "text", indirect: false, origin: "SQL command file" });
        expect(LEVEL_ORDER[CRITICAL]).toBeLessThan(LEVEL_ORDER[HIGH]);
        expect(LEVEL_ORDER[HIGH]).toBeLessThan(LEVEL_ORDER[STRICT]);
    });
});
