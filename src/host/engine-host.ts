/**
 * The `Host` inside Claude Code: every call goes through the engine's `$`.
 *
 * Built once per hooks-module load (`engineHost($)` in `register`); the
 * environment snapshot is taken then, with the literal names the engine
 * requires (`$.env.get` refuses a name the module does not spell).
 */

import type { EngineInterface } from "claude-code";
import { dirname } from "../util/paths.ts";
import type { DirEntry, FileStat, Host, HttpReply, HttpRequest, RunOptions, RunResult } from "./host.ts";
import { KNOWN_ENV_NAMES } from "./host.ts";

export class EngineHost implements Host {
    readonly home: string;
    readonly platform: Host["platform"];
    private readonly environment: ReadonlyMap<string, string>;

    private constructor(
        private readonly $: EngineInterface,
        home: string,
        platform: Host["platform"],
        environment: ReadonlyMap<string, string>,
    ) {
        this.home = home;
        this.platform = platform;
        this.environment = environment;
    }

    /** Snapshots the environment the module reads; the only async step of construction. */
    static async create($: EngineInterface): Promise<EngineHost> {
        const environment = new Map<string, string>();
        for (const name of KNOWN_ENV_NAMES) {
            const value = await $.env.get(name).catch(() => undefined);
            if (value !== undefined) environment.set(name, value);
        }
        const home = environment.get("HOME") ?? (await EngineHost.homeFromCwd($));
        const platform = await EngineHost.platformOf($);
        return new EngineHost($, home, platform, environment);
    }

    private static async homeFromCwd($: EngineInterface): Promise<string> {
        const cwd = await $.session.cwd().catch(() => "/");
        const match = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?:\/|$)/.exec(cwd);
        return match?.[1] ?? "/";
    }

    private static async platformOf($: EngineInterface): Promise<Host["platform"]> {
        if (await $.fs.exists("/System/Library/CoreServices").catch(() => false)) return "darwin";
        if (await $.fs.exists("/proc/version").catch(() => false)) return "linux";
        return "other";
    }

    env(name: string): string | undefined {
        return this.environment.get(name);
    }

    async stat(path: string): Promise<FileStat | undefined> {
        try {
            const stat = await this.$.fs.stat(path);
            return { kind: stat.kind, size: stat.size, isLink: stat.isLink };
        } catch {
            return undefined;
        }
    }

    async realPath(path: string): Promise<string> {
        // os.path.realpath semantics: resolve what exists, keep the rest as spelled.
        let head = path;
        let tail = "";
        for (let depth = 0; depth < 256; depth += 1) {
            try {
                const stat = await this.$.fs.stat(head, { resolve: true });
                if (stat.realPath !== undefined) {
                    return tail ? `${stat.realPath.replace(/\/$/, "")}/${tail}` : stat.realPath;
                }
            } catch {
                // fall through to the parent
            }
            const parent = dirname(head);
            if (parent === head) return path;
            const name = head.slice(parent.length).replace(/^\//, "");
            tail = tail ? `${name}/${tail}` : name;
            head = parent;
        }
        return path;
    }

    async readText(path: string, maxBytes: number): Promise<string | undefined> {
        const stat = await this.stat(path);
        if (stat === undefined || stat.kind !== "file" || stat.size > maxBytes) return undefined;
        try {
            const { base64 } = await this.$.fs.read(path, { as: "bytes" });
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            return new TextDecoder("utf-8").decode(bytes);
        } catch {
            return undefined;
        }
    }

    async list(path: string): Promise<readonly DirEntry[] | undefined> {
        try {
            const entries = await this.$.fs.list(path);
            return entries
                .map(
                    (entry): DirEntry => ({
                        name: entry.name,
                        kind: entry.kind === "file" || entry.kind === "dir" ? entry.kind : "other",
                        isLink: entry.isLink,
                    }),
                )
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        } catch {
            return undefined;
        }
    }

    async run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult | undefined> {
        try {
            const result = await this.$.process.run(argv, {
                cwd: options.cwd,
                env: options.env ? { ...options.env } : undefined,
                stdin: options.stdin,
                timeoutMs: options.timeoutMs ?? 5_000,
            });
            return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        } catch {
            return undefined;
        }
    }

    async fetch(url: string, request: HttpRequest): Promise<HttpReply | undefined> {
        const timeoutMs = request.timeoutMs ?? 10_000;
        const stop = new AbortController();
        const deadline = this.$.clock
            .sleep(timeoutMs, { signal: stop.signal })
            .then(() => undefined)
            .catch(() => undefined);
        const call = this.$.http
            .fetch(url, {
                method: request.method ?? "GET",
                headers: request.headers ? { ...request.headers } : undefined,
                body: request.body,
            })
            .then((reply) => ({ status: reply.status, ok: reply.ok, text: reply.text }))
            .catch(() => undefined);
        try {
            return await Promise.race([call, deadline]);
        } finally {
            stop.abort();
        }
    }

    async appendText(path: string, text: string): Promise<void> {
        // The engine's fs has no append: read what is there (bounded) and write it back.
        try {
            const stat = await this.stat(path);
            const existing =
                stat !== undefined && stat.size <= 3 * 1024 * 1024 ? await this.$.fs.read(path) : "";
            await this.$.fs.write(path, existing + text);
        } catch {
            this.$.ui.log(`decisions-guard: could not append to ${path}`, { to: "debug" });
        }
    }

    now(): number {
        return Date.now();
    }

    debug(message: string): void {
        this.$.ui.log(message, { to: "debug" });
    }
}

export const engineHost = EngineHost.create;
