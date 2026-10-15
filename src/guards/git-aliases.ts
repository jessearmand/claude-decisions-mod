/**
 * What a git alias runs, for the source resolver (shell/sources.ts).
 *
 * `git wipe` is harmless text until git looks up `alias.wipe` in the
 * repository, global or system config. A `!` alias runs a shell command; any
 * other alias is a git command line. Neither appears in the command the agent
 * typed, so the guards never saw it. This module asks git for the alias the way
 * git itself would, and returns what it expands to as program text the command
 * runs: the shell command for `!rm -rf x`, or `git clean -fdx` for `clean -fdx`.
 *
 * An alias set inline with `git -c alias.x=…` wins over the config files, as in
 * git, and counts as typed. One read from config counts as not typed (the file
 * may predate the session), so guards ask about it rather than deny.
 *
 * Only `git config --get` is run, with a short timeout: it reads config files and
 * runs no hooks or helpers. Builtin subcommands are skipped without a lookup,
 * because git never lets an alias shadow them.
 *
 * Ported from git_aliases.py. The Python module cached lookups per process
 * (`lru_cache`); a hooks module lives for the whole session, where a cache
 * would outlive the user's next `git config` edit, so each call asks git again.
 */

import type { Host } from "../host/host.ts";
import type { SourceText } from "../shell/model.ts";
import { createSourceResolver, type GitAliasResolver } from "../shell/sources.ts";
import { partition, shellQuote } from "../util/text.ts";
import { gitInvocation } from "./dangerous-git.ts";

export const LOOKUP_TIMEOUT_SECONDS = 2.0;

// `git --list-cmds=builtins,main` (git 2.43): commands an alias cannot replace.
export const BUILTINS: ReadonlySet<string> = new Set(
    `
add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore
check-mailmap check-ref-format checkout checkout--worker checkout-index cherry cherry-pick clean
clone column commit commit-graph commit-tree config count-objects credential credential-cache
credential-cache--daemon credential-store daemon describe diagnose diff diff-files diff-index
diff-tree difftool difftool--helper fast-export fast-import fetch fetch-pack filter-branch
fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects fsmonitor--daemon gc
get-tar-commit-id grep hash-object help hook http-backend http-fetch http-push imap-send index-pack
init init-db instaweb interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit
maintenance merge merge-base merge-file merge-index merge-octopus merge-one-file merge-ours
merge-recursive merge-recursive-ours merge-recursive-theirs merge-resolve merge-subtree merge-tree
mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs
patch-id pickaxe prune prune-packed pull push quiltimport range-diff read-tree rebase receive-pack
reflog remote remote-ext remote-fd remote-ftp remote-ftps remote-http remote-https repack replace
request-pull rerere reset restore rev-list rev-parse revert rm send-pack sh-i18n--envsubst shell
shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace
submodule submodule--helper subtree switch symbolic-ref tag unpack-file unpack-objects update-index
update-ref update-server-info upload-archive upload-archive--writer upload-pack var verify-commit
verify-pack verify-tag version web--browse whatchanged worktree write-tree
`
        .split(/\s+/)
        .filter((name) => name !== ""),
);

/** `git config --get KEY` as git would read it from `directory`, or undefined. */
async function configured(
    directory: string | undefined,
    key: string,
    host: Host,
): Promise<string | undefined> {
    const command = ["git", ...(directory ? ["-C", directory] : []), "config", "--get", key];
    // A missing git, a forbidden process or a timeout answers undefined, as the OSError branch did.
    const completed = await host.run(command, { timeoutMs: LOOKUP_TIMEOUT_SECONDS * 1000 });
    if (completed === undefined) return undefined;
    const value = completed.stdout.replace(/\n+$/, "");
    return completed.exitCode === 0 && value ? value : undefined;
}

/** What `git ALIAS ARGS` runs when alias.ALIAS is `value`. */
function programText(value: string, args: readonly string[]): string {
    const quoted = args.map(shellQuote).join(" ");
    if (value.startsWith("!")) {
        // git runs `sh -c '<command> "$@"' <command> ARGS`: the arguments follow the command.
        return `${value.slice(1).trim()} ${quoted}`.trim();
    }
    return `git ${value} ${quoted}`.trim();
}

/** (program text, label) for the alias `command` invokes, if it is one. */
export const resolveGitAliases: GitAliasResolver = async (command, host) => {
    const git = gitInvocation(command, host.home);
    if (git === undefined || !git.subcommand || BUILTINS.has(git.subcommand)) return [];
    const key = `alias.${git.subcommand.toLowerCase()}`;
    const inline = git.config
        .filter((item) => partition(item, "=")[0] === key)
        .map((item) => partition(item, "=")[2]);
    const last = inline[inline.length - 1];
    if (last !== undefined) return [[programText(last, git.args), `written git alias ${git.subcommand}`]];
    const found: SourceText[] = [];
    for (const directory of git.directories.length > 0 ? git.directories : [undefined]) {
        const value = await configured(directory, key, host);
        if (value !== undefined) {
            const entry: SourceText = [programText(value, git.args), `git alias ${git.subcommand}`];
            if (!found.some(([text, label]) => text === entry[0] && label === entry[1])) found.push(entry);
        }
    }
    return found;
};

/** The source resolver the hooks module and the scripts use: scripts, package.json, Makefiles and git aliases. */
export const sourcesWithGitAliases = createSourceResolver({ gitAliases: resolveGitAliases });
