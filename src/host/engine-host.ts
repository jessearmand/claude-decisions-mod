/**
 * The `Host` inside Claude Code: every call goes through the engine's `$`.
 *
 * Built once per hooks-module load (`engineHost($)` in `register`); the
 * environment snapshot is taken then, with the literal names the engine
 * requires (`$.env.get` refuses a name the module does not spell).
 *
 * The engine reads a hooks module's source to list what it calls on `$`, so
 * `$` is only ever spelled `$.noun.method(...)` or passed to a function
 * declared at the top of a file: no class holds it, no closure returns it.
 */

import type { EngineInterface } from "claude-code";
import { dirname } from "../util/paths.ts";
import type { DirEntry, FileStat, Host, HttpReply, HttpRequest, RunOptions, RunResult } from "./host.ts";
import { KNOWN_ENV_NAMES } from "./host.ts";

async function snapshotEnvironment($: EngineInterface): Promise<Map<string, string>> {
    const environment = new Map<string, string>();
    const put = (name: string, value: string | undefined): void => {
        if (value !== undefined) environment.set(name, value);
    };
    // One literal call per name in KNOWN_ENV_NAMES: the engine lists what a module reads
    // off its source, so a loop over the list is refused (env-names.spec.ts keeps them in step).
    put("HOME", await $.env.get("HOME").catch(() => undefined));
    put("PATH", await $.env.get("PATH").catch(() => undefined));
    put("TMPDIR", await $.env.get("TMPDIR").catch(() => undefined));
    put("CLAUDE_CONFIG_DIR", await $.env.get("CLAUDE_CONFIG_DIR").catch(() => undefined));
    put("CODEX_HOME", await $.env.get("CODEX_HOME").catch(() => undefined));
    put("XDG_CONFIG_HOME", await $.env.get("XDG_CONFIG_HOME").catch(() => undefined));
    put("GIT_CONFIG_GLOBAL", await $.env.get("GIT_CONFIG_GLOBAL").catch(() => undefined));
    put("GIT_CONFIG_SYSTEM", await $.env.get("GIT_CONFIG_SYSTEM").catch(() => undefined));
    put("GIT_DIR", await $.env.get("GIT_DIR").catch(() => undefined));
    put("GIT_COMMON_DIR", await $.env.get("GIT_COMMON_DIR").catch(() => undefined));
    put("GIT_WORK_TREE", await $.env.get("GIT_WORK_TREE").catch(() => undefined));
    put("GIT_NAMESPACE", await $.env.get("GIT_NAMESPACE").catch(() => undefined));
    put("HOOKS_LOG_DIR", await $.env.get("HOOKS_LOG_DIR").catch(() => undefined));
    put("HOOK_UNATTENDED_KEEP_ASK", await $.env.get("HOOK_UNATTENDED_KEEP_ASK").catch(() => undefined));
    put("HOOK_ASK_CRITICAL", await $.env.get("HOOK_ASK_CRITICAL").catch(() => undefined));
    put("HOOK_ASK_HIGH", await $.env.get("HOOK_ASK_HIGH").catch(() => undefined));
    put("HOOK_ASK_STRICT", await $.env.get("HOOK_ASK_STRICT").catch(() => undefined));
    put("HOOK_JEV_ENABLE", await $.env.get("HOOK_JEV_ENABLE").catch(() => undefined));
    put("HOOK_JEV_MODEL", await $.env.get("HOOK_JEV_MODEL").catch(() => undefined));
    put("HOOK_JEV_TIMEOUT", await $.env.get("HOOK_JEV_TIMEOUT").catch(() => undefined));
    put("HOOK_JEV_FNOX_CONFIG", await $.env.get("HOOK_JEV_FNOX_CONFIG").catch(() => undefined));
    put("HOOK_JEV_DEBUG", await $.env.get("HOOK_JEV_DEBUG").catch(() => undefined));
    put("HOOK_JEV_GATEWAY_URL", await $.env.get("HOOK_JEV_GATEWAY_URL").catch(() => undefined));
    put("AI_GATEWAY_API_KEY", await $.env.get("AI_GATEWAY_API_KEY").catch(() => undefined));
    put("VERCEL_OIDC_TOKEN", await $.env.get("VERCEL_OIDC_TOKEN").catch(() => undefined));
    put("BASH_RISK_JUDGE_DISABLE", await $.env.get("BASH_RISK_JUDGE_DISABLE").catch(() => undefined));
    put(
        "BASH_RISK_JUDGE_ASK_THRESHOLD",
        await $.env.get("BASH_RISK_JUDGE_ASK_THRESHOLD").catch(() => undefined),
    );
    put("BASH_RISK_JUDGE_LOG_DIR", await $.env.get("BASH_RISK_JUDGE_LOG_DIR").catch(() => undefined));
    put("BASH_RISK_JUDGE_CONTEXT", await $.env.get("BASH_RISK_JUDGE_CONTEXT").catch(() => undefined));
    put(
        "BASH_RISK_JUDGE_TRUST_TRUNCATED",
        await $.env.get("BASH_RISK_JUDGE_TRUST_TRUNCATED").catch(() => undefined),
    );
    put(
        "BASH_RISK_JUDGE_UNATTENDED_DENY",
        await $.env.get("BASH_RISK_JUDGE_UNATTENDED_DENY").catch(() => undefined),
    );
    put(
        "BASH_COMMAND_VALIDATOR_DISABLE",
        await $.env.get("BASH_COMMAND_VALIDATOR_DISABLE").catch(() => undefined),
    );
    put("RM_RF_GUARD_DISABLE", await $.env.get("RM_RF_GUARD_DISABLE").catch(() => undefined));
    put("FILE_PROTECTION_DISABLE", await $.env.get("FILE_PROTECTION_DISABLE").catch(() => undefined));
    put("FILE_PROTECTION_ASK", await $.env.get("FILE_PROTECTION_ASK").catch(() => undefined));
    put("FILE_PROTECTION_LOG_DIR", await $.env.get("FILE_PROTECTION_LOG_DIR").catch(() => undefined));
    put("SECRETS_GUARD_DISABLE", await $.env.get("SECRETS_GUARD_DISABLE").catch(() => undefined));
    put("SECRETS_GUARD_LEVEL", await $.env.get("SECRETS_GUARD_LEVEL").catch(() => undefined));
    put("SECRETS_GUARD_LOG_DIR", await $.env.get("SECRETS_GUARD_LOG_DIR").catch(() => undefined));
    put("DANGEROUS_COMMANDS_DISABLE", await $.env.get("DANGEROUS_COMMANDS_DISABLE").catch(() => undefined));
    put("DANGEROUS_COMMANDS_LEVEL", await $.env.get("DANGEROUS_COMMANDS_LEVEL").catch(() => undefined));
    put("DANGEROUS_COMMANDS_ASK", await $.env.get("DANGEROUS_COMMANDS_ASK").catch(() => undefined));
    put("DANGEROUS_COMMANDS_LOG_DIR", await $.env.get("DANGEROUS_COMMANDS_LOG_DIR").catch(() => undefined));
    put("CONFIG_GUARD_DISABLE", await $.env.get("CONFIG_GUARD_DISABLE").catch(() => undefined));
    put("CONFIG_GUARD_ASK", await $.env.get("CONFIG_GUARD_ASK").catch(() => undefined));
    put("CONFIG_GUARD_LOG_DIR", await $.env.get("CONFIG_GUARD_LOG_DIR").catch(() => undefined));
    put("CONFIG_GUARD_LIVE_DIRS", await $.env.get("CONFIG_GUARD_LIVE_DIRS").catch(() => undefined));
    return environment;
}

async function homeFromCwd($: EngineInterface): Promise<string> {
    const cwd = await $.session.cwd().catch(() => "/");
    const match = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?:\/|$)/.exec(cwd);
    return match?.[1] ?? "/";
}

async function platformOf($: EngineInterface): Promise<Host["platform"]> {
    if (await $.fs.exists("/System/Library/CoreServices").catch(() => false)) return "darwin";
    if (await $.fs.exists("/proc/version").catch(() => false)) return "linux";
    return "other";
}

async function statPath($: EngineInterface, path: string): Promise<FileStat | undefined> {
    try {
        const stat = await $.fs.stat(path);
        return { kind: stat.kind, size: stat.size, isLink: stat.isLink };
    } catch {
        return undefined;
    }
}

/** os.path.realpath semantics: resolve what exists, keep the rest as spelled. */
async function realPathOf($: EngineInterface, path: string): Promise<string> {
    let head = path;
    let tail = "";
    for (let depth = 0; depth < 256; depth += 1) {
        try {
            const stat = await $.fs.stat(head, { resolve: true });
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

async function readTextOf($: EngineInterface, path: string, maxBytes: number): Promise<string | undefined> {
    const stat = await statPath($, path);
    if (stat === undefined || stat.kind !== "file" || stat.size > maxBytes) return undefined;
    try {
        const { base64 } = await $.fs.read(path, { as: "bytes" });
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return new TextDecoder("utf-8").decode(bytes);
    } catch {
        return undefined;
    }
}

async function listDirectory($: EngineInterface, path: string): Promise<readonly DirEntry[] | undefined> {
    try {
        const entries = await $.fs.list(path);
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

async function runProcess(
    $: EngineInterface,
    argv: readonly string[],
    options: RunOptions = {},
): Promise<RunResult | undefined> {
    try {
        const result = await $.process.run(argv, {
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

async function fetchUrl(
    $: EngineInterface,
    url: string,
    request: HttpRequest,
): Promise<HttpReply | undefined> {
    const timeoutMs = request.timeoutMs ?? 10_000;
    const stop = new AbortController();
    const deadline = $.clock
        .sleep(timeoutMs, { signal: stop.signal })
        .then(() => undefined)
        .catch(() => undefined);
    const call = $.http
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

/** The engine's fs has no append: read what is there (bounded) and write it back. */
async function appendTextTo($: EngineInterface, path: string, text: string): Promise<void> {
    try {
        const stat = await statPath($, path);
        const existing = stat !== undefined && stat.size <= 3 * 1024 * 1024 ? await $.fs.read(path) : "";
        await $.fs.write(path, existing + text);
    } catch {
        $.ui.log(`decisions-guard: could not append to ${path}`, { to: "debug" });
    }
}

function debugLine($: EngineInterface, message: string): void {
    $.ui.log(message, { to: "debug" });
}

/** Builds the host for a hooks module; the one async step is the environment snapshot. */
export async function engineHost($: EngineInterface): Promise<Host> {
    const environment = await snapshotEnvironment($);
    const home = environment.get("HOME") ?? (await homeFromCwd($));
    const platform = await platformOf($);
    return {
        home,
        platform,
        env: (name) => environment.get(name),
        stat: (path) => statPath($, path),
        realPath: (path) => realPathOf($, path),
        readText: (path, maxBytes) => readTextOf($, path, maxBytes),
        list: (path) => listDirectory($, path),
        run: (argv, options) => runProcess($, argv, options),
        fetch: (url, request) => fetchUrl($, url, request),
        appendText: (path, text) => appendTextTo($, path, text),
        now: () => Date.now(),
        debug: (message) => debugLine($, message),
    };
}
