/**
 * Rule table for config-guard.ts: the files an agent must not change about itself.
 *
 * An agent that can edit its own settings, hooks or MCP servers can switch every
 * other guard off, grant itself permissions, or plant something that runs in
 * the next session (the CHAINDROP npm worm persisted through
 * `.claude/settings.json`). These rules cover the agent harnesses this repo
 * configures (Claude Code, Codex, omp, pi, opencode), the instructions they
 * load into every session from the user's home (skills, subagents, commands,
 * global AGENTS.md), and the places a process can make itself run again later
 * (shell startup files, git hooks and git config, launchd, systemd, and cron).
 *
 * Patterns are matched against a `/`-separated path. Most are anchored on a
 * path suffix (`(?:^|/)\.claude/settings...`) so they hold for `~/...`,
 * `$HOME/...`, an absolute path, or a project-relative one alike. Patterns
 * anchored on `^~/` hold only in the home directory: the guard also matches
 * every path in its home-relative form, with the directories the harnesses and
 * git let the environment move (HOME_ALIASES) mapped back to their defaults, so
 * `$CODEX_HOME/skills` is checked as `~/.codex/skills`.
 *
 * Levels:
 *   critical  the agent's own permission and hook configuration     -> deny
 *   high      other harness config and persistence locations        -> deny
 *   Set CONFIG_GUARD_ASK=1 to prompt instead of denying.
 *
 * Ported from config_guard_rules.py.
 */

export const CRITICAL = "critical";
export const HIGH = "high";

export interface ConfigRule {
    readonly ruleId: string;
    readonly level: string;
    readonly pattern: RegExp;
    readonly reason: string;
}

function rule(ruleId: string, level: string, pattern: RegExp, reason: string): ConfigRule {
    return { ruleId, level, pattern, reason };
}

export const CONFIG_RULES: readonly ConfigRule[] = [
    // ---- critical: the running agent's own permissions, hooks and tools ----
    rule(
        "claude-settings",
        CRITICAL,
        /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/,
        "Claude Code settings hold permissions, hooks and env for the agent itself",
    ),
    rule(
        "claude-managed-settings",
        CRITICAL,
        /(?:^|\/)(?:ClaudeCode|claude-code)\/managed-(?:settings|mcp)\.json$/,
        "managed Claude Code policy",
    ),
    rule(
        "claude-user-state",
        CRITICAL,
        /(?:^|\/)\.claude\.json$/,
        "~/.claude.json holds MCP servers, trusted projects and allowed tools",
    ),
    rule(
        "claude-hooks",
        CRITICAL,
        /(?:^|\/)\.claude\/hooks(?:\/|$)/,
        "hook scripts are the guards themselves",
    ),
    rule(
        "claude-plugins",
        CRITICAL,
        /(?:^|\/)\.claude\/plugins(?:\/|$)/,
        "installed plugins can register hooks and MCP servers",
    ),
    rule(
        "mcp-config",
        CRITICAL,
        /(?:^|\/)\.mcp\.json$/,
        "project MCP servers run with the agent's privileges",
    ),
    rule(
        "codex-config",
        CRITICAL,
        /(?:^|\/)\.codex\/(?:config\.toml|[^/]*\.config\.toml|hooks\.json|hooks(?:\/|$)|rules(?:\/|$))/,
        "Codex approval, sandbox and hook configuration",
    ),
    rule(
        "omp-config",
        CRITICAL,
        /(?:^|\/)\.omp\/(?:agent\/)?(?:config\.ya?ml|settings\.json|extensions(?:\/|$)|plugins(?:\/|$)|hooks(?:\/|$))/,
        "omp configuration, extensions and hooks",
    ),
    rule(
        "pi-config",
        CRITICAL,
        /(?:^|\/)\.pi\/(?:agent\/)?(?:settings\.json|extensions(?:\/|$)|hooks(?:\/|$)|packages(?:\/|$))/,
        "pi configuration, extensions and hooks",
    ),
    rule(
        "opencode-config",
        CRITICAL,
        /(?:^|\/)(?:\.config\/opencode\/|\.opencode\/)(?:opencode\.jsonc?$|plugins?(?:\/|$))|(?:^|\/)opencode\.jsonc?$/,
        "opencode configuration and plugins",
    ),

    // ---- high: instructions every future session loads ----
    // User-level skills, subagents, commands/prompts and global instruction files
    // of each harness, and the shared ~/.agents/skills install that their skills
    // directories link to. A project's own `.claude/skills` is repository content
    // the user reviews in the diff, so these hold in the home directory only.
    rule(
        "agent-instructions",
        HIGH,
        /^~\/(?:\.claude|\.codex|\.agents|\.omp\/agent|\.pi\/agent|\.config\/opencode)\/(?:(?:skills?|agents?|commands?|prompts|output-styles|modes?)(?:\/|$)|(?:AGENTS|CLAUDE)(?:\.override)?\.md$)/,
        "skills, subagents, commands and global instructions load into every future session",
    ),

    // ---- high: places that make a process run again later ----
    rule(
        "shell-startup",
        HIGH,
        /(?:^|\/)\.(?:bashrc|bash_profile|bash_login|profile|zshrc|zshenv|zprofile|zlogin|kshrc|mkshrc|inputrc)$|(?:^|\/)\.config\/fish\/(?:config\.fish|conf\.d\/)/,
        "shell startup files run on every new shell",
    ),
    // A repository's hooks, its submodules' hooks (.git/modules/NAME/hooks).
    rule(
        "git-hooks",
        HIGH,
        /(?:^|\/)\.git\/(?:modules\/(?:[^/]+\/)+)?hooks(?:\/|$)/,
        "git hooks run code on git commands",
    ),
    // Every config file git reads: the repository's, a submodule's or worktree's,
    // the user's (~/.gitconfig, $XDG_CONFIG_HOME/git/config) and the system's
    // (/etc/gitconfig, or PREFIX/etc/gitconfig for a Homebrew git).
    rule(
        "git-config",
        HIGH,
        /(?:^|\/)\.git\/(?:(?:modules|worktrees)\/(?:[^/]+\/)+)?config(?:\.worktree)?$|^~\/\.gitconfig$|^~\/\.config\/git\/config$|(?:^|\/)etc\/gitconfig$/,
        "git config runs code on git commands (core.fsmonitor, core.hooksPath, aliases, filters)",
    ),
    rule(
        "launch-agents",
        HIGH,
        /(?:^|\/)Library\/Launch(?:Agents|Daemons)(?:\/|$)/,
        "launchd jobs persist across reboots",
    ),
    rule(
        "systemd-units",
        HIGH,
        /(?:^|\/)\.config\/systemd\/user(?:\/|$)|^\/etc\/systemd\//,
        "systemd units persist across reboots",
    ),
    rule(
        "cron",
        HIGH,
        /^\/(?:etc\/cron|var\/spool\/cron|usr\/lib\/cron)/,
        "cron tables run commands on a schedule",
    ),
    rule(
        "ssh-config",
        HIGH,
        /(?:^|\/)\.ssh\/(?:config|rc|environment)$/,
        "ssh client config can run commands (ProxyCommand, LocalCommand)",
    ),
    rule(
        "direnv-mise-config",
        HIGH,
        /(?:^|\/)\.config\/(?:direnv|mise)\/|(?:^|\/)\.config\/fnox\//,
        "global direnv/mise/fnox config runs or exposes code in every project",
    ),
];

/**
 * Directories whose removal, move or permission change would take a protected
 * path with it. `~` is expanded by the guard. The system entries are the
 * persistence locations outside the home directory: the file rules match a
 * unit or crontab, not an ancestor such as `/etc` or `/Library`.
 */
export const PROTECTED_ROOTS: readonly string[] = [
    "~/.claude",
    "~/.codex",
    "~/.agents/skills",
    "~/.omp",
    "~/.pi",
    "~/.config/opencode",
    "~/.ssh",
    "~/Library/LaunchAgents",
    "~/.config/systemd/user",
    "/etc/systemd",
    "/etc/crontab",
    "/etc/cron.d",
    "/etc/cron.hourly",
    "/etc/cron.daily",
    "/etc/cron.weekly",
    "/etc/cron.monthly",
    "/etc/gitconfig",
    "/Library/LaunchAgents",
    "/Library/LaunchDaemons",
    "/System/Library/LaunchAgents",
    "/System/Library/LaunchDaemons",
];
/** Relative to the session's working directory. */
export const PROJECT_PROTECTED_ROOTS: readonly string[] = [".claude", ".git/hooks"];

/**
 * Directories (or files) the environment may move away from their default
 * place, as (variable, default). A path under the variable's value is also
 * checked under the default, and each protected root under the default is
 * also protected under the variable's value.
 */
export const HOME_ALIASES: ReadonlyArray<readonly [variable: string, defaultPath: string]> = [
    ["CLAUDE_CONFIG_DIR", "~/.claude"],
    ["CODEX_HOME", "~/.codex"],
    ["XDG_CONFIG_HOME", "~/.config"],
    ["GIT_CONFIG_GLOBAL", "~/.gitconfig"],
    ["GIT_CONFIG_SYSTEM", "/etc/gitconfig"],
];
