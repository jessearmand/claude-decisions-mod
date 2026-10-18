/**
 * Claude Code Hook: File Edit Protection (ported from file_protection.py)
 * =======================================================================
 * PreToolUse guard for Edit / MultiEdit / Write / NotebookEdit. Blocks writes to
 * files that a tool owns and regenerates, so they must never be hand-edited.
 *
 * Reads are deliberately NOT blocked: inspecting a lockfile to see which version
 * resolved is normal and useful. Only writes are refused.
 *
 * This is the "generated files" category. Secrets and environment variables are a
 * separate concern handled by secrets-guard.ts — .env is not listed here.
 *
 * Covered ecosystems: npm, yarn, pnpm, bun, deno, Cargo, SwiftPM, uv, poetry,
 * pipenv, bundler (Ruby), composer, Go, Dart/Flutter, Nix, CocoaPods, Gradle,
 * plus git internals and node_modules.
 *
 * A match answers `deny` naming the command that should regenerate the file
 * instead. A non-match defers (`undefined`).
 *
 * Configuration (config.ts, from the userConfig options or the environment):
 *   FILE_PROTECTION_DISABLE=1     turn the guard off entirely
 *   FILE_PROTECTION_ASK=true      prompt the user instead of denying outright
 *   FILE_PROTECTION_LOG_DIR=<dir> default ~/.claude/hooks-logs
 */

import { logEvent } from "../audit.ts";
import { actionVerb, type Decision, decision, type HookInput, pathsFrom, WRITE_TOOLS } from "../decision.ts";
import { truncate } from "../util/text.ts";
import type { Guard, GuardDeps } from "./guard.ts";

export const HOOK_NAME = "file-protection";

/** A path pattern that a tool owns, plus how to regenerate it properly. */
export interface ProtectedFile {
    readonly ruleId: string;
    readonly pattern: RegExp;
    readonly ecosystem: string;
    readonly reason: string;
    readonly regenerate: string;
}

function rx(pattern: string): RegExp {
    return new RegExp(pattern, "i");
}

/** A lockfile rule, matched on basename. */
function lock(ruleId: string, filenames: string, ecosystem: string, regenerate: string): ProtectedFile {
    return {
        ruleId,
        pattern: rx(`(?:^|/)(?:${filenames})$`),
        ecosystem,
        reason: "lockfile is generated and carries integrity hashes",
        regenerate,
    };
}

// Order matters only for reporting: the first match wins, so keep the specific
// rules ahead of the broad directory rules.
export const PROTECTED_FILES: readonly ProtectedFile[] = [
    // ---- JavaScript / TypeScript ----
    lock(
        "npm-lock",
        String.raw`package-lock\.json|npm-shrinkwrap\.json`,
        "npm",
        "`npm install` (or `npm ci` to install from the lockfile unchanged)",
    ),
    lock(
        "yarn-lock",
        String.raw`yarn\.lock`,
        "yarn",
        "`yarn install`, or `yarn up <pkg>` to move a single dependency",
    ),
    lock(
        "pnpm-lock",
        String.raw`pnpm-lock\.yaml`,
        "pnpm",
        "`pnpm install`, or `pnpm update <pkg>` for one dependency",
    ),
    lock(
        "bun-lock",
        String.raw`bun\.lock|bun\.lockb`,
        "bun",
        "`bun install`, or `bun update <pkg>` for one dependency",
    ),
    lock(
        "deno-lock",
        String.raw`deno\.lock`,
        "deno",
        "`deno install`, or `deno cache --reload <entrypoint>` to refresh. " +
            "Edit `deno.json` imports instead — that file is yours to change",
    ),

    // ---- Rust / Swift / Go ----
    lock(
        "cargo-lock",
        String.raw`Cargo\.lock`,
        "cargo",
        "`cargo update -p <crate>` for one crate, or `cargo build` to resolve. Edit `Cargo.toml` instead",
    ),
    lock(
        "swiftpm-resolved",
        String.raw`Package\.resolved`,
        "swiftpm",
        "`swift package resolve`, or `swift package update <dep>`. Edit `Package.swift` instead",
    ),
    lock(
        "go-sum",
        String.raw`go\.sum`,
        "go",
        "`go mod tidy`, or `go get <module>@<version>`. Edit `go.mod` instead",
    ),

    // ---- Python ----
    lock(
        "uv-lock",
        String.raw`uv\.lock`,
        "uv",
        "`uv lock` to re-resolve, or `uv add <pkg>` / `uv remove <pkg>`. Edit `pyproject.toml` instead",
    ),
    lock(
        "poetry-lock",
        String.raw`poetry\.lock`,
        "poetry",
        "`poetry lock`, or `poetry add <pkg>` / `poetry update <pkg>`. Edit `pyproject.toml` instead",
    ),
    lock(
        "pipenv-lock",
        String.raw`Pipfile\.lock`,
        "pipenv",
        "`pipenv lock`, or `pipenv install <pkg>`. Edit `Pipfile` instead",
    ),

    // ---- Ruby / PHP ----
    lock(
        "bundler-lock",
        String.raw`Gemfile\.lock|gems\.locked`,
        "bundler",
        "`bundle install`, or `bundle update <gem>` for one gem. Edit `Gemfile` instead — that file is yours to change",
    ),
    lock(
        "composer-lock",
        String.raw`composer\.lock`,
        "composer",
        "`composer update`, or `composer require <pkg>`. Edit `composer.json` instead",
    ),

    // ---- Other ecosystems ----
    lock(
        "dart-lock",
        String.raw`pubspec\.lock`,
        "pub",
        "`dart pub get` or `flutter pub get`. Edit `pubspec.yaml` instead",
    ),
    lock(
        "nix-flake-lock",
        String.raw`flake\.lock`,
        "nix",
        "`nix flake update`, or `nix flake lock --update-input <input>`",
    ),
    lock(
        "cocoapods-lock",
        String.raw`Podfile\.lock`,
        "cocoapods",
        "`pod install`, or `pod update <pod>`. Edit `Podfile` instead",
    ),
    lock(
        "gradle-lock",
        String.raw`gradle\.lockfile|gradle/verification-metadata\.xml`,
        "gradle",
        "`./gradlew dependencies --write-locks`",
    ),

    // ---- Tool-managed directories ----
    {
        ruleId: "git-internals",
        pattern: rx(String.raw`(?:^|/)\.git/`),
        ecosystem: "git",
        reason: "files under .git/ are repository internals",
        regenerate:
            "use a git command (`git config`, `git update-ref`, `git rebase`, …). " +
            "Hand-editing .git/ can corrupt the repository",
    },
    {
        ruleId: "node-modules",
        pattern: rx("(?:^|/)node_modules/"),
        ecosystem: "npm",
        reason: "node_modules/ is installed content, not source",
        regenerate:
            "change the dependency and reinstall. To alter a package's behaviour, use a " +
            "patch tool (`patch-package`, `pnpm patch`) so the change survives reinstall",
    },
];

/** Return the rule that forbids writing `path`, if any. */
export function checkPath(path: string): ProtectedFile | undefined {
    if (path === "") return undefined;
    // Python replaced os.sep with "/"; the guards cover POSIX hosts, where it already is.
    const normalized = path;
    return PROTECTED_FILES.find((rule) => rule.pattern.test(normalized));
}

export function buildReason(rule: ProtectedFile, toolName: string, path: string): string {
    return [
        `📦 BLOCKED by file-protection [${rule.ruleId}] — cannot ${actionVerb(toolName)}: ${rule.reason}.`,
        `    target: ${truncate(path)}`,
        "",
        `Regenerate it with ${rule.ecosystem} instead: ${rule.regenerate}.`,
        "",
        "Hand-edited lockfiles drift from the manifest and break reproducible " +
            "installs on other machines and in CI. Reading this file is allowed — only " +
            "writing is blocked.",
    ].join("\n");
}

/** Return the generated-file policy decision for one tool call. */
async function run(input: HookInput, deps: GuardDeps): Promise<Decision | undefined> {
    const { config, host } = deps;
    if (config.fileProtection.disable) return undefined;

    const toolName = input.toolName;
    if (!WRITE_TOOLS.has(toolName)) return undefined;

    let finding: readonly [ProtectedFile, string] | undefined;
    for (const path of pathsFrom(input.toolInput)) {
        const rule = checkPath(path);
        if (rule) {
            finding = [rule, path];
            break;
        }
    }
    if (!finding) return undefined;

    const [rule, path] = finding;
    const kind = config.fileProtection.ask ? "ask" : "deny";
    await logEvent(
        host,
        HOOK_NAME,
        {
            outcome: kind,
            rule: rule.ruleId,
            ecosystem: rule.ecosystem,
            tool: toolName,
            target: path.slice(0, 200),
            session_id: input.sessionId,
            cwd: input.cwd,
            permission_mode: input.permissionMode,
        },
        config.fileProtection.logDirEnv,
        { logDir: config.logDir },
    );
    return decision(
        kind,
        buildReason(rule, toolName, path),
        `file-protection [${rule.ruleId}]: ${rule.reason}`,
        HOOK_NAME,
    );
}

export const fileProtection: Guard = { name: HOOK_NAME, tools: WRITE_TOOLS, run };
