#!/usr/bin/env python3
"""Generate src/shell/__fixtures__/expand-parity.json from shell_expand.

Each case lexes a command with a preset variable table and runs every word
through the pipeline shell_parse uses (array_words / _at_word_pieces, then
_brace_expand -> _expand_word -> _split_unquoted; _compound_word for arrays),
recording the words, the truncated flag and the variables afterwards. Glob
cases do the same through _glob_words over a file tree built in a temporary
directory (expand.spec.ts rebuilds it in memoryHost under ROOT).
Run: python3 scripts/parity/gen-expand-fixture.py
"""

from __future__ import annotations

import os
import tempfile

import _oracle
import shell_expand
import shell_lexer
from shell_model import _FIELD, SHELL_OPTION, UNSET, ParseResult, WrittenFile, _Context

ROOT = "/expand-root"
CWD = "/work"

BASE = {
    "X": ["rm"], "P": ["~/.claude/x.bak"], "Y": ["echo", "rm"], "U": [UNSET], "E": [""], "N": ["X"],
    "A[0]": ["a"], "A[1]": ["b c"], "A[3]": ["d"], "A": ["a"], "i": ["1"], "n": ["3"], "D": ["/usr/local/bin"],
    "S": ["\\x72m"], "Q": ["it's"], "C": ["rm,-rf,/"], "M": ["rM"], "L": ["a[$(cmd)]"], "V": ["L"],
    "@": ["a" + _FIELD + "b" + _FIELD + "c"],
}
COMMA = {**BASE, "IFS": [","]}
MULTI_IFS = {**BASE, "IFS": [",", " "]}
EXTGLOB = {**BASE, SHELL_OPTION + "extglob": ["on"]}
XPG = {**BASE, SHELL_OPTION + "xpg_echo": ["on"]}
NO_PARAMS = {k: v for k, v in BASE.items() if k != "@"}
CASES = [
    (BASE, "$X -rf ~"), (BASE, '"$X" ${X} $X-rf $Xm ${X}m'), (BASE, "${X:0:2} ${X,,} ${P%.bak} ${!N} ${#X} ${#P}"),
    (BASE, "${X:-d} ${U:-d} ${E:-d} ${E-d} ${Z:-d} ${U-d}"), (BASE, "${X:+alt} ${Z:+alt} ${U:+alt} ${E:+alt} ${E+alt}"),
    (BASE, "${X:=w} ${Z:=w} ${U:=w} ${E:=w} ${E=w}; $Z $U $E"), (BASE, "${X:?msg} ${Z:?msg} ${U?msg}"),
    (BASE, "$(echo rm) `printf r` $(echo -n a; echo b) $(printf '%s\\n' x y)"),
    (BASE, "$(mktemp) $(mktemp -d) $(mktemp -p /x) $(mktemp -t a.XXX) $(mktemp out.XXX) $(mktemp --tmpdir=/y z.XX)"),
    (BASE, "$(mktemp -q --suffix=.sh) $(mktemp -z) $(mktemp $X) $(mktemp -p $D f) $(mktemp;echo)"),
    (BASE, "$(cat f) $(cat g) $(cat f g) $(cat -n f) $(cat)"), (BASE, "$(ls) $(echo $X) $(echo \"$X\") $(echo rm > f)"),
    (BASE, "$(echo rm | cat) $(true; echo rm) $(echo a)$(echo b) x$(echo y)z `echo` $()"),
    (BASE, "$HOME/x ~/x $PWD/x x$PWD ${PWD} $HOME ${HOME:-z}"), (BASE, "$1 $2 $3 $4 $# $@ $* $0 ${1} ${@} ${*} $11"),
    (BASE, '"$@" "$*" r"$@"x r$@x "${@}" r"${@}"x "$1$2"'), (NO_PARAMS, '"$@" $1 $# r"$@"x ${#} ${@}'),
    (BASE, "${A[0]} ${A[1]} ${A[-1]} ${A[-2]} ${A[-9]} ${A[@]} ${A[*]} ${#A[@]} ${#A[*]} ${A[i+1]} ${A[$i]} ${A[9]} ${A[i]}"),
    (BASE, '"${A[@]}" "${A[*]}" ${A[@]} "${B[@]}" ${A[1+1]} ${A[n-2]} ${A[2**2-1]} ${A[x]}'),
    (COMMA, '"${A[*]}" $C "$C" ${C} $X "$*" $*'), (MULTI_IFS, "$C"), (BASE, "$C ${C}x"),
    (BASE, "${X@Q} ${X@P} ${X@U} ${X@u} ${X@L} ${S@E} ${Q@Q} ${X@A} ${X@K} ${X@a} ${X@z}"),
    (BASE, "$((1+2)) $(( i + n )) $((X)) ((i+1)) $(($(echo 1)+1))"),
    (BASE, "{a,b}$X {rm,-rf,~/x} a{b,c}d {a..c} {} {x} a{b{c,d},e}f '{a,b}' \"{c,d}\" {a,$X} {$X,$Y}"),
    (BASE, "rm {" + ",".join(["x"] * 70) + ",-rf} victim"), (BASE, "{" + ",".join(f"v{i}" for i in range(64)) + "}"),
    (BASE, "{" + ",".join(f"v{i}" for i in range(65)) + "}"), (BASE, "a{b,c}{d,e}{f,g}{h,i}{j,k}{l,m}{n,o}"),
    (BASE, "$X$X \"$X $Y\" $Y ${Y} $Y$X"), (BASE, "${X/r/R} ${X//[rm]/_} ${X^^} ${X#r} ${D##*/} ${D%/*} ${X:1} ${X: -1}"),
    (BASE, "${M/!(r)/m} ${M/@(r|M)/_}"), (EXTGLOB, "${M/!(r)/m} ${M/@(r|M)/_} ${M/+(r)/_}"),
    (XPG, "$(echo '\\0162') $(echo -E '\\0162') `echo '\\0162\\155'`"), (BASE, "$(echo '\\0162') $(echo -e '\\0162')"),
    (BASE, "${Z/a/b} ${Z:1} ${Z#x} ${Z@Q} ${#Z} ${!Z} ${!X} ${!E}"),
    (BASE, "${X:-$(echo d)} ${Z:-$(echo d)} ${Z:-$Y} ${X:-${Y}} ${Z:-${Y}} ${Z:-${W:-deep}} ${X}${Y} ${X}}"),
    (BASE, "${Z:=$(echo d)} $Z; ${W:=$X}; $W ${W2:=${X}y}; $W2"),
    (BASE, "${ ${X ${X:- $"), (BASE, "$ $$ $! $? $- $_ $é ${é} $é$X"),
    (BASE, "X=(a \"b c\" $Y $X $(echo d) {e,f} ${A[@]} $C)"), (COMMA, "X=($C)"), (BASE, "X+=(1 2) Y=() Z=($Q)"),
    (BASE, "${L} $((L)) $((V)) $((n)) $((Z))"), (BASE, '"${X} ${Y}" "${Z:-$X}" "${Z}" "$Z"'),
    (BASE, "${X:0:-1} ${X:5} ${X: 0 : 1 } ${X:-1} ${X: -1:1} ${X:x} ${X:$i} ${X:i}"),
    (BASE, "${A[0]:1} ${A[1]%c} ${A[@]:1} ${#A[0]} ${A[0]:-z} ${A[9]:-z} ${A[1]@U}"),
    (BASE, "cat <<EOF\n$X $Z\nEOF"), (BASE, "echo $(echo $(echo rm))"), (BASE, "$(echo a b c) \"$(echo a b c)\""),
    (COMMA, "$(echo a,b,c) \"$(echo a,b,c)\" $(echo a) $(printf a,)"), (BASE, "${X:-}x ${Z:-}x ${Z:+}x ${Z}x"),
    (BASE, "$X'' $X\"\" ''$X \"\"$X"), (BASE, "${X-${Z-${W-d}}} ${#@} ${#*} ${@:1} ${*:1}"),
]

# Pathname expansion: files under the cwd, paths the line created earlier, the command.
TREE = ["-rf", "a.txt", "b.txt", ".hidden", "bin/rm", "bin/rmdir", "sub/x.py", "x1", "x2", "y 1"]
GLOB_CASES = [
    ([], "rm -* x"), ([], ROOT + "/bin/r[m] x"), ([], "ls *.txt .*"), ([], "ls '*.txt' \"*.txt\" $X*"), ([], "ls z*"),
    ([], "ls bin/r* */x.py ./x* x?"), ([], "echo " + ROOT + "/*.txt " + ROOT + "/sub/* /nonexistent-dir-x/*"),
    (["x3"], "ls x*"), (["x3", ".x4"], "ls ./x* .x* *"), ([ROOT + "/x3"], "ls " + ROOT + "/x*"),
    (["-rf", "-n"], "rm -* x"), ([], "ls sub/*.py"), (["sub/z.py"], "ls sub/*"), ([], "ls [ab].txt y\\ 1*"),
    ([], "x* ls"), (["z"], "z* ls"), ([], "ls " + " ".join(f"m{i}*" for i in range(3))),
]


def make_context(variables: dict[str, list[str]], cwd: str) -> _Context:
    ctx = _Context(ParseResult(), cwd, None, (cwd,))
    ctx.variables = {name: tuple(values) for name, values in variables.items()}
    ctx.written_files = {os.path.join(cwd, "f"): WrittenFile("r", True), os.path.join(cwd, "g"): WrittenFile("m", False)}
    return ctx


def word_json(word: shell_lexer.Word) -> dict:
    return {"text": word.text, "dynamic": word.dynamic, "quoted": word.quoted, "splits": word.splits,
            "substitutions": list(word.substitutions)}


def expand_tokens(tokens, ctx: _Context) -> list:
    out = []
    for token in tokens:
        if isinstance(token, shell_lexer.Operator):
            out.append({"op": token.op})
            continue
        if token.elements is not None:
            out.append({"compound": word_json(shell_expand._compound_word(token, ctx, {}))})
            continue
        array = shell_expand.array_words(token, ctx)
        pieces = shell_expand._at_word_pieces(token, ctx) if array is None else None
        expanded = []
        for piece in shell_expand._brace_expand(token, ctx):
            expanded += shell_expand._split_unquoted(piece, shell_expand._expand_word(piece, ctx), ctx)
        out.append({
            "arrayWords": [word_json(w) for w in array] if array is not None else None,
            "atWordPieces": [word_json(w) for w in pieces] if pieces is not None else None,
            "expanded": [word_json(w) for w in expanded],
            "arithmetic": shell_expand._arithmetic_expressions(token.text),
        })
    return out


def main() -> None:
    cases = []
    for variables, command in CASES:
        ctx = make_context(variables, CWD)
        tokens = shell_lexer.lex(command).tokens
        words = expand_tokens(tokens, ctx)
        cases.append({
            "variables": variables, "command": command, "words": words, "truncated": ctx.result.truncated,
            "variablesAfter": {k: list(v) for k, v in ctx.variables.items()},
            "ifsValues": list(shell_expand._ifs_values(ctx)),
            "ifsValuesEnv": list(shell_expand._ifs_values(ctx, ("A=1", "IFS=:", "B=2"))),
            "arithmeticSubstitutions": {
                e: shell_expand._arithmetic_substitutions(e, ctx)
                for e in ("L", "V+1", "X", "i+n", "Z")},
        })
    glob_cases = []
    with tempfile.TemporaryDirectory() as temp:
        real = os.path.realpath(temp)
        for path in TREE:
            full = os.path.join(real, path)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            open(full, "w").close()
        for created, command in GLOB_CASES:
            ctx = make_context(BASE, real)
            ctx.created_paths = {os.path.join(real, p.replace(ROOT + "/", "")) for p in created}
            tokens = shell_lexer.lex(command.replace(ROOT, real)).tokens
            words = [w for t in tokens if isinstance(t, shell_lexer.Word)
                     for p in shell_expand._brace_expand(t, ctx)
                     for w in shell_expand._split_unquoted(p, shell_expand._expand_word(p, ctx), ctx)]
            globbed = shell_expand._glob_words(words, ctx)
            glob_cases.append({
                "created": created, "command": command, "truncated": ctx.result.truncated,
                "words": [{"text": w.text.replace(real, ROOT), "dynamic": w.dynamic, "quoted": w.quoted} for w in globbed],
            })
        ctx = make_context(BASE, real)
        ctx.created_unknown = True
        globbed = shell_expand._glob_words(shell_lexer.lex("r* -* x*").tokens, ctx)
        glob_cases.append({"created": [], "createdUnknown": True, "command": "r* -* x*", "truncated": ctx.result.truncated,
                           "words": [{"text": w.text, "dynamic": w.dynamic, "quoted": w.quoted} for w in globbed]})
    _oracle.write_fixture("expand-parity.json", {"cwd": CWD, "root": ROOT, "tree": TREE, "cases": cases, "glob": glob_cases})


if __name__ == "__main__":
    main()
