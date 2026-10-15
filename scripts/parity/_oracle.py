"""Shared helpers for the parity fixture generators: locate the Python hooks
(the oracle) and load the command corpora from their test files.

Set CLAUDE_CODE_RULES_HOOKS to the hooks directory of jessearmand/claude-code-rules;
the default is a sibling checkout of this repository.
"""

from __future__ import annotations

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(_HERE))
HOOKS_DIR = os.environ.get(
    "CLAUDE_CODE_RULES_HOOKS", os.path.join(os.path.dirname(REPO_ROOT), "claude-code-rules", "hooks")
)
FIXTURES_DIR = os.path.join(REPO_ROOT, "src", "shell", "__fixtures__")

# The oracle's HOME: memoryHost() answers the same, so `$HOME` expands alike.
os.environ["HOME"] = "/home/user"
os.environ.pop("TMPDIR", None)
sys.path.insert(0, HOOKS_DIR)


def corpus_commands() -> list[str]:
    """Every command in the guard test corpora, once, in order."""
    import dangerous_commands_test  # noqa: PLC0415
    import rm_rf_guard_test  # noqa: PLC0415
    import secrets_guard_test  # noqa: PLC0415

    found: list[str] = []
    for items in (
        rm_rf_guard_test.SHOULD_BLOCK,
        rm_rf_guard_test.SHOULD_ALLOW,
        dangerous_commands_test.CASES,
        secrets_guard_test.COMMAND_CASES,
    ):
        for item in items:
            command = item[0] if isinstance(item, tuple) else item
            if isinstance(command, str) and command not in found:
                found.append(command)
    return found


def _dumps(value: object, depth: int) -> str:
    """JSON with one list element per line at the top two levels, compact below."""
    if depth < 2 and isinstance(value, list):
        if not value:
            return "[]"
        return "[\n" + ",\n".join(_dumps(item, depth + 1) for item in value) + "\n]"
    if depth < 2 and isinstance(value, dict):
        items = (f"{json.dumps(key, ensure_ascii=False)}: {_dumps(item, depth + 1)}" for key, item in value.items())
        return "{\n" + ",\n".join(items) + "\n}"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def write_fixture(name: str, data: object) -> None:
    path = os.path.join(FIXTURES_DIR, name)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(_dumps(data, 0) + "\n")
    print(f"wrote {os.path.relpath(path, REPO_ROOT)}")
