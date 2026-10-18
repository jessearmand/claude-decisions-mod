/**
 * Read-only filesystem case semantics for protected-path comparisons.
 *
 * Ported from filesystem_paths.py. Python asked `pathconf(_PC_CASE_SENSITIVE)`
 * of the nearest existing ancestor; a `Host` has no pathconf, so the volume is
 * probed by looking that ancestor up under a case-swapped spelling instead (see
 * `caseInsensitive`). `patternMatches` and `isInside` take the answer, computed
 * once per path by the caller, rather than probing per call.
 */

import type { Host } from "../host/host.ts";
import { abspath, basename, dirname, expanduser } from "../util/paths.ts";
import { casefold } from "../util/text.ts";

/** `os.path.exists`: the path leads somewhere (a dangling link does not). */
function exists(stat: Awaited<ReturnType<Host["stat"]>>): boolean {
    return stat !== undefined && !(stat.isLink && stat.kind === "other");
}

/** `name` with every letter's case swapped; undefined when it has no letter to swap. */
function swapCase(name: string): string | undefined {
    const swapped = [...name]
        .map((char) => {
            const lower = char.toLowerCase();
            const upper = char.toUpperCase();
            return char === lower && char !== upper ? upper : char === upper && char !== lower ? lower : char;
        })
        .join("");
    return swapped === name ? undefined : swapped;
}

/**
 * Query the target volume on macOS, including for a file not yet created.
 *
 * Darwin's _PC_CASE_SENSITIVE is 11 (xnu/bsd/sys/unistd.h). Querying the
 * nearest existing target ancestor follows symlinks and respects mounted
 * case-sensitive volumes; the host platform alone cannot decide this.
 * An unavailable answer on macOS conservatively protects case aliases.
 * Linux paths retain their normal case-sensitive comparisons.
 *
 * Without pathconf, the ancestor is looked up again with the letters of its
 * last component case-swapped: a case-folding volume always finds it. The
 * two spellings are not compared by `realPath`, since the engine's answer
 * keeps a case alias's own spelling. On a case-sensitive volume the swapped
 * name exists only as a distinct sibling, which folds case for this path
 * and so protects more, never less. An ancestor with no letter to swap (the
 * root, digits only) answers true, as Python's `except` branch did.
 *
 * `cwd` anchors a relative `path` (Python used the process directory).
 */
export async function caseInsensitive(path: string, host: Host, cwd = "/"): Promise<boolean> {
    if (host.platform !== "darwin") return false;
    let target = abspath(expanduser(path, host.home), cwd);
    while (!exists(await host.stat(target))) {
        const parent = dirname(target);
        if (parent === target) return true;
        target = parent;
    }
    // pathconf followed symlinks: the volume asked is the one holding the real ancestor.
    const real = await host.realPath(target);
    const swapped = swapCase(basename(real));
    if (swapped === undefined) return true;
    const parent = dirname(real);
    const sibling = parent === "/" ? `/${swapped}` : `${parent}/${swapped}`;
    return exists(await host.stat(sibling));
}

/** `pattern` without the `g` flag, so `.test` never carries a `lastIndex` between calls. */
function plain(pattern: RegExp): RegExp {
    return pattern.global ? new RegExp(pattern.source, pattern.flags.replace("g", "")) : pattern;
}

/**
 * Whether `pattern` matches `path`, or, on a case-insensitive volume
 * (`insensitive`, computed by `caseInsensitive`), matches ignoring case.
 */
export function patternMatches(pattern: RegExp, path: string, insensitive = false): boolean {
    if (plain(pattern).test(path)) return true;
    if (!insensitive) return false;
    const flags = plain(pattern).flags;
    return new RegExp(pattern.source, flags.includes("i") ? flags : `${flags}i`).test(path);
}

/** `path == root or path.startswith(root.rstrip("/") + "/")`, folding case on an insensitive volume. */
export function isInside(path: string, root: string, insensitive = false): boolean {
    const [candidate, base] = insensitive ? [casefold(path), casefold(root)] : [path, root];
    return candidate === base || candidate.startsWith(`${base.replace(/\/+$/, "")}/`);
}
