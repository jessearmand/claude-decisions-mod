import { describe, expect, it } from "vitest";
import type { Host } from "../host/host.ts";
import { MemoryHost, memoryHost } from "../host/memory-host.ts";
import { SimpleCommand, SOURCE_TOO_LARGE, type SourceText, type WrittenFiles } from "./model.ts";
import { createSourceResolver, MAX_MAKE_TARGETS, MAX_SOURCE_BYTES, resolve } from "./sources.ts";

const CLEAN = "#!/usr/bin/env bash\nset -e\nrm -rf ~/stuff\n";
const WIPE = "#!/bin/sh\nrm -rf ~/stuff\n";
const RUN = '#!/bin/sh\n"$1" -rf victim\n';
const MAKEFILE = "all: build\nbuild: clean\n\t@echo built\nclean:\n\t-rm -rf out\n";
const AUTO = "rm:; $@ -rf victim\nout/x: a b\n\techo $(@D) $^ $$HOME\n";

const host = memoryHost({
    home: "/home/user",
    files: {
        "/proj/clean.sh": CLEAN,
        "/proj/notes.txt": "rm -rf ~\n",
        "/proj/py.py": "#!/usr/bin/env python3\nprint(1)\n",
        "/proj/zshrun": "#!/usr/bin/env -S zsh -f\nrm -rf ~\n",
        "/proj/binary": "#!/bin/sh\n\0\x01\n",
        "/proj/big.sh": "x".repeat(MAX_SOURCE_BYTES + 1),
        "/proj/tools/wipe.sh": WIPE,
        "/proj/run.sh": RUN,
        "/proj/bin/cleanup_guard_test": "rm -rf victim\n",
        "/proj/package.json": JSON.stringify({
            scripts: { prebuild: "rm -rf dist", build: "tsc", test: "jest" },
        }),
        "/proj/Makefile": MAKEFILE,
        "/proj/sub/Makefile": "clean:\n\trm -rf ~/victim\n",
        "/proj/sub/package.json": JSON.stringify({ scripts: { x: "rm -rf ~/a" } }),
        "/proj/auto/Makefile": AUTO,
        "/proj/mk-shell/Makefile": "X := $(shell rm -rf victim)\nall:\n\t@echo hi\n",
        "/proj/mk-file/Makefile": "$(file >.claude/settings.json,evil)\nall:\n\t@echo hi\n",
        "/proj/mk-big/Makefile": "x".repeat(MAX_SOURCE_BYTES + 1),
        "/proj/mk-many/Makefile": `${Array.from({ length: MAX_MAKE_TARGETS + 10 }, (_, i) => `t${i}: t${i + 1}\n\techo ${i}\n`).join("")}`,
        "/proj/broken/package.json": "{not json",
        "/mono/package.json": JSON.stringify({ workspaces: ["packages/*"], scripts: { clean: "echo root" } }),
        "/mono/packages/app/package.json": JSON.stringify({
            name: "@me/app",
            scripts: { clean: "rm -rf ~/victim" },
        }),
        "/mono/packages/lib/package.json": JSON.stringify({ name: "lib", scripts: { build: "tsc" } }),
        "/mono/sub/package.json": JSON.stringify({ scripts: { x: "rm -rf ~/a" } }),
        "/pnpm/pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - \"!apps/skip\"\n",
        "/pnpm/apps/web/package.json": JSON.stringify({ name: "web", scripts: { dev: "rm -rf ~/x" } }),
    },
    dirs: ["/empty"],
});

async function sources(
    line: string,
    cwd = "/proj",
    written: WrittenFiles = new Map(),
    options: {
        env?: ReadonlyArray<readonly [string, readonly string[]]>;
        dynamicHead?: boolean;
        on?: Host;
    } = {},
): Promise<SourceText[]> {
    const argv = line.split(" ");
    const command = new SimpleCommand({
        argv,
        cwd,
        environment: options.env ?? [],
        dynamicHead: options.dynamicHead,
    });
    return resolve(command, cwd, written, options.on ?? host);
}

describe("resolve: shell scripts", () => {
    it("reads a script run by path when its shebang (or extension) names a shell", async () => {
        expect(await sources("./clean.sh")).toEqual([[CLEAN, "script ./clean.sh"]]);
        expect(await sources("./tools/wipe.sh")).toEqual([[WIPE, "script ./tools/wipe.sh"]]);
        expect(await sources("/proj/zshrun")).toEqual([
            ["#!/usr/bin/env -S zsh -f\nrm -rf ~\n", "script /proj/zshrun"],
        ]);
        expect(await sources("./notes.txt")).toEqual([]); // no shebang, no shell extension
        expect(await sources("./py.py")).toEqual([]);
        expect(await sources("./missing.sh")).toEqual([]);
    });
    it("reads what a shell or source is given, whatever the file looks like", async () => {
        expect(await sources("bash clean.sh")).toEqual([[CLEAN, "script clean.sh"]]);
        expect(await sources("sh -x run.sh rm")).toEqual([[RUN, "script run.sh"]]);
        expect(await sources("bash notes.txt")).toEqual([["rm -rf ~\n", "script notes.txt"]]);
        expect(await sources("source clean.sh")).toEqual([[CLEAN, "script clean.sh"]]);
        expect(await sources(". -- clean.sh")).toEqual([[CLEAN, "script clean.sh"]]);
        expect(await sources("source")).toEqual([]);
        expect(await sources("bash -n clean.sh")).toEqual([]); // syntax check only
        expect(await sources("bash -c rm")).toEqual([]); // command strings are parsed by the parser itself
        expect(await sources("bash")).toEqual([]);
    });
    it("looks `source NAME` up in PATH first, for every PATH the line may have", async () => {
        const env = [["PATH", ["/proj/bin:/usr/bin", "/usr/bin"]]] as const;
        expect(await sources("source cleanup_guard_test", "/proj", new Map(), { env: [...env] })).toEqual([
            ["rm -rf victim\n", "script /proj/bin/cleanup_guard_test"],
        ]);
        const path = memoryHost({
            files: { "/proj/bin/cleanup_guard_test": "rm -rf victim\n" },
            env: { PATH: "/proj/bin" },
        });
        expect(await sources("source cleanup_guard_test", "/proj", new Map(), { on: path })).toEqual([
            ["rm -rf victim\n", "script /proj/bin/cleanup_guard_test"],
        ]);
        expect(await sources("source cleanup_guard_test")).toEqual([]); // not in PATH, not in the cwd
    });
    it("asks about a script it cannot read as text", async () => {
        expect(await sources("bash big.sh")).toEqual([[SOURCE_TOO_LARGE, "script big.sh"]]);
        expect(await sources("./big.sh")).toEqual([[SOURCE_TOO_LARGE, "script ./big.sh"]]);
        expect(await sources("./binary")).toEqual([[SOURCE_TOO_LARGE, "script ./binary"]]);
    });
    it("uses a file the same line wrote, labelled written, after what was on disk when appending", async () => {
        const replaced: WrittenFiles = new Map([["/proj/x.sh", { text: "rm -rf ~\n", replaces: true }]]);
        expect(await sources("bash x.sh", "/proj", replaced)).toEqual([["rm -rf ~\n", "written x.sh"]]);
        expect(await sources("./x.sh", "/proj", replaced)).toEqual([["rm -rf ~\n", "written ./x.sh"]]);
        const appended: WrittenFiles = new Map([["/proj/clean.sh", { text: "echo ok\n", replaces: false }]]);
        expect(await sources("bash clean.sh", "/proj", appended)).toEqual([
            [CLEAN, "script clean.sh"],
            ["echo ok\n", "written clean.sh"],
        ]);
        const appendedLarge: WrittenFiles = new Map([
            ["/proj/big.sh", { text: "echo ok\n", replaces: false }],
        ]);
        expect(await sources("bash big.sh", "/proj", appendedLarge)).toEqual([
            [SOURCE_TOO_LARGE, "script big.sh"],
            ["echo ok\n", "written big.sh"],
        ]);
    });
    it("answers nothing for a computed program, an unknown program or a git command", async () => {
        expect(await sources("$CMD x", "/proj", new Map(), { dynamicHead: true })).toEqual([]);
        expect(await sources("ls -la")).toEqual([]);
        expect(await sources("git cleanup")).toEqual([]);
    });
});

describe("resolve: package.json scripts", () => {
    it("runs a script with its pre/post hooks, for run, lifecycle verbs and bare yarn/pnpm/bun verbs", async () => {
        expect(await sources("npm run build")).toEqual([
            ["rm -rf dist", "npm script prebuild"],
            ["tsc", "npm script build"],
        ]);
        expect(await sources("npm test")).toEqual([["jest", "npm script test"]]);
        expect(await sources("npm build")).toEqual([]);
        expect(await sources("yarn build")).toEqual([
            ["rm -rf dist", "yarn script prebuild"],
            ["tsc", "yarn script build"],
        ]);
        expect(await sources("bun run-script build -- --watch")).toHaveLength(2);
        expect(await sources("npm run")).toEqual([]);
        expect(await sources("npm run missing")).toEqual([]);
    });
    it("runs the script of the package a directory option selects", async () => {
        expect(await sources("npm --prefix sub run x")).toEqual([["rm -rf ~/a", "npm script x"]]);
        expect(await sources("pnpm -C sub x")).toEqual([["rm -rf ~/a", "pnpm script x"]]);
    });
    it.each([
        ["npm -w packages/app run clean", "npm"],
        ["npm --workspace=@me/app run clean", "npm"],
        ["npm -ws run clean", "npm"],
        ["pnpm --filter @me/app clean", "pnpm"],
        ["yarn workspace @me/app clean", "yarn"],
        ["yarn workspaces foreach clean", "yarn"],
        ["npm -w unknown-name run clean", "npm"], // every workspace, never none
        ["npm -w app run clean", "npm"],
    ])("%s runs the workspace's script", async (line, runner) => {
        expect(await sources(line, "/mono")).toEqual([
            ["rm -rf ~/victim", `${runner} script clean in packages/app`],
        ]);
    });
    it("runs the root's script without a selector, and finds pnpm-workspace.yaml packages", async () => {
        expect(await sources("npm run clean", "/mono")).toEqual([["echo root", "npm script clean"]]);
        expect(await sources("npm -w lib run build", "/mono")).toEqual([
            ["tsc", "npm script build in packages/lib"],
        ]);
        expect(await sources("pnpm -r dev", "/pnpm")).toEqual([
            ["rm -rf ~/x", "pnpm script dev in apps/web"],
        ]);
    });
    it("uses a package.json the same line wrote, whose scripts count as typed", async () => {
        const written: WrittenFiles = new Map([
            ["/empty/package.json", { text: '{"scripts":{"boom":"rm -rf victim"}}', replaces: true }],
        ]);
        expect(await sources("npm run boom", "/empty", written)).toEqual([
            ["rm -rf victim", "written npm script boom"],
        ]);
    });
    it("skips malformed or missing package.json files", async () => {
        expect(await sources("npm run x", "/proj/broken")).toEqual([]);
        expect(await sources("npm run x", "/empty")).toEqual([]);
    });
});

describe("resolve: Makefile recipes", () => {
    it("follows the default target's prerequisites one recipe at a time", async () => {
        expect(await sources("make")).toEqual([
            ["echo built", "make build"],
            ["rm -rf out", "make clean"],
        ]);
        expect(await sources("make clean")).toEqual([["rm -rf out", "make clean"]]);
        expect(await sources("gmake -j4 VAR=1 clean")).toEqual([["rm -rf out", "make clean"]]);
        expect(await sources("make nothing")).toEqual([]);
        expect(await sources("make", "/empty")).toEqual([]);
    });
    it.each([
        "make -Csub clean",
        "make --directory=sub clean",
        "make -fsub/Makefile clean",
        "make --file=sub/Makefile clean",
        "make -C sub clean",
    ])("%s reads the Makefile the options name", async (line) => {
        expect(await sources(line)).toEqual([["rm -rf ~/victim", "make clean"]]);
    });
    it("substitutes Make's automatic variables and expands its variables", async () => {
        expect(await sources("make -C auto rm")).toEqual([["rm -rf victim", "make rm"]]);
        expect(await sources("make -C auto out/x")).toEqual([["echo out a b $HOME", "make out/x"]]);
    });
    it("adds what Make runs and writes while reading the Makefile", async () => {
        expect(await sources("make -C mk-shell")).toEqual([
            ["echo hi", "make all"],
            ["rm -rf victim", "make $(shell)"],
        ]);
        expect(await sources("make -C mk-file")).toEqual([
            ["echo hi", "make all"],
            [": > .claude/settings.json", "make $(file)"],
        ]);
    });
    it("counts statements typed with --eval and Makefiles the line wrote as written", async () => {
        const command = new SimpleCommand({ argv: ["make", "--eval=x:; rm -rf victim", "x"], cwd: "/empty" });
        expect(await resolve(command, "/empty", new Map(), host)).toEqual([
            ["rm -rf victim", "written make x"],
        ]);
        const written: WrittenFiles = new Map([
            ["/empty/Makefile", { text: "x:\n\trm -rf victim\n", replaces: true }],
        ]);
        expect(await sources("make x", "/empty", written)).toEqual([["rm -rf victim", "written make x"]]);
        const appended: WrittenFiles = new Map([
            ["/proj/Makefile", { text: "x:\n\trm -rf victim\n", replaces: false }],
        ]);
        expect(await sources("make x", "/proj", appended)).toEqual([["rm -rf victim", "written make x"]]);
    });
    it("asks about a Makefile too large to read or with too many targets", async () => {
        expect(await sources("make -C mk-big")).toEqual([[SOURCE_TOO_LARGE, "make /proj/mk-big/Makefile"]]);
        const many = await sources("make -C mk-many");
        expect(many).toHaveLength(MAX_MAKE_TARGETS + 1);
        expect(many[MAX_MAKE_TARGETS]).toEqual([
            SOURCE_TOO_LARGE,
            `make: more than ${MAX_MAKE_TARGETS} targets`,
        ]);
    });
});

describe("createSourceResolver", () => {
    it("resolves git aliases through the supplied resolver", async () => {
        const custom = createSourceResolver({
            gitAliases: async (command) => [[`alias ${command.args[0]}`, "git alias"]],
        });
        const command = new SimpleCommand({ argv: ["git", "cleanup"], cwd: "/proj" });
        expect(await custom(command, "/proj", new Map(), host)).toEqual([["alias cleanup", "git alias"]]);
        expect(await resolve(command, "/proj", new Map(), host)).toEqual([]);
    });
    it("never throws", async () => {
        class BrokenHost extends MemoryHost {
            override async stat(): Promise<never> {
                throw new Error("boom");
            }
        }
        const broken: Host = new BrokenHost({ files: { "/proj/clean.sh": CLEAN } });
        expect(
            await resolve(
                new SimpleCommand({ argv: ["./clean.sh"], cwd: "/proj" }),
                "/proj",
                new Map(),
                broken,
            ),
        ).toEqual([]);
    });
});
