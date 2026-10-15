#!/usr/bin/env python3
"""Generate src/shell/__fixtures__/interpreters-parity.json from shell_interpreters.

Programs: hand-written one-liners plus every corpus command (as a program text,
which exercises the literal scanner on realistic shell). Argument lists for
inline_programs/awk_commands come from lexing corpus commands that start with an
interpreter or awk.
Run: python3 scripts/parity/gen-interpreters-fixture.py
"""

from __future__ import annotations

import _oracle
import shell_interpreters
import shell_lexer
from shell_model import Redirect

PROGRAMS = [
    "import os; os.system('rm -rf ~')",
    'import subprocess; subprocess.run(["rm", "-rf", "x"])',
    "import subprocess; subprocess.run(['rm', '-rf', p])",
    "subprocess.check_output('ls -la', shell=True)",
    "print('hello')",
    "require('child_process').execSync('rm -rf x')",
    "require(\"child_process\").spawn(\"rm\", [\"-rf\", \"x\"])",
    "system(\"rm -rf x\"); `ls`; qx{cat /etc/passwd}; qx(echo a); %x(rm y)",
    "%x(rm -rf victim)",
    "exec 'rm -rf x'",
    "shell_exec(\"rm -rf x\"); passthru('ls'); proc_open('cat', [], $p)",
    "do shell script \"rm -rf ~\"",
    "Deno.Command('rm', { args: ['-rf', 'x'] })",
    "Bun.spawn(['rm', '-rf', 'x'])",
    'os.system("""rm -rf\n~""")',
    "os.system('''a''')",
    "x = 'no sink here'; y = \"nor here\"",
    "os.popen('a\\'b'); exec(\"c\\\"d\")",
    "system(\"a\\nb\")",
    "`a\\`b`",
    "os.system(  'spaced'  )",
    "subprocess.call([ 'rm' , '-rf', 'x' , p ])",
    "subprocess.call(['single'])",
    "subprocess.call([\"a\", 'b'])",
    "subprocess.Popen(['a', 'b'], shell=True); os.execvp('rm', ['rm', '-rf', 'x'])",
    "Open3.capture2('ls'); IO.popen('rm x'); Kernel.system('a b')",
    "exec(\"\"); os.system('   ')",
    "os.system('dup'); os.system('dup')",
    "getoutput('a'); check_call('b'); commands.getoutput('c')",
    "`backtick only`",
    "'quoted only'",
    "qx 'not a qx form'",
    "os.system(f'rm {x}')",
    "spawnSync('a'); execFileSync(\"b\"); execFile('c'); execlp('d'); execvp('e'); execl('f')",
    "x = ['rm', '-rf', 'a b']; os.system(' '.join(x))",
    "os.system(\"a\" + \"b\")",
    "system(\"it's\")",
    "unterminated 'string",
    'unterminated "string',
    "a 'multi\nline' system()",
    'system("multi\nline")',
]
ARGV_CASES = [
    ("python3", ["-c", "import os"]), ("python", ["-c"]), ("python3.12", ["-Bc", "code"]), ("python", ["-m", "mod", "-c", "x"]),
    ("python", ["-W", "ignore", "-c", "x"]), ("python", ["-X", "dev", "script.py"]), ("python", ["script.py", "-c", "x"]),
    ("node", ["-e", "code"]), ("node", ["--eval=code"]), ["node", ["--eval", "code"]], ("node", ["-p", "1+1"]), ("node", ["-pe", "x"]),
    ("node", ["-r", "mod", "-e", "x"]), ("node", ["--require", "m", "--print", "y"]), ("node", ["-e"]), ("node", ["-ecode"]),
    ("bun", ["-e", "x"]), ("bun", ["--preload", "p", "-e", "x"]), ("deno", ["eval", "x"]), ("deno", ["run", "x"]),
    ("ruby", ["-e", "x"]), ("ruby", ["-pe", "x"]), ("ruby", ["-ne", "x"]), ("ruby", ["-I", "lib", "-e", "x"]), ("ruby", ["-ex"]),
    ("perl", ["-e", "x"]), ("perl", ["-E", "x"]), ("perl", ["-ne", "x"]), ("perl", ["-lne", "x"]), ("perl", ["-pie", "x"]),
    ("perl", ["-Mstrict", "-e", "x"]), ("perl", ["-M", "strict", "-e", "x"]), ("perl", ["-e", "a", "-e", "b"]),
    ("php", ["-r", "x"]), ("php", ["-d", "x=1", "-r", "y"]), ("php", ["-f", "file"]), ("osascript", ["-e", "x"]),
    ("osascript", ["-l", "JavaScript", "-e", "x"]), ("awk", ["x"]), ("bash", ["-c", "x"]), ("python2", []),
    ("python3", ["-"]), ("python3", ["-c", "a", "-c", "b"]), ("python", ["--c", "x"]), ("python", ["-cc", "x"]),
    ("perl", ["-e"]), ("node", ["-"]), ("python", ["-Ic", "x"]), ("ruby", ["-rjson", "-e", "x"]),
]
REDIRECT_CASES = [
    [("<<", "EOF", "import os\nos.system('rm')")], [("<<-", "EOF", "x")], [("<<", "EOF", "")], [("<<<", "code", None)],
    [(">", "f", None)], [("<<<", "a", None), ("<<", "E", "b")],
]
AWK_CASES = [
    ("awk", ["BEGIN { system(\"rm -rf ~\") }"]), ("gawk", ["{ print | \"sort\" }"]), ("mawk", ["{ \"date\" | getline d }"]),
    ("nawk", ["-F", ":", "{ system(\"x\") }"]), ("awk", ["-v", "x=1", "{ system(\"y\") }"]), ("awk", ["-f", "prog.awk"]),
    ("awk", ["-e", "{ system(\"z\") }"]), ("awk", ["--source", "{ system(\"w\") }", "file"]), ("awk", ["-W", "{ system(\"v\") }"]),
    ("awk", ["--", "{ system(\"u\") }"]), ("awk", ["{ system(\"a\\\"b\\\\c\") }"]), ("awk", ["{ system(\"\") }"]),
    ("awk", ["{ system( \"spaced\" ) }"]), ("awk", ["-", "{ system(\"t\") }"]), ("awk", []), ("sed", ["s/a/b/"]),
    ("awk", ["{ print | \"cmd1\"; \"cmd2\" | getline; system(\"cmd3\") }"]), ("awk", ["-f"]),
]


def main() -> None:
    programs = [*PROGRAMS, *_oracle.corpus_commands()]
    kinds = ["python", "ruby", "perl", "php", "node", None]
    program_cases = [{
        "program": program,
        "shellStrings": shell_interpreters.shell_strings(program),
        "stringLiterals": shell_interpreters.string_literals(program),
        "directShellStrings": {str(kind): shell_interpreters.direct_shell_strings(program, kind) for kind in kinds},
    } for program in programs]
    argv_cases = []
    for item in ARGV_CASES:
        name, args = item
        argv_cases.append({"name": name, "args": args, "kind": shell_interpreters.interpreter_kind(name),
                           "programs": shell_interpreters.inline_programs(name, tuple(args))})
    for command in _oracle.corpus_commands():
        tokens = shell_lexer.lex(command).tokens
        if tokens and isinstance(tokens[0], shell_lexer.Word):
            name = tokens[0].text.rsplit("/", 1)[-1]
            if shell_interpreters.interpreter_kind(name) or name in ("awk", "gawk", "mawk", "nawk"):
                args = []
                for token in tokens[1:]:
                    if isinstance(token, shell_lexer.Operator):
                        break
                    args.append(token.text)
                argv_cases.append({"name": name, "args": args, "kind": shell_interpreters.interpreter_kind(name),
                                   "programs": shell_interpreters.inline_programs(name, tuple(args)),
                                   "awk": shell_interpreters.awk_commands(name, tuple(args))})
    redirect_cases = [{
        "redirects": [{"op": op, "target": target, "body": body} for op, target, body in redirects],
        "programs": shell_interpreters.inline_programs(
            "python3", ("-c", "x"), tuple(Redirect(op, target, False, body) for op, target, body in redirects)),
    } for redirects in REDIRECT_CASES]
    awk_cases = [{"name": n, "args": a, "commands": shell_interpreters.awk_commands(n, tuple(a))} for n, a in AWK_CASES]
    _oracle.write_fixture("interpreters-parity.json", {
        "programs": program_cases, "argv": argv_cases, "redirects": redirect_cases, "awk": awk_cases,
    })


if __name__ == "__main__":
    main()
