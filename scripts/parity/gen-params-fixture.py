#!/usr/bin/env python3
"""Generate src/shell/__fixtures__/params-parity.json from shell_params.apply.
Run: python3 scripts/parity/gen-params-fixture.py
"""

from __future__ import annotations

import _oracle
import shell_params

VALUES = ["rm", "rmdir", "RM", "/home/user/.claude/x.bak", "a.b.c", "hello world", "", "aXbXc", "ab*c", "rM", "x'y",
          "a\\nb\\tc", "~/.claude/settings.json", "Ünïcode", "a&b", "abcabc", "-rf"]
OPERATORS = [
    ":0:2", ":1", ":-1", ":-3:2", ": 1 : 2 ", ":0:-1", ":2:-1", ":5:-10", ":-10", ":10", ":0:0", ":1:1",
    "#r", "##*/", "#*/", "%.bak", "%%.*", "%.*", "#dir", "%dir", "##*", "%%*", "#", "%", "#?", "%?",
    "/r/c", "//a/b", "/a/", "//a/", "/#r/c", "/%m/c", "/x/&", "/x/\\&", "/x/'&'", "/x/\"&\"", "/x/[&]", "/X/-",
    "//X/-", "/*/x", "//*/x", "/?/x", "/#/x", "/%/x", "/a*/x", "//./x", "/&/x", "/[a-c]/_", "//[a-c]/_",
    "^", "^^", ",", ",,", "^r", "^^[rm]", ",,M", ",R", "^^[[:lower:]]", ",,[[:upper:]]", "^^?", "^*",
    "@E", "@Q", "@U", "@u", "@L", "@P", "@A", "@K", "@a", "@", "@x",
    "!bogus", "x", "", ":", ":a", "::", ":1:2:3", "/!(r)/m", "//+(a)/x", "/@(r|c)m/x", "/*(a)/x",
]
EXTGLOB_OPERATORS = ["/!(r)/m", "//+(a)/x", "/@(r|c)m/x", "/*(a)/x", "#+(a)", "%%+(c)", "^^@(r|m)", "/?(r)m/x"]


def main() -> None:
    cases = []
    for value in VALUES:
        for operator in OPERATORS:
            cases.append({"value": value, "operator": operator, "extglob": False,
                          "result": shell_params.apply(value, operator)})
        for operator in EXTGLOB_OPERATORS:
            cases.append({"value": value, "operator": operator, "extglob": True,
                          "result": shell_params.apply(value, operator, extglob=True)})
    _oracle.write_fixture("params-parity.json", cases)


if __name__ == "__main__":
    main()
