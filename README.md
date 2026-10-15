# claude-decisions-mod

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that
decides, before a tool call runs, whether it may: deterministic guards for the
Bash, Read, Edit, Write, Grep and Glob tools, and a model-assisted second
opinion from a **decision model** ([Jev](https://vercel.com/kb/jev-from-typesafe-ai)
by TypeSafe AI on [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/modalities/decision))
for the long tail of risky commands no rule enumerates.

It is the TypeScript port of the Python hooks in
[`jessearmand/claude-code-rules`](https://github.com/jessearmand/claude-code-rules)
(`hooks/*.py`), rewritten as a hooks module that runs inside Claude Code
instead of as settings-hook scripts. Policy, rule ids, reason texts and the
bash-subset parser are the same; see [docs/PORTING.md](docs/PORTING.md) for
the module map and the conventions of the port.

[cc-safety-net](https://github.com/kenryu42/cc-safety-net) is the reference for
guard-family coverage. PowerShell and Windows shells are out of scope: the
guards cover Bash on Linux and macOS.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install decisions-guard --marketplace jessearmand/claude-decisions-mod
```

From a shell:

```
claude plugin install decisions-guard --marketplace jessearmand/claude-decisions-mod
```

In the Desktop app, where `/plugin` does not run: click **+** next to the
prompt box, then **Plugins**, **Add marketplace** with
`jessearmand/claude-decisions-mod`, then **Add plugin**.

To run it from a checkout for one session: `claude --plugin-dir /path/to/claude-decisions-mod`.

Do not also wire the Python hooks of `claude-code-rules` in `settings.json`:
every call would be judged twice.

## What it decides

Every guard answers `deny` or `ask` or defers to the normal permission flow;
none ever answers `allow`, so your own permission rules are never loosened.
A deny from any guard wins over an ask; the model is consulted only when
nothing deterministic decided, and it can only ask.

| Guard | Tools | What it does |
|---|---|---|
| `rm-rf-guard` | Bash | Asks before any `rm` that is both recursive and forced, with a per-target analysis and the least destructive alternative. |
| `dangerous-commands` | Bash | Denies (or asks about) destructive git, downloads piped into a shell, disk writes, `chmod -R 777`, crontab, package publishing, cloud/Kubernetes/database deletes and switching off security controls. Local removals (`git clean -f`, `find -delete`, `shred`) ask. |
| `secrets-guard` | Bash, Read, Edit, Write, Grep, Glob | Blocks reading, mutating or exfiltrating credential files (`.env`, keys, cloud and coding-agent tokens), in three tiers. |
| `config-guard` | Bash, Edit, Write | Stops the agent changing its own settings, hooks, MCP servers, other harnesses' config, home-directory skills and instructions, and persistence locations (shell rc files, git hooks and config, launchd, systemd, cron). |
| `file-protection` | Edit, Write | Denies hand edits to generated files: lockfiles, `.git/` internals, `node_modules/`. |
| `bash-command-validator` | Bash | Points `grep`, `find -name` and source-code `rg` at `rg`, `rg --files` and `ast-grep`. |
| `bash-risk-judge` | Bash | Opt-in. Asks a decision model typed questions (destruction, exfiltration, persistence, weakened controls, fetch-and-execute, privilege escalation, erased history, credential stores, network exposure, off-task) and prompts when any crosses a threshold. |

All Bash guards parse the command with a shared bash-subset parser, so
newlines, `sudo -u x`, `timeout 5`, `bash -c`, `eval`, `ssh host '...'`,
`$(...)`, heredocs fed to a shell and interpreter one-liners cannot hide a
command, and what a command runs from disk (shell scripts, `npm run`
scripts, Makefile recipes, database command files, git aliases) is read and
judged too. A match found only in such a file asks instead of denying.

Under `bypassPermissions` or `dontAsk`, where nobody can answer, a
deterministic ask becomes a deny (set `unattendedKeepAsk` to keep asks).
The mode is read from the merged settings' `permissions.defaultMode`.

## The Jev risk judge

The judge is off until enabled. It sends the (redacted) command, the
user's latest prompt, the agent's last few commands and the body of any
script the command runs to `POST https://ai-gateway.vercel.sh/v1/evaluate`
with typed boolean and choice questions, and reads back calibrated
probabilities. Credentials are, in order: the `jevApiKey` option,
`AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, or `fnox` (pointed at
`HOOK_JEV_FNOX_CONFIG`). Every failure (no key, timeout, bad JSON) defers.

Any gateway decision model works in place of Jev, for example
`openai/gpt-6-luna-decisions`.

## Configuration

Options are set in `/plugin configure decisions-guard@claude-decisions-mod`
(or `claude plugin configure`) and stored in `settings.json` under
`pluginConfigs`. The Python hooks' environment variables are honoured as
overrides, so an existing `env` block keeps working.

| Option | Environment | Default | Meaning |
|---|---|---|---|
| `jevEnable` | `HOOK_JEV_ENABLE` | off | Turn the judge on. |
| `jevModel` | `HOOK_JEV_MODEL` | `typesafe-ai/jev` | Gateway decision model id. |
| `jevApiKey` | `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN` | | Gateway credential (stored in secure storage). |
| `jevTimeoutSeconds` | `HOOK_JEV_TIMEOUT` | 5 | Deadline for the decision call. |
| `askThreshold` | `BASH_RISK_JUDGE_ASK_THRESHOLD` | 0.7 | Probability at or above which the judge asks. |
| `secretsLevel` | `SECRETS_GUARD_LEVEL` | `high` | `critical`, `high` or `strict`. |
| `dangerousLevel` | `DANGEROUS_COMMANDS_LEVEL` | `high` | `critical`, `high` or `strict`. |
| `askInsteadOfDeny` | `*_ASK`, `HOOK_ASK_<LEVEL>` | off | Prompt instead of denying. |
| `unattendedKeepAsk` | `HOOK_UNATTENDED_KEEP_ASK` | off | Keep asks under `bypassPermissions`/`dontAsk`. |
| `logDir` | `HOOKS_LOG_DIR`, `*_LOG_DIR` | `~/.claude/hooks-logs` | Audit log directory (JSONL, one file a day). |

Each guard also has a `*_DISABLE` environment switch
(`RM_RF_GUARD_DISABLE`, `DANGEROUS_COMMANDS_DISABLE`, `SECRETS_GUARD_DISABLE`,
`CONFIG_GUARD_DISABLE`, `FILE_PROTECTION_DISABLE`,
`BASH_COMMAND_VALIDATOR_DISABLE`, `BASH_RISK_JUDGE_DISABLE`), and
`CONFIG_GUARD_LIVE_DIRS`, `BASH_RISK_JUDGE_CONTEXT`,
`BASH_RISK_JUDGE_TRUST_TRUNCATED`, `BASH_RISK_JUDGE_UNATTENDED_DENY`,
`HOOK_JEV_DEBUG` and `HOOK_JEV_GATEWAY_URL` keep their Python meaning.

## Development

```
bun install
bun run typecheck   # tsc against the engine's types and against Node
bun run lint        # biome
bun run test        # vitest: the ported Python corpora and parity fixtures
bun run test:mod    # claude plugin test: the hooks module against the engine
bun run validate    # claude plugin validate
```

`scripts/replay-ccsafety.ts` replays cc-safety-net's harvested verdict
labels through the guards in-process and compares the decisions with the
Python hooks' replay (see `docs/cc-safety-net-coverage.md` in
`claude-code-rules`). `scripts/judge-probe.ts` and `scripts/jev-calibrate.ts`
need network access and a gateway credential; they are benchmarks, not tests.

## Where it runs

Hooks run wherever the plugin loads: the terminal, the Desktop app's Code
tab, the VS Code extension, `claude -p` and cloud sessions that carry the
plugin. `classic.PreToolUse` hooks of a user-installed plugin do not run
where an organization manages Claude Code; an administrator lists the plugin
in managed settings instead.
