/**
 * The engine host against a stand-in for the engine's `$.fs`, shaped as its
 * contract documents: a listing reports a symbolic link as `other`, `stat`
 * follows links, and every read and write takes a turn of the event loop.
 */

import type { EngineInterface } from "claude-code";
import { describe, expect, it } from "vitest";
import { globPaths } from "../shell/glob.ts";
import { engineHost, partPath } from "./engine-host.ts";

interface FakeTree {
    readonly files: Map<string, string>;
    readonly dirs: ReadonlySet<string>;
    /** Link path to the absolute path it points at. */
    readonly links: ReadonlyMap<string, string>;
}

/** One turn of the microtask queue, so parallel calls interleave as real I/O would. */
const tick = () => Promise.resolve();

function follow(tree: FakeTree, path: string): string {
    for (const [link, target] of tree.links) {
        if (path === link || path.startsWith(`${link}/`)) return target + path.slice(link.length);
    }
    return path;
}

function fakeEngine(tree: FakeTree): EngineInterface {
    const missing = () => Promise.reject(new Error("ENOENT"));
    const fs = {
        async list(path: string) {
            await tick();
            const real = follow(tree, path);
            if (!tree.dirs.has(real)) return missing();
            const prefix = `${real}/`;
            const children = (paths: Iterable<string>) =>
                [...paths].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
            const entry = (full: string, kind: "file" | "dir" | "other", isLink: boolean) => ({
                name: full.slice(prefix.length),
                kind,
                size: 0,
                mtimeMs: 0,
                isLink,
            });
            return [
                ...children(tree.files.keys()).map((p) => entry(p, "file", false)),
                ...children(tree.dirs).map((p) => entry(p, "dir", false)),
                ...children(tree.links.keys()).map((p) => entry(p, "other", true)),
            ];
        },
        async stat(path: string) {
            await tick();
            const real = follow(tree, path);
            const isLink = tree.links.has(path);
            if (tree.files.has(real))
                return { kind: "file", size: (tree.files.get(real) as string).length, mtimeMs: 0, isLink };
            if (tree.dirs.has(real)) return { kind: "dir", size: 0, mtimeMs: 0, isLink };
            return missing();
        },
        async exists(path: string) {
            return tree.files.has(follow(tree, path)) || tree.dirs.has(follow(tree, path));
        },
        async read(path: string) {
            await tick();
            const text = tree.files.get(follow(tree, path));
            return text === undefined ? missing() : text;
        },
        async write(path: string, text: string) {
            await tick();
            tree.files.set(follow(tree, path), text);
        },
    };
    const engine = {
        fs,
        env: { get: async () => undefined },
        session: { cwd: async () => "/home/u" },
        ui: { log: () => undefined },
    };
    return engine as unknown as EngineInterface;
}

describe("engineHost", () => {
    it("lists a symbolic link by what it leads to, so a glob descends through it", async () => {
        const tree: FakeTree = {
            files: new Map([["/home/u/.claude/settings.json", "{}"]]),
            dirs: new Set(["/work", "/home/u", "/home/u/.claude"]),
            links: new Map([
                ["/work/alias", "/home/u/.claude"],
                ["/work/gone", "/nowhere"],
            ]),
        };
        const host = await engineHost(fakeEngine(tree));
        const entries = await host.list("/work");
        expect(entries).toEqual([
            { name: "alias", kind: "dir", isLink: true },
            { name: "gone", kind: "other", isLink: true },
        ]);
        expect(await globPaths("al*/settings.json", host, { rootDir: "/work" })).toEqual([
            "alias/settings.json",
        ]);
    });

    it("keeps every record of appends made in parallel", async () => {
        const tree: FakeTree = {
            files: new Map([["/logs/day.jsonl", "seed\n"]]),
            dirs: new Set(["/logs"]),
            links: new Map(),
        };
        const host = await engineHost(fakeEngine(tree));
        await Promise.all(
            ["first", "second", "third"].map((line) => host.appendText("/logs/day.jsonl", `${line}\n`)),
        );
        expect(tree.files.get("/logs/day.jsonl")).toBe("seed\nfirst\nsecond\nthird\n");
    });

    it("goes on in a new part once a day's log is full, never erasing it", async () => {
        const full = `${"x".repeat(3 * 1024 * 1024 - 4)}\n`;
        const tree: FakeTree = {
            files: new Map([["/logs/day.jsonl", full]]),
            dirs: new Set(["/logs"]),
            links: new Map(),
        };
        const host = await engineHost(fakeEngine(tree));
        await host.appendText("/logs/day.jsonl", "next\n");
        await host.appendText("/logs/day.jsonl", "after\n");
        expect(tree.files.get("/logs/day.jsonl")).toBe(full);
        expect(tree.files.get("/logs/day.1.jsonl")).toBe("next\nafter\n");
    });

    it("names the parts beside the day's file", () => {
        expect(partPath("/logs/2026-10-18.jsonl", 0)).toBe("/logs/2026-10-18.jsonl");
        expect(partPath("/logs/2026-10-18.jsonl", 2)).toBe("/logs/2026-10-18.2.jsonl");
        expect(partPath("/logs.d/day", 1)).toBe("/logs.d/day.1");
    });
});
