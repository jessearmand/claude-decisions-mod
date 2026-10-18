/**
 * The guards' configuration: the mod's `userConfig` options, with the Python
 * hooks' environment variables honoured as overrides so an existing
 * `settings.json` `env` block keeps working.
 *
 * Every guard reads from a `Config` rather than the environment, so a test
 * can build one in a line and the engine host's literal-name snapshot
 * (host.ts KNOWN_ENV_NAMES) stays the one place environment names live.
 */

import { envFlag, envNotDisabled, type Host } from "./host/host.ts";

export type Level = "critical" | "high" | "strict";
export const LEVEL_ORDER: Readonly<Record<Level, number>> = { critical: 1, high: 2, strict: 3 };

export function isLevel(value: unknown): value is Level {
    return value === "critical" || value === "high" || value === "strict";
}

/** The raw `userConfig` values as `register(on, options)` receives them. */
export type RawOptions = Readonly<Record<string, string | number | boolean | readonly string[]>>;

export interface JudgeConfig {
    /** HOOK_JEV_ENABLE or the jevEnable option; off by default. */
    readonly enable: boolean;
    /** BASH_RISK_JUDGE_DISABLE: the judge hook off entirely. */
    readonly disable: boolean;
    readonly model: string;
    readonly timeoutSeconds: number;
    /** A bearer credential given directly (the sensitive option, AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN). */
    readonly apiKey: string | undefined;
    /** fnox.toml to read the key from when none is in the environment (HOOK_JEV_FNOX_CONFIG). */
    readonly fnoxConfig: string | undefined;
    readonly debug: boolean;
    readonly gatewayUrl: string;
    readonly askThreshold: number;
    /** BASH_RISK_JUDGE_CONTEXT: send the user's prompt, recent commands and sources along. */
    readonly context: boolean;
    /** BASH_RISK_JUDGE_TRUST_TRUNCATED: judge a partially read script instead of asking. */
    readonly trustTruncated: boolean;
    /** BASH_RISK_JUDGE_UNATTENDED_DENY: let the judge's ask become a deny when nobody can answer. */
    readonly unattendedDeny: boolean;
    readonly logDirEnv: readonly string[];
}

export interface Config {
    readonly rmRfGuard: { readonly disable: boolean };
    readonly commandValidator: { readonly disable: boolean };
    readonly fileProtection: {
        readonly disable: boolean;
        readonly ask: boolean;
        readonly logDirEnv: readonly string[];
    };
    readonly secretsGuard: {
        readonly disable: boolean;
        readonly level: Level;
        readonly logDirEnv: readonly string[];
    };
    readonly dangerousCommands: {
        readonly disable: boolean;
        readonly level: Level;
        readonly ask: boolean;
        readonly logDirEnv: readonly string[];
    };
    readonly configGuard: {
        readonly disable: boolean;
        readonly ask: boolean;
        /** Extra directories holding running guard code (CONFIG_GUARD_LIVE_DIRS, colon-separated). */
        readonly liveDirs: readonly string[];
        readonly logDirEnv: readonly string[];
    };
    readonly judge: JudgeConfig;
    /**
     * HOOK_ASK_CRITICAL / HOOK_ASK_HIGH / HOOK_ASK_STRICT: prompt for that tier instead of
     * denying; every tier when the askInsteadOfDeny option is on.
     */
    readonly askForLevel: Readonly<Record<Level, boolean>>;
    /** HOOK_UNATTENDED_KEEP_ASK or the option: leave asks alone under bypassPermissions/dontAsk. */
    readonly unattendedKeepAsk: boolean;
    /** The `logDir` option, or undefined for the default. */
    readonly logDir: string | undefined;
}

export const DEFAULT_GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/evaluate";
export const DEFAULT_JEV_MODEL = "typesafe-ai/jev";
export const DEFAULT_JEV_TIMEOUT_SECONDS = 5;
export const DEFAULT_ASK_THRESHOLD = 0.7;

function stringOption(options: RawOptions, key: string): string | undefined {
    const value = options[key];
    return typeof value === "string" && value !== "" ? value : undefined;
}

function booleanOption(options: RawOptions, key: string): boolean {
    const value = options[key];
    return typeof value === "boolean" ? value : typeof value === "string" ? envFlag(value) : false;
}

function numberOption(options: RawOptions, key: string): number | undefined {
    return numberValue(options[key]);
}

function numberValue(value: RawOptions[string] | undefined): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
        return Number(value);
    return undefined;
}

function levelOf(envValue: string | undefined, optionValue: string | undefined, fallback: Level): Level {
    const requested = (envValue ?? "").trim().toLowerCase();
    if (isLevel(requested)) return requested;
    return isLevel(optionValue) ? optionValue : fallback;
}

function numberOf(envValue: string | undefined, optionValue: number | undefined, fallback: number): number {
    if (envValue !== undefined && envValue.trim() !== "" && Number.isFinite(Number(envValue)))
        return Number(envValue);
    return optionValue ?? fallback;
}

/** How an option reads its value, so an environment value can be compared with it. */
type Reader = (value: RawOptions[string] | undefined) => string | number | undefined;

const readNumber: Reader = numberValue;
const readLevel: Reader = (value) => {
    const level = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    return isLevel(level) ? level : undefined;
};
const readString: Reader = (value) => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * Options an environment variable replaces outright, when both are set
 * (`resolveConfig`'s precedence). Flags are left out: either one turns them
 * on, so neither hides the other. The API key is left out: it is a secret.
 */
const ENV_OVERRIDES: ReadonlyArray<readonly [option: string, envName: string, read: Reader]> = [
    ["askThreshold", "BASH_RISK_JUDGE_ASK_THRESHOLD", readNumber],
    ["jevTimeoutSeconds", "HOOK_JEV_TIMEOUT", readNumber],
    ["jevModel", "HOOK_JEV_MODEL", readString],
    ["secretsLevel", "SECRETS_GUARD_LEVEL", readLevel],
    ["dangerousLevel", "DANGEROUS_COMMANDS_LEVEL", readLevel],
];

/**
 * One line per option set to a value that an environment variable replaces
 * with a different one, e.g. askThreshold 0.75 under
 * BASH_RISK_JUDGE_ASK_THRESHOLD=0.6. Empty when nothing is overridden.
 */
export function overriddenOptions(host: Host, options: RawOptions = {}): string[] {
    const found: string[] = [];
    for (const [option, envName, read] of ENV_OVERRIDES) {
        const fromEnv = read(host.env(envName));
        const fromOption = read(options[option]);
        if (fromEnv === undefined || fromOption === undefined || fromEnv === fromOption) continue;
        found.push(
            `the ${option} option (${fromOption}) is ignored: ${envName}=${fromEnv} in the environment ` +
                `overrides it. Remove one of them so they cannot disagree.`,
        );
    }
    return found;
}

/** Resolve the configuration from the userConfig options and the host's environment. */
export function resolveConfig(host: Host, options: RawOptions = {}): Config {
    const env = (name: string) => host.env(name);
    const askAll = booleanOption(options, "askInsteadOfDeny");
    const threshold = numberOf(
        env("BASH_RISK_JUDGE_ASK_THRESHOLD"),
        numberOption(options, "askThreshold"),
        DEFAULT_ASK_THRESHOLD,
    );
    const timeout = numberOf(
        env("HOOK_JEV_TIMEOUT"),
        numberOption(options, "jevTimeoutSeconds"),
        DEFAULT_JEV_TIMEOUT_SECONDS,
    );
    return {
        rmRfGuard: { disable: envFlag(env("RM_RF_GUARD_DISABLE")) },
        commandValidator: { disable: envFlag(env("BASH_COMMAND_VALIDATOR_DISABLE")) },
        fileProtection: {
            disable: envFlag(env("FILE_PROTECTION_DISABLE")),
            ask: askAll || envFlag(env("FILE_PROTECTION_ASK")),
            logDirEnv: ["FILE_PROTECTION_LOG_DIR"],
        },
        secretsGuard: {
            disable: envFlag(env("SECRETS_GUARD_DISABLE")),
            level: levelOf(env("SECRETS_GUARD_LEVEL"), stringOption(options, "secretsLevel"), "high"),
            logDirEnv: ["SECRETS_GUARD_LOG_DIR"],
        },
        dangerousCommands: {
            disable: envFlag(env("DANGEROUS_COMMANDS_DISABLE")),
            level: levelOf(env("DANGEROUS_COMMANDS_LEVEL"), stringOption(options, "dangerousLevel"), "high"),
            ask: askAll || envFlag(env("DANGEROUS_COMMANDS_ASK")),
            logDirEnv: ["DANGEROUS_COMMANDS_LOG_DIR"],
        },
        configGuard: {
            disable: envFlag(env("CONFIG_GUARD_DISABLE")),
            ask: askAll || envFlag(env("CONFIG_GUARD_ASK")),
            liveDirs: (env("CONFIG_GUARD_LIVE_DIRS") ?? "")
                .split(":")
                .map((dir) => dir.trim())
                .filter((dir) => dir !== ""),
            logDirEnv: ["CONFIG_GUARD_LOG_DIR"],
        },
        judge: {
            enable: envFlag(env("HOOK_JEV_ENABLE")) || booleanOption(options, "jevEnable"),
            disable: envFlag(env("BASH_RISK_JUDGE_DISABLE")),
            model: env("HOOK_JEV_MODEL") || stringOption(options, "jevModel") || DEFAULT_JEV_MODEL,
            timeoutSeconds: Math.max(1, timeout),
            apiKey:
                env("AI_GATEWAY_API_KEY") || env("VERCEL_OIDC_TOKEN") || stringOption(options, "jevApiKey"),
            fnoxConfig: env("HOOK_JEV_FNOX_CONFIG"),
            debug: envFlag(env("HOOK_JEV_DEBUG")),
            gatewayUrl: env("HOOK_JEV_GATEWAY_URL") || DEFAULT_GATEWAY_URL,
            askThreshold: Math.min(Math.max(threshold, 0), 1),
            context: envNotDisabled(env("BASH_RISK_JUDGE_CONTEXT")),
            trustTruncated: envFlag(env("BASH_RISK_JUDGE_TRUST_TRUNCATED")),
            unattendedDeny: envFlag(env("BASH_RISK_JUDGE_UNATTENDED_DENY")),
            logDirEnv: ["BASH_RISK_JUDGE_LOG_DIR"],
        },
        askForLevel: {
            critical: askAll || envFlag(env("HOOK_ASK_CRITICAL")),
            high: askAll || envFlag(env("HOOK_ASK_HIGH")),
            strict: askAll || envFlag(env("HOOK_ASK_STRICT")),
        },
        unattendedKeepAsk:
            envFlag(env("HOOK_UNATTENDED_KEEP_ASK")) || booleanOption(options, "unattendedKeepAsk"),
        logDir: stringOption(options, "logDir"),
    };
}
