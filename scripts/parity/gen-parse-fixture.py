#!/usr/bin/env python3
"""Generate the parse-parity fixture from the Python parser.

For every command string in the guard test corpora (rm_rf_guard_test.py
SHOULD_BLOCK/SHOULD_ALLOW, dangerous_commands_test.py CASES,
secrets_guard_test.py COMMAND_CASES, config_guard_test.py BASH_CASES), runs
`shell_parse.parse(command, "/home/u/proj")` with no source resolver and
records a JSON summary of the result. `parse.parity.spec.ts` replays the same
commands through the TypeScript port and compares.

Usage: python3 scripts/parity/gen-parse-fixture.py [HOOKS_DIR] [OUT_FILE]
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "..", "claude-code-rules", "hooks")
OUT_FILE = (
    sys.argv[2]
    if len(sys.argv) > 2
    else os.path.join(HERE, "..", "..", "src", "shell", "__fixtures__", "parse-parity.json")
)
CWD = "/home/u/proj"

sys.path.insert(0, os.path.abspath(HOOKS_DIR))

# The Python side resolves `~` through HOME; the TypeScript side through the
# memory host's `home`. Pin both to the same value before the hooks load.
os.environ["HOME"] = "/home/u"
os.environ.pop("TMPDIR", None)  # `$(mktemp)` falls back to /tmp on both sides

from shell_parse import parse  # noqa: E402


def commands() -> list[str]:
    import config_guard_test
    import dangerous_commands_test
    import rm_rf_guard_test
    import secrets_guard_test

    found: list[str] = []
    found += list(rm_rf_guard_test.SHOULD_BLOCK)
    found += list(rm_rf_guard_test.SHOULD_ALLOW)
    found += [case[0] for case in dangerous_commands_test.CASES]
    found += [case[0] for case in secrets_guard_test.COMMAND_CASES]
    found += [case[0] for case in config_guard_test.BASH_CASES]
    return list(dict.fromkeys(found))


def summary(command: str) -> dict:
    result = parse(command, CWD)
    return {
        "commands": [
            {
                "argv": list(c.argv),
                "via": list(c.via),
                "wrappers": list(c.wrappers),
                "dynamicHead": c.dynamic_head,
                "indirect": c.indirect,
                "pipeline": c.pipeline,
                "stage": c.stage,
                "cwd": c.cwd,
                "cwdOptions": list(c.cwd_options),
                "redirects": [
                    {"op": r.op, "target": r.target, "dynamic": r.dynamic, "fd": r.fd} for r in c.redirects
                ],
            }
            for c in result.commands
        ],
        "nestedSources": [
            {"text": s.text, "via": list(s.via), "indirect": s.indirect} for s in result.nested_sources
        ],
        "links": dict(result.links),
        "unparseable": result.unparseable,
        "truncated": result.truncated,
    }


def main() -> int:
    cases = [{"command": command, "expected": summary(command)} for command in commands()]
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as handle:
        json.dump({"cwd": CWD, "home": os.environ["HOME"], "cases": cases}, handle, indent=1, ensure_ascii=False)
        handle.write("\n")
    print(f"{len(cases)} cases -> {OUT_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
