/**
 * Writes whose target path cannot be worked out, judged by what the command does.
 *
 * `> "$OUT"` with OUT never set on the line could be any file, an agent's
 * settings included. Asking for every such write would interrupt ordinary
 * logging (`echo done >> "$LOG"`), so the command decides:
 *
 * - removing, moving, linking, re-permissioning or copying something into an
 *   unknown place asks: these replace or destroy whatever is there;
 * - writers that copy content from elsewhere (cp, install, rsync, dd, tee of a
 *   download, curl -o, archive extraction, in-place editors) ask;
 * - a redirect or `tee` asks when the text written comes from a download, a
 *   decoder or a file copy, or reads like agent configuration or a shell
 *   startup/persistence entry (in the command's arguments or heredoc);
 * - anything else, such as program output or a status line, passes.
 *
 * A path under a known directory other than the root, home or the current one
 * (`/tmp/$NAME`) is left to the ordinary path rules. `$(mktemp)` is resolved by
 * the parser.
 *
 * Ported from unknown_target.py.
 */

import { expanduser } from "../util/paths.ts";
import type { ParseResult, SimpleCommand } from "./model.ts";
import { type PathWrite, WRITE } from "./writes.ts";

const UNRESOLVED = /\$|`/;
/** Text that configures an agent or runs at login/startup. */
const CONFIG_TEXT =
    /hooks|PreToolUse|PostToolUse|UserPromptSubmit|permissions|mcpServers|bypassPermissions|dangerously|apiKeyHelper|statusLine|allowedTools|settings\.json|\.mcp\.json|CLAUDE\.md|AGENTS\.md|\balias\s+\w+=|\bexport\s+\w+=|\bPATH=|\bsource\s|authorized_keys|LaunchAgents|LaunchDaemons|@reboot|crontab|systemctl|\.bashrc|\.zshrc|\.profile|\.zshenv/i;
/** Programs whose output is content brought from elsewhere. */
const CONTENT_SOURCES: ReadonlySet<string> = new Set([
    "curl",
    "wget",
    "fetch",
    "aria2c",
    "http",
    "https",
    "xh",
    "nc",
    "ncat",
    "socat",
    "base64",
    "base32",
    "xxd",
    "openssl",
    "uudecode",
    "gunzip",
    "zcat",
    "bzcat",
    "xzcat",
    "unzip",
]);
const REDIRECTS: ReadonlySet<string> = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);

/**
 * Where `path` lands cannot be told apart from an agent's configuration:
 * nothing before its first computed part is known (`$OUT`, `$DIR/x.json`),
 * or only the root, the home or the current directory is (`~/$X`, `./$X`),
 * which is where agent configuration lives. `/tmp/$NAME` and `logs/$NAME`
 * stay in a known directory. `home` is what `~` expands to (`host.home`).
 */
export function isUnknown(path: string, home: string): boolean {
    const segments = path.split("/");
    const first = segments.findIndex((segment) => UNRESOLVED.test(segment));
    if (first < 0) return false;
    const known = segments.slice(0, first).join("/");
    return (
        known === "" || known === "." || known === "~" || expanduser(known, home) === expanduser("~", home)
    );
}

const ACTION_WORDS: ReadonlyMap<string, string> = new Map([
    ["delete", "deletes"],
    ["delete-tree", "deletes everything under"],
    ["move", "moves away"],
    ["permissions", "changes the permissions of"],
    ["link", "links"],
    ["into-dir", "copies files into"],
]);

/** Why this write to an unknown target deserves a look, or undefined if it does not. */
export function reason(command: SimpleCommand, write: PathWrite, parsed: ParseResult): string | undefined {
    if (write.action !== WRITE) {
        const verb = ACTION_WORDS.get(write.action) ?? "changes";
        return `the target is not known, and \`${command.name}\` ${verb} it`;
    }
    const stream =
        command.redirects.some((r) => REDIRECTS.has(r.op) && r.target === write.path) ||
        command.name === "tee";
    if (!stream) return `the target is not known, and \`${command.name}\` replaces its contents`;
    for (const producer of producers(command, parsed)) {
        if (
            CONTENT_SOURCES.has(producer.name) ||
            (producer.name === "cat" && fileOperands(producer).length > 0)
        ) {
            return `the target is not known, and the text written comes from \`${producer.name}\``;
        }
        if (texts(producer).some((text) => CONFIG_TEXT.test(text))) {
            return "the target is not known, and the text written reads like agent configuration or a startup file";
        }
    }
    return undefined;
}

/**
 * The command writing the text, and for `tee` or a bare `cat`, the commands
 * piping into it.
 */
function producers(command: SimpleCommand, parsed: ParseResult): SimpleCommand[] {
    const found = [command];
    let current = command;
    while ((current.name === "tee" || current.name === "cat") && fileOperands(current).length === 0) {
        const previous = parsed.previousStage(current);
        if (previous === undefined) break;
        found.push(previous);
        current = previous;
    }
    return found;
}

function fileOperands(command: SimpleCommand): string[] {
    return command.name === "cat" ? command.args.filter((a) => !a.startsWith("-") || a === "-") : [];
}

/** The arguments and heredoc bodies of `command`: what it may write. */
function texts(command: SimpleCommand): string[] {
    const bodies = command.redirects.flatMap((r) => (r.body ? [r.body] : []));
    return [command.argv.join(" "), ...bodies];
}
