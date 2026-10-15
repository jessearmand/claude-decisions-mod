/**
 * POSIX path helpers with Python `os.path` semantics, pure and synchronous.
 * The guards cover Linux and macOS only, so `/` is the one separator.
 */

export function isAbsolute(path: string): boolean {
    return path.startsWith("/");
}

/** `os.path.normpath`: collapses `//`, `.` and `..`; keeps a leading `/`; "" becomes ".". */
export function normpath(path: string): string {
    if (path === "") return ".";
    const absolute = path.startsWith("/");
    // POSIX keeps exactly two leading slashes as significant; Python does too.
    const doubleSlash = path.startsWith("//") && !path.startsWith("///");
    const parts: string[] = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
            else if (!absolute) parts.push("..");
            continue;
        }
        parts.push(part);
    }
    const joined = parts.join("/");
    if (absolute) return (doubleSlash ? "//" : "/") + joined;
    return joined === "" ? "." : joined;
}

/** `os.path.join`: an absolute later part discards what came before it. */
export function join(...parts: string[]): string {
    let result = "";
    for (const part of parts) {
        if (part.startsWith("/")) result = part;
        else if (result === "" || result.endsWith("/")) result += part;
        else result += `/${part}`;
    }
    return result;
}

/** `os.path.dirname`. */
export function dirname(path: string): string {
    const index = path.lastIndexOf("/");
    if (index < 0) return "";
    const head = path.slice(0, index + 1);
    return head === "/".repeat(head.length) ? head : head.replace(/\/+$/, "");
}

/** `os.path.basename`. */
export function basename(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
}

/** `os.path.split`. */
export function split(path: string): [string, string] {
    return [dirname(path), basename(path)];
}

/**
 * `os.path.expanduser` for `~` and `~/...`; `~user` is left as written (the
 * guards never need another user's home).
 */
export function expanduser(path: string, home: string): string {
    if (path === "~") return home;
    if (path.startsWith("~/")) return (home === "/" ? "" : home.replace(/\/$/, "")) + path.slice(1);
    return path;
}

/** `os.path.abspath` against an explicit working directory. */
export function abspath(path: string, cwd: string): string {
    return normpath(isAbsolute(path) ? path : join(cwd, path));
}

/** `path == root or path.startswith(root.rstrip("/") + "/")` (danger_rule.is_inside). */
export function isInside(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root.replace(/\/+$/, "")}/`);
}

/** Every value once, first occurrence kept (Python `dict.fromkeys`). */
export function unique<T>(values: Iterable<T>): T[] {
    return [...new Set(values)];
}
