/**
 * Commands that run another command, and how to find the command they run.
 *
 * Each table entry says which options take a separate argument, so that
 * `sudo -u root rm -rf /` resolves to `rm -rf /` instead of treating `root` as
 * the command. Options not listed are assumed to take no argument; an option
 * written as `--name=value` or `-uroot` carries its value with it either way.
 *
 * Three shapes of wrapper are handled by parse.ts:
 *
 *   PREFIX_WRAPPERS   the wrapped command follows the wrapper's options
 *                     (sudo, env, nice, timeout, xargs, ...)
 *   STRING_RUNNERS    the wrapped command is a single string argument that a
 *                     shell parses again (bash -c, su -c, watch, ssh host ...)
 *   SUBCOMMAND_RUNNERS  a tool subcommand that runs whatever follows it
 *                     (mise exec --, fnox exec --, uv run, direnv exec DIR)
 *
 * Ported from shell_wrappers.py.
 */

/** How to skip a wrapper's own arguments to reach the command it runs. */
export interface WrapperSpec {
    readonly withArg: ReadonlySet<string>;
    /**
     * Positional arguments that belong to the wrapper itself (timeout's
     * duration, flock's lock file, direnv's directory).
     */
    readonly positionals: number;
    /**
     * Options that turn the wrapper into a query that runs nothing
     * (`command -v rm`, `sudo -l`).
     */
    readonly noExec: ReadonlySet<string>;
    /** Options whose value is a shell command string (`su -c`, `flock --command`). */
    readonly commandOptions: ReadonlySet<string>;
    /** Options that change directory before running the command (`env -C`, `sudo -D`). */
    readonly chdirOptions: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

function opts(...names: string[]): ReadonlySet<string> {
    return new Set(names);
}

/** `WrapperSpec(with_arg, positionals=..., ...)` with the dataclass defaults. */
export function wrapperSpec(
    withArg: ReadonlySet<string> = NONE,
    rest: Partial<WrapperSpec> = {},
): WrapperSpec {
    return {
        withArg,
        positionals: rest.positionals ?? 0,
        noExec: rest.noExec ?? NONE,
        commandOptions: rest.commandOptions ?? NONE,
        chdirOptions: rest.chdirOptions ?? NONE,
    };
}

/** The filename and positionals after source's optional option terminator. */
export function sourceArguments(args: readonly string[]): readonly string[] {
    return args[0] === "--" ? args.slice(1) : args;
}

export const PREFIX_WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map([
    [
        "sudo",
        wrapperSpec(
            opts(
                "-u",
                "-g",
                "-C",
                "-D",
                "-h",
                "-p",
                "-r",
                "-t",
                "-U",
                "-T",
                "--user",
                "--group",
                "--close-from",
                "--chdir",
                "--host",
                "--prompt",
                "--role",
                "--type",
                "--other-user",
                "--command-timeout",
            ),
            {
                noExec: opts(
                    "-l",
                    "--list",
                    "-v",
                    "--validate",
                    "-k",
                    "-K",
                    "--reset-timestamp",
                    "--remove-timestamp",
                    "-V",
                    "--version",
                    "-e",
                    "--edit",
                ),
                chdirOptions: opts("-D", "--chdir"),
            },
        ),
    ],
    ["doas", wrapperSpec(opts("-u", "-C"), { noExec: opts("-C") })],
    ["pkexec", wrapperSpec(opts("--user"))],
    [
        "run0",
        wrapperSpec(
            opts(
                "-u",
                "--user",
                "-g",
                "--group",
                "--chdir",
                "-D",
                "--unit",
                "--property",
                "--slice",
                "--description",
                "--setenv",
            ),
            { chdirOptions: opts("-D", "--chdir") },
        ),
    ],
    [
        "env",
        wrapperSpec(
            opts(
                "-u",
                "--unset",
                "-C",
                "--chdir",
                "-P",
                "--default-signal",
                "--ignore-signal",
                "--block-signal",
                "-a",
                "--argv0",
            ),
            { chdirOptions: opts("-C", "--chdir") },
        ),
    ],
    ["nice", wrapperSpec(opts("-n", "--adjustment"))],
    [
        "ionice",
        wrapperSpec(opts("-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid")),
    ],
    ["timeout", wrapperSpec(opts("-s", "--signal", "-k", "--kill-after"), { positionals: 1 })],
    ["gtimeout", wrapperSpec(opts("-s", "--signal", "-k", "--kill-after"), { positionals: 1 })],
    ["nohup", wrapperSpec()],
    ["setsid", wrapperSpec()],
    ["stdbuf", wrapperSpec(opts("-i", "--input", "-o", "--output", "-e", "--error"))],
    ["time", wrapperSpec(opts("-f", "--format", "-o", "--output"))],
    // strace runs the command after its options (strace's getopt table). Only
    // required arguments are listed. Optional ones (`--quiet`, `--daemonize`)
    // stay flags, so `strace --quiet git status` still reaches git.
    [
        "strace",
        wrapperSpec(
            opts(
                "-a",
                "--columns",
                "-b",
                "--detach-on",
                "-e",
                "-E",
                "--env",
                "-I",
                "--interruptible",
                "-o",
                "--output",
                "-O",
                "--summary-syscall-overhead",
                "-p",
                "--attach",
                "-P",
                "--trace-path",
                "-s",
                "--string-limit",
                "-S",
                "--summary-sort-by",
                "-u",
                "--user",
                "-U",
                "--summary-columns",
                "-X",
                "--const-print-style",
                "--argv0",
                "--color",
                "--syscall-limit",
                "--stack-trace-frame-limit",
                "--trace",
                "--trace-fds",
                "--signals",
                "--signal",
                "--status",
                "--abbrev",
                "--verbose",
                "--raw",
                "--read",
                "--write",
                "--fault",
                "--inject",
                "--kvm",
                "--decode-pids",
            ),
        ),
    ],
    ["command", wrapperSpec(NONE, { noExec: opts("-v", "-V") })],
    ["builtin", wrapperSpec()],
    ["exec", wrapperSpec(opts("-a"))],
    ["caffeinate", wrapperSpec(opts("-t", "-w"))],
    ["chronic", wrapperSpec()],
    ["unbuffer", wrapperSpec()],
    ["fakeroot", wrapperSpec(opts("-l", "--lib", "--faked", "-s", "-i"))],
    ["proxychains", wrapperSpec(opts("-f"))],
    ["proxychains4", wrapperSpec(opts("-f"))],
    ["torsocks", wrapperSpec(opts("-u", "-p", "-a", "-P"))],
    ["busybox", wrapperSpec()],
    ["toybox", wrapperSpec()],
    [
        "xargs",
        wrapperSpec(
            opts(
                "-a",
                "--arg-file",
                "-d",
                "--delimiter",
                "-E",
                "-e",
                "--eof",
                "-I",
                "--replace",
                "-L",
                "--max-lines",
                "-n",
                "--max-args",
                "-P",
                "--max-procs",
                "-s",
                "--max-chars",
                "--process-slot-var",
            ),
        ),
    ],
    [
        "flock",
        wrapperSpec(opts("-w", "--timeout", "-E", "--conflict-exit-code"), {
            positionals: 1,
            commandOptions: opts("-c", "--command"),
        }),
    ],
    ["chroot", wrapperSpec(opts("--userspec", "--groups"), { positionals: 1 })],
    [
        "unshare",
        wrapperSpec(opts("--mount-proc", "-S", "--setuid", "-G", "--setgid", "-R", "--root", "-w", "--wd"), {
            chdirOptions: opts("-w", "--wd"),
        }),
    ],
    [
        "nsenter",
        wrapperSpec(
            opts("-t", "--target", "-S", "--setuid", "-G", "--setgid", "-R", "--root", "-w", "--wd"),
            {
                chdirOptions: opts("-w", "--wd"),
            },
        ),
    ],
    ["dbus-launch", wrapperSpec()],
]);

// Shells: `-c STRING` runs STRING; a bare positional is a script file; no
// positional at all means the program is read from stdin.
// Paths that name the process's own stdin: `bash /dev/stdin <<< CMD` runs CMD.
export const STDIN_PATHS: ReadonlySet<string> = new Set(["-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);
export const SHELLS: ReadonlySet<string> = new Set([
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "mksh",
    "ash",
    "fish",
    "yash",
    "posh",
]);
export const SHELL_OPTIONS_WITH_ARG: ReadonlySet<string> = opts(
    "-o",
    "+o",
    "-O",
    "+O",
    "--rcfile",
    "--init-file",
);
// Options whose value is itself a command string the shell runs. fish takes
// them as `-c CMD`, `--command=CMD`, `-C CMD`, `--init-command=CMD`.
export const SHELL_COMMAND_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["fish", opts("-c", "--command", "-C", "--init-command")],
]);
// Other value-taking options, per shell.
export const SHELL_EXTRA_OPTIONS_WITH_ARG: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    [
        "fish",
        opts(
            "-d",
            "--debug",
            "-o",
            "--debug-output",
            "-p",
            "--profile",
            "-f",
            "--features",
            "--profile-startup",
        ),
    ],
]);

/** What a shell command line will run. */
export interface ShellInvocation {
    /** Command strings run directly: `bash -c STR`, `fish -C STR --command=STR`. */
    readonly commands: readonly string[];
    /** Positional arguments after a `-c` string: $0, $1, ... */
    readonly commandArgs: readonly string[];
    /** `bash script.sh` */
    readonly script: string | undefined;
    /** `bash script.sh a b`: its $1, $2, ... */
    readonly scriptArgs: readonly string[];
    /** `bash`, `bash -s args`, `bash -` */
    readonly readsStdin: boolean;
    /** `-n`: parse and check, run nothing */
    readonly syntaxOnly: boolean;
    /** `-i`: prompts, and PROMPT_COMMAND, are shown and run */
    readonly interactive: boolean;
    /** explicit Bash rc file executed before interactive input */
    readonly startupFile: string | undefined;
}

/** Python `arg.split("=", 1)`. */
function splitOnce(arg: string, separator: string): [string] | [string, string] {
    const index = arg.indexOf(separator);
    return index < 0 ? [arg] : [arg.slice(0, index), arg.slice(index + separator.length)];
}

/** Parse a shell's own arguments. The single source of truth for every guard. */
export function shellInvocation(name: string, args: readonly string[]): ShellInvocation {
    const commandOptions = SHELL_COMMAND_OPTIONS.get(name) ?? NONE;
    const withArg = new Set([...SHELL_OPTIONS_WITH_ARG, ...(SHELL_EXTRA_OPTIONS_WITH_ARG.get(name) ?? NONE)]);
    const commands: string[] = [];
    let dashC = false;
    let readsStdin = false;
    let syntaxOnly = false;
    let interactive = false;
    let commandGiven = false; // fish `-c CMD`: the string came with the option
    let rcfile: string | undefined;
    let noRc = false;
    let login = false;
    let posix = false;
    let index = 0;
    while (index < args.length) {
        const arg = args[index] as string;
        if (arg === "--") {
            index += 1;
            break;
        }
        const key = arg.startsWith("--") ? (splitOnce(arg, "=")[0] as string) : arg;
        if (key === "--norc") noRc = true;
        else if (key === "--login") login = true;
        else if (key === "--posix") posix = true;
        if (commandOptions.has(key)) {
            // `-c`/`--command` replace the script; `-C`/`--init-command` run before it.
            if (key === "-c" || key === "--command") {
                dashC = true;
                commandGiven = true;
            }
            if (arg.startsWith("--") && arg.includes("=")) {
                commands.push(splitOnce(arg, "=")[1] as string);
                index += 1;
            } else {
                if (index + 1 < args.length) commands.push(args[index + 1] as string);
                index += 2;
            }
            continue;
        }
        if (withArg.has(key)) {
            const value = arg.includes("=")
                ? splitOnce(arg, "=")[1]
                : index + 1 < args.length
                  ? args[index + 1]
                  : undefined;
            if (key === "--rcfile" || key === "--init-file") rcfile = value;
            else if ((key === "-o" || key === "+o") && value === "posix") posix = key === "-o";
            index += arg.includes("=") ? 1 : 2;
            continue;
        }
        if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1) {
            const letters = arg.slice(1);
            syntaxOnly = syntaxOnly || letters.includes("n");
            dashC = dashC || letters.includes("c");
            readsStdin = readsStdin || letters.includes("s");
            interactive = interactive || letters.includes("i");
            login = login || letters.includes("l");
            index += 1;
            continue;
        }
        if ((arg.startsWith("+") || arg.startsWith("--")) && arg !== "+" && arg !== "--") {
            index += 1;
            continue;
        }
        break;
    }
    const positionals = args.slice(index);
    let commandArgs: readonly string[] = [];
    let script: string | undefined;
    let scriptArgs: readonly string[] = [];
    if (dashC && !commandGiven && positionals.length > 0) {
        commands.push(positionals[0] as string); // `bash -c STR $0 $1 ...`
        commandArgs = positionals.slice(1);
    } else if (dashC) {
        commandArgs = positionals;
    } else if (!readsStdin && positionals.length > 0 && !STDIN_PATHS.has(positionals[0] as string)) {
        script = positionals[0];
        scriptArgs = positionals.slice(1);
    }
    const stdin = readsStdin || (!dashC && script === undefined);
    const startupFile = name === "bash" && interactive && !(noRc || login || posix) ? rcfile : undefined;
    return {
        commands,
        commandArgs,
        script,
        scriptArgs,
        readsStdin: stdin,
        syntaxOnly,
        interactive,
        startupFile,
    };
}

// Wrappers whose command is a string the shell parses again.
export const STRING_RUNNERS: ReadonlyMap<string, WrapperSpec> = new Map([
    [
        "su",
        wrapperSpec(
            opts("-s", "--shell", "-g", "--group", "-G", "--supp-group", "-w", "--whitelist-environment"),
            {
                commandOptions: opts("-c", "--command"),
            },
        ),
    ],
    [
        "runuser",
        wrapperSpec(opts("-u", "--user", "-g", "--group", "-G", "--supp-group", "-s", "--shell", "-w"), {
            commandOptions: opts("-c", "--command"),
        }),
    ],
    [
        "script",
        wrapperSpec(
            opts(
                "-E",
                "--echo",
                "-I",
                "--log-in",
                "-O",
                "--log-out",
                "-B",
                "--log-io",
                "-T",
                "--log-timing",
                "-m",
                "--logging-format",
                "-o",
                "--output-limit",
            ),
            { commandOptions: opts("-c", "--command") },
        ),
    ],
    ["watch", wrapperSpec(opts("-n", "--interval", "-d", "--differences", "-q", "--equexit", "--chgexit"))],
]);

export const SSH_OPTIONS_WITH_ARG: ReadonlySet<string> = opts(
    "-B",
    "-b",
    "-c",
    "-D",
    "-E",
    "-e",
    "-F",
    "-I",
    "-i",
    "-J",
    "-L",
    "-l",
    "-m",
    "-O",
    "-o",
    "-P",
    "-p",
    "-Q",
    "-R",
    "-S",
    "-W",
    "-w",
);

/** `tool sub [opts] [--] command...`, e.g. `mise exec -- rm -rf x`. */
export interface SubcommandRunner {
    readonly subcommands: ReadonlySet<string>;
    readonly withArg: ReadonlySet<string>;
    readonly positionals: number;
    /** Options that change directory before running the command (`uv --directory`). */
    readonly chdirOptions: ReadonlySet<string>;
    /** Options whose value is a command string run through a shell (`npm exec -c CMD`). */
    readonly commandOptions: ReadonlySet<string>;
}

function subcommandRunner(
    subcommands: ReadonlySet<string>,
    withArg: ReadonlySet<string> = NONE,
    rest: Partial<SubcommandRunner> = {},
): SubcommandRunner {
    return {
        subcommands,
        withArg,
        positionals: rest.positionals ?? 0,
        chdirOptions: rest.chdirOptions ?? NONE,
        commandOptions: rest.commandOptions ?? NONE,
    };
}

export const SUBCOMMAND_RUNNERS: ReadonlyMap<string, SubcommandRunner> = new Map([
    [
        "mise",
        subcommandRunner(
            opts("exec", "x"),
            opts("-C", "--cd", "-E", "--env", "-j", "--jobs", "-c", "--command"),
            {
                chdirOptions: opts("-C", "--cd"),
                commandOptions: opts("-c", "--command"),
            },
        ),
    ],
    [
        "npm",
        subcommandRunner(
            opts("exec", "x"),
            opts("-p", "--package", "-w", "--workspace", "--prefix", "-c", "--call"),
            {
                chdirOptions: opts("--prefix"),
                commandOptions: opts("-c", "--call"),
            },
        ),
    ],
    ["fnox", subcommandRunner(opts("exec"), opts("-c", "--config", "-p", "--profile", "--if-missing"))],
    ["direnv", subcommandRunner(opts("exec"), NONE, { positionals: 1 })],
    [
        "uv",
        subcommandRunner(
            opts("run"),
            opts(
                "--with",
                "--with-editable",
                "--with-requirements",
                "-p",
                "--python",
                "--project",
                "--directory",
                "--package",
                "--extra",
                "--group",
                "--env-file",
                "--index",
                "--default-index",
                "--index-url",
                "--extra-index-url",
                "-f",
                "--find-links",
                "--config-file",
                "--cache-dir",
                "--only-group",
                "--no-group",
            ),
            { chdirOptions: opts("--directory") },
        ),
    ],
    [
        "poetry",
        subcommandRunner(opts("run"), opts("-C", "--directory", "-P", "--project"), {
            chdirOptions: opts("-C", "--directory"),
        }),
    ],
    [
        "pnpm",
        subcommandRunner(opts("exec", "dlx"), opts("-C", "--dir", "--filter", "-F"), {
            chdirOptions: opts("-C", "--dir"),
            commandOptions: opts("-c", "--shell-mode"),
        }),
    ],
    ["bundle", subcommandRunner(opts("exec"))],
    ["pipenv", subcommandRunner(opts("run"))],
    ["conda", subcommandRunner(opts("run"), opts("-n", "--name", "-p", "--prefix"))],
]);

// Words that start a compound command or negate a pipeline; the command proper
// follows them.
export const RESERVED_PREFIXES: ReadonlySet<string> = new Set([
    "!",
    "{",
    "}",
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "do",
    "done",
    "while",
    "until",
    "time",
    "coproc",
]);

const GRADLE_OPTIONS = opts(
    "-p",
    "--project-dir",
    "-c",
    "--settings-file",
    "-g",
    "--gradle-user-home",
    "-I",
    "--init-script",
    "-x",
    "--exclude-task",
);
const PODMAN_OPTIONS = opts(
    "--url",
    "--connection",
    "-c",
    "--identity",
    "--log-level",
    "--root",
    "--runroot",
);

// Options that take a separate value, per CLI, wherever they appear: before
// the subcommand (`npm -w web publish`, `helm -n prod uninstall`) or after
// it. Without them the value reads as the subcommand and the rule misses.
export const CLI_OPTIONS_WITH_VALUE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    [
        "npm",
        opts(
            "-w",
            "--workspace",
            "--registry",
            "--prefix",
            "--userconfig",
            "--globalconfig",
            "--cache",
            "--tag",
            "--access",
            "--otp",
            "--loglevel",
            "--scope",
            "--auth-type",
            "--include",
            "--omit",
        ),
    ],
    [
        "pnpm",
        opts(
            "-C",
            "--dir",
            "-F",
            "--filter",
            "--registry",
            "--tag",
            "--access",
            "--otp",
            "--loglevel",
            "--publish-branch",
            "--report-summary",
        ),
    ],
    ["yarn", opts("--cwd", "--registry", "--tag", "--access", "--otp", "--new-version")],
    ["bun", opts("--cwd", "-c", "--config", "--registry", "--tag", "--access", "--otp")],
    [
        "cargo",
        opts(
            "-Z",
            "--config",
            "--color",
            "-C",
            "--manifest-path",
            "--registry",
            "--index",
            "--token",
            "-p",
            "--package",
            "-j",
            "--jobs",
            "--target",
            "--target-dir",
            "-F",
            "--features",
        ),
    ],
    ["gem", opts("-k", "--key", "--host", "--otp")],
    [
        "twine",
        opts(
            "-r",
            "--repository",
            "--repository-url",
            "-u",
            "--username",
            "-p",
            "--password",
            "-c",
            "--comment",
            "-i",
            "--identity",
            "--sign-with",
            "--config-file",
            "--cert",
            "--client-cert",
        ),
    ],
    [
        "uv",
        opts(
            "--directory",
            "--project",
            "--config-file",
            "--cache-dir",
            "--index",
            "--publish-url",
            "-u",
            "--username",
            "-p",
            "--password",
            "-t",
            "--token",
            "--trusted-publishing",
            "--check-url",
        ),
    ],
    [
        "poetry",
        opts(
            "-C",
            "--directory",
            "-P",
            "--project",
            "-r",
            "--repository",
            "-u",
            "--username",
            "-p",
            "--password",
            "--cert",
            "--client-cert",
        ),
    ],
    ["pdm", opts("-p", "--project", "-r", "--repository", "-u", "--username", "-P", "--password")],
    ["hatch", opts("-r", "--repo", "-u", "--user", "-a", "--auth", "-e", "--env")],
    [
        "mvn",
        opts(
            "-f",
            "--file",
            "-s",
            "--settings",
            "-gs",
            "--global-settings",
            "-P",
            "--activate-profiles",
            "-pl",
            "--projects",
            "-rf",
            "--resume-from",
            "-T",
            "--threads",
            "-t",
            "--toolchains",
        ),
    ],
    ["gradle", GRADLE_OPTIONS],
    [
        "docker",
        opts(
            "-H",
            "--host",
            "--context",
            "-c",
            "--config",
            "-l",
            "--log-level",
            "--tlscacert",
            "--tlscert",
            "--tlskey",
        ),
    ],
    ["podman", PODMAN_OPTIONS],
    [
        "helm",
        opts(
            "-n",
            "--namespace",
            "--kube-context",
            "--kubeconfig",
            "--kube-apiserver",
            "--kube-token",
            "--registry-config",
            "--repository-config",
            "--repository-cache",
        ),
    ],
    ["gh", opts("-R", "--repo", "--hostname")],
    ["gradlew", GRADLE_OPTIONS],
    ["buildah", PODMAN_OPTIONS],
    [
        "systemctl",
        opts(
            "-H",
            "--host",
            "-M",
            "--machine",
            "-t",
            "--type",
            "-p",
            "--property",
            "--state",
            "-n",
            "--lines",
            "-o",
            "--output",
            "--root",
            "--signal",
            "-s",
        ),
    ],
]);
