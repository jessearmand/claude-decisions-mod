# Porting the Python hooks to this mod

The hooks in `jessearmand/claude-code-rules/hooks/*.py` (merged PR #1) are
ported module for module into `src/`. This page is the contract every ported
module follows, so modules written separately fit together.

## Layout

| Python module | TypeScript module | Layer |
|---|---|---|
| `shell_model.py` | `src/shell/model.ts` (written, do not rewrite) | parser data |
| `shell_lexer.py` | `src/shell/lexer.ts` | parser |
| `shell_glob.py` | `src/shell/glob.ts` | parser |
| `shell_ifs.py` | `src/shell/ifs.ts` | parser |
| `shell_arith.py` | `src/shell/arith.ts` | parser |
| `shell_printf.py` | `src/shell/printf.ts` | parser |
| `shell_params.py` | `src/shell/params.ts` | parser |
| `shell_expand.py` | `src/shell/expand.ts` | parser |
| `shell_wrappers.py` | `src/shell/wrappers.ts` | parser |
| `shell_interpreters.py` | `src/shell/interpreters.ts` | parser |
| `shell_streams.py` | `src/shell/streams.ts` | parser |
| `shell_effects.py` | `src/shell/effects.ts` | parser |
| `shell_state.py` | `src/shell/state.ts` | parser |
| `shell_unwrap.py` | `src/shell/unwrap.ts` | parser |
| `shell_payloads.py` | `src/shell/payloads.ts` | parser |
| `shell_parse.py` | `src/shell/parse.ts` | parser driver |
| `shell_sources.py` | `src/shell/sources.ts` | sources |
| `make_expand.py` | `src/shell/make-expand.ts` | sources |
| `db_client_files.py` | `src/shell/db-client-files.ts` | sources |
| `command_stdin.py` | `src/shell/command-stdin.ts` | sources |
| `shell_writes.py` | `src/shell/writes.ts` | writes |
| `landing_paths.py` | `src/shell/landing-paths.ts` | writes |
| `unknown_target.py` | `src/shell/unknown-target.ts` | writes |
| `python_argv.py` | `src/shell/python-argv.ts` | parser |
| `filesystem_paths.py` | `src/shell/filesystem-paths.ts` | parser |
| `git_aliases.py` | `src/guards/git-aliases.ts` | guards |
| `hook_protocol.py` | `src/decision.ts`, `src/audit.ts` (written) | protocol |
| `rm_rf_guard.py` | `src/guards/rm-rf-guard.ts` | guards |
| `file_protection.py` | `src/guards/file-protection.ts` | guards |
| `secrets_guard.py`, `secrets_guard_rules.py` | `src/guards/secrets-guard.ts`, `secrets-guard-rules.ts` | guards |
| `config_guard.py`, `config_guard_rules.py` | `src/guards/config-guard.ts`, `config-guard-rules.ts` | guards |
| `danger_rule.py`, `dangerous_*.py` | `src/guards/danger-rule.ts`, `dangerous-system.ts`, `dangerous-git.ts`, `dangerous-infra.ts`, `dangerous-commands.ts` | guards |
| `bash_command_validator.py` | `src/guards/bash-command-validator.ts` | guards |
| `judge_redact.py`, `jev_client.py`, `judge_context.py`, `bash_risk_judge.py` | `src/judge/redact.ts`, `jev-client.ts`, `context.ts`, `bash-risk-judge.ts` | judge |
| `judge_probe_cases.py`, `judge_probe.py`, `jev_calibrate.py` | `src/judge/probe-cases.ts`, `scripts/judge-probe.ts`, `scripts/jev-calibrate.ts` | scripts |
| `scripts/replay_ccsafety.py` | `scripts/replay-ccsafety.ts` | scripts |
| `*_test.py` | the module's `*.spec.ts` beside it (vitest) | tests |

`hooks/register.ts` is the hooks module Claude Code loads; it wires the guards
and imports from `src/`. Nothing under `src/` imports from `hooks/`.

## Naming

- `snake_case` becomes `camelCase`; a leading underscore is dropped. A name
  another module imports is exported; module-private names stay unexported.
  `UPPER_SNAKE` constants keep their spelling.
- A Python dataclass becomes a `readonly` interface, or a class when it has
  methods or properties (`SimpleCommand`). `dataclasses.replace(x, ...)` is
  `x.with({...})` on `SimpleCommand` and `{ ...x, ... }` on a plain object.
- A Python `dict` keyed by arbitrary strings is a `Map`; `frozenset`/`set` are
  `ReadonlySet`/`Set`; tuples and lists are `readonly T[]`; `None` is
  `undefined` in return types and `null` where the model already says so
  (`Directory = string | null`).
- Keep every comment and docstring: they record why a rule exists. A
  docstring becomes a JSDoc comment on the export.

## No Node, no globals

A hooks module runs with no Node and no DOM. Under `src/` only
`src/host/node-host.ts` may import `node:*`, and `*.spec.ts` files (vitest,
run under Node) may too. Everything else reaches the world through a `Host`
(`src/host/host.ts`): `host.stat`, `host.realPath`, `host.readText`,
`host.list`, `host.run`, `host.fetch`, `host.env`, `host.home`. The parser
carries it as `ctx.host`; a guard's `run(input, deps)` receives it.

Consequences of the Python code touching the disk synchronously:

- Any function that reads a path becomes `async` and its callers `await` it.
  Loops become `for ... of` with `await` inside, never `Array.map` with
  promises unless gathered with `Promise.all` deliberately.
- `os.path.expanduser(p)` is `expanduser(p, host.home)`; `os.getcwd()` is
  never called (the cwd is always a parameter); `os.environ.get(x)` is
  `host.env(x)` and `x` is added to `KNOWN_ENV_NAMES` in `host.ts`.
- `glob.glob(pattern, root_dir=cwd)` is `globPaths(pattern, host, { rootDir: cwd, limit })`
  from `src/shell/glob.ts` (it lists directories with `host.list` and matches
  with the module's own matcher).
- `tarfile`/`zipfile` listings run `tar -tvf` / `unzip -Z1` through `host.run`.
- Every host method answers `undefined` on failure; never `try/catch` around
  them for ordinary misses, decide conservatively instead.

## Regular expressions

Python `re` to JavaScript `RegExp`:

- `(?i)`, `(?m)`, `(?s)`, `(?x)` inline flags become the `i`, `m`, `s` flags
  (rewrite a verbose pattern on one line). `re.IGNORECASE | re.MULTILINE` is `/.../im`.
- `(?P<name>...)` is `(?<name>...)`; `\Z` is `$` with no `m` flag or
  `(?![\s\S])`; `\A` is `^`.
- `re.fullmatch(p, s)` anchors the pattern `^(?:p)$`; `re.match` anchors with `^`
  only; `re.search` is `.exec`/`.test`.
- `re.finditer`/`findall` is `matchAll` on a `g` regex (never reuse a `g`
  regex with `.test` across calls: `lastIndex` persists). Prefer non-`g`
  regexes stored as module constants and `matchAll(new RegExp(source, "g"))`
  only where iteration is needed.
- `re.sub(pattern, fn, text)` is `text.replace(/.../g, fn)`; `count=1` drops the `g`.
- Python `\w`, `\d`, `\s`, `\b` are Unicode-aware; the JS ASCII forms are fine
  here (the rules are ASCII). Add the `u` flag only when a pattern needs it.
- Lookbehind (`(?<!...)`, `(?<=...)`) works in JS and may be variable-length.
- `str.isspace()`, `partition`, `split()` with no separator, `strip(chars)`,
  `shlex.quote`, `re.escape` are in `src/util/text.ts`; `os.path.*` in `src/util/paths.ts`.

## Tests

- Port each `*_test.py` corpus into a `*.spec.ts` beside the module (vitest:
  `describe`, `it.each`, `expect`). Keep every case and its expected label.
- Tests that need real files write them into a temporary directory with
  `node:fs` and use `nodeHost()`; tests that only need a file to exist use
  `memoryHost({ files, dirs, links })`.
- `*.test.ts` is reserved for `claude plugin test` (the mod kit, imports from
  `claude-code/testing`); vitest only collects `*.spec.ts`.
- Run `bun run typecheck`, `bun run lint`, `bun run test` before handing a
  module over; fix what they report rather than disabling rules.

## Behaviour

Parity with the Python hooks is the goal, including their exact reason texts,
rule ids and `ask`-versus-`deny` choices. Where a Python behaviour depended
on a synchronous filesystem probe, make the same probe through the host.
Where Python code catches `OSError` and skips, the host's `undefined` answer
skips the same way. Do not add rules, rename rule ids or soften decisions.

## Import cycles

The Python stages import `parse`/`_parse_into` lazily inside functions to
avoid load-time cycles. ES modules tolerate a cycle as long as nothing is
*called* while the modules load, so import at the top of the file
(`import { parseInto } from "./parse.ts"`) and call it inside the function
as before. Never read an imported constant at module top level across a
cycle (`const X = OTHER_MODULE_CONST + 1` where the other module imports
this one); compute it lazily or move it into `model.ts`.

## Ownership

Three agents port the parser in parallel; each owns the files in its brief
and writes no other `src/` file. A sibling module that does not exist yet is
imported by its mapped file name and the camelCased Python name, exactly as
the Python import spells it (`from shell_expand import command_output`
becomes `import { commandOutput } from "./expand.ts"`). The integration pass
reconciles any name that drifted.
