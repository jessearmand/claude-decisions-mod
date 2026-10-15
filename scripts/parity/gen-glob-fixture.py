#!/usr/bin/env python3
"""Generate src/shell/__fixtures__/glob-parity.json from shell_glob and glob.glob.

`match`: shell_glob_test.py's cases plus extra patterns, with extglob off and on.
`paths`: a file tree built in a temporary directory, then `glob.glob(pattern,
root_dir=...)` for each pattern; glob.spec.ts rebuilds the tree in memoryHost
under ROOT and expects the same (sorted) results.
Run: python3 scripts/parity/gen-glob-fixture.py
"""

from __future__ import annotations

import glob
import os
import re
import tempfile

import _oracle
import shell_glob
import shell_glob_test

ROOT = "/glob-root"

EXTRA_MATCH = [
    ("", ""), ("a", ""), ("", "*"), ("", "**"), ("a/b", "*"), ("a/b", "a?b"), ("a\nb", "*"),
    ("abc", "a[b-c]c"), ("a-c", "a[b-]c"), ("a-c", "a[-b]c"), ("a]c", "a[]]c"), ("a]c", "a[!]]c"),
    ("abc", "a[!]]c"), ("x", "[[:alpha:][:digit:]]"), ("5", "[[:alpha:][:digit:]]"), ("_", "[[:word:]]"),
    (" ", "[[:space:]]"), ("\t", "[[:blank:]]"), ("~", "[[:punct:]]"), ("a", "[[:bogus:]]"), (":", "[[:bogus:]]"),
    ("[", "[["), ("[[", "[["), ("a", "[a"), ("[a", "[a"), ("a.b", "*.b"), (".b", "*.b"), ("a", "\\a"), ("\\", "\\"),
    ("\\a", "\\\\a"), ("*", "[*]"), ("?", "[?]"), ("a", "[^]a]"), ("]", "[^]a]"), ("b", "[^]a]"),
    ("AB", "[[:upper:]][[:upper:]]"), ("Ab", "[[:upper:]]*"), ("+(x)", "+(x)"), ("x", "@(x)"), ("", "*(x)"),
    ("rm", "r?"), ("rm", "r"), ("rm", "r*"), ("rm", "*m"), ("rm", "[r][m]"), ("é", "?"), ("é", "[[:alpha:]]"),
    ("a", "[z-a]"), ("abc", "a{b,c}c"), ("a{b,c}c", "a{b,c}c"), ("a(b)", "a(b)"), ("a|b", "a|b"), ("a", "a|b"),
    ("a.b", "a\\.b"), ("a/b", "a\\/b"), ("$a", "\\$a"), ("^a", "\\^a"), ("a", "[\\a]"), ("\\", "[\\]"), ("-", "[\\-]"),
]
EXTRA_EXTGLOB = [
    ("", "+(x)"), ("xx", "+(x)"), ("xy", "+(x|y)"), ("xyx", "*(x|y)"), ("z", "*(x|y)"), ("", "?()"),
    ("a", "?(a|b)"), ("ab", "?(a|b)"), ("ab", "@(a|b)@(a|b)"), ("abc", "a@(b|c)c"), ("a(b)", "a(b)"),
    ("ab", "a+(b"), ("a+(b", "a+(b"), ("x", "@(x\\)|y)"), ("x)", "@(x\\)|y)"), ("ad", "a@(b|c|@(d|e))"),
    ("a", "!(b)"), ("x", "+([[:alpha:]])"), ("1", "+([[:alpha:]])"), ("rm", "@(rm|cp)"), ("mv", "@(rm|cp)"),
    ("ab", "+(a)b"), ("b", "*(a)b"), ("ab", "?(a)?(b)"), ("", "?(a)?(b)"), ("", "@()"), ("x", "@(|x)"),
]

TREE_FILES = [
    "a.txt", "b.txt", ".hidden", ".hidden.txt", "-rf", "c", "sub/x.py", "sub/y.py", "sub/.z.py",
    "sub/inner/deep.txt", "other/x.py", "[brackets]/q", "dir.d/f", "e-f", "e1f", "e_f", "home/.claude/settings.json",
    "home/.claude/other.json", "home/.zshrc", "bin/rm", "bin/rmdir", "bin/cp", "spaced name/file",
]
TREE_DIRS = ["empty", ".hiddendir"]
TREE_LINKS = {"link-to-sub": "sub", "dangling": "nowhere"}
RELATIVE_PATTERNS = [
    "*", "*.txt", ".*", ".??*", "?", "[ab].txt", "[!a].txt", "[^a].txt", "sub/*.py", "sub/*", "*/x.py", "*/*.py",
    "*/", "s*/", "sub/", "sub", "sub/x.py", "missing", "missing/*", "*/missing", "./*.txt", "./sub/*", "./sub/x.py",
    "sub/../*.txt", "sub//*.py", "sub/inner/*", "sub/*/*", "*/*/*", "**", "**/*.py", "e?f", "e[-_]f",
    "e[!-]f", "-*", "[brackets]/q", "\\[brackets\\]/q", "[[]brackets]/q", "home/.claude/*.json", "home/*/*.json",
    "home/.*", "home/*", "bin/r[m]", "bin/r*", "bin/*", "link-to-sub/*", "link*", "dangling", "dangling*", "d*",
    "spaced*", "spaced name/*", "", "*.json", "a.txt/", "a.txt/*", "c", "c/", "[", "a[", "[a", ".hidden",
    "*hidden*", "*.hidden", ".hidden.*", "sub/.*", "sub/.z.py", "empty", "empty/", "empty/*", "???", "?.txt",
    "*.??", "*.?", "sub/[xy].py", "sub/[!x].py", "s?b/x.py",
]
ABSOLUTE_PATTERNS = ["/*.txt", "/sub/*.py", "/*/", "/", "//*.txt", "/./*.txt", "/sub/../*.txt", "/missing/*", "/[ab].txt"]


def oracle_match(text: str, pattern: str) -> bool | str:
    """shell_glob.match, or why it raised: "unsupported" (`!( )`), "error" (Python's
    re rejects the pattern, e.g. `[z-a]`; glob.ts throws Unsupported for both)."""
    try:
        return shell_glob.match(text, pattern)
    except shell_glob.Unsupported:
        return "unsupported"
    except re.error:
        return "error"


def build_tree(root: str) -> None:
    for path in TREE_FILES:
        full = os.path.join(root, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        open(full, "w").close()
    for path in TREE_DIRS:
        os.makedirs(os.path.join(root, path), exist_ok=True)
    for link, target in TREE_LINKS.items():
        os.symlink(target, os.path.join(root, link))


def main() -> None:
    match_cases = [
        {"text": t, "pattern": p, "extglob": False, "matches": e}
        for t, p, e in shell_glob_test.CASES
    ]
    for text, pattern in EXTRA_MATCH:
        match_cases.append({"text": text, "pattern": pattern, "extglob": False, "matches": oracle_match(text, pattern)})
    with shell_glob.extglob(True):
        for t, p, e in shell_glob_test.EXTGLOB_CASES:
            match_cases.append({"text": t, "pattern": p, "extglob": True, "matches": e})
        for text, pattern in EXTRA_EXTGLOB:
            match_cases.append({"text": text, "pattern": pattern, "extglob": True, "matches": oracle_match(text, pattern)})

    path_cases = []
    with tempfile.TemporaryDirectory() as temp:
        real_root = os.path.realpath(temp)
        build_tree(real_root)
        for pattern in RELATIVE_PATTERNS:
            results = sorted(glob.glob(pattern, root_dir=real_root))
            path_cases.append({"pattern": pattern, "rootDir": ROOT, "results": results})
        for pattern in RELATIVE_PATTERNS[:12]:
            results = sorted(glob.glob(pattern, root_dir=os.path.join(real_root, "sub")))
            path_cases.append({"pattern": pattern, "rootDir": ROOT + "/sub", "results": results})
        for pattern in ABSOLUTE_PATTERNS:
            spelled = "/" + real_root + pattern[1:] if pattern.startswith("//") else real_root + pattern
            results = sorted(r.replace(real_root, ROOT) for r in glob.glob(spelled))
            path_cases.append({"pattern": pattern.replace("/", ROOT + "/", 1) if not pattern.startswith("//")
                               else "/" + ROOT + pattern[1:], "rootDir": None, "results": results})
        # The limit stops the listing early (config_guard's itertools.islice).
        path_cases.append({"pattern": "*", "rootDir": ROOT, "limit": 3,
                           "results": sorted(glob.glob("*", root_dir=real_root))[:3], "limited": True})
    _oracle.write_fixture("glob-parity.json", {
        "match": match_cases,
        "tree": {"files": TREE_FILES, "dirs": TREE_DIRS, "links": TREE_LINKS, "root": ROOT},
        "paths": path_cases,
    })


if __name__ == "__main__":
    main()
