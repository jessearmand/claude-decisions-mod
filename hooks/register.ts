/**
 * decisions-guard: the hooks module Claude Code loads.
 *
 * Every tool call passes through `classic.PreToolUse`, where the guard chain
 * answers `{ deny }`, `{ ask }` or hands the call on to the normal permission
 * flow, exactly as the Python settings hooks did through their stdout JSON.
 * The chain runs the deterministic guards first and the Jev judge only when
 * nothing deterministic decided (src/chain.ts).
 *
 * A guard that throws is caught by the chain and denies; should the module
 * itself fail (a `$` call rejecting, a bug outside the chain), `.catch`
 * denies too, so a broken guard never lets a call through unexamined.
 */

import type { EngineInterface, PluginOptions, Register, ToolCallEnvelope } from "claude-code";
import { type Chain, decide } from "../src/chain.ts";
import { type Config, overriddenOptions, resolveConfig } from "../src/config.ts";
import type { HookInput } from "../src/decision.ts";
import { bashCommandValidator } from "../src/guards/bash-command-validator.ts";
import { configGuard } from "../src/guards/config-guard.ts";
import { dangerousCommands } from "../src/guards/dangerous-commands.ts";
import { fileProtection } from "../src/guards/file-protection.ts";
import { sourcesWithGitAliases } from "../src/guards/git-aliases.ts";
import type { GuardDeps } from "../src/guards/guard.ts";
import { rmRfGuard } from "../src/guards/rm-rf-guard.ts";
import { secretsGuard } from "../src/guards/secrets-guard.ts";
import { engineHost } from "../src/host/engine-host.ts";
import { engineTranscriptReader } from "../src/host/engine-transcript.ts";
import type { Host } from "../src/host/host.ts";
import { bashRiskJudge } from "../src/judge/bash-risk-judge.ts";
import { onceEach } from "../src/notices.ts";
import { normpath } from "../src/util/paths.ts";

const PLUGIN = "decisions-guard";

/** The Python hooks' order in settings.template.json; a deny from any wins, so order only shapes the audit log. */
const CHAIN: Chain = {
    guards: [rmRfGuard, dangerousCommands, bashCommandValidator, secretsGuard, configGuard, fileProtection],
    judge: bashRiskJudge,
};

interface Runtime {
    readonly host: Host;
    readonly config: Config;
    readonly deps: GuardDeps;
    /** Notices already shown since the module loaded, so a failure that repeats each call is shown once. */
    readonly shown: Set<string>;
}

/** `deps` for one call, with notices going to this call's session. */
function withNotices($: EngineInterface, { deps, shown }: Runtime): GuardDeps {
    return { ...deps, notify: onceEach((message) => $.ui.log(`${PLUGIN}: ${message}`), shown) };
}

async function build($: EngineInterface, options: PluginOptions): Promise<Runtime> {
    const host = await engineHost($);
    const resolved = resolveConfig(host, options);
    // The running guard code lives in the plugin's own folder: writes there are
    // asked about, as the Python guard did for its own checkout.
    const config: Config = {
        ...resolved,
        configGuard: { ...resolved.configGuard, liveDirs: [...resolved.configGuard.liveDirs, $.plugin.root] },
    };
    return {
        host,
        config,
        deps: { host, config, sources: sourcesWithGitAliases, transcript: engineTranscriptReader($) },
        shown: new Set(),
    };
}

/** The permission mode, as far as the settings say: `permissions.defaultMode`. */
async function permissionMode($: EngineInterface): Promise<string | undefined> {
    try {
        const settings = await $.settings.read();
        const permissions = settings.permissions;
        if (permissions && typeof permissions === "object" && "defaultMode" in permissions) {
            const mode = (permissions as { defaultMode?: unknown }).defaultMode;
            return typeof mode === "string" ? mode : undefined;
        }
    } catch {
        // no settings: the mode is unknown
    }
    return undefined;
}

async function hookInput($: EngineInterface, e: ToolCallEnvelope): Promise<HookInput> {
    const {
        tool,
        tool_use_id: _id,
        ...rest
    } = e as ToolCallEnvelope & { tool_use_id?: string; consent?: string };
    const toolInput: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) if (key !== "consent") toolInput[key] = value;
    const [cwd, mode, sessionId] = await Promise.all([
        $.session.cwd().catch(() => "/"),
        permissionMode($),
        $.session.id().catch(() => undefined),
    ]);
    return { toolName: tool, toolInput, cwd: normpath(cwd), permissionMode: mode, sessionId };
}

let runtime: Promise<Runtime> | undefined;
let pluginOptions: PluginOptions = {};

/** The runtime, built once per module load on first use. */
function ready($: EngineInterface): Promise<Runtime> {
    runtime ??= build($, pluginOptions);
    return runtime;
}

/**
 * Snapshot the environment and settings before the first tool call, and say
 * which options an environment variable overrides.
 */
async function warm($: EngineInterface): Promise<void> {
    try {
        const { host } = await ready($);
        for (const warning of overriddenOptions(host, pluginOptions)) $.ui.log(`${PLUGIN}: ${warning}`);
    } catch (error) {
        $.ui.log(`${PLUGIN}: setup failed: ${String(error)}`, { to: "debug" });
    }
}

export const register: Register = (on, options) => {
    pluginOptions = options;
    runtime = undefined;

    on("session.start", async ($, e, next) => {
        void warm($);
        return next(e);
    });

    on("classic.PreToolUse", async ($, e, next) => {
        const deps = withNotices($, await ready($));
        const input = await hookInput($, e);
        const outcome = await decide(CHAIN, input, deps);
        for (const [guard, error] of outcome.errors)
            $.ui.log(`${PLUGIN}: ${guard} failed: ${error}`, { to: "debug" });
        const verdict = outcome.decision;
        if (verdict === undefined) return next(e);
        if (verdict.systemMessage) $.ui.log(verdict.systemMessage);
        return verdict.decision === "deny" ? { deny: verdict.reason } : { ask: verdict.reason };
    }).catch((_$, e, next) =>
        next.called
            ? next(e)
            : {
                  deny:
                      `${PLUGIN}: the guards could not check this call (${next.error?.message ?? "unknown error"}); ` +
                      "it is denied rather than run unexamined. Report the error and ask the user how to proceed.",
              },
    );
};
