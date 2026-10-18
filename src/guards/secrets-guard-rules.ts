/**
 * Rule tables for secrets-guard.ts (ported from secrets_guard_rules.py).
 *
 * Kept separate from the matching logic so the policy can be reviewed and edited
 * without reading any code:
 *
 *   SECRET_FILES     credential file paths, for Read / Edit / Write / Grep
 *   SECRET_COMMANDS  shell commands that read, mutate, or exfiltrate secrets
 *   ALLOWLIST        templates and examples that are never secrets
 *
 * Levels gate how much is enforced (see safetyLevel() in secrets-guard.ts):
 *   critical  SSH keys, cloud credentials, .env files
 *   high      + secrets files, env dumps, exfiltration attempts   <- default
 *   strict    + database configs and anything that might hold a secret
 *
 * Generated files that must not be hand-edited (lockfiles, .git/ internals) are a
 * separate concern and live in file-protection.ts.
 */

import type { Level } from "../config.ts";

export const CRITICAL: Level = "critical";
export const HIGH: Level = "high";
export const STRICT: Level = "strict";

/** A path pattern that should be neither read nor written. */
export interface FileRule {
    readonly ruleId: string;
    readonly level: Level;
    readonly pattern: RegExp;
    readonly reason: string;
    readonly remediation?: string;
}

/** A shell command pattern that would expose or exfiltrate a secret. */
export interface CommandRule {
    readonly ruleId: string;
    readonly level: Level;
    readonly pattern: RegExp;
    readonly reason: string;
    readonly remediation?: string;
}

/**
 * Compile a rule pattern.
 *
 * MULTILINE matters because secrets-guard normalizes a command into one
 * statement per line before matching, so `^`/`$` in a command rule must mean
 * "start/end of statement". Paths do not contain newlines, so the flag is a
 * no-op for file rules.
 */
function rx(pattern: string): RegExp {
    return new RegExp(pattern, "im");
}

function fileRule(
    ruleId: string,
    level: Level,
    pattern: string,
    reason: string,
    remediation?: string,
): FileRule {
    return { ruleId, level, pattern: rx(pattern), reason, remediation };
}

function commandRule(
    ruleId: string,
    level: Level,
    pattern: string,
    reason: string,
    remediation?: string,
): CommandRule {
    return { ruleId, level, pattern: rx(pattern), reason, remediation };
}

// --------------------------------------------------------------------------- #
// Allowlist: checked before every rule, for both paths and command tokens.
// --------------------------------------------------------------------------- #

export const ALLOWLIST = rx(
    String.raw`(?:^|[\w./-]*?)` +
        String.raw`(?:\.env\.(?:example|sample|template|schema|defaults|dist)` +
        String.raw`|env\.example|example\.env|\.env\.example\.\w+)$`,
);

// Same idea, but usable mid-command so `cat .env.example; cat .env` still trips
// the second half instead of the whole command being waved through.
// Anchored at the start of a word: tried from every position, `\S*` takes
// quadratic time on a long word (an inline base64 blob).
export const ALLOWLIST_IN_COMMAND = rx(
    String.raw`(?<!\S)\S*(?:\.env\.(?:example|sample|template|schema|defaults|dist)|env\.example|example\.env)\b`,
);

// Commands that can only ever mention a secret path as literal text.
export const EXEMPT_COMMAND_HEADS = rx(
    String.raw`^(?:git\s+(?:commit|tag|notes|log|show|diff|status|blame)` +
        String.raw`|gh\s+(?:pr|issue|release|gist)\s+\w+` +
        String.raw`|glab\s+\w+\s+\w+` +
        String.raw`|jj\s+(?:describe|commit)` +
        String.raw`|echo\s+['"][^'"]*['"]\s*$)\b`,
);

// `secrets`/`credentials` must be a whole path component, optionally with a
// config extension — never a fragment of a longer identifier. Without the
// lookbehind, source files such as `protect-secrets.js` or `secrets_guard.py`
// match, and routine work on them gets blocked as if they held credentials.
const SECRET_NAME = String.raw`(?<![\w.-])(?:secrets?|credentials?)(?:\.(?:json|ya?ml|toml|ini))?\b`;

// `.env` must start a path component, as in the env-file path rule: never the
// tail of an identifier or a regex. Without the lookbehind, searches such as
// `rg 'process.env.HOME' src` or `rg '\.env'` read as greps of a .env file.
const ENV_FILE = String.raw`(?<![\w.\\-])\.env\b`;

// A whole variable name that looks secret. `${NAME:+word}` and `${NAME+word}`
// expand to `word`, never the value, so the echo rule passes them over; the
// trailing lookahead keeps backtracking from ending the name early to get there.
const SECRET_VAR =
    String.raw`[A-Za-z_]*(?:SECRET|APIKEY|API_KEY|KEY|TOKEN|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH|PRIVATE|SALT)` +
    String.raw`\w*(?!\w)`;

// Reusable fragment: a token that names something secret. Used by rules that
// would otherwise fire on entirely innocent pipelines.
const SECRET_TOKEN =
    String.raw`(?:(?<![\w.\\-])\.envrc\b|${ENV_FILE}|${SECRET_NAME}|id_rsa\b|id_ed25519\b|id_ecdsa\b` +
    String.raw`|id_dsa\b|\.pem\b|\.key\b|\.netrc\b|authorized_keys\b|\.p12\b|\.pfx\b|\.pgpass\b` +
    String.raw`|\.git-credentials\b|\.credentials\.json\b)`;

// Coding-agent and developer-CLI login tokens. Path list follows
// cc-safety-net's coding-CLI credential rules (MIT, kenryu42/cc-safety-net).
const AGENT_CREDENTIALS =
    String.raw`\.claude/\.credentials\.json` +
    String.raw`|\.codex/(?:auth\.json|\.credentials\.json|secrets|\.sandbox-secrets)` +
    String.raw`|\.(?:pi|omp)/agent/auth\.json` +
    String.raw`|\.local/share/(?:opencode/(?:auth|mcp-auth)\.json|amp/secrets\.json|devin/credentials\.toml)` +
    String.raw`|\.gemini/(?:oauth_creds|mcp-oauth-tokens|a2a-oauth-tokens|gemini-credentials)\.json` +
    String.raw`|\.copilot/(?:mcp-oauth-config|mcp-secrets)` +
    String.raw`|\.(?:cursor|config/cursor|grok)/(?:auth|mcp_credentials)\.json` +
    String.raw`|\.factory/auth\.(?:encrypted|v2\.file|v2\.key)` +
    String.raw`|\.config/gh/hosts\.yml` +
    String.raw`|\.git-credentials`;
const READERS = "(?:cat|bat|less|more|head|tail|view|nl|od|xxd|strings|open)";
const EDITORS = "(?:nano|vi|vim|nvim|emacs|code|codium|subl|atom|gedit|micro|helix|hx)";
const SEG = String.raw`[^;|&\n]*`; // stay inside one simple command

// A command name only counts when it sits in a command position: the start of a
// statement (secrets-guard puts one per line), after a pipe, inside a command
// substitution, or behind a wrapper such as sudo/xargs/find -exec.
//
// Without this, any command carrying prose matches — an MR titled
// "rm -rf guard, and split secrets from ..." looked exactly like `rm <secret>`,
// and every gh/glab/git invocation with a description was a candidate.
const HEAD =
    String.raw`(?:^|\|\s*|\$\(\s*|` +
    "`" +
    String.raw`\s*|\(\s*|\{\s*` +
    String.raw`|\b(?:sudo|doas|env|command|builtin|exec|time|nohup|nice|ionice|xargs)\s+(?:-\S+\s+)*` +
    String.raw`|-exec(?:dir)?\s+)`;

const ENV_SAFE_HINT =
    "Do not read the file. If you need to know which keys exist, ask the user to name them, " +
    "or have the user run the command themselves by typing `! <command>` in the prompt. " +
    "If `env-safe` is installed, `env-safe list` / `env-safe check KEY` show keys without values.";
const ENV_WRITE_HINT =
    "Do not write this file. Tell the user exactly which key and value to add, and let them " +
    "edit it outside Claude Code.";

// --------------------------------------------------------------------------- #
// Sensitive files, matched against Read / Edit / Write / Grep paths.
// --------------------------------------------------------------------------- #

export const SECRET_FILES: readonly FileRule[] = [
    // ---- critical ----
    fileRule(
        "env-file",
        CRITICAL,
        String.raw`(?:^|/)\.env(?:\.[^/]*)?$`,
        ".env file contains secrets",
        ENV_SAFE_HINT,
    ),
    fileRule(
        "envrc",
        CRITICAL,
        String.raw`(?:^|/)\.envrc$`,
        ".envrc (direnv) contains secrets",
        ENV_SAFE_HINT,
    ),
    fileRule("ssh-private-key", CRITICAL, String.raw`(?:^|/)\.ssh/id_[^/]+$`, "SSH private key"),
    fileRule(
        "ssh-private-key-bare",
        CRITICAL,
        String.raw`(?:^|/)id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$`,
        "SSH key material",
    ),
    fileRule(
        "ssh-authorized-keys",
        CRITICAL,
        String.raw`(?:^|/)\.ssh/authorized_keys$`,
        "SSH authorized_keys",
    ),
    fileRule("aws-credentials", CRITICAL, String.raw`(?:^|/)\.aws/credentials$`, "AWS credentials file"),
    fileRule("aws-config", CRITICAL, String.raw`(?:^|/)\.aws/config$`, "AWS config may contain secrets"),
    fileRule(
        "kube-config",
        CRITICAL,
        String.raw`(?:^|/)\.kube/config$`,
        "Kubernetes config contains credentials",
    ),
    fileRule("pem-key", CRITICAL, String.raw`\.pem$`, "PEM key file"),
    fileRule("key-file", CRITICAL, String.raw`\.key$`, "Key file"),
    fileRule("pkcs12-key", CRITICAL, String.raw`\.(?:p12|pfx)$`, "PKCS#12 key file"),
    fileRule(
        "age-key",
        CRITICAL,
        String.raw`(?:^|/)(?:key\.txt|keys\.txt|age\.key)$`,
        "age/sops key material",
    ),
    fileRule(
        "agent-credentials",
        CRITICAL,
        `(?:^|/)(?:${AGENT_CREDENTIALS})$`,
        "coding-agent or CLI login token (Claude, Codex, pi, opencode, gh, git credentials)",
    ),

    // ---- high ----
    // Tool-specific rules come first so their id appears in the message; the
    // generic secrets-file rule below would otherwise shadow them.
    fileRule(
        "cargo-credentials",
        HIGH,
        String.raw`(?:^|/)\.cargo/credentials(?:\.toml)?$`,
        "crates.io token",
    ),
    fileRule("gem-credentials", HIGH, String.raw`(?:^|/)\.gem/credentials$`, "RubyGems credentials"),
    fileRule("credentials-json", HIGH, String.raw`(?:^|/)credentials\.json$`, "Credentials file"),
    fileRule(
        "secrets-file",
        HIGH,
        String.raw`(?:^|/)(?:secrets?|credentials?)\.(?:json|ya?ml|toml|ini)$`,
        "Secrets configuration file",
    ),
    fileRule("service-account", HIGH, String.raw`service[_-]?account[^/]*\.json$`, "GCP service account key"),
    fileRule(
        "gcloud-creds",
        HIGH,
        String.raw`(?:^|/)\.config/gcloud/.*(?:credentials|tokens)`,
        "gcloud credentials",
    ),
    fileRule(
        "azure-creds",
        HIGH,
        String.raw`(?:^|/)\.azure/(?:credentials|accessTokens)`,
        "Azure credentials",
    ),
    fileRule(
        "docker-config",
        HIGH,
        String.raw`(?:^|/)\.docker/config\.json$`,
        "Docker config holds registry auth",
    ),
    fileRule("netrc", HIGH, String.raw`(?:^|/)\.netrc$`, ".netrc contains credentials"),
    fileRule("npmrc", HIGH, String.raw`(?:^|/)\.npmrc$`, ".npmrc may contain auth tokens"),
    fileRule("pypirc", HIGH, String.raw`(?:^|/)\.pypirc$`, ".pypirc contains PyPI credentials"),
    fileRule("vault-token", HIGH, String.raw`(?:^|/)\.?vault-token$`, "Vault token file"),
    fileRule("keystore", HIGH, String.raw`\.(?:keystore|jks)$`, "Java keystore"),
    fileRule("htpasswd", HIGH, String.raw`(?:^|/)\.?htpasswd$`, "htpasswd contains hashed passwords"),
    fileRule("pgpass", HIGH, String.raw`(?:^|/)\.pgpass$`, "PostgreSQL password file"),
    fileRule("my-cnf", HIGH, String.raw`(?:^|/)\.my\.cnf$`, "MySQL config may contain a password"),
    fileRule(
        "git-config-file",
        HIGH,
        String.raw`(?:^|/)\.git/config$`,
        ".git/config can embed tokens in remote URLs",
    ),
    fileRule(
        "terraform-state",
        HIGH,
        String.raw`(?:^|/)terraform\.tfstate(?:\.backup)?$`,
        "Terraform state stores resource secrets in plaintext",
    ),
    fileRule(
        "tfvars",
        HIGH,
        String.raw`\.auto\.tfvars$|(?:^|/)terraform\.tfvars$`,
        "Terraform variable files often hold credentials",
    ),

    // ---- strict ----
    fileRule(
        "database-config",
        STRICT,
        String.raw`(?:^|/)(?:config/)?database\.(?:json|ya?ml)$`,
        "Database config may contain passwords",
    ),
    fileRule(
        "ssh-known-hosts",
        STRICT,
        String.raw`(?:^|/)\.ssh/known_hosts$`,
        "known_hosts reveals infrastructure",
    ),
    fileRule("gitconfig", STRICT, String.raw`(?:^|/)\.gitconfig$`, ".gitconfig may contain credentials"),
    fileRule("curlrc", STRICT, String.raw`(?:^|/)\.curlrc$`, ".curlrc may contain auth headers"),
];

// --------------------------------------------------------------------------- #
// Bash commands that expose, modify, or exfiltrate secrets.
// --------------------------------------------------------------------------- #

export const SECRET_COMMANDS: readonly CommandRule[] = [
    // ---- critical: direct reads ----
    commandRule(
        "read-env",
        CRITICAL,
        String.raw`${HEAD}${READERS}\s+${SEG}${ENV_FILE}`,
        "Reading a .env file exposes secrets",
        ENV_SAFE_HINT,
    ),
    commandRule(
        "read-private-key",
        CRITICAL,
        String.raw`${HEAD}${READERS}\s+${SEG}(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|\.pem|\.key)\b`,
        "Reading private key material",
    ),
    commandRule(
        "read-cloud-creds",
        CRITICAL,
        String.raw`${HEAD}${READERS}\s+${SEG}(?:\.aws/credentials|\.kube/config|\.azure/)`,
        "Reading cloud credentials",
    ),
    commandRule(
        "read-agent-credentials",
        CRITICAL,
        String.raw`${HEAD}(?:${READERS}|grep|rg|jq|base64|xxd|cp|scp|rsync)\b${SEG}(?:${AGENT_CREDENTIALS})\b`,
        "Reading a coding-agent or CLI login token",
    ),
    commandRule(
        "edit-env",
        CRITICAL,
        String.raw`${HEAD}${EDITORS}\s+${SEG}${ENV_FILE}`,
        "Opening a .env file in an editor",
        ENV_WRITE_HINT,
    ),

    // ---- high: environment exposure ----
    commandRule(
        "env-dump",
        HIGH,
        String.raw`\bprintenv\b|(?:^|[;|&])\s*env\b\s*(?:$|[;|&])`,
        "Dumping the environment may expose secrets",
        // Shell syntax in the hint, not a template
        'Check for one specific variable instead, e.g. `test -n "${KEY:-}" && echo set`.',
    ),
    commandRule(
        "echo-secret-var",
        HIGH,
        String.raw`${HEAD}(?:echo|printf|print)\b[^;|&]*\$(?:${SECRET_VAR}|\{${SECRET_VAR}(?!:?\+)[^}]*\})`,
        "Echoing a secret-looking variable",
        // Shell syntax in the hint, not a template
        'Test whether it is set without printing it: `[ -n "${VAR:-}" ]`.',
    ),
    commandRule(
        "read-secrets-file",
        HIGH,
        String.raw`${HEAD}${READERS}\s+${SEG}(?:credentials?|secrets?)\.(?:json|ya?ml|toml|ini)\b`,
        "Reading a secrets file",
    ),
    commandRule(
        "read-netrc",
        HIGH,
        String.raw`${HEAD}${READERS}\s+${SEG}(?:\.netrc|\.npmrc|\.pypirc|\.pgpass)\b`,
        "Reading a credentials dotfile",
    ),
    commandRule(
        "source-env",
        HIGH,
        String.raw`${HEAD}source\s+${SEG}${ENV_FILE}|(?:^|[;|&]\s*)\.\s+${SEG}${ENV_FILE}`,
        "Sourcing a .env file loads secrets into the shell",
    ),
    commandRule(
        "proc-environ",
        HIGH,
        String.raw`/proc/[^/\s]*/environ`,
        "Reading a process environment block",
    ),

    // ---- high: search that would print secret contents ----
    commandRule(
        "grep-env",
        HIGH,
        String.raw`${HEAD}(?:grep|rg|ag|ack|sift|ugrep)\b${SEG}${ENV_FILE}`,
        "Grepping a .env file prints matching secret lines",
        ENV_SAFE_HINT,
    ),
    commandRule(
        "find-env",
        HIGH,
        String.raw`${HEAD}find\b${SEG}-name\s+['"]?\.env`,
        "Locating .env files as a prelude to reading them",
        "If you only need to know whether one exists, use `test -f .env`.",
    ),
    commandRule(
        "xargs-read-secret",
        HIGH,
        String.raw`${HEAD}xargs\s+(?:-\S+\s+)*${READERS}\b${SEG}${SECRET_TOKEN}` +
            String.raw`|${SECRET_TOKEN}${SEG}\|${SEG}xargs\b${SEG}${READERS}\b`,
        "Reading secret files through xargs",
    ),
    commandRule(
        "find-exec-read-secret",
        HIGH,
        String.raw`${HEAD}find\b${SEG}${SECRET_TOKEN}${SEG}-exec` +
            String.raw`|${HEAD}find\b${SEG}-exec\s+${READERS}${SEG}${SECRET_TOKEN}`,
        "Reading secret files through find -exec",
    ),

    // ---- high: exfiltration ----
    // Requires the secret to be an actual file argument (`@file`, --upload-file,
    // -T, or a redirect). Matching any POST that merely mentions "credentials"
    // blocked ordinary secrets-manager API calls and caught nothing real.
    commandRule(
        "curl-upload-secret",
        HIGH,
        String.raw`${HEAD}curl\b${SEG}(?:@|--upload-file\s+|-T\s+|<\s*)\S*${SECRET_TOKEN}`,
        "Uploading a secret file via curl",
    ),
    commandRule(
        "wget-post-secret",
        HIGH,
        String.raw`${HEAD}wget\b${SEG}--post-file${SEG}${SECRET_TOKEN}`,
        "POSTing secrets via wget",
    ),
    commandRule(
        "scp-secret",
        HIGH,
        String.raw`${HEAD}scp\b${SEG}${SECRET_TOKEN}${SEG}\S+:`,
        "Copying secrets to a remote host via scp",
    ),
    commandRule(
        "rsync-secret",
        HIGH,
        String.raw`${HEAD}rsync\b${SEG}${SECRET_TOKEN}${SEG}\S+:`,
        "Syncing secrets to a remote host via rsync",
    ),
    commandRule(
        "nc-secret",
        HIGH,
        String.raw`${HEAD}(?:nc|ncat|netcat|socat)\b${SEG}<${SEG}${SECRET_TOKEN}`,
        "Exfiltrating secrets via netcat",
    ),
    commandRule(
        "pipe-secret-to-clipboard",
        HIGH,
        String.raw`${SECRET_TOKEN}${SEG}\|${SEG}\b(?:pbcopy|xclip|xsel|wl-copy)\b`,
        "Copying secrets to the clipboard",
    ),

    // ---- high: mutating secret files ----
    commandRule(
        "write-env-redirect",
        HIGH,
        String.raw`>>?\s*\S*${ENV_FILE}`,
        "Redirecting output into a .env file",
        ENV_WRITE_HINT,
    ),
    commandRule(
        "tee-env",
        HIGH,
        String.raw`${HEAD}tee\b${SEG}\S*${ENV_FILE}`,
        "Writing a .env file via tee",
        ENV_WRITE_HINT,
    ),
    commandRule(
        "sed-inplace-env",
        HIGH,
        String.raw`${HEAD}sed\b${SEG}-i${SEG}${ENV_FILE}`,
        "Editing a .env file in place",
        ENV_WRITE_HINT,
    ),
    commandRule("copy-secret", HIGH, String.raw`${HEAD}cp\b${SEG}${SECRET_TOKEN}`, "Copying a secret file"),
    commandRule("move-secret", HIGH, String.raw`${HEAD}mv\b${SEG}${SECRET_TOKEN}`, "Moving a secret file"),
    commandRule(
        "touch-env",
        HIGH,
        String.raw`${HEAD}touch\b${SEG}\S*${ENV_FILE}`,
        "Creating a .env file",
        ENV_WRITE_HINT,
    ),
    commandRule(
        "delete-secret",
        HIGH,
        String.raw`${HEAD}rm\b${SEG}${SECRET_TOKEN}|${HEAD}rm\b${SEG}authorized_keys`,
        "Deleting a secret file",
        "Losing these is unrecoverable. Confirm with the user first.",
    ),
    commandRule(
        "truncate-secret",
        HIGH,
        String.raw`${HEAD}truncate\b${SEG}\.(?:env|pem|key)\b|(?:^|[;|&]\s*)>\s*\S*${ENV_FILE}`,
        "Truncating a secret file",
    ),

    // ---- strict ----
    commandRule(
        "grep-for-secrets",
        STRICT,
        String.raw`${HEAD}(?:grep|rg)\b[^|;]*(?:-r|-R|--recursive)[^|;]*` +
            "(?:password|passwd|secret|api.?key|token|credential|private.?key)",
        "Recursive grep for secrets would print them",
        "Search for the variable *name* only, e.g. `rg -l 'API_KEY'`, and read no values.",
    ),
    commandRule(
        "base64-secret",
        STRICT,
        String.raw`${HEAD}base64\b${SEG}${SECRET_TOKEN}`,
        "Base64-encoding a secret file",
    ),
    commandRule(
        "history-grep",
        STRICT,
        String.raw`${HEAD}history\b[^|;]*\|[^|;]*(?:grep|rg)\b`,
        "Shell history may contain pasted secrets",
    ),
];

// Header comment above SECRET_FILES still applies: these are matched against the
// path arguments of Read / Edit / MultiEdit / Write / NotebookEdit / Grep / Glob.
