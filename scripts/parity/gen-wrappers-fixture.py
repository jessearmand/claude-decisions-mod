#!/usr/bin/env python3
"""Generate src/shell/__fixtures__/wrappers-parity.json from shell_wrappers.
`shell_invocation` over many argument lists, `source_arguments`, and the tables
themselves (so a typo in a long option list shows up).
Run: python3 scripts/parity/gen-wrappers-fixture.py
"""

from __future__ import annotations

import dataclasses

import _oracle
import shell_wrappers

SHELL_ARGS = [
    [], ["-c", "rm -rf x"], ["-c", "rm -rf x", "sh", "a", "b"], ["-c"], ["-lc", "rm x"], ["-xc", "ls", "arg0"],
    ["-n", "-c", "rm x"], ["-s", "a", "b"], ["-s"], ["-"], ["/dev/stdin", "a"], ["/dev/fd/0"], ["/proc/self/fd/0"],
    ["script.sh"], ["script.sh", "a", "b"], ["--", "script.sh", "a"], ["--", "-c", "x"], ["-c", "--", "x"],
    ["-o", "posix", "-c", "x"], ["+o", "posix", "-c", "x"], ["-o", "pipefail", "script.sh"], ["-O", "extglob", "s.sh"],
    ["--rcfile", "rc", "-i"], ["--rcfile=rc", "-i"], ["--init-file", "rc", "-i"], ["-i", "--rcfile", "rc", "--norc"],
    ["-i", "--rcfile", "rc", "--login"], ["-il", "--rcfile", "rc"], ["-i", "--rcfile", "rc", "--posix"],
    ["-i", "--rcfile", "rc", "-o", "posix"], ["-i", "--rcfile", "rc", "+o", "posix"], ["--rcfile", "rc"],
    ["-i", "--rcfile"], ["--rcfile"], ["-o"], ["--norc", "-c", "x"], ["--posix", "s.sh"], ["--login", "-c", "x"],
    ["--verbose", "s.sh"], ["+x", "s.sh"], ["+", "s.sh"], ["-", "s.sh"], ["--", "-"], ["-c", "x", "--", "y"],
    ["-ic", "x"], ["-si", "x"], ["-is"], ["-nx", "s.sh"], ["-abc", "s.sh"], ["-e", "s.sh", "-c", "y"],
    ["-c", "a", "-c", "b"], ["--", "--", "x"], ["--rcfile=", "-i"], ["-o", "posix", "+o", "posix", "-i", "--rcfile", "r"],
]
FISH_ARGS = [
    ["-c", "rm x"], ["--command", "rm x"], ["--command=rm x"], ["-C", "init", "-c", "main"], ["--init-command=init", "s.fish"],
    ["-c", "a", "b", "c"], ["-d", "3", "-c", "x"], ["--debug=3", "-c", "x"], ["-p", "prof", "s.fish"], ["-C", "init"],
    ["-C"], ["--command"], ["-c", "x", "--", "y"], ["-ic", "x"], ["--features", "f", "--", "s.fish", "a"],
]
SOURCE_ARGS = [[], ["--"], ["--", "f", "a"], ["f", "--"], ["f", "a"], ["-", "a"]]


def spec_json(spec) -> dict:
    out = {}
    for field in dataclasses.fields(spec):
        value = getattr(spec, field.name)
        name = "".join(p.capitalize() if i else p for i, p in enumerate(field.name.split("_")))
        out[name] = sorted(value) if isinstance(value, frozenset) else value
    return out


def main() -> None:
    invocations = []
    for shell in ("bash", "sh", "zsh", "dash", "fish", "ksh", "yash"):
        for args in SHELL_ARGS + (FISH_ARGS if shell == "fish" else FISH_ARGS[:3]):
            result = shell_wrappers.shell_invocation(shell, args)
            invocations.append({"name": shell, "args": args, "result": spec_json(result)})
    tables = {
        "PREFIX_WRAPPERS": {k: spec_json(v) for k, v in shell_wrappers.PREFIX_WRAPPERS.items()},
        "STRING_RUNNERS": {k: spec_json(v) for k, v in shell_wrappers.STRING_RUNNERS.items()},
        "SUBCOMMAND_RUNNERS": {k: spec_json(v) for k, v in shell_wrappers.SUBCOMMAND_RUNNERS.items()},
        "CLI_OPTIONS_WITH_VALUE": {k: sorted(v) for k, v in shell_wrappers.CLI_OPTIONS_WITH_VALUE.items()},
        "SHELL_COMMAND_OPTIONS": {k: sorted(v) for k, v in shell_wrappers.SHELL_COMMAND_OPTIONS.items()},
        "SHELL_EXTRA_OPTIONS_WITH_ARG": {k: sorted(v) for k, v in shell_wrappers.SHELL_EXTRA_OPTIONS_WITH_ARG.items()},
        "SHELL_OPTIONS_WITH_ARG": sorted(shell_wrappers.SHELL_OPTIONS_WITH_ARG),
        "SSH_OPTIONS_WITH_ARG": sorted(shell_wrappers.SSH_OPTIONS_WITH_ARG),
        "STDIN_PATHS": sorted(shell_wrappers.STDIN_PATHS),
        "SHELLS": sorted(shell_wrappers.SHELLS),
        "RESERVED_PREFIXES": sorted(shell_wrappers.RESERVED_PREFIXES),
    }
    sources = [{"args": a, "result": list(shell_wrappers.source_arguments(tuple(a)))} for a in SOURCE_ARGS]
    _oracle.write_fixture("wrappers-parity.json", {"invocations": invocations, "tables": tables, "sources": sources})


if __name__ == "__main__":
    main()
