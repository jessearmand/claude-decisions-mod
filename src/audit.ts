/**
 * The guards' audit log: one JSONL record per decision, one file per day,
 * under `~/.claude/hooks-logs` unless HOOKS_LOG_DIR, a guard's own *_LOG_DIR
 * or the `logDir` option says otherwise (hook_protocol.log_event).
 *
 * Logging never throws and never blocks a decision: a failure to write is
 * swallowed, as the Python hooks swallowed OSError.
 */

import type { Host } from "./host/host.ts";
import { join } from "./util/paths.ts";

export type AuditPayload = Readonly<Record<string, unknown>>;

export interface AuditOptions {
    /** The `logDir` userConfig option, when set to a non-empty string. */
    readonly logDir?: string;
}

export function logDirectory(
    host: Host,
    dirEnvNames: readonly string[] = [],
    options: AuditOptions = {},
): string {
    for (const name of [...dirEnvNames, "HOOKS_LOG_DIR"]) {
        const value = host.env(name);
        if (value) return value;
    }
    if (options.logDir) return options.logDir;
    return join(host.home, ".claude", "hooks-logs");
}

/** Append one JSONL record. Never rejects: logging must not break a hook. */
export async function logEvent(
    host: Host,
    hook: string,
    payload: AuditPayload,
    dirEnvNames: readonly string[] = [],
    options: AuditOptions = {},
): Promise<void> {
    try {
        const now = new Date(host.now());
        const record = { ts: now.toISOString(), hook, ...payload };
        const day = now.toISOString().slice(0, 10);
        await host.appendText(
            join(logDirectory(host, dirEnvNames, options), `${day}.jsonl`),
            `${JSON.stringify(record)}\n`,
        );
    } catch {
        // never raise from logging
    }
}
