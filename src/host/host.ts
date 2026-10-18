/**
 * Everything the guards and the parser need from the world outside their own
 * code, behind one asynchronous interface.
 *
 * A mod's hooks module runs with no Node and no DOM: files, the environment,
 * processes and the network are reached through the engine's `$`. The Python
 * hooks called `os.path.isdir`, `glob.glob`, `open()` and `os.environ` wherever
 * they liked; here every such call goes through a `Host`, so the same code
 * runs inside Claude Code (`engineHost($)`), under Node for the test suite and
 * the scripts (`nodeHost()`), and against an in-memory tree (`memoryHost()`).
 *
 * No method ever throws for an ordinary failure (a missing file, a denied
 * read, a process that is not installed): each answers `undefined` instead,
 * the way the Python code swallowed `OSError`. A guard that cannot read a
 * file must then decide conservatively, never crash.
 */

export type FileKind = "file" | "dir" | "other";

export interface FileStat {
    /** What the path leads to, links followed; a link that leads nowhere is `other`. */
    readonly kind: FileKind;
    /** Bytes, for a regular file; 0 otherwise. */
    readonly size: number;
    /** True when the path itself is a symbolic link. */
    readonly isLink: boolean;
}

export interface DirEntry {
    readonly name: string;
    /** What the entry leads to, links followed. */
    readonly kind: FileKind;
    readonly isLink: boolean;
}

export interface RunResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface RunOptions {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly stdin?: string;
    readonly timeoutMs?: number;
}

export interface HttpRequest {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    /** The whole request, connection included, must finish inside this. */
    readonly timeoutMs?: number;
}

export interface HttpReply {
    readonly status: number;
    readonly ok: boolean;
    readonly text: string;
}

export interface Host {
    /** The user's home directory, absolute, what `~` expands to. */
    readonly home: string;
    /** `darwin`, `linux` or `other`; case-insensitive file systems are assumed on darwin only. */
    readonly platform: "darwin" | "linux" | "other";
    /**
     * A variable of the process environment, or `undefined` when unset.
     *
     * Inside Claude Code the engine reads only names the module spells as
     * literals, so `engineHost` takes a snapshot of the names in
     * `KNOWN_ENV_NAMES` at load and answers everything else from that; a
     * name outside the snapshot is `undefined` there. Under Node it is
     * `process.env`.
     */
    env(name: string): string | undefined;
    /** `stat`, links followed; `undefined` when the path does not exist or cannot be read. */
    stat(path: string): Promise<FileStat | undefined>;
    /**
     * `os.path.realpath`: every symbolic link and `..` resolved, for as much
     * of the path as exists; the rest is appended as spelled. Never fails.
     */
    realPath(path: string): Promise<string>;
    /**
     * The file's text, decoded as UTF-8 with replacement characters for stray
     * bytes, as bash reads a script. `undefined` when missing, not a regular
     * file, larger than `maxBytes` or unreadable.
     */
    readText(path: string, maxBytes: number): Promise<string | undefined>;
    /** The entries of a directory, or `undefined` when it is not a readable directory. */
    list(path: string): Promise<readonly DirEntry[] | undefined>;
    /**
     * Runs a program by argv (no shell) and answers its output, or `undefined`
     * when it cannot be started, is not installed, times out, or the host
     * forbids processes (a cloud session). Never used to run the command
     * under judgement: only to list archives, read git config and the like.
     */
    run(argv: readonly string[], options?: RunOptions): Promise<RunResult | undefined>;
    /** An HTTP request through the host; `undefined` on a network failure or timeout. */
    fetch(url: string, request: HttpRequest): Promise<HttpReply | undefined>;
    /** Appends one line of text to a file, creating it and its directory; never throws. */
    appendText(path: string, text: string): Promise<void>;
    /** Milliseconds since the epoch. */
    now(): number;
    /** A line for the debug log (`claude --debug`), never shown to the user. */
    debug(message: string): void;
}

/**
 * Every environment variable the guards read, so the engine host can snapshot
 * them with literal names. Keep this list in step with config.ts and the
 * guards; `claude plugin validate` lists what the module reads.
 */
export const KNOWN_ENV_NAMES = [
    "HOME",
    "PATH",
    "TMPDIR",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_NAMESPACE",
    "HOOKS_LOG_DIR",
    "HOOK_UNATTENDED_KEEP_ASK",
    "HOOK_ASK_CRITICAL",
    "HOOK_ASK_HIGH",
    "HOOK_ASK_STRICT",
    "HOOK_JEV_ENABLE",
    "HOOK_JEV_MODEL",
    "HOOK_JEV_TIMEOUT",
    "HOOK_JEV_FNOX_CONFIG",
    "HOOK_JEV_DEBUG",
    "HOOK_JEV_GATEWAY_URL",
    "AI_GATEWAY_API_KEY",
    "VERCEL_OIDC_TOKEN",
    "BASH_RISK_JUDGE_DISABLE",
    "BASH_RISK_JUDGE_ASK_THRESHOLD",
    "BASH_RISK_JUDGE_LOG_DIR",
    "BASH_RISK_JUDGE_CONTEXT",
    "BASH_RISK_JUDGE_TRUST_TRUNCATED",
    "BASH_RISK_JUDGE_UNATTENDED_DENY",
    "BASH_COMMAND_VALIDATOR_DISABLE",
    "RM_RF_GUARD_DISABLE",
    "FILE_PROTECTION_DISABLE",
    "FILE_PROTECTION_ASK",
    "FILE_PROTECTION_LOG_DIR",
    "SECRETS_GUARD_DISABLE",
    "SECRETS_GUARD_LEVEL",
    "SECRETS_GUARD_LOG_DIR",
    "DANGEROUS_COMMANDS_DISABLE",
    "DANGEROUS_COMMANDS_LEVEL",
    "DANGEROUS_COMMANDS_ASK",
    "DANGEROUS_COMMANDS_LOG_DIR",
    "CONFIG_GUARD_DISABLE",
    "CONFIG_GUARD_ASK",
    "CONFIG_GUARD_LOG_DIR",
    "CONFIG_GUARD_LIVE_DIRS",
] as const;

export type KnownEnvName = (typeof KNOWN_ENV_NAMES)[number];

/** True for 1/true/yes/on, case-insensitive (Python `env_flag`). */
export function envFlag(value: string | undefined): boolean {
    return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/** False for 0/false/no/off, case-insensitive; true otherwise (an opt-out flag that defaults on). */
export function envNotDisabled(value: string | undefined): boolean {
    return !["0", "false", "no", "off"].includes((value ?? "").trim().toLowerCase());
}
