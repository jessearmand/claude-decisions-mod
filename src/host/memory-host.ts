/**
 * A `Host` over an in-memory file tree, for unit tests that need a file to
 * exist (`./deploy.sh` with a body, a `package.json` with scripts) without
 * touching the disk. Paths are absolute POSIX paths; directories are implied
 * by the files under them unless listed in `dirs`. Symbolic links map a path
 * to its target path.
 */

import { dirname, normpath } from "../util/paths.ts";
import type { DirEntry, FileStat, Host, HttpReply, HttpRequest, RunOptions, RunResult } from "./host.ts";

export interface MemoryTree {
    readonly files?: Readonly<Record<string, string>>;
    readonly dirs?: readonly string[];
    readonly links?: Readonly<Record<string, string>>;
    readonly env?: Readonly<Record<string, string>>;
    readonly home?: string;
    readonly platform?: Host["platform"];
    readonly run?: (argv: readonly string[], options?: RunOptions) => RunResult | undefined;
    readonly fetch?: (url: string, request: HttpRequest) => HttpReply | undefined;
}

export class MemoryHost implements Host {
    readonly home: string;
    readonly platform: Host["platform"];
    readonly files = new Map<string, string>();
    readonly dirs = new Set<string>();
    readonly links = new Map<string, string>();
    readonly appended: string[] = [];
    readonly debugLines: string[] = [];
    private readonly environment: Map<string, string>;
    private readonly runner: MemoryTree["run"];
    private readonly fetcher: MemoryTree["fetch"];

    constructor(tree: MemoryTree = {}) {
        this.home = tree.home ?? "/home/user";
        this.platform = tree.platform ?? "linux";
        this.environment = new Map(Object.entries({ HOME: this.home, PATH: "/usr/bin:/bin", ...tree.env }));
        this.runner = tree.run;
        this.fetcher = tree.fetch;
        for (const [path, text] of Object.entries(tree.files ?? {})) this.writeFile(path, text);
        for (const dir of tree.dirs ?? []) this.addDir(dir);
        for (const [link, target] of Object.entries(tree.links ?? {})) {
            this.links.set(normpath(link), target);
            this.addDir(dirname(normpath(link)));
        }
    }

    writeFile(path: string, text: string): void {
        const normalized = normpath(path);
        this.files.set(normalized, text);
        this.addDir(dirname(normalized));
    }

    addDir(path: string): void {
        let current = normpath(path);
        while (!this.dirs.has(current)) {
            this.dirs.add(current);
            const parent = dirname(current);
            if (parent === current) break;
            current = parent;
        }
    }

    env(name: string): string | undefined {
        return this.environment.get(name);
    }

    private resolveLinks(path: string, depth = 0): string {
        const normalized = normpath(path);
        if (depth > 16) return normalized;
        const parts = normalized.split("/").filter((part) => part !== "");
        let current = "/";
        for (const part of parts) {
            current = current === "/" ? `/${part}` : `${current}/${part}`;
            const target = this.links.get(current);
            if (target !== undefined) {
                const absolute = target.startsWith("/") ? target : normpath(`${dirname(current)}/${target}`);
                const rest = normalized.slice(current.length);
                return this.resolveLinks(absolute + rest, depth + 1);
            }
        }
        return current;
    }

    async stat(path: string): Promise<FileStat | undefined> {
        const normalized = normpath(path);
        const isLink = this.links.has(normalized);
        const real = this.resolveLinks(normalized);
        const text = this.files.get(real);
        if (text !== undefined) return { kind: "file", size: new TextEncoder().encode(text).length, isLink };
        if (this.dirs.has(real)) return { kind: "dir", size: 0, isLink };
        return isLink ? { kind: "other", size: 0, isLink } : undefined;
    }

    async realPath(path: string): Promise<string> {
        return this.resolveLinks(path);
    }

    async readText(path: string, maxBytes: number): Promise<string | undefined> {
        const text = this.files.get(this.resolveLinks(path));
        if (text === undefined) return undefined;
        return new TextEncoder().encode(text).length > maxBytes ? undefined : text;
    }

    async list(path: string): Promise<readonly DirEntry[] | undefined> {
        const directory = this.resolveLinks(path);
        if (!this.dirs.has(directory)) return undefined;
        const prefix = directory === "/" ? "/" : `${directory}/`;
        const names = new Map<string, DirEntry>();
        const childOf = (full: string): string | undefined => {
            if (!full.startsWith(prefix) || full === directory) return undefined;
            const rest = full.slice(prefix.length);
            return rest.includes("/") ? undefined : rest;
        };
        for (const full of this.files.keys()) {
            const name = childOf(full);
            if (name !== undefined) names.set(name, { name, kind: "file", isLink: false });
        }
        for (const full of this.dirs) {
            const name = childOf(full);
            if (name !== undefined) names.set(name, { name, kind: "dir", isLink: false });
        }
        for (const full of this.links.keys()) {
            const name = childOf(full);
            if (name === undefined) continue;
            const stat = await this.stat(full);
            names.set(name, { name, kind: stat?.kind ?? "other", isLink: true });
        }
        return [...names.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }

    async run(argv: readonly string[], options?: RunOptions): Promise<RunResult | undefined> {
        return this.runner?.(argv, options);
    }

    async fetch(url: string, request: HttpRequest): Promise<HttpReply | undefined> {
        return this.fetcher?.(url, request);
    }

    async appendText(path: string, text: string): Promise<void> {
        this.appended.push(`${path}\n${text}`);
        this.writeFile(path, (this.files.get(normpath(path)) ?? "") + text);
    }

    now(): number {
        return 1_700_000_000_000;
    }

    debug(message: string): void {
        this.debugLines.push(message);
    }
}

export function memoryHost(tree: MemoryTree = {}): MemoryHost {
    return new MemoryHost(tree);
}
