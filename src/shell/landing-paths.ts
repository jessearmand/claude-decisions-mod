/**
 * Where the files of a copy or archive extraction land.
 *
 * `tar xf payload.tar` in a project, or `cp -r template/. .`, writes files whose
 * names the command line does not show. When the destination holds protected
 * config (`.claude/`, `.git/hooks/`, `~/.ssh/`), config_guard needs those names:
 * this lists them, relative to the destination, or returns null when they cannot
 * be known (an archive read from stdin, too large, renamed on the way out, or a
 * member link pointing outside the destination).
 *
 * Ported from landing_paths.py. Python listed archives with tarfile/zipfile;
 * here `tar -tvf` and `unzip -Z` run through the host, and an archive the host
 * cannot list (no tool, a cloud session) counts as unknown.
 */

import type { DirEntry, Host } from "../host/host.ts";
import { basename, dirname, expanduser, isAbsolute, join, normpath } from "../util/paths.ts";
import { type Contents, keptPaths } from "./writes.ts";

/** listing a compressed tar reads all of it */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_ENTRIES = 20_000;

class Unknown extends Error {}

/** `(name, symlink target or undefined)` per archive member. */
type Entry = readonly [name: string, symlink: string | undefined];

export type Descend = (relativeDir: string) => boolean;
export type MadeEarlier = (name: string) => boolean;

/**
 * Paths relative to the destination, or null when they cannot be known.
 *
 * `descend(relativeDir)`: whether a copied directory's contents matter. Trees
 * are walked only where protected paths may lie, so a large copy stays cheap.
 * `madeEarlier(path)`: whether the line writes that file before this command;
 * a missing archive it does not write makes the extraction fail, landing nothing.
 */
export async function landingPaths(
    contents: Contents | undefined,
    cwd: string,
    descend: Descend,
    host: Host,
    madeEarlier: MadeEarlier = () => true,
): Promise<string[] | null> {
    if (contents === undefined) return null;
    try {
        if (contents.archive !== undefined) return await archiveMembers(contents, cwd, madeEarlier, host);
        return await copied(contents, cwd, descend, host);
    } catch (error) {
        if (error instanceof Unknown) return null;
        throw error;
    }
}

async function archiveMembers(
    contents: Contents,
    cwd: string,
    madeEarlier: MadeEarlier,
    host: Host,
): Promise<string[]> {
    const archive = contents.archive ?? "";
    if (archive.includes("$") || archive.includes("`")) throw new Unknown(archive);
    const path = join(cwd, expanduser(archive, host.home));
    const stat = await host.stat(path);
    if (stat === undefined) {
        if (madeEarlier(archive)) throw new Unknown(archive); // downloaded or written earlier on the line
        return []; // nothing to extract: the command fails
    }
    if (stat.kind !== "file" || stat.size > MAX_ARCHIVE_BYTES) throw new Unknown(archive);
    const entries = contents.zipArchive ? await zipEntries(path, host) : await tarEntries(path, host);
    if (entries.length > MAX_ENTRIES) throw new Unknown(archive);
    const links = new Map<string, string>(); // a symlink member -> where it points, both relative to the destination
    const landed: string[] = [];
    for (const [name, symlink] of entries) {
        const stripped = strippedName(name, contents.strip);
        if (stripped === undefined) continue;
        // tar drops a leading `/` unless -P; unzip always does.
        const member =
            contents.absoluteNames && !contents.zipArchive ? stripped : stripped.replace(/^\/+/, "");
        const target = throughLinks(member, links);
        landed.push(target);
        if (symlink !== undefined) {
            // Later members under this name land where it points (`link -> .claude`,
            // then `link/settings.json`), as tar and unzip write through it.
            links.set(member, throughLinks(normpath(join(dirname(target), symlink)), links));
        }
    }
    return landed;
}

/** `member` after the archive's own links: `link/x` with `link -> .claude` is `.claude/x`. */
function throughLinks(member: string, links: ReadonlyMap<string, string>): string {
    let current = member;
    for (let round = 0; round < 16; round += 1) {
        const parts = normpath(current).split("/");
        let replaced = false;
        for (let length = parts.length; length > 0; length -= 1) {
            const prefix = parts.slice(0, length).join("/");
            const target = links.get(prefix);
            if (target !== undefined) {
                current = [target, ...parts.slice(length)].join("/");
                replaced = true;
                break;
            }
        }
        if (!replaced) return current;
    }
    throw new Unknown(member); // a cycle of links
}

/** The output of a listing tool, or Unknown when the host cannot run it or it fails. */
async function listing(argv: readonly string[], host: Host): Promise<string> {
    const result = await host.run(argv, { timeoutMs: 60_000 });
    if (result === undefined || result.exitCode !== 0) throw new Unknown(argv.join(" "));
    return result.stdout;
}

// zipinfo's member line: mode, version, OS, size, flags, method, date, time, name.
const ZIP_MEMBER = /^([-dlbcps?][-rwxsStTlLa]{6,9})\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+\S+\s(.*)$/;
const ZIP_SKIPPED = [/^Archive:\s/, /^Zip file size:/, /^\d+ files?, /, /^Empty zipfile\.$/];
const ZIP_WILDCARDS = /[[\]*?\\]/g;

/** (name, symlink target or undefined) per member; unzip restores Unix symlinks. */
async function zipEntries(path: string, host: Host): Promise<Entry[]> {
    const lines = (await listing(["unzip", "-Z", path], host)).split("\n");
    const members: Array<readonly [name: string, symlink: boolean]> = [];
    for (const line of lines) {
        if (line === "" || ZIP_SKIPPED.some((pattern) => pattern.test(line))) continue;
        const match = ZIP_MEMBER.exec(line);
        if (!match) throw new Unknown(line);
        members.push([match[2] as string, (match[1] as string).startsWith("l")]);
    }
    if (members.length > MAX_ENTRIES) throw new Unknown(path);
    const entries: Entry[] = [];
    for (const [name, symlink] of members) {
        if (!symlink) {
            entries.push([name, undefined]);
            continue;
        }
        if (name.startsWith("-")) throw new Unknown(name); // unzip would read it as an option
        const target = await listing(["unzip", "-p", path, name.replace(ZIP_WILDCARDS, "\\$&")], host);
        if (escapes(name, target)) throw new Unknown(name);
        entries.push([name, target]);
    }
    return entries;
}

// `tar -tvf` columns before the name: GNU (`mode owner/group size YYYY-MM-DD HH:MM`)
// and bsdtar (`mode links owner group size Mon DD HH:MM|YYYY`).
const TAR_GNU_HEAD = /^\S+\s+\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s/;
const TAR_BSD_HEAD = /^\S+\s+\d+\s+\S+\s+\S+\s+\d+\s+[A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\s/;
const TAR_ESCAPES: Readonly<Record<string, string>> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    "?": "?",
    '"': '"',
};

/** GNU tar lists names in `--quoting-style=escape`: `\n`, `\\` and octal `\NNN` stand for the bytes. */
function unescapeTarName(name: string): string {
    return name.replace(/\\([0-7]{1,3}|[abfnrtv\\?"])/g, (whole, code: string) => {
        if (/^[0-7]+$/.test(code)) return String.fromCharCode(Number.parseInt(code, 8));
        return TAR_ESCAPES[code] ?? whole;
    });
}

/** `text` split at its one occurrence of `separator`; Unknown when there are several or none. */
function splitOnce(text: string, separator: string): readonly [string, string] {
    const index = text.indexOf(separator);
    if (index < 0 || text.indexOf(separator, index + separator.length) >= 0) throw new Unknown(text);
    return [text.slice(0, index), text.slice(index + separator.length)];
}

async function tarEntries(path: string, host: Host): Promise<Entry[]> {
    const lines = (await listing(["tar", "-tvf", path], host)).split("\n");
    const entries: Entry[] = [];
    for (const line of lines) {
        if (line === "") continue;
        const head = TAR_GNU_HEAD.exec(line) ?? TAR_BSD_HEAD.exec(line);
        if (!head) throw new Unknown(line);
        const type = line[0];
        const rest = line.slice(head[0].length);
        if (type === "l") {
            const [name, target] = splitOnce(rest, " -> ").map(unescapeTarName) as [string, string];
            if (escapes(name, target)) throw new Unknown(name); // later members may be written through it
            entries.push([name, target]);
        } else if (type === "h") {
            const [name, target] = splitOnce(rest, " link to ").map(unescapeTarName) as [string, string];
            if (escapes(name, target)) throw new Unknown(name);
            entries.push([name, undefined]);
        } else {
            // tarfile strips the trailing slash of a directory member's name.
            const name = unescapeTarName(rest);
            entries.push([type === "d" ? name.replace(/\/+$/, "") : name, undefined]);
        }
    }
    return entries;
}

/** Whether a link member points outside the directory it is extracted into. */
function escapes(name: string, target: string): boolean {
    if (isAbsolute(target)) return true;
    const resolved = normpath(join(dirname(name), target));
    return resolved === ".." || resolved.startsWith("../");
}

function strippedName(name: string, strip: number): string | undefined {
    if (strip <= 0) return name;
    const parts = name.split("/").filter((part) => part);
    return parts.length > strip ? parts.slice(strip).join("/") : undefined;
}

/**
 * `cp a b dir/`: `a` and `b` under their own names. A directory copied
 * recursively lands as `dir/NAME/...`, or as `dir/...` for `src/.`, for
 * `src/` where the tool reads it so (rsync, BSD cp), and for ditto. A
 * path-keeping copy (`cp --parents`, `rsync -R`) lands it under its path.
 */
async function copied(contents: Contents, cwd: string, descend: Descend, host: Host): Promise<string[]> {
    const landed: string[] = [];
    for (const source of contents.sources) {
        const dynamic =
            source.includes("$") || source.includes("`") || (source.split("/", 1)[0] as string).includes(":");
        if (dynamic) {
            if (contents.recursive) throw new Unknown(source); // a computed or remote tree
            continue; // a single file under a name that cannot be known: no protected directory reached
        }
        const path = join(cwd, expanduser(source, host.home));
        const names = contents.keepParents
            ? keptPaths(source, contents.rsyncRelative)
            : [basename(normpath(path))];
        if ((await host.stat(path))?.kind !== "dir") {
            landed.push(...names);
            continue;
        }
        if (!contents.recursive) continue; // cp without -r skips directories
        const holds =
            !contents.keepParents &&
            (contents.copiesContents ||
                source.endsWith("/.") ||
                (source.endsWith("/") && contents.slashCopiesContents));
        for (const name of names) {
            if (!holds) landed.push(name);
            landed.push(...(await tree(path, holds ? "" : name, descend, host, contents.followLinks)));
        }
    }
    return landed;
}

/** Whether a directory entry is a directory, following links only when asked. */
function isDirectory(entry: DirEntry, followLinks: boolean): boolean {
    return entry.kind === "dir" && (followLinks || !entry.isLink);
}

async function tree(
    root: string,
    prefix: string,
    descend: Descend,
    host: Host,
    followLinks = false,
): Promise<string[]> {
    if ((await host.stat(root)) === undefined) throw new Unknown(root);
    // A directory's identity is its real path (Python compared device and inode).
    const ancestors = new Set([await host.realPath(root)]);
    const stack: Array<readonly [string, string, ReadonlySet<string>]> = [["", root, ancestors]];
    const landed: string[] = [];
    let seen = 0;
    while (stack.length > 0) {
        const [relative, directory, above] = stack.pop() as (typeof stack)[number];
        const entries = await host.list(directory);
        if (entries === undefined) throw new Unknown(directory);
        for (const entry of entries) {
            seen += 1;
            if (seen > MAX_ENTRIES) throw new Unknown(root);
            const child = relative ? `${relative}/${entry.name}` : entry.name;
            const target = prefix ? `${prefix}/${child}` : child;
            landed.push(target);
            if (isDirectory(entry, followLinks) && descend(target)) {
                const entryPath = `${directory}/${entry.name}`;
                const identity = await host.realPath(entryPath);
                if (above.has(identity)) throw new Unknown(entryPath);
                stack.push([child, entryPath, new Set([...above, identity])]);
            }
        }
    }
    return landed;
}
