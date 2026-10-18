/**
 * Destructive infrastructure, cloud, container and database commands.
 *
 * These are the families the offline eval showed slipping past every hook
 * (psql, kubectl, terraform, docker, aws, gcloud, helm). Delete verbs that
 * remove named resources are denied; broad "delete anything" verbs the rules
 * cannot scope are asked about.
 *
 * The terraform/aws/gcloud/az lists follow cc-safety-net's official
 * rulebooks (MIT, cc-safety-net/rulebooks).
 *
 * Ported from dangerous_infra.py. SQL command files are read through the
 * context's host, so the SQL rule is asynchronous.
 */

import { knownStdin } from "../shell/command-stdin.ts";
import {
    type ClientInput,
    clientInput,
    fileOptionValues,
    GETOPT_CLIENTS,
    included,
    optionValues,
    readFile,
} from "../shell/db-client-files.ts";
import type { SimpleCommand } from "../shell/model.ts";
import {
    type DangerRule,
    dangerRule,
    HIGH,
    has,
    longFlag,
    type MatchDetail,
    matchDetail,
    operands,
    positionalWords,
    type RuleContext,
    shortFlag,
} from "./danger-rule.ts";

// --------------------------------------------------------------------------- #
// Terraform / OpenTofu
// --------------------------------------------------------------------------- #

const TF_TRUE = /^-{1,2}destroy(?:=(?:1|t|true))?$/i;

function terraform(command: SimpleCommand): string | undefined {
    if (!["terraform", "tofu", "terragrunt"].includes(command.name)) return undefined;
    const words = command.args.filter((a) => !a.startsWith("-chdir"));
    const positional = words.filter((a) => !a.startsWith("-"));
    const verb = positional[0];
    if (verb === undefined) return undefined;
    const dryRun = words.some((a) => {
        const lower = a.toLowerCase();
        return lower.startsWith("-dry-run") && !lower.endsWith("=false") && !lower.endsWith("=0");
    });
    if (verb === "destroy") return "terraform destroy";
    if (verb === "apply" && words.some((a) => TF_TRUE.test(a))) return "terraform apply -destroy";
    const second = positional[1];
    if (verb === "state" && (second === "rm" || second === "push") && !dryRun)
        return `terraform state ${second}`;
    if (verb === "workspace" && second === "delete") return "terraform workspace delete";
    return undefined;
}

// --------------------------------------------------------------------------- #
// Cloud CLIs
// --------------------------------------------------------------------------- #

const AWS_GLOBAL_WITH_VALUE: ReadonlySet<string> = new Set([
    "--ca-bundle",
    "--cli-binary-format",
    "--cli-connect-timeout",
    "--cli-error-format",
    "--cli-read-timeout",
    "--color",
    "--endpoint-url",
    "--output",
    "--profile",
    "--query",
    "--region",
]);
const AWS_DENY: ReadonlySet<string> = new Set([
    "s3 rb",
    "ec2 terminate-instances",
    "cloudformation delete-stack",
    "rds delete-db-instance",
    "rds delete-db-cluster",
    "dynamodb delete-table",
    "eks delete-cluster",
    "kms schedule-key-deletion",
    "s3api delete-bucket",
    "s3api delete-objects",
    "iam delete-user",
    "iam delete-role",
    "secretsmanager delete-secret",
    "route53 delete-hosted-zone",
    "lambda delete-function",
    "ecr delete-repository",
    "logs delete-log-group",
]);
const DESTRUCTIVE_VERB = /^(?:delete|terminate|destroy|purge|remove|deregister|revoke)(?:-|$)/;

function aws(command: SimpleCommand): string | undefined {
    if (command.name !== "aws") return undefined;
    const words = operands(command.args, AWS_GLOBAL_WITH_VALUE);
    if (words.length < 2) return undefined;
    const service = words[0] as string;
    const action = words[1] as string;
    if (command.args.some((a) => a.startsWith("--generate-cli-skeleton")) || has(command.args, "--dry-run")) {
        return undefined;
    }
    if (service === "s3" && action === "rm") return has(command.args, "--dryrun") ? undefined : "aws s3 rm";
    if (service === "s3" && action === "sync" && has(command.args, "--delete")) {
        return has(command.args, "--dryrun") ? undefined : "aws s3 sync --delete";
    }
    if (AWS_DENY.has(`${service} ${action}`)) return `aws ${service} ${action}`;
    return undefined;
}

function awsGeneric(command: SimpleCommand): string | undefined {
    if (command.name !== "aws") return undefined;
    const words = operands(command.args, AWS_GLOBAL_WITH_VALUE);
    if (words.length >= 2 && DESTRUCTIVE_VERB.test(words[1] as string) && !has(command.args, "--dry-run")) {
        return `aws ${words[0]} ${words[1]}`;
    }
    return undefined;
}

const GCLOUD_GLOBAL_WITH_VALUE: ReadonlySet<string> = new Set([
    "--access-token-file",
    "--account",
    "--billing-project",
    "--configuration",
    "--flags-file",
    "--flatten",
    "--format",
    "--impersonate-service-account",
    "--project",
    "--trace-token",
    "--verbosity",
]);
const GCLOUD_DENY: ReadonlyArray<readonly string[]> = [
    ["projects", "delete"],
    ["compute", "instances", "delete"],
    ["compute", "disks", "delete"],
    ["compute", "snapshots", "delete"],
    ["storage", "rm"],
    ["storage", "buckets", "delete"],
    ["sql", "instances", "delete"],
    ["container", "clusters", "delete"],
    ["kms", "keys", "versions", "destroy"],
    ["secrets", "versions", "destroy"],
    ["secrets", "delete"],
    ["run", "services", "delete"],
    ["functions", "delete"],
];

function startsWithPath(words: readonly string[], path: readonly string[]): boolean {
    return path.length <= words.length && path.every((word, index) => words[index] === word);
}

function gcloud(command: SimpleCommand): string | undefined {
    if (command.name !== "gcloud" && command.name !== "gsutil") return undefined;
    let words = operands(command.args, GCLOUD_GLOBAL_WITH_VALUE);
    if (command.name === "gsutil") {
        if (words[0] === "rm" || words[0] === "rb") return `gsutil ${words[0]}`;
        return undefined;
    }
    if (words[0] !== undefined && ["alpha", "beta", "preview"].includes(words[0])) words = words.slice(1);
    for (const path of GCLOUD_DENY) {
        if (startsWithPath(words, path)) return `gcloud ${path.join(" ")}`;
    }
    return undefined;
}

function gcloudGeneric(command: SimpleCommand): string | undefined {
    if (command.name !== "gcloud") return undefined;
    const words = operands(command.args, GCLOUD_GLOBAL_WITH_VALUE);
    const verb = words.find((w) => DESTRUCTIVE_VERB.test(w));
    return verb !== undefined ? `gcloud ... ${verb}` : undefined;
}

const AZ_DENY: ReadonlyArray<readonly string[]> = [
    ["group", "delete"],
    ["vm", "delete"],
    ["aks", "delete"],
    ["storage", "account", "delete"],
    ["storage", "container", "delete"],
    ["storage", "blob", "delete"],
    ["sql", "server", "delete"],
    ["sql", "db", "delete"],
    ["keyvault", "purge"],
    ["keyvault", "delete"],
    ["resource", "delete"],
    ["cosmosdb", "delete"],
];
const AZ_WITH_VALUE: ReadonlySet<string> = new Set(["-o", "--output", "--query", "--subscription"]);

function az(command: SimpleCommand): string | undefined {
    if (command.name !== "az") return undefined;
    const words = operands(command.args, AZ_WITH_VALUE);
    for (const path of AZ_DENY) {
        if (startsWithPath(words, path)) return `az ${path.join(" ")}`;
    }
    return undefined;
}

function azGeneric(command: SimpleCommand): string | undefined {
    if (command.name !== "az") return undefined;
    const words = operands(command.args, AZ_WITH_VALUE);
    const verb = words.find((w) => DESTRUCTIVE_VERB.test(w));
    return verb !== undefined ? `az ... ${verb}` : undefined;
}

// --------------------------------------------------------------------------- #
// Kubernetes, Helm, containers
// --------------------------------------------------------------------------- #

const KUBE_WITH_VALUE: ReadonlySet<string> = new Set([
    "-n",
    "--namespace",
    "--context",
    "--kubeconfig",
    "--cluster",
    "--user",
    "-l",
    "--selector",
    "-f",
    "--filename",
    "-o",
    "--output",
    "--grace-period",
    "--timeout",
]);
const KUBE_BROAD_KINDS: ReadonlySet<string> = new Set([
    "namespace",
    "namespaces",
    "ns",
    "node",
    "nodes",
    "no",
    "pv",
    "persistentvolume",
    "persistentvolumes",
    "pvc",
    "persistentvolumeclaim",
    "persistentvolumeclaims",
    "crd",
    "crds",
    "customresourcedefinition",
    "customresourcedefinitions",
    "all",
    "clusterrole",
    "clusterrolebinding",
    "storageclass",
    "secret",
    "secrets",
]);

function kubectlDeleteBroad(command: SimpleCommand): string | undefined {
    if (!["kubectl", "oc", "k3s"].includes(command.name) || !command.args.includes("delete"))
        return undefined;
    if (kubeDryRun(command)) return undefined;
    const words = operands(command.args, KUBE_WITH_VALUE);
    const after = words.includes("delete") ? words.slice(words.indexOf("delete") + 1) : [];
    const kinds = new Set<string>();
    for (const word of after) {
        for (const kind of word.toLowerCase().split(",")) kinds.add(kind);
        kinds.add((word.split("/")[0] as string).toLowerCase());
    }
    if (
        longFlag(command.args, "--all", 5) ||
        longFlag(command.args, "--all-namespaces") ||
        shortFlag(command.args, "A") ||
        [...kinds].some((kind) => KUBE_BROAD_KINDS.has(kind))
    ) {
        return "kubectl delete (namespace/cluster-wide/--all)";
    }
    return undefined;
}

function kubeDryRun(command: SimpleCommand): boolean {
    return command.args.some((a) => a.startsWith("--dry-run") && !a.endsWith("=none"));
}

function kubectlDelete(command: SimpleCommand): string | undefined {
    if (kubeDryRun(command)) return undefined;
    if (
        (command.name === "kubectl" || command.name === "oc") &&
        operands(command.args, KUBE_WITH_VALUE).includes("delete")
    ) {
        return "kubectl delete";
    }
    const words = operands(command.args, KUBE_WITH_VALUE);
    if (command.name === "k3s" && words[0] === "kubectl" && words.slice(1).includes("delete")) {
        return "k3s kubectl delete"; // k3s runs its embedded kubectl
    }
    const verb = positionalWords(command)[0];
    if (
        command.name === "helm" &&
        verb !== undefined &&
        ["uninstall", "delete", "del", "un"].includes(verb)
    ) {
        return "helm uninstall";
    }
    return undefined;
}

function dockerPrune(command: SimpleCommand): string | undefined {
    if (command.name === "docker-compose" || command.name === "podman-compose") {
        return composeDownVolumes(command.name, command.args);
    }
    if (command.name !== "docker" && command.name !== "podman") return undefined;
    const words = positionalWords(command);
    if (words[0] === "compose") {
        return composeDownVolumes(
            `${command.name} compose`,
            command.args.slice(command.args.indexOf("compose") + 1),
        );
    }
    if (
        words[0] === "system" &&
        words[1] === "prune" &&
        (shortFlag(command.args, "a") || longFlag(command.args, ["--all", "--volumes"]))
    ) {
        return `${command.name} system prune --all/--volumes`;
    }
    const second = words[1];
    if (words[0] === "volume" && second !== undefined && ["rm", "prune", "remove"].includes(second)) {
        return `${command.name} volume ${second}`;
    }
    return undefined;
}

// Compose options before the subcommand that take a value (`-f prod.yml down`).
const COMPOSE_WITH_VALUE: ReadonlySet<string> = new Set([
    "-f",
    "--file",
    "-p",
    "--project-name",
    "--project-directory",
    "--env-file",
    "--profile",
    "--ansi",
    "--progress",
    "--parallel",
]);

/** `docker compose down -v` / `--volumes` deletes the project's volumes. */
function composeDownVolumes(name: string, args: readonly string[]): string | undefined {
    if (
        operands(args, COMPOSE_WITH_VALUE)[0] === "down" &&
        (shortFlag(args, "v") || longFlag(args, "--volumes"))
    ) {
        return `${name} down --volumes`;
    }
    return undefined;
}

// --------------------------------------------------------------------------- #
// Databases
// --------------------------------------------------------------------------- #

// A table name: plain, or quoted with "", `` or [] (which may hold spaces), schema-qualified.
const SQL_PART = String.raw`(?:"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|[^\s;."\x60\[]+)`;
const SQL_NAME = `${SQL_PART}(?:\\.${SQL_PART})*`;
// What a DELETE removes rows from, before or instead of its FROM: MySQL's
// multi-table `DELETE t1, t2.* FROM …` (PR review), after its modifiers.
const DELETE_MODIFIERS = String.raw`(?:(?:LOW_PRIORITY|QUICK|IGNORE)\s+)*`;
const DELETE_TARGETS = `${SQL_NAME}(?:\\.\\*)?(?:\\s*,\\s*${SQL_NAME}(?:\\.\\*)?)*`;
const NO_WHERE = String.raw`(?![^;]*\bWHERE\b)`;
// A DELETE is whole-table when no WHERE follows before the statement ends
// (`DELETE FROM t;`, `DELETE FROM t RETURNING id;`, `DELETE u FROM users AS u;`),
// and so is SQL Server's `DELETE t` without FROM, ending the statement.
// DROP always removes a database object. Quoted data is blanked before matching;
// matching the verb avoids an incomplete list of dialect-specific object names.
const SQL_DESTRUCTIVE = new RegExp(
    String.raw`\b(?:DROP\s+[A-Z]+\b|TRUNCATE\b` +
        String.raw`|DELETE\s+${DELETE_MODIFIERS}(?:${DELETE_TARGETS}\s+)?FROM\s+${SQL_NAME}${NO_WHERE}` +
        String.raw`|DELETE\s+(?!(?:FROM|CASCADE|RESTRICT|NO|SET|ON|TO|AS|OR|USING|TOP)\b)${SQL_NAME}\s*(?:;|$)` +
        String.raw`|ALTER\s+TABLE\s+${SQL_NAME}\s+DROP\b)`,
    "i",
);
const SQL_CLIENTS: ReadonlyMap<string, readonly string[]> = new Map([
    ["psql", ["-c", "--command"]],
    ["mysql", ["-e", "--execute", "--init-command", "--init-command-add"]],
    ["mariadb", ["-e", "--execute", "--init-command"]],
    ["sqlite3", []],
    ["duckdb", ["-c"]],
    ["clickhouse-client", ["-q", "--query"]],
    ["cockroach", ["-e", "--execute"]],
    ["sqlcmd", ["-Q", "-q"]],
]);
const NOSQL = /\b(?:dropDatabase|FLUSHALL|FLUSHDB)\b|\.drop\(\s*\)|\bdeleteMany\(\s*\{\s*\}\s*\)/i;

/** A file the client opens itself, as written on the line or on disk. */
function commandFile(
    path: string,
    command: SimpleCommand,
    ctx: RuleContext,
): Promise<ClientInput | undefined> {
    return readFile(path, command.possibleCwds, ctx.parsed.writtenFiles, ctx.host);
}

// sqlite3 options that take a value (so it is not read as the database or SQL).
const SQLITE_WITH_VALUE: ReadonlySet<string> = new Set([
    "-init",
    "--init",
    "-cmd",
    "--cmd",
    "-separator",
    "--separator",
    "-newline",
    "--newline",
    "-nullvalue",
    "--nullvalue",
    "-vfs",
    "--vfs",
    "-maxsize",
    "--maxsize",
    "-mmap",
    "--mmap",
    "-pagecache",
    "-lookaside",
]);

async function sqlTexts(command: SimpleCommand, ctx: RuleContext): Promise<ClientInput[]> {
    const flags = SQL_CLIENTS.get(command.name);
    if (flags === undefined) {
        if (command.name === "mongosh" || command.name === "mongo") {
            return command.args
                .filter((_, i) => i > 0 && command.args[i - 1] === "--eval")
                .map((a) => clientInput(a, true));
        }
        if (command.name === "redis-cli") return [clientInput(command.args.join(" "), true)];
        return [];
    }
    const texts = optionValues(command.args, flags, GETOPT_CLIENTS.has(command.name));
    // `psql -f q.sql`, `sqlite3 -init q.sql`, `sqlcmd -i q.sql`: a file of statements,
    // as written on the line or on disk.
    const files: ClientInput[] = [];
    for (const value of fileOptionValues(command.name, command.args)) {
        const file = await commandFile(value, command, ctx);
        if (file) files.push(file);
    }
    if (command.name === "sqlite3") {
        // `-cmd SQL` runs a statement before the rest.
        command.args.slice(0, -1).forEach((a, i) => {
            if (a === "-cmd" || a === "--cmd") texts.push(command.args[i + 1] as string);
        });
        texts.push(...operands(command.args, SQLITE_WITH_VALUE).slice(1));
    }
    texts.push(
        ...command.redirects
            .filter((r) => r.op === "<<" || r.op === "<<-" || r.op === "<<<")
            .map((r) => r.body || r.target),
    );
    const inputs: ClientInput[] = [...texts.map((text) => clientInput(text, true)), ...files];
    // `sqlite3 db < q.sql`: the file, as written earlier on the line or as on disk.
    for (const redirect of command.redirects) {
        if (redirect.op === "<" && !redirect.dynamic) {
            const entry = await commandFile(redirect.target, command, ctx);
            // The client sees stdin, not the filename: psql's \ir uses its cwd.
            if (entry) inputs.push(clientInput(entry.text, entry.typed));
        }
    }
    // `printf 'DROP TABLE t;' | sqlite3 db`, `cat <<SQL | psql`: statements piped in.
    const source = await knownStdin(command, ctx.parsed, undefined, ctx.host);
    if (source !== undefined) inputs.push(source);
    // `.read q.sql`, `\i q.sql`, `source q.sql`: files the statements include (PR review).
    // Only a file the client opened itself has a directory for psql's `\ir`; on stdin it is the cwd's.
    inputs.push(
        ...(await included(
            command.name,
            inputs,
            command.possibleCwds,
            ctx.parsed.writtenFiles,
            undefined,
            ctx.host,
        )),
    );
    return inputs;
}

// MySQL `/*! … */` and `/*!80000 … */`, MariaDB `/*M! … */`: comments the server
// executes (when it is at least that version) (PR review).
const EXECUTABLE_COMMENT = /\/\*M?!\d*/y;
// PostgreSQL dollar quoting: `$$` or `$tag$`, where a tag cannot start with a digit (`$1` is a parameter).
const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

// A string literal the database runs as SQL rather than keeps as data, by what
// precedes it: PostgreSQL `DO 'code'` / `DO LANGUAGE l $$code$$`, a function or
// procedure body (`CREATE FUNCTION … AS 'code'`), PL/pgSQL `EXECUTE 'code'` and
// `EXECUTE format('code', …)`, `EXECUTE IMMEDIATE`, MySQL `PREPARE s FROM 'code'`,
// SQL Server `EXEC('code')` and `sp_executesql N'code'` (PR review). An `N`/`E`
// prefix belongs to the literal.
const EXECUTED_STRING =
    /(?:\bDO(?:\s+LANGUAGE\s+\w+)?|\bEXEC(?:UTE)?(?:\s+IMMEDIATE)?(?:\s*\(|\s+format\s*\()?|\bPREPARE\s+\S+\s+FROM|\bsp_executesql|\b(?:FUNCTION|PROCEDURE)\b[^;]*\bAS)\s*[NE]?$/i;
const EXECUTED_LOOKBACK = 400; // characters of the statement so far that decide it
const MAX_EXECUTED_DEPTH = 4; // code inside code inside code ...

function executesNextString(out: string[]): boolean {
    return EXECUTED_STRING.test(out.join("").slice(-EXECUTED_LOOKBACK));
}

/** `regex.match(text, index)`: a sticky match at `index`, or undefined. */
function matchAt(regex: RegExp, text: string, index: number): RegExpExecArray | undefined {
    regex.lastIndex = index;
    return regex.exec(text) ?? undefined;
}

/**
 * The text of the `'…'` literal opening at `start`, unescaped (`''` and,
 * for MySQL, `\'`), and the index after it. Unterminated: to the end.
 */
function quotedBody(sql: string, start: number, backslashEscapes: boolean): [string, number] {
    const body: string[] = [];
    let index = start + 1;
    while (index < sql.length) {
        const char = sql[index] as string;
        if (backslashEscapes && char === "\\" && index + 1 < sql.length) {
            body.push(sql[index + 1] as string);
            index += 2;
        } else if (char === "'" && sql.startsWith("''", index)) {
            body.push("'");
            index += 2;
        } else if (char === "'") {
            return [body.join(""), index + 1];
        } else {
            body.push(char);
            index += 1;
        }
    }
    return [body.join(""), index];
}

/**
 * `sql` with `-- ...` and `/* ... *\/` comments blanked, outside quoted
 * strings and identifiers ('', "", ``, []): in `SELECT '--'; DROP TABLE t`
 * the `--` is data. `backslashEscapes`: inside a string `\'` does not end it,
 * as in MySQL; standard SQL (SQLite, PostgreSQL) treats the backslash as text.
 * The MySQL reading also ends a line at `#` and keeps the body of an
 * executable comment (`/*! DROP TABLE t *\/`, `/*!50000 …*\/`, MariaDB's
 * `/*M!100100 …*\/`), which the server runs; the standard one quotes
 * PostgreSQL's `$tag$ ... $tag$` (in `SELECT $$--$$; DROP TABLE t` the `--` is data).
 * `blankQuoted`: quoted text is blanked too, keeping its quotes, except a
 * string the database runs as SQL (EXECUTED_STRING), whose body is read as
 * statements in turn.
 */
function withoutComments(sql: string, backslashEscapes = false, blankQuoted = false, depth = 0): string {
    const out: string[] = [];
    let index = 0;
    let quote = "";
    let executable = false;
    while (index < sql.length) {
        const char = sql[index] as string;
        if (quote) {
            if (
                backslashEscapes &&
                char === "\\" &&
                (quote === "'" || quote === '"') &&
                index + 1 < sql.length
            ) {
                out.push(blankQuoted ? "  " : sql.slice(index, index + 2));
                index += 2;
                continue;
            }
            if (char === quote) {
                quote = "";
            } else if (blankQuoted) {
                out.push(" ");
                index += 1;
                continue;
            }
        } else if (char === "'" && blankQuoted && depth < MAX_EXECUTED_DEPTH && executesNextString(out)) {
            const [body, next] = quotedBody(sql, index, backslashEscapes);
            out.push(` ${withoutComments(body, backslashEscapes, true, depth + 1)} `);
            index = next;
            continue;
        } else if (char === "'" || char === '"' || char === "`" || char === "[") {
            quote = char === "[" ? "]" : char; // `[name]` quotes an identifier (SQLite, SQL Server)
        } else if (char === "$" && !backslashEscapes && matchAt(DOLLAR_TAG, sql, index)) {
            const tag = matchAt(DOLLAR_TAG, sql, index) as RegExpExecArray;
            const delimiter = tag[0];
            const tagEnd = index + delimiter.length;
            const close = sql.indexOf(delimiter, tagEnd);
            const end = close < 0 ? sql.length : close + delimiter.length; // unterminated: quoted to the end
            if (blankQuoted && depth < MAX_EXECUTED_DEPTH && executesNextString(out)) {
                const body = sql.slice(tagEnd, close < 0 ? sql.length : close);
                out.push(` ${withoutComments(body, backslashEscapes, true, depth + 1)} `);
            } else if (blankQuoted) {
                const closing = close < 0 ? "" : delimiter;
                out.push(delimiter + " ".repeat(end - tagEnd - closing.length) + closing);
            } else {
                out.push(sql.slice(index, end));
            }
            index = end;
            continue;
        } else if (sql.startsWith("--", index) || (char === "#" && backslashEscapes)) {
            const end = sql.indexOf("\n", index);
            index = end < 0 ? sql.length : end;
            out.push(" ");
            continue;
        } else if (backslashEscapes && matchAt(EXECUTABLE_COMMENT, sql, index)) {
            const opening = matchAt(EXECUTABLE_COMMENT, sql, index) as RegExpExecArray;
            executable = true; // its body is SQL: scanned as such, up to its `*/`
            index += opening[0].length;
            out.push(" ");
            continue;
        } else if (executable && sql.startsWith("*/", index)) {
            executable = false;
            index += 2;
            out.push(" ");
            continue;
        } else if (sql.startsWith("/*", index)) {
            const end = sql.indexOf("*/", index + 2);
            index = end < 0 ? sql.length : end + 2;
            out.push(" ");
            continue;
        }
        out.push(char);
        index += 1;
    }
    return out.join("");
}

async function destructiveSql(command: SimpleCommand, ctx: RuleContext): Promise<MatchDetail | undefined> {
    // A directly typed destructive statement takes precedence over an indirect file match.
    const entries = (await sqlTexts(command, ctx)).sort((a, b) => Number(!a.typed) - Number(!b.typed));
    const mysql = command.name === "mysql" || command.name === "mariadb";
    const nosql = ["mongo", "mongosh", "redis-cli"].includes(command.name);
    for (const entry of entries) {
        // `DELETE FROM users -- all rows` still deletes every row: match without comments,
        // reading MySQL strings both with and without NO_BACKSLASH_ESCAPES.
        let match: RegExpExecArray | null = null;
        for (const backslashEscapes of mysql ? [false, true] : [false]) {
            // A `WHERE` inside a literal (`DELETE FROM t RETURNING 'WHERE'`) is data:
            // Blank quoted contents so data such as SELECT 'DROP TABLE users' is harmless.
            const unquoted = withoutComments(entry.text, backslashEscapes, true);
            match = SQL_DESTRUCTIVE.exec(unquoted);
            if (nosql) match = match || NOSQL.exec(withoutComments(entry.text, backslashEscapes));
            if (match) break;
        }
        if (match) return matchDetail(`${command.name}: ${match[0].trim()}`, !entry.typed);
    }
    return undefined;
}

function databaseDropTools(command: SimpleCommand): string | undefined {
    if (command.name === "dropdb" || command.name === "dropuser") return command.name;
    if (
        (command.name === "mysqladmin" || command.name === "mariadb-admin") &&
        command.args.some((a) => a === "drop" || a === "flush-tables")
    ) {
        return `${command.name} drop`;
    }
    return undefined;
}

const INFRA_HINT =
    "This deletes infrastructure or data that is not in version control. Show the user the " +
    "exact command and target and let them run it, or use the tool's dry-run/plan mode first.";

export const INFRA_RULES: readonly DangerRule[] = [
    dangerRule(
        "terraform-destroy",
        HIGH,
        "destroys managed infrastructure or state",
        `${INFRA_HINT} (\`terraform plan -destroy\`)`,
        terraform,
    ),
    dangerRule("aws-delete", HIGH, "deletes AWS resources", INFRA_HINT, aws),
    dangerRule("gcloud-delete", HIGH, "deletes Google Cloud resources", INFRA_HINT, gcloud),
    dangerRule("az-delete", HIGH, "deletes Azure resources", INFRA_HINT, az),
    dangerRule(
        "kubectl-delete-broad",
        HIGH,
        "deletes a namespace, cluster-scoped objects or everything matching",
        `${INFRA_HINT} (\`kubectl delete --dry-run=server\`)`,
        kubectlDeleteBroad,
    ),
    dangerRule(
        "docker-prune-volumes",
        HIGH,
        "deletes container volumes and their data",
        INFRA_HINT,
        dockerPrune,
    ),
    dangerRule(
        "sql-destructive",
        HIGH,
        "drops or truncates database objects or data",
        INFRA_HINT,
        destructiveSql,
    ),
    dangerRule("db-drop-tool", HIGH, "drops a database or user", INFRA_HINT, databaseDropTools),
    // Broad delete verbs the tables above do not scope: worth a human look.
    dangerRule("cloud-delete", HIGH, "a cloud CLI delete/terminate verb", INFRA_HINT, awsGeneric, "ask"),
    dangerRule("gcloud-delete-other", HIGH, "a gcloud delete/destroy verb", INFRA_HINT, gcloudGeneric, "ask"),
    dangerRule("az-delete-other", HIGH, "an az delete/purge verb", INFRA_HINT, azGeneric, "ask"),
    dangerRule(
        "kubectl-delete",
        HIGH,
        "deletes Kubernetes resources or a Helm release",
        INFRA_HINT,
        kubectlDelete,
        "ask",
    ),
];
