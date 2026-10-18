/**
 * Protected-path regressions for case-sensitive and case-insensitive volumes
 * (filesystem_paths_test.py). The Python test patched `os.pathconf`; here a
 * memory host stands for the volume: a case-swapped alias link that resolves
 * to the directory makes it case-insensitive, its absence case-sensitive.
 */

import { describe, expect, it } from "vitest";
import type { Host } from "../host/host.ts";
import { memoryHost } from "../host/memory-host.ts";
import { caseInsensitive, isInside, patternMatches } from "./filesystem-paths.ts";

const SETTINGS = /\/\.claude\/settings\.json$/;

/** `cwd` on an insensitive or sensitive darwin volume, with `~` under the same tree. */
function darwin(cwd: string, insensitive: boolean) {
    return memoryHost({
        platform: "darwin",
        home: "/Users/me",
        dirs: [cwd, "/Users/me", "/Users/me/.claude"],
        files: { [`${cwd}/notes.json`]: "{}" },
        links: insensitive ? { "/Users/ME": "/Users/me", [`${cwd.slice(0, -4)}WORK`]: cwd } : {},
    });
}

describe("caseInsensitive", () => {
    it("is false off macOS whatever the volume", async () => {
        const linux = memoryHost({ platform: "linux", dirs: ["/work"], links: { "/WORK": "/work" } });
        expect(await caseInsensitive("/work/.CLAUDE/settings.json", linux)).toBe(false);
    });
    it("answers for the nearest existing ancestor of a file not yet created", async () => {
        const insensitive = darwin("/private/work", true);
        expect(await caseInsensitive("/private/work/.CLAUDE/settings.json", insensitive)).toBe(true);
        expect(await caseInsensitive("~/.CLAUDE/settings.json", insensitive)).toBe(true);
        const sensitive = darwin("/private/work", false);
        expect(await caseInsensitive("/private/work/.CLAUDE/settings.json", sensitive)).toBe(false);
        expect(await caseInsensitive(".CLAUDE/settings.json", sensitive, "/private/work")).toBe(false);
    });
    it("follows a symlink to the volume that holds the target", async () => {
        // macOS's $TMPDIR lives under the /var -> /private/var symlink; a link into a
        // case-sensitive volume must answer for that volume, not the link's own.
        const host = memoryHost({
            platform: "darwin",
            dirs: ["/private/var/tmp/sensitive", "/private/var/tmp/insensitive"],
            links: {
                "/var": "/private/var",
                "/private/var/tmp/INSENSITIVE": "/private/var/tmp/insensitive",
                "/private/var/tmp/link": "/private/var/tmp/sensitive",
            },
        });
        expect(await caseInsensitive("/var/tmp/sensitive/.CLAUDE/settings.json", host)).toBe(false);
        expect(await caseInsensitive("/var/tmp/insensitive/.CLAUDE/settings.json", host)).toBe(true);
        expect(await caseInsensitive("/var/tmp/link/.CLAUDE/settings.json", host)).toBe(false);
    });
    it("conservatively protects case aliases when the volume cannot be asked", async () => {
        // No letter to swap in the existing ancestor (the root, or a digits-only name).
        const host = memoryHost({ platform: "darwin", dirs: ["/123"] });
        expect(await caseInsensitive("/123/.CLAUDE/settings.json", host)).toBe(true);
        expect(await caseInsensitive("/nowhere/.CLAUDE/settings.json", host)).toBe(true);
    });
    it("does not rely on realPath folding a case alias's spelling", async () => {
        // The engine's `$.fs.stat(..., { resolve: true })` keeps a case alias as spelled,
        // so the alias and the original resolve to different strings on the same volume.
        const base = darwin("/private/work", true);
        const host: Host = Object.assign(Object.create(base), {
            realPath: async (path: string) => path,
        });
        expect(await caseInsensitive("/Users/me/.CLAUDE/SETTINGS.JSON", host)).toBe(true);
        expect(await caseInsensitive("/private/work/.CLAUDE/settings.json", host)).toBe(true);
    });
});

describe("patternMatches and isInside", () => {
    it("match exactly on a case-sensitive volume", () => {
        expect(patternMatches(SETTINGS, "/w/.claude/settings.json", false)).toBe(true);
        expect(patternMatches(SETTINGS, "/w/.CLAUDE/settings.json", false)).toBe(false);
        expect(patternMatches(SETTINGS, "/w/.claude/SETTINGS.JSON")).toBe(false);
        expect(isInside("/w/.CLAUDE", "/w/.claude", false)).toBe(false);
        expect(isInside("/w/.claude/x", "/w/.claude/", false)).toBe(true);
        expect(isInside("/w/.claude", "/w/.claude", false)).toBe(true);
    });
    it("fold case on a case-insensitive volume", () => {
        for (const path of [
            "/w/.CLAUDE/settings.json",
            "/w/.claude/SETTINGS.JSON",
            "/w/.CODEX/CONFIG.TOML",
        ]) {
            expect(patternMatches(/\/\.claude\/settings\.json$|\/\.codex\/config\.toml$/, path, true)).toBe(
                true,
            );
        }
        expect(patternMatches(SETTINGS, "/w/notes.json", true)).toBe(false);
        expect(isInside("/w/.CLAUDE/settings.json", "/w/.claude", true)).toBe(true);
        expect(isInside("/w/.claudeX", "/w/.claude", true)).toBe(false);
    });
    it("never carries a global regex's lastIndex between calls", () => {
        const global = /settings\.json/g;
        expect(patternMatches(global, "/a/settings.json")).toBe(true);
        expect(patternMatches(global, "/a/settings.json")).toBe(true);
    });
});
