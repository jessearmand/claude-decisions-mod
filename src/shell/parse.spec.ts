/** Tests for the lexer and the parse driver, ported from shell_parse_test.py. */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the commands under test spell shell parameter expansions

import { describe, expect, it } from "vitest";
import { memoryHost } from "../host/memory-host.ts";
import { shellQuote } from "../util/text.ts";
import { parse, type SimpleCommand } from "./parse.ts";

const host = memoryHost({ home: "/home/u" });
const HOME = host.home;

const run = (command: string, cwd = "/") => parse(command, cwd, host);
const argvs = async (command: string, cwd = "/") => (await run(command, cwd)).commands.map((c) => c.argv);
const echoes = async (command: string) =>
    (await run(command)).commands.filter((c) => c.name === "echo").map((c) => c.argv);

// (command, expected argv of every simple command, in order)
const ARGV_CASES: Array<[string, string[][]]> = [
    [
        "printf %s prefix<(echo hi)suffix",
        [
            ["echo", "hi"],
            ["printf", "%s", "prefix<(echo hi)suffix"],
        ],
    ],
    ["OUT=>(echo hi) env", [["echo", "hi"], ["env"]]],
    ["ls -la", [["ls", "-la"]]],
    ["a && b || c; d & e", [["a"], ["b"], ["c"], ["d"], ["e"]]],
    [
        "echo hi\nrm x",
        [
            ["echo", "hi"],
            ["rm", "x"],
        ],
    ],
    [
        "echo a{b,c}d {x,{y,z}}! '{p,q}' \"{r\",s} {} {t}",
        [["echo", "abd", "acd", "x!", "y!", "z!", "{p,q}", "{r,s}", "{}", "{t}"]],
    ],
    ["echo a#b # trailing comment", [["echo", "a#b"]]],
    ["echo 'a b' \"c d\" e\\ f", [["echo", "a b", "c d", "e f"]]],
    ["sudo -u root -- rm x", [["rm", "x"]]],
    ["env -i FOO=1 BAR=2 python3 x.py", [["python3", "x.py"]]],
    ["timeout -s KILL 30 make test", [["make", "test"]]],
    ["strace -o /dev/null rm -rf victim", [["rm", "-rf", "victim"]]],
    ["strace --output=trace git status", [["git", "status"]]],
    ["strace --quiet git status", [["git", "status"]]],
    ["time -p nice -10 ionice -c 3 cmd", [["cmd"]]],
    ["command -v git", [["command", "-v", "git"]]],
    ["sudo -l", [["sudo", "-l"]]],
    ["uv run --with rich python x.py", [["python", "x.py"]]],
    ["fnox exec --if-missing error -- ai evaluate", [["ai", "evaluate"]]],
    ["bash -c 'a; b'", [["bash", "-c", "a; b"], ["a"], ["b"]]],
    ["x=$(id -u)", [["id", "-u"]]],
    [
        "diff <(sort a) b",
        [
            ["sort", "a"],
            ["diff", "<(sort a)", "b"],
        ],
    ],
    [
        "find . -name '*.o' -exec rm {} + -o -execdir chmod 600 {} \\;",
        [
            [
                "find",
                ".",
                "-name",
                "*.o",
                "-exec",
                "rm",
                "{}",
                "+",
                "-o",
                "-execdir",
                "chmod",
                "600",
                "{}",
                ";",
            ],
            ["rm", "{}"],
            ["chmod", "600", "{}"],
        ],
    ],
];

const REDIRECT_CASES: Array<[string, Array<[string, string]>]> = [
    ["echo x > out.txt", [[">", "out.txt"]]],
    [
        "cmd 2>&1 >>log",
        [
            [">&", "1"],
            [">>", "log"],
        ],
    ],
    ["cmd &> all.log", [["&>", "all.log"]]],
    [
        "cat <<EOF > f\nbody\nEOF",
        [
            ["<<", "EOF"],
            [">", "f"],
        ],
    ],
];

describe("simple commands", () => {
    it.each(ARGV_CASES)("%j", async (command, expected) => {
        expect(await argvs(command)).toEqual(expected);
    });
});

describe("redirects", () => {
    it.each(REDIRECT_CASES)("%j", async (command, expected) => {
        const parsed = await run(command);
        const actual = parsed.commands.flatMap((c) => c.redirects.map((r) => [r.op, r.target]));
        expect(actual).toEqual(expected);
    });
});

describe("heredoc bodies", () => {
    it("quoted heredoc body is data", async () => {
        const parsed = await run("cat <<'EOF' > notes.md\n$(not run)\nEOF");
        expect(parsed.commands[0]?.redirects[0]?.body).toBe("$(not run)");
        expect(parsed.commands).toHaveLength(1);
    });
    it("unquoted heredoc runs $(...)", async () => {
        const parsed = await run("cat <<EOF\n$(run me)\nEOF");
        expect(parsed.commands[0]?.argv).toEqual(["run", "me"]);
    });
    it("apostrophe in a heredoc inside $(...) is data", async () => {
        const parsed = await run(
            "gh pr create --body \"$(cat <<'EOF'\nit's about rm -rf ~\nEOF\n)\" && rm x",
        );
        expect(parsed.commands.map((c) => c.name)).toEqual(["cat", "gh", "rm"]);
        expect(parsed.unparseable).toBe(false);
    });
    it("bash -n runs nothing", async () => {
        expect((await run("bash -n -c 'rm -rf /'")).commands.map((c) => c.name)).toEqual(["bash"]);
    });
    it("carriage return stays in the word", async () => {
        expect((await run("a\rb")).commands[0]?.argv).toEqual(["a\rb"]);
    });
    it("substitutions run with their command, inner first", async () => {
        const order = (await run("a $(b) && c $(d $(e))")).commands.map((c) => c.name);
        expect(order).toEqual(["b", "a", "e", "d", "c"]);
    });
});

describe("shell invocations", () => {
    it.each<[string, string[]]>([
        ["fish -c 'a'", ["a"]],
        ["fish -C 'a' x.fish", ["a"]],
        ["fish --command=a", ["a"]],
        ["fish --init-command=a", ["a"]],
        ["bash -lc a", ["a"]],
        ["echo $(( $(a) + 1 ))", ["a"]],
        ["bash -n -c a", []],
    ])("%j runs %j", async (command, expected) => {
        const names = (await run(command)).commands.filter((c) => c.name === "a").map((c) => c.name);
        expect(names).toEqual(expected);
    });
});

describe("variables", () => {
    it("assigned target resolves; single-quoted $P stays literal", async () => {
        const parsed = await run("P=$HOME/.claude/s.json; echo x > \"$P\"; echo '$P'");
        const target = parsed.commands[0]?.redirects[0];
        expect(target?.target).toBe(`${HOME}/.claude/s.json`);
        expect(target?.dynamic).toBe(false);
        expect(parsed.commands[1]?.argv).toEqual(["echo", "$P"]);
    });
    it("unset stays as written", async () => {
        expect((await run("echo $UNSET > f")).commands[0]?.argv).toEqual(["echo", "$UNSET"]);
    });
    it("quote boundaries and splitting", async () => {
        const parsed = await run("X=r; Y='a b'; echo $X'm' \"$X\"m '$X'm $Y'' \"$Y\"");
        expect(parsed.commands.at(-1)?.argv).toEqual(["echo", "rm", "rm", "$Xm", "a", "b", "a b"]);
    });
    it("parameter operators on a known value", async () => {
        const parsed = await run(
            "X=hello.tar.gz; echo ${X:1} ${#X} ${X/l/L} ${X//l/L} ${X^} ${X%%.*} ${X%.*} ${X#*.} " +
                "${X##*.} ${X: -2} ${X:1:-2} ${!X}",
        );
        expect(parsed.commands.at(-1)?.argv.slice(1)).toEqual([
            "ello.tar.gz",
            "12",
            "heLlo.tar.gz",
            "heLLo.tar.gz",
            "Hello.tar.gz",
            "hello",
            "hello.tar",
            "tar.gz",
            "gz",
            "gz",
            "ello.tar.",
            "${!X}",
        ]);
    });
    it("positional parameters from set --", async () => {
        const argv = await argvs('set -- a "b c"; echo "$@" "$*" $# $2; (set -- z); echo $1');
        expect(argv[1]).toEqual(["echo", "a", "b c", "a b c", "2", "b", "c"]);
        expect(argv.at(-1)).toEqual(["echo", "a"]);
    });
    it("links recorded", async () => {
        const links = (await run("ln -s /etc/hosts h; ln -st /tmp /a/b", "/w")).links;
        expect([...links.entries()]).toEqual([
            ["/w/h", "/etc/hosts"],
            ["/tmp/b", "/a/b"],
        ]);
    });
    it('"$@" inside a word', async () => {
        expect((await run('set -- a b c; echo x"$@"y')).commands.at(-1)?.argv).toEqual([
            "echo",
            "xa",
            "b",
            "cy",
        ]);
    });
    it("${X:=word} assigns", async () => {
        const argv = await argvs(": ${X:=r} ${Y=a}; echo $X $Y; Z=k; : ${Z:=q}; echo $Z");
        expect(argv[1]).toEqual(["echo", "r", "a"]);
        expect(argv.at(-1)).toEqual(["echo", "k"]);
    });
    it("IFS splits expansions and read", async () => {
        const argv = await argvs('IFS=,; X=a,b; echo $X "$X"; IFS=: read A B <<< "c:d"; echo $A $B');
        expect(argv[0]).toEqual(["echo", "a", "b", "a,b"]);
        expect(argv.at(-1)).toEqual(["echo", "c", "d"]);
    });
    it("aliases expand once, unalias removes", async () => {
        const argv = await argvs("alias a=b b='a x'; a; alias ll='ls -l'; ll; unalias ll; ll");
        expect(argv.filter((_, index) => index % 2 === 1)).toEqual([["a", "x"], ["ls", "-l"], ["ll"]]);
    });
    it("declare -u and -i", async () => {
        const argv = await argvs("declare -u X; X=rm; declare -i N=5; echo $X $N");
        expect(argv.at(-1)).toEqual(["echo", "RM", "$N"]);
    });
    it("local -n in a function", async () => {
        const parsed = await run("f(){ local -n r=$1; r=rm; }; f X; echo $X");
        expect(parsed.commands.at(-1)?.argv).toEqual(["echo", "rm"]);
        expect(parsed.truncated).toBe(false);
    });
    it("compound array assignments", async () => {
        const argv = await argvs(
            "X=(a 'b c' $Y [5]=d); X+=(e); echo \"${X[1]}\" ${X[5]} ${X[6]} $X; X=(z); echo ${X[1]}",
        );
        expect(argv).toEqual([
            ["echo", "b c", "d", "e", "a"],
            ["echo", "${X[1]}"],
        ]);
    });
    it("prefix assignments: temporary, kept by export", async () => {
        const argv = await argvs("X=a; X=b true; echo $X; X=c export X; echo $X");
        expect(argv[1]).toEqual(["echo", "a"]);
        expect(argv.at(-1)).toEqual(["echo", "c"]);
    });
    it("shift", async () => {
        const argv = await argvs("set -- a b c; shift 5; echo $#; shift 2; echo $# $1");
        expect(argv[2]).toEqual(["echo", "3"]);
        expect(argv.at(-1)).toEqual(["echo", "1", "c"]);
    });
    it("read -N / -n", async () => {
        const argv = await argvs(
            'read -N 3 A B <<< "a b c"; echo "$A" "[$B]"; read -n 3 A B <<< "a b c"; echo $A $B',
        );
        expect(argv[1]).toEqual(["echo", "a b", "[]"]);
        expect(argv.at(-1)).toEqual(["echo", "a", "b"]);
    });
    it("trap resets, ignores and listings run nothing", async () => {
        expect(await argvs("trap - EXIT; trap '' INT; trap -p; trap EXIT")).toHaveLength(4);
    });
    it("mapfile -O / -s / -n / -t", async () => {
        const argv = await argvs(
            "X=(q w e); mapfile -O 1 -t X <<< z; echo ${X[0]} ${X[1]} ${X[2]}; " +
                "mapfile -s 1 -n 1 -t Y < <(printf '1\\n2\\n3\\n'); echo ${Y[0]} ${Y[1]}",
        );
        expect(argv[1]).toEqual(["echo", "q", "z", "e"]);
        expect(argv.at(-1)).toEqual(["echo", "2", "${Y[1]}"]);
    });
    it("getopts as bash runs it", async () => {
        const argv = await echoes(
            "set -- -rf -x val z; getopts rfx: O; echo $O $OPTIND; getopts rfx: O; " +
                "echo $O $OPTIND; getopts rfx: O; echo $O $OPTARG $OPTIND; getopts rfx: O; " +
                "echo $O $OPTIND; getopts :ab Q -c; echo $Q $OPTARG; OPTIND=1; getopts :ab Q -c; echo $Q $OPTARG",
        );
        expect(argv).toEqual([
            ["echo", "r", "1"],
            ["echo", "f", "2"],
            ["echo", "x", "val", "4"],
            ["echo", "?", "4"],
            ["echo", "?", "$OPTARG"],
            ["echo", "?", "c"],
        ]);
    });
    it("hash -r forgets, a function comes first", async () => {
        const argv = await argvs("hash -p /bin/rm x; hash -r; x; f(){ :; }; hash -p /bin/rm f; f");
        expect(argv[2]).toEqual(["x"]);
        expect(argv.at(-2)).toEqual(["f"]);
    });
    it("$((...)) closes at `))`; ((expr)) is arithmetic, ((cmd; cmd)) subshells", async () => {
        expect(await argvs("echo $((1+2)) ok; (( n++ )); ((cd /tmp; ls))")).toEqual([
            ["echo", "$((1+2))", "ok"],
            ["(( n++ ))"],
            ["cd", "/tmp"],
            ["ls"],
        ]);
    });
    it("@ transformations; @P is not modelled", async () => {
        const parsed = await run("X=abc; echo ${X@U} ${X@Q} ${X@P}");
        expect(parsed.commands[0]?.argv).toEqual(["echo", "ABC", "'abc'", "${X@P}"]);
        expect(parsed.truncated).toBe(true);
    });
    it("array subscripts", async () => {
        const parsed = await run("X=(a 'b c' d); echo ${#X[@]} \"${X[@]}\" ${X[*]} ${X[1+1]} ${X[-1]}");
        expect(parsed.commands.at(-1)?.argv).toEqual([
            "echo",
            "3",
            "a",
            "b c",
            "d",
            "a",
            "b",
            "c",
            "d",
            "d",
            "d",
        ]);
    });
    it("exit ends the shell, ( exit ) only the subshell", async () => {
        expect(await argvs("X=echo; (exit); X=ls; exit; X=rm; echo $X")).toEqual([["exit"], ["exit"]]);
    });
    it("descriptors: 3<<< is not stdin; 3<&- closes", async () => {
        const argv = await echoes(
            "read X 3<<< no <<< yes; echo $X; exec 3<<<a; exec 3<&-; read -u 3 Y; echo $Y",
        );
        expect(argv).toEqual([
            ["echo", "yes"],
            ["echo", "$Y"],
        ]);
    });
    it("read -n/-N take K characters, an escape counts once", async () => {
        const argv = await echoes(
            "exec 3<<<$'a\\\\bcd\\nefg'; read -u3 -n2 X; read -u3 Y; read -u3 -N2 Z; echo $X $Y $Z",
        );
        expect(argv).toEqual([["echo", "ab", "cd", "ef"]]);
    });
    it("declare -u converts later assignments; a subshell's attribute stays there", async () => {
        const argv = await echoes(
            "X=a; declare -u X; echo $X; X+=b; echo $X; (declare -l X); X=c; echo $X; unset X; X=d; echo $X",
        );
        expect(argv).toEqual([
            ["echo", "a"],
            ["echo", "AB"],
            ["echo", "C"],
            ["echo", "d"],
        ]);
    });
    it("aliases and functions follow branches, subshells and unset -f", async () => {
        const parsed = await run(
            "alias x=ls; false && alias x=pwd; x; f(){ id; }; (f(){ who; }); f; unset -f f; f",
        );
        const argv = parsed.commands
            .filter((c) => !["alias", "false", "unset"].includes(c.name))
            .map((c) => c.argv);
        expect(argv).toContainEqual(["ls"]);
        expect(argv).toContainEqual(["pwd"]);
        expect(argv.slice(-3)).not.toContainEqual(["who"]);
        expect(argv.at(-1)).toEqual(["f"]);
    });
    it("a local array and its attributes end with the function", async () => {
        const argv = await echoes("X=(a b); f(){ local -u X; X[1]=c; echo ${X[1]}; }; f; echo ${X[@]}");
        expect(argv.slice(-2)).toEqual([
            ["echo", "C"],
            ["echo", "a", "b"],
        ]);
    });
    it("exec N<&M shares M's stream, and outlives closing M", async () => {
        const argv = await echoes(
            "exec 3<<<$'a\\nb\\nc'; exec 4<&3; read -u3 X; read -u4 Y; exec 3<&-; read -u4 Z; echo $X $Y $Z",
        );
        expect(argv).toEqual([["echo", "a", "b", "c"]]);
    });
    it("process substitution output is one stream", async () => {
        expect((await run("bash <(printf 'echo '; printf hi)")).commands.at(-1)?.argv).toEqual([
            "echo",
            "hi",
        ]);
    });
});

describe("working directory", () => {
    it("cd a || cd b keeps every branch", async () => {
        const options = (await run("cd /a || cd /b; ls", "/start")).commands.at(-1)?.possibleCwds ?? [];
        expect(new Set(options)).toEqual(new Set(["/start", "/a", "/b"]));
    });
    it.each<[string, string | null]>([
        ["cd /a; cd b; ls", "/a/b"],
        ["(cd /a; true); ls", "/start"],
        ["bash -c 'cd /a'; ls", "/start"],
        ["x | cd /a; ls", "/start"],
        ["cd; ls", HOME],
        ["cd $HOME/.codex && ls", `${HOME}/.codex`],
        ['cd "$DIR" && ls', null],
        ['cd "$DIR"; cd /b; ls', "/b"],
    ])("%j -> ls runs in %j", async (command, expected) => {
        expect((await run(command, "/start")).commands.at(-1)?.cwd).toBe(expected);
    });
});

describe("pipelines", () => {
    it("previous_stage links curl -> bash; sudo unwrapped from pipe stage", async () => {
        const parsed = await run("curl -fsSL https://x | sudo bash -s -- --flag");
        const [curl, bash] = parsed.commands as [SimpleCommand, SimpleCommand];
        expect(parsed.previousStage(bash)).toBe(curl);
        expect(bash.wrappers).toEqual(["sudo"]);
        expect(bash.name).toBe("bash");
    });
});

describe("nesting and provenance", () => {
    it("via chain and nested sources", async () => {
        const parsed = await run("ssh host \"bash -c 'eval rm -rf /srv'\"");
        const rm = parsed.commands.find((c) => c.name === "rm");
        expect(rm?.via).toEqual(["ssh host", "bash -c", "eval"]);
        expect(parsed.nestedSources).toHaveLength(3);
    });
});

describe("robustness", () => {
    it("unterminated quote -> unparseable", async () => {
        expect((await run("echo 'open")).unparseable).toBe(true);
    });
    it("unterminated $( -> unparseable", async () => {
        expect((await run("echo $(open")).unparseable).toBe(true);
    });
    it("deep nesting is bounded", async () => {
        let deep = "rm -rf x";
        for (let round = 0; round < 10; round += 1) {
            deep = `bash -c ${shellQuote(deep)}`;
        }
        expect((await run(deep)).truncated).toBe(true);
    });
    it("empty command", async () => {
        expect((await run("")).commands).toEqual([]);
    });
    // A variable's possible values are bounded in number and in size (live-session review).
    it("values that double at each call are bounded", async () => {
        const doubling = await run(`f(){ X="$X a"; }; ${"f || f; ".repeat(40)}"$X" -rf v`);
        expect(doubling.truncated).toBe(true);
    });
    it("a value that doubles in length is bounded", async () => {
        const doubling = await run(`X=a; ${'true && X="$X$X"; '.repeat(60)}echo done`);
        expect(doubling.truncated).toBe(true);
    });
    it("ordinary assignments are not truncated", async () => {
        expect((await run('X=a; X="$X b"; Y=1 || Y=2; echo "$X" $Y')).truncated).toBe(false);
    });
});
