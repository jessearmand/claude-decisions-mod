/**
 * The `Host` for Node: the vitest suite, the replay and probe scripts, and
 * any CLI use. Never imported by the hooks module, which has no Node.
 */

import { spawn } from "node:child_process";
import {
    appendFileSync,
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readSync,
    realpathSync,
    statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type {
    DirEntry,
    FileKind,
    FileStat,
    Host,
    HttpReply,
    HttpRequest,
    RunOptions,
    RunResult,
} from "./host.ts";

function kindOf(stat: { isFile(): boolean; isDirectory(): boolean }): FileKind {
    return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
}

export class NodeHost implements Host {
    readonly home: string;
    readonly platform: Host["platform"];
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly debugLines: string[] = [];

    constructor(options: { home?: string; env?: Record<string, string | undefined> } = {}) {
        this.environment = options.env ?? process.env;
        this.home = options.home ?? this.environment.HOME ?? homedir();
        this.platform =
            process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "other";
    }

    env(name: string): string | undefined {
        return this.environment[name];
    }

    async stat(path: string): Promise<FileStat | undefined> {
        try {
            const link = lstatSync(path);
            if (!link.isSymbolicLink())
                return { kind: kindOf(link), size: link.isFile() ? link.size : 0, isLink: false };
            try {
                const target = statSync(path);
                return { kind: kindOf(target), size: target.isFile() ? target.size : 0, isLink: true };
            } catch {
                return { kind: "other", size: 0, isLink: true };
            }
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
                const resolved = realpathSync.native(head);
                return tail ? `${resolved.replace(/\/$/, "")}/${tail}` : resolved;
            } catch {
                const parent = dirname(head);
                const name = head.slice(parent.length).replace(/^\//, "");
                tail = tail ? `${name}/${tail}` : name;
                if (parent === head) return path;
                head = parent;
            }
        }
        return path;
    }

    async readText(path: string, maxBytes: number): Promise<string | undefined> {
        try {
            const stat = statSync(path);
            if (!stat.isFile() || stat.size > maxBytes) return undefined;
            const fd = openSync(path, "r");
            try {
                const buffer = Buffer.alloc(stat.size);
                readSync(fd, buffer, 0, stat.size, 0);
                return new TextDecoder("utf-8").decode(buffer);
            } finally {
                closeSync(fd);
            }
        } catch {
            return undefined;
        }
    }

    async list(path: string): Promise<readonly DirEntry[] | undefined> {
        try {
            const entries = readdirSync(path, { withFileTypes: true });
            return entries
                .map((entry): DirEntry => {
                    if (!entry.isSymbolicLink())
                        return { name: entry.name, kind: kindOf(entry), isLink: false };
                    try {
                        return {
                            name: entry.name,
                            kind: kindOf(statSync(`${path}/${entry.name}`)),
                            isLink: true,
                        };
                    } catch {
                        return { name: entry.name, kind: "other", isLink: true };
                    }
                })
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        } catch {
            return undefined;
        }
    }

    run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult | undefined> {
        return new Promise((resolve) => {
            const [program, ...args] = argv;
            if (program === undefined) return resolve(undefined);
            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(program, args, {
                    cwd: options.cwd,
                    env: options.env ? { ...process.env, ...options.env } : process.env,
                    stdio: ["pipe", "pipe", "pipe"],
                });
            } catch {
                return resolve(undefined);
            }
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                resolve(undefined);
            }, options.timeoutMs ?? 30_000);
            child.on("error", () => {
                clearTimeout(timer);
                resolve(undefined);
            });
            child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
            child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
            child.on("close", (code) => {
                clearTimeout(timer);
                resolve({
                    exitCode: code ?? -1,
                    stdout: Buffer.concat(stdout).toString("utf-8"),
                    stderr: Buffer.concat(stderr).toString("utf-8"),
                });
            });
            if (options.stdin !== undefined) child.stdin?.end(options.stdin);
            else child.stdin?.end();
        });
    }

    async fetch(url: string, request: HttpRequest): Promise<HttpReply | undefined> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 10_000);
        try {
            const response = await fetch(url, {
                method: request.method ?? "GET",
                headers: request.headers,
                body: request.body,
                signal: controller.signal,
            });
            return { status: response.status, ok: response.ok, text: await response.text() };
        } catch {
            return undefined;
        } finally {
            clearTimeout(timer);
        }
    }

    async appendText(path: string, text: string): Promise<void> {
        try {
            const directory = dirname(path);
            if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
            appendFileSync(path, text, { encoding: "utf-8" });
        } catch {
            // logging must never break a guard
        }
    }

    now(): number {
        return Date.now();
    }

    debug(message: string): void {
        this.debugLines.push(message);
        if (process.env.HOOKS_DEBUG) process.stderr.write(`${message}\n`);
    }
}

export function nodeHost(
    options: { home?: string; env?: Record<string, string | undefined> } = {},
): NodeHost {
    return new NodeHost(options);
}
