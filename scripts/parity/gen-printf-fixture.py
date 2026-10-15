#!/usr/bin/env python3
"""Generate src/shell/__fixtures__/printf-parity.json from shell_printf.printed_text.
Run: python3 scripts/parity/gen-printf-fixture.py
"""

from __future__ import annotations

import _oracle
import shell_printf

# (name, args, xpg_echo)
CASES = [
    ("echo", [], False), ("echo", ["hi"], False), ("echo", ["a", "b"], False), ("echo", ["-n", "r"], False),
    ("echo", ["-e", "\\162\\155"], False), ("echo", ["-e", "\\0162\\0155"], False), ("echo", ["\\0162"], True),
    ("echo", ["-E", "\\0162"], True), ("echo", ["-ne", "a\\tb"], False), ("echo", ["-en", "a\\nb"], False),
    ("echo", ["-nE", "x"], False), ("echo", ["-eE", "\\n"], False), ("echo", ["-Ee", "\\n"], False),
    ("echo", ["-e", "a\\cb"], False), ("echo", ["-e", "\\c"], False), ("echo", ["-x", "a"], False),
    ("echo", ["--", "a"], False), ("echo", ["-", "a"], False), ("echo", ["-n"], False), ("echo", ["-n", "-e", "\\x41"], False),
    ("echo", ["-e", "\\x41\\x4a\\x4"], False), ("echo", ["-e", "\\xzz"], False), ("echo", ["-e", "\\q"], False),
    ("echo", ["-e", "\\\\"], False), ("echo", ["-e", "\\e[0m"], False), ("echo", ["-e", "\\a\\b\\f\\v\\r"], False),
    ("echo", ["-e", "\\0"], False), ("echo", ["-e", "\\00"], False), ("echo", ["-e", "\\0777"], False),
    ("echo", ["-e", "\\08"], False), ("echo", ["-e", "\\400"], False), ("echo", ["-e", "trailing\\"], False),
    ("echo", ["-e", "\\'\\\""], False), ("echo", ["-neeen", "x"], False), ("echo", ["-nee-", "x"], False),
    ("printf", [], False), ("printf", ["hi"], False), ("printf", ["%s", "rm"], False), ("printf", ["%s\\n", "a", "b"], False),
    ("printf", ["\\162\\155"], False), ("printf", ["%b", "\\x72m"], False), ("printf", ["%b", "\\0162"], False),
    ("printf", ["%b", "\\162"], False), ("printf", ["%b", "a\\cb"], False), ("printf", ["%b\\n", "a\\c", "b"], False),
    ("printf", ["%s %s\\n", "a"], False), ("printf", ["%s %s\\n", "a", "b", "c"], False), ("printf", ["%d", "5"], False),
    ("printf", ["%5.2f", "1"], False), ("printf", ["%q", "a b"], False), ("printf", ["%q", "~x#y"], False),
    ("printf", ["%q", "#"], False), ("printf", ["%q", ""], False), ("printf", ["%q", "a\tb"], False),
    ("printf", ["%q", "a\x01b"], False), ("printf", ["%q", "it's"], False), ("printf", ["%q", "$HOME/`x`"], False),
    ("printf", ["%q", "aé"], False), ("printf", ["%q", "a b"], False), ("printf", ["%q", "a b"], False),
    ("printf", ["%%"], False), ("printf", ["%%s", "x"], False), ("printf", ["100%%\\n"], False), ("printf", ["%"], False),
    ("printf", ["%z", "x"], False), ("printf", ["%-5s|", "a"], False), ("printf", ["%05d", "7"], False),
    ("printf", ["%.3s", "abcdef"], False), ("printf", ["%x %X %o %u %i %c", "1", "2", "3", "4", "5", "6"], False),
    ("printf", ["\\n\\t\\\\\\a\\e\\E\\f\\v\\r\\\"\\'"], False), ("printf", ["\\x41\\x4"], False), ("printf", ["\\0"], False),
    ("printf", ["\\0101"], False), ("printf", ["\\101"], False), ("printf", ["\\777"], False), ("printf", ["\\8"], False),
    ("printf", ["\\q"], False), ("printf", ["x\\"], False), ("printf", ["%b", "\\0"], False), ("printf", ["%b", "\\08"], False),
    ("printf", ["%b", "\\0101"], False), ("printf", ["%b", "\\101"], False), ("printf", ["%b", "\\\\"], False),
    ("printf", ["%b", "a\\nb"], False), ("printf", ["%s", "a\\nb"], False), ("printf", ["%s%s", "a"], False),
    ("printf", ["%s\\n"], False), ("printf", ["rm -rf victim\\n"], False), ("printf", ["%s\\n", "-rf victim"], False),
    ("printf", ["%s %s", "echo", "rm"], False), ("printf", ["%s", ""], False), ("printf", ["%c", "abc"], False),
    ("cat", ["x"], False), ("echo", ["x"], True), ("printf", ["%b", "\\c"], False), ("printf", ["a%sb%sc", "1"], False),
    ("printf", ["%s", "x", "y"], False), ("printf", ["-", "x"], False), ("printf", ["--", "x"], False),
    ("printf", ["-v", "x"], False), ("printf", ["%s\\c%s", "a", "b"], False),
]


def main() -> None:
    cases = [{"name": n, "args": a, "xpgEcho": x, "printed": shell_printf.printed_text(n, a, x)} for n, a, x in CASES]
    _oracle.write_fixture("printf-parity.json", cases)


if __name__ == "__main__":
    main()
