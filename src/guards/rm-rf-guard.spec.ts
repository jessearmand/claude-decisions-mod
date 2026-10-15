/**
 * Port of rm_rf_guard_test.py: the detection corpora, the file-backed cases,
 * the target analysis and the end-to-end hook protocol, run in-process through
 * `rmRfGuard.run` (the Python test spawned the hook as a subprocess).
 *
 * The corpora run against a memory host like parse.parity.spec.ts: the Python
 * test parsed them against the real disk with an empty cwd, and the one real
 * path a case globs is `/bin/r[m]`, which the memory host carries. The cases
 * that write files use a temporary directory and `nodeHost()`.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../config.ts";
import { type Decision, forPermissionMode, type HookInput } from "../decision.ts";
import type { Host } from "../host/host.ts";
import { memoryHost } from "../host/memory-host.ts";
import { nodeHost } from "../host/node-host.ts";
import { parse } from "../shell/parse.ts";
import { resolve } from "../shell/sources.ts";
import { SHOULD_ALLOW, SHOULD_BLOCK } from "./__fixtures__/rm-rf-cases.ts";
import type { GuardDeps } from "./guard.ts";
import {
    analyzeTarget,
    buildAskReason,
    findRecursiveForceInvocations,
    RmInvocation,
    rmRfGuard,
} from "./rm-rf-guard.ts";

const corpusHost = memoryHost({ home: "/home/u", files: { "/bin/rm": "" } });
const CORPUS_CWD = "/home/u/proj";

const node = nodeHost();
const nodeDeps: GuardDeps = { host: node, config: resolveConfig(node), sources: resolve };
const temporaries: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
    temporaries.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

function write(directory: string, name: string, text: string): void {
    mkdirSync(join(directory, name, ".."), { recursive: true });
    writeFileSync(join(directory, name), text);
}

async function detect(command: string, cwd: string, host: Host, sources = false): Promise<RmInvocation[]> {
    const [invocations] = await findRecursiveForceInvocations(command, cwd, host, sources ? resolve : null);
    return invocations;
}

/** The Python `_run_hook`: the guard's decision for a Bash call, after the permission-mode rule. */
async function hook(command: string, cwd: string, mode?: string): Promise<Decision | undefined> {
    const input: HookInput = { toolName: "Bash", toolInput: { command }, cwd, permissionMode: mode };
    return forPermissionMode(await rmRfGuard.run(input, nodeDeps), input);
}

const decisionOf = async (command: string, cwd: string): Promise<string | undefined> =>
    (await hook(command, cwd))?.decision;
const reasonOf = async (command: string, cwd: string): Promise<string> =>
    (await hook(command, cwd))?.reason ?? "";

// The start of the reason for an `rm -rf` typed in the command (not run from a file).
const TYPED = "this command runs `rm` with both recursive and force";

describe("detection — must block", () => {
    it.each(SHOULD_BLOCK)("%j", async (command) => {
        expect((await detect(command, CORPUS_CWD, corpusHost)).length).toBeGreaterThan(0);
    });
});

describe("detection — must not block", () => {
    it.each(SHOULD_ALLOW)("%j", async (command) => {
        expect(await detect(command, CORPUS_CWD, corpusHost)).toEqual([]);
    });
});

describe("RmInvocation", () => {
    it("renders like the Python dataclass", () => {
        const plain = new RmInvocation({ recursive: true, force: true, flags: ["-rf"], targets: ["build"] });
        expect(plain.isRecursiveForce).toBe(true);
        expect(plain.rendered()).toBe("rm -rf build");
        const via = new RmInvocation({ flags: ["-rf"], targets: ["~"], origin: "bash -c" });
        expect(via.isRecursiveForce).toBe(false);
        expect(via.rendered()).toBe("rm -rf ~    (via bash -c)");
    });
});

describe("detection with files on disk", () => {
    const tmp = tempDir("rm-rf-guard-files");

    it("same-line Makefile recipe", async () => {
        const command = "cat > Makefile <<'EOF'\nx:\n\trm -rf victim\nEOF\nmake x";
        const invocations = await detect(command, tmp, node, true);
        expect(invocations.length).toBeGreaterThan(0);
        expect(invocations[0]?.indirect).toBe(false);
    });

    it("make --eval recipe", async () => {
        const invocations = await detect("make --eval='x:;rm -rf victim' x", tmp, node, true);
        expect(invocations.length).toBeGreaterThan(0);
        expect(invocations[0]?.indirect).toBe(false);
    });

    it("script with a non-UTF-8 byte is still read", async () => {
        writeFileSync(join(tmp, "latin.sh"), Buffer.from("#!/bin/sh\n# caf\xe9\nrm -rf victim\n", "latin1"));
        chmodSync(join(tmp, "latin.sh"), 0o755);
        expect((await detect("./latin.sh", tmp, node, true)).length).toBeGreaterThan(0);
    });

    it("same-line package.json script", async () => {
        const command =
            'cat > package.json <<\'EOF\'\n{"scripts":{"boom":"rm -rf victim"}}\nEOF\nnpm run boom';
        const invocations = await detect(command, tmp, node, true);
        expect(invocations.length).toBeGreaterThan(0);
        expect(invocations[0]?.indirect).toBe(false);
    });

    it("overflowing command-word glob keeps its first match", async () => {
        mkdirSync(join(tmp, "bin"));
        symlinkSync("/bin/rm", join(tmp, "bin", "rm"));
        for (let i = 0; i < 70; i += 1) writeFileSync(join(tmp, "bin", `s${i}`), "");
        expect((await detect("bin/[r-z]* -rf victim", tmp, node, true)).length).toBeGreaterThan(0);
    });

    it("source binds its arguments", async () => {
        writeFileSync(join(tmp, "positional.sh"), '"$1" -rf victim\n');
        expect((await detect("source positional.sh rm", tmp, node, true)).length).toBeGreaterThan(0);
        expect(await detect("source positional.sh echo", tmp, node, true)).toEqual([]);
        for (const builtin of ["source", "."]) {
            for (const [argument, expected] of [
                ["rm", true],
                ["echo", false],
            ] as const) {
                const command = `${builtin} -- positional.sh ${argument}`;
                expect((await detect(command, tmp, node, true)).length > 0, command).toBe(expected);
            }
        }
    });

    it("script built from exact printf bytes", async () => {
        const command = "printf r > run.sh; printf m >> run.sh; printf ' -rf victim' >> run.sh; bash run.sh";
        expect((await detect(command, tmp, node, true)).length).toBeGreaterThan(0);
    });
});

describe("target analysis", () => {
    const tmp = tempDir("rm-rf-guard-targets");
    const directory = join(tmp, "adir");
    mkdirSync(directory);
    writeFileSync(join(directory, "child"), "");
    const filePath = join(tmp, "afile");
    writeFileSync(filePath, "");
    const link = join(tmp, "alink");
    symlinkSync(filePath, link);

    it.each([
        [filePath, "file", `rm ${filePath}`],
        [directory, "directory", `rm -r ${directory}`],
        [link, "symlink", `rm ${link}`],
        [join(tmp, "nope"), "missing", undefined],
        ["$UNSET/dist", "unresolved", undefined],
        ["build/*", "glob", undefined],
    ])("%s -> kind=%s safer=%s", async (target, kind, safer) => {
        const analysis = await analyzeTarget(target, tmp, node);
        expect(analysis.kind).toBe(kind);
        expect(analysis.saferCommand).toBe(safer);
    });

    it("describes a directory by its entry count and a glob by an ls -d probe", async () => {
        expect((await analyzeTarget(directory, tmp, node)).detail).toBe(
            `is a directory (1 immediate entry) at ${directory} — this is outside your home directory`,
        );
        expect((await analyzeTarget("build/*", tmp, node)).detail).toBe(
            "is a glob; run `ls -d 'build/*'` first to see exactly what it matches",
        );
    });

    it("/ is critical", async () => {
        expect((await analyzeTarget("/", tmp, node)).severity).toBe("critical");
    });
    it("~ is critical", async () => {
        const analysis = await analyzeTarget(node.home, tmp, node);
        expect(analysis.severity).toBe("critical");
        expect(analysis.detail).toContain("this is your entire home directory");
    });
    it("/usr is critical", async () => {
        expect((await analyzeTarget("/usr", tmp, node)).severity).toBe("critical");
    });
    it(".. from cwd is critical (ancestor of cwd)", async () => {
        expect((await analyzeTarget("..", directory, node)).severity).toBe("critical");
    });
    it("a dangling symlink is still a symlink", async () => {
        const memory = memoryHost({ links: { "/home/user/proj/dangling": "/nowhere" } });
        const analysis = await analyzeTarget("dangling", "/home/user/proj", memory);
        expect(analysis.kind).toBe("symlink");
        expect(analysis.saferCommand).toBe("rm dangling");
    });
});

describe("end-to-end hook protocol", () => {
    const cwd = tempDir("rm-rf-guard-e2e");

    it("rm with uncheckable argument combinations -> ask", async () => {
        // Too many possible values to pair every one: the `rm` asks (PR review).
        const overflow = `A=rm; B=-rf; ${Array.from({ length: 8 }, (_, i) => `true || A=a${i}`).join("; ")}; ${Array.from(
            { length: 7 },
            (_, i) => `true || B=b${i}`,
        ).join("; ")}; $A $B victim`;
        const asked = await hook(overflow, cwd);
        expect(asked?.decision).toBe("ask");
        expect(asked?.reason).toContain("could not all be worked out");
        expect(asked?.systemMessage).toBe("rm-rf-guard: an `rm` whose flags could not be fully determined.");
    });

    it("rm -rf build -> ask, with the full reason", async () => {
        const asked = await hook("rm -rf build", cwd);
        expect(asked?.decision).toBe("ask");
        expect(asked?.hook).toBe("rm-rf-guard");
        expect(asked?.systemMessage).toBe("rm-rf-guard: confirm the `rm -rf` before it runs.");
        expect(asked?.reason).toContain("do NOT route around this hook");
        expect(asked?.reason).toContain("rm -r ");
        expect(asked?.reason).toContain(TYPED);
        expect(asked?.reason).toContain("Invocation(s):\n  rm -rf build\n");
        expect(asked?.reason).toContain(`  build does not exist (${cwd}/build); removing it is a no-op`);
    });

    it("rm -rf build when no one can be asked -> deny", async () => {
        const denied = await hook("rm -rf build", cwd, "bypassPermissions");
        expect(denied?.decision).toBe("deny");
        expect(denied?.reason).toContain("[rm-rf-guard] Permission mode is bypassPermissions");
    });

    it("rm -r build -> defer", async () => {
        expect(await hook("rm -r build", cwd)).toBeUndefined();
    });
    it("ls -la -> defer", async () => {
        expect(await hook("ls -la", cwd)).toBeUndefined();
    });
    it("non-Bash tool -> defer", async () => {
        const input: HookInput = { toolName: "Edit", toolInput: { new_text: "rm -rf /" }, cwd };
        expect(await rmRfGuard.run(input, nodeDeps)).toBeUndefined();
    });
    it("RM_RF_GUARD_DISABLE=1 -> defer (config.rmRfGuard.disable)", async () => {
        const host = nodeHost({ env: { ...process.env, RM_RF_GUARD_DISABLE: "1" } });
        const input: HookInput = { toolName: "Bash", toolInput: { command: "rm -rf build" }, cwd };
        expect(
            await rmRfGuard.run(input, { host, config: resolveConfig(host), sources: resolve }),
        ).toBeUndefined();
    });

    it("target analysis follows `cd` (cd ~ && rm -rf .)", async () => {
        expect(await reasonOf("cd ~ && rm -rf .", cwd)).toContain("entire home directory");
    });

    it("an unterminated quote still yields the parsed invocation, not the regex fallback", async () => {
        // The parser recovers from every shape tried (checked against the Python oracle), so the
        // fallback branch is reached only through `unparseable`; its text is covered below.
        for (const command of ['rm -rf "build', "rm -rf build; echo 'unterminated", "echo $(rm -rf build"]) {
            const [invocations, unparseable] = await findRecursiveForceInvocations(command, cwd, node);
            expect(unparseable, command).toBe(false);
            expect(
                invocations.map((invocation) => invocation.targets),
                command,
            ).toEqual([["build"]]);
        }
    });

    it("the unparseable reason names the fallback and skips the invocation list", async () => {
        const reason = await buildAskReason([], cwd, true, node);
        expect(reason).toContain(TYPED);
        expect(reason).toContain(
            "The command could not be parsed completely, but it appears to contain a recursive forced `rm`.",
        );
        expect(reason).not.toContain("Invocation(s):");
        expect(reason).toContain("Less destructive alternatives:");
    });
});

describe("package scripts in the selected workspace (PR review)", () => {
    const root = tempDir("rm-rf-guard-workspaces");
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    mkdirSync(join(root, "packages", "lib"), { recursive: true });
    mkdirSync(join(root, "sub"));
    write(
        root,
        "package.json",
        JSON.stringify({ workspaces: ["packages/*"], scripts: { clean: "echo root" } }),
    );
    write(
        root,
        join("packages", "app", "package.json"),
        JSON.stringify({ name: "@me/app", scripts: { clean: "rm -rf ~/victim" } }),
    );
    write(
        root,
        join("packages", "lib", "package.json"),
        JSON.stringify({ name: "lib", scripts: { build: "tsc" } }),
    );
    write(root, join("sub", "package.json"), JSON.stringify({ scripts: { x: "rm -rf ~/a" } }));

    it.each([
        "npm -w packages/app run clean",
        "npm --workspace=@me/app run clean",
        "npm -ws run clean",
        "pnpm --filter @me/app clean",
        "yarn workspace @me/app clean",
        "npm -w unknown-name run clean",
        "npm --prefix sub run x",
        "pnpm -C sub x",
    ])("%s -> ask", async (command) => {
        expect(await decisionOf(command, root)).toBe("ask");
    });
    it.each(["npm run clean", "npm -w lib run build"])("%s -> defer", async (command) => {
        expect(await decisionOf(command, root)).toBeUndefined();
    });
});

describe("commands run from files the agent did not type here -> ask", () => {
    const project = tempDir("rm-rf-guard-project");
    write(project, "clean.sh", "#!/usr/bin/env bash\nset -e\nrm -rf ~/stuff\n");
    write(project, "notes.txt", "rm -rf ~\n");
    write(project, "package.json", JSON.stringify({ scripts: { prebuild: "rm -rf dist", build: "tsc" } }));
    write(project, "Makefile", "all: build\nbuild: clean\n\t@echo built\nclean:\n\t-rm -rf out\n");
    write(project, join("tools", "wipe.sh"), "#!/bin/sh\nrm -rf ~/stuff\n");
    write(project, join("sub", "Makefile"), "clean:\n\trm -rf ~/victim\n");
    write(project, "run.sh", '#!/bin/sh\n"$1" -rf victim\n');
    write(project, join("auto", "Makefile"), "rm:; $@ -rf victim\nout/x: a b\n\techo $(@D) $^ $$HOME\n");
    write(project, join("bin", "cleanup_guard_test"), "rm -rf victim\n");
    write(project, join("safe", "cleanup_guard_test"), "echo ok\n");
    write(project, "evilrc", "rm -rf victim\n");
    write(project, "saferc", "echo ok\n");
    write(project, "largerc", `#${"x".repeat(256 * 1024)}\nrm -rf victim\n`);
    write(project, "init.sql", ".shell rm -rf victim\n");
    write(project, "safe.sql", "SELECT 1;\n");
    write(project, "q.sql", "\\! rm -rf victim\n");
    write(project, "outer.sql", ".read init.sql\n");
    write(project, "safe-outer.sql", ".read safe.sql\n");

    // Make runs `$(shell …)` and `!=` while reading the Makefile, whatever the
    // target, and recipes run what their variables hold (PR review).
    const expansions: Record<string, string> = {
        shell: "X := $(shell rm -rf victim)\nall:\n\t@echo hi\n",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Make syntax, not a template
        braces: "X = ${shell rm -rf victim}\nall:\n\t@echo hi\n",
        bang: "X != rm -rf victim\nall:\n\t@echo hi\n",
        conditional: "ifeq ($(shell rm -rf victim),)\nendif\nall:\n\t@echo hi\n",
        variable: "CLEAN = rm -rf\nTARGET := victim\nall:\n\t$(CLEAN) $(TARGET)\n",
        nested: "A = $(B)\nB = rm -rf victim\nall:\n\t$(A)\n",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Make syntax, not a template
        appended: "FLAGS = -r\nFLAGS += -f\nall:\n\trm ${FLAGS} victim\n",
        "recipe-shell": "all:\n\techo $(shell rm -rf victim)\n",
    };
    // A `$$` is the shell's `$`, not a Make reference; unknown variables stay as written.
    const safeExpansions: Record<string, string> = {
        escaped: "all:\n\techo $$(shell rm -rf victim) $(UNSET)\n",
        "safe-shell": "REV := $(shell git rev-parse HEAD)\nall:\n\techo $(REV)\n",
    };
    for (const [name, text] of Object.entries({ ...expansions, ...safeExpansions })) {
        write(project, join(`mk-${name}`, "Makefile"), text);
    }

    it.each(["./clean.sh", "bash clean.sh", "source clean.sh", "npm run build", "make", "make clean"])(
        "%s -> ask",
        async (command) => {
            expect(await decisionOf(command, project)).toBe("ask");
        },
    );

    it.each(["bash < clean.sh", "sh -s -- --verbose < clean.sh", "cat clean.sh | bash"])(
        "script on stdin (PR review): %s -> ask",
        async (command) => {
            expect(await decisionOf(command, project)).toBe("ask");
        },
    );

    it("script found in a directory a conditional cd may leave (PR review)", async () => {
        expect(await decisionOf("cd tools || cd other; ./wipe.sh", project)).toBe("ask");
    });

    it.each([
        "make -Csub clean",
        "make --directory=sub clean",
        "make -fsub/Makefile clean",
        "make --file=sub/Makefile clean",
    ])("make attached/= options (PR review): %s -> ask", async (command) => {
        expect(await decisionOf(command, project)).toBe("ask");
    });

    // A script's arguments are its $1.. and Make's `$@` is the target (PR review).
    it.each(["bash run.sh rm", "./run.sh rm", "sh -x run.sh rm", "make -C auto rm"])(
        "arguments reach the script: %s -> ask",
        async (command) => {
            expect(await decisionOf(command, project)).toBe("ask");
        },
    );
    it.each(["bash run.sh echo", "make -C auto out/x"])("%s -> defer", async (command) => {
        expect(await decisionOf(command, project)).toBeUndefined();
    });

    it.each(Object.keys(expansions))("make expansion '%s' -> ask", async (name) => {
        expect(await decisionOf(`make -C mk-${name}`, project)).toBe("ask");
    });
    it.each(Object.keys(safeExpansions))("make expansion '%s' -> defer", async (name) => {
        expect(await decisionOf(`make -C mk-${name}`, project)).toBeUndefined();
    });

    it("bash -n < clean.sh only checks syntax -> defer", async () => {
        expect(await decisionOf("bash -n < clean.sh", project)).toBeUndefined();
    });

    it("source NAME found in PATH -> ask (PR review)", async () => {
        expect(await decisionOf(`PATH=${project}/bin:$PATH; source cleanup_guard_test`, project)).toBe("ask");
    });

    it("BASH_ENV startup file -> ask (PR review)", async () => {
        const typed = "printf %b '\\162\\155 -rf victim\\n' > env.sh; ";
        expect(await decisionOf(`${typed}BASH_ENV="$PWD/env.sh" bash -c :`, project)).toBe("ask");
        // bash expands BASH_ENV itself (PR review)
        expect(await decisionOf(`${typed}BASH_ENV='$PWD/env.sh' bash -c :`, project)).toBe("ask");
    });

    it.each([
        ["bash --rcfile evilrc -i <<<'exit'", "ask"],
        ["bash --init-file evilrc -ic ':'", "ask"],
        ["printf 'rm -rf victim' > typedrc; bash --rcfile typedrc -i <<<'exit'", "ask"],
        ["bash --rcfile saferc -i <<<'exit'", undefined],
        ["bash --rcfile evilrc --init-file saferc -i <<<'exit'", undefined],
        ["bash --rcfile evilrc --norc -i <<<'exit'", undefined],
        ["bash --rcfile evilrc -c ':'", undefined],
        ["bash --rcfile evilrc --posix -i <<<'exit'", undefined],
        ["bash --rcfile evilrc -li <<<'exit'", undefined],
    ])("explicit Bash rc: %s -> %s", async (command, expected) => {
        expect(await decisionOf(command, project)).toBe(expected);
    });

    it.each(["--rcfile", "--init-file"])(
        "%s uses the same-line file snapshot as typed code",
        async (option) => {
            const command = `printf 'rm -rf victim' > typedrc; bash ${option} typedrc -i <<<'exit'`;
            const invocations = await detect(command, project, node, true);
            expect(invocations.length).toBeGreaterThan(0);
            expect(invocations[0]?.indirect).toBe(false);
        },
    );

    it("oversized explicit rc file marks analysis incomplete", async () => {
        const parsed = await parse("bash --rcfile largerc -i <<<'exit'", project, node, resolve);
        expect(parsed.truncated).toBe(true);
    });

    it("source searches every PATH the line may have (PR review)", async () => {
        expect(await decisionOf("PATH=bin; false && PATH=safe; source cleanup_guard_test", project)).toBe(
            "ask",
        );
    });

    it("a signal handler is checked in the directory it runs in (PR review)", async () => {
        const command = "cd safe; trap 'source ./cleanup_guard_test' TERM; cd ../bin; kill -TERM $$";
        expect(await decisionOf(command, project)).toBe("ask");
    });

    // Database clients run shell escapes from command files too (PR review).
    it.each([
        "sqlite3 -init init.sql :memory:",
        "sqlite3 --init init.sql :memory:",
        "sqlite3 :memory: < init.sql",
        "cat init.sql | cat | sqlite3 :memory:",
        "psql -f q.sql",
        "psql --file=q.sql",
        "psql -fq.sql",
        "psql < q.sql",
    ])("shell escape in a command file: %s -> ask", async (command) => {
        expect(await decisionOf(command, project)).toBe("ask");
    });

    // ... and from the files those include, followed in turn (PR review).
    it.each([
        "sqlite3 :memory: '.read init.sql'",
        "sqlite3 -init outer.sql :memory:",
        "duckdb -c '.read outer.sql'",
        "psql -c '\\i q.sql'",
        "psql -c '\\include q.sql'",
    ])("shell escape in an included file: %s -> ask", async (command) => {
        expect(await decisionOf(command, project)).toBe("ask");
    });

    it.each([
        "sqlite3 -init safe.sql :memory:",
        "psql -f safe.sql",
        "sqlite3 -init missing.sql :memory:",
        "printf 'SELECT 1;' | sqlite3 :memory:",
        "printf '.shell rm -rf victim\\n' | sqlite3 :memory: <<< 'SELECT 1;'",
        "sqlite3 :memory: '.read safe-outer.sql'",
        "psql -c '\\i safe.sql'",
        "cat notes.txt",
        "./notes.txt",
        "npm run lint",
    ])("%s -> defer", async (command) => {
        expect(await decisionOf(command, project)).toBeUndefined();
    });

    it("`>>` adds to the remembered script (PR review)", async () => {
        const appended = "printf 'rm -rf ~\\n' > x.sh; printf 'echo ok\\n' >> x.sh; bash x.sh";
        expect(await reasonOf(appended, project)).toContain(TYPED);
    });

    it("`>>` keeps the file's existing body", async () => {
        expect(await decisionOf("printf 'echo ok\\n' >> clean.sh; ./clean.sh", project)).toBe("ask");
    });

    it("typed rm -rf beside a script is reported as typed", async () => {
        expect(await reasonOf("./clean.sh && rm -rf build", project)).toContain(TYPED);
    });

    it("a script-only rm -rf is reported as indirect, with its origin and targets", async () => {
        const asked = await hook("./clean.sh", project);
        expect(asked?.decision).toBe("ask");
        expect(asked?.systemMessage).toBe("rm-rf-guard: the command runs a script containing `rm -rf`.");
        expect(asked?.reason).toContain("runs a script, recipe or interpreter program that contains");
        expect(asked?.reason).toContain("rm -rf ~/stuff    (via script ./clean.sh)");
        expect(asked?.reason).toContain("Target analysis:");
        expect(asked?.reason).toContain("do not edit the script to get around this");
    });
});
