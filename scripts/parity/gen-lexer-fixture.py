#!/usr/bin/env python3
"""Generate src/shell/__fixtures__/lexer-parity.json from the Python shell_lexer.

Every command of the guard corpora plus the edge cases below is lexed by the
oracle; lexer.spec.ts lexes the same text and compares token for token.
Run: python3 scripts/parity/gen-lexer-fixture.py
"""

from __future__ import annotations

import _oracle
import shell_lexer

EDGE_CASES = [
    "echo hi\nrm -rf ~",
    "echo a#b; rm -rf ~ # comment",
    "echo a \\\n b",
    "cat <<EOF\nline $X $(cmd)\n  indented\nEOF\necho after",
    "cat <<'EOF'\nit's $X\nEOF",
    "cat <<-EOF\n\t\tbody\n\tEOF",
    'cat <<"E"O"F"\nx\nEOF',
    "cat <<EOF <<EOF2\na\nEOF\nb\nEOF2",
    "cat <<EOF\nnever closed",
    "cat <<EOF",
    "cat << ",
    "echo $(cat <<'EOF'\nit's\nEOF\n) done",
    "X=(a \"b c\" $Y $(cmd) 'd')",
    "X+=(1 2)",
    "X=(a b",
    "X=(a # comment\nb)",
    "X=(a;b|c)",
    "(( 1 + 2 ))",
    "((cd x; ls))",
    "(( $(cmd) + 1 ))",
    "((a) && (b))",
    "echo $((1 + $(cmd))) ${X:-$(cmd)} ${Y:=`cmd`} ${Z##*/}",
    "${1:-$(a)} ${@-$(b)} ${#:+$(c)} ${!:=$(d)}",
    "2>&1 ls 3<<<x 1>out 10>&2 '2'>q 2 >r",
    "echo <(cmd) >(cmd2) < <(cmd3)",
    "$'\\x72\\155\\n\\t\\a\\e\\u0072\\U00000072\\cA\\c\\q'",
    "$'\\x' $'\\xzz' $'\\u' $'\\uZZZZ' $'\\U00110000' $'\\c'",
    "$'unterminated",
    "'unterminated",
    '"unterminated $X',
    "`unterminated",
    "$(unterminated",
    "${unterminated",
    "echo \\",
    'echo "a\\',
    "echo `a\\",
    "echo $X'm' $X\"m\" $Xm ${X}m $X-m $X_m \"$X\"m",
    "echo a{b,c}d {rm,-rf,x} '{a,b}' \"{c,d}\" {} {x} a{b{c,d},e}f",
    'echo "\\$ \\` \\" \\\\ \\n \\a"',
    "echo `echo \\`inner\\` \\$x \\\\ \\a`",
    "echo $$ $! $? $- $# $@ $* $0 $1 $9 $_ $é $ $a1_b $",
    "echo $(echo \"a)b\") $(echo 'a)b') $(echo `a)b`) $(echo \\))",
    "echo ${X}} ${X:-{}} ${X/a/${Y}}",
    "echo \"$(echo \"nested $(cmd)\")\"",
    "a && b || c ; d & e | f |& g ;; h ;& i ;;& j",
    "a &> f &>> g >| h <> i <& j >& k >> l",
    "echo\t\"tab\"\r\n",
    "f() { rm -rf x; }",
    "case $x in a) echo a;; *) echo b;; esac",
    "for i in 1 2; do echo $i; done",
    "echo 'a'\"b\"$'c'\\d$X\"$Y\"'$Z'",
    "echo ${X@Q} ${X[@]} ${X[1]} ${!X} ${#X} ${X:1:2}",
    "",
    " \t\n",
    "   #only a comment",
    "\\",
    "echo 2>",
    "X=",
    "X=(",
    "echo $(( 1 + 2 )",
    "echo $(((1+2)))",
    "echo ${X:-\"}\"} ${Y:-'}'}",
    "cat <<EOF\n$(rm -rf x)\n`rm y`\nEOF",
    "cat <<\\EOF\n$(rm -rf x)\nEOF",
    "cat <<$X\nbody\n$X",
    "cat <<E\\OF\nbody\nEOF",
    "é=1; echo ${é} $é é",
    "echo \"${X:-$(a) $(b)}\" ${Y:+`c`}",
    "ls 2>&1 >/dev/null 2>&1 | grep x",
]


def word_json(word: shell_lexer.Word) -> dict:
    return {
        "type": "word",
        "text": word.text,
        "dynamic": word.dynamic,
        "quoted": word.quoted,
        "heredocBody": word.heredoc_body,
        "substitutions": list(word.substitutions),
        "splits": word.splits,
        "braces": list(word.braces),
        "elements": [word_json(e) for e in word.elements] if word.elements is not None else None,
        "guards": {str(index): list(guard) for index, guard in word.guards.items()},
    }


def token_json(token: shell_lexer.Word | shell_lexer.Operator) -> dict:
    if isinstance(token, shell_lexer.Operator):
        return {"type": "op", "op": token.op, "fd": token.fd}
    return word_json(token)


def main() -> None:
    cases = []
    for command in [*_oracle.corpus_commands(), *EDGE_CASES]:
        result = shell_lexer.lex(command)
        cases.append({
            "command": command,
            "tokens": [token_json(t) for t in result.tokens],
            "substitutions": list(result.substitutions),
            "unterminated": result.unterminated,
            "nested": shell_lexer.nested_substitutions(command),
        })
    _oracle.write_fixture("lexer-parity.json", cases)


if __name__ == "__main__":
    main()
