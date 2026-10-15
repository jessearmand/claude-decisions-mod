/** The REDACTIONS corpus of bash_risk_judge_test.py, plus the context tests' redaction expectations. */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the commands under test spell shell parameter expansions

import { describe, expect, it } from "vitest";
import { quotedSpans, REDACTED, redact } from "./redact.ts";

// Stands in for the secret half of a credential, built at run time so scanners do not flag the fixture.
const PLACEHOLDER = "z".repeat(12);

const REDACTIONS: Array<[string, string]> = [
    ["password: correct horse battery staple", "password: <redacted>"],
    ["password = correct horse battery staple", "password = <redacted>"],
    ["passphrase: several secret words\nnext line", "passphrase: <redacted>\nnext line"],
    // No-space `=` is the same prose when the value is a multi-word passphrase.
    // An env-style assignment keeps the command after its single token, and a
    // single trailing word stays that command. PASSWORD_FILE is where, not what.
    ["password=correct horse battery staple", "password=<redacted>"],
    ["password=correct horse battery staple for user42", "password=<redacted>"],
    ["Here is my password=correct horse battery staple", "Here is my password=<redacted>"],
    [
        "Here is my password=correct horse battery staple\nnext line",
        "Here is my password=<redacted>\nnext line",
    ],
    ["password=secret cmd", "password=<redacted> cmd"],
    ["PASSWORD_FILE=/path", "PASSWORD_FILE=/path"],
    ["password: $PASSWORD", "password: $PASSWORD"],
    ["curl -H 'Authorization: Bearer abc.def-123' x", "curl -H 'Authorization: Bearer <redacted>' x"],
    ["export API_KEY=supersecretvalue123", "export API_KEY=<redacted>"],
    // Private key blocks, whole or cut off by the source budget (PR review).
    [
        "KEY='-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----'; echo ok",
        "KEY='<redacted private key>'; echo ok",
    ],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA", "<redacted private key>"],
    // Basic-auth credentials (PR review).
    [`curl -u alice:${PLACEHOLDER} https://example.com`, "curl -u alice:<redacted> https://example.com"],
    [`curl https://alice:${PLACEHOLDER}@example.com/x`, "curl https://alice:<redacted>@example.com/x"],
    [`curl --user=bob:${PLACEHOLDER} x`, "curl --user=bob:<redacted> x"],
    // Quoted JSON/dict keys (PR review).
    [`{"api_key":"${PLACEHOLDER}"}`, '{"api_key":"<redacted>"}'],
    [`{'token': '${PLACEHOLDER}'}`, "{'token': '<redacted>'}"],
    [`{"token": "${PLACEHOLDER} with spaces"}`, '{"token": "<redacted>"}'], // the whole quoted value
    [`curl -u 'alice:${PLACEHOLDER} with spaces' x`, "curl -u 'alice:<redacted>' x"],
    [`curl -u "alice:a\\"${PLACEHOLDER} more" x`, 'curl -u "alice:<redacted>" x'], // an escaped quote (PR review)
    [`{"token":"a\\"${PLACEHOLDER} more"}`, '{"token":"<redacted>"}'], // an escaped quote does not end it
    // An auth scheme inside a quoted value, and credential terms inside longer names (PR review).
    [`{"authorization":"Basic ${PLACEHOLDER}"}`, '{"authorization":"Basic <redacted>"}'],
    [`{'Authorization': 'Bearer ${PLACEHOLDER}'}`, "{'Authorization': 'Bearer <redacted>'}"],
    [`AWS_SECRET_ACCESS_KEY=${PLACEHOLDER} aws s3 ls`, "AWS_SECRET_ACCESS_KEY=<redacted> aws s3 ls"],
    [`{"aws_secret_access_key": "${PLACEHOLDER}"}`, '{"aws_secret_access_key": "<redacted>"}'],
    ["PASSWORD_FILE=/run/secrets/db ./start", "PASSWORD_FILE=/run/secrets/db ./start"], // where, not what
    ["kubectl --token-file=/var/run/t get pods", "kubectl --token-file=/var/run/t get pods"],
    ["ssh user@host", "ssh user@host"],
    [
        "gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123",
        "gh auth login --with-token <redacted>",
    ],
    ["rm -rf build", "rm -rf build"],
    // References and substitutions are not literals. Redacting them used to turn
    // `TOKEN=$(cat ~/.netrc)` into `TOKEN=<redacted> ~/.netrc)`: broken syntax
    // that hid the credential read from the model and scored a false negative.
    ["export TOKEN=$(cat ~/.netrc)", "export TOKEN=$(cat ~/.netrc)"],
    ['API_KEY="$(op read op://vault/item)"', 'API_KEY="$(op read op://vault/item)"'],
    ["password=`cat p.txt`", "password=`cat p.txt`"],
    ['curl -H "Authorization: Bearer $GH_TOKEN" x', 'curl -H "Authorization: Bearer $GH_TOKEN" x'],
    ["mysql --password=<(pass show db)", "mysql --password=<(pass show db)"],
    // A shell quote that opens before the key holds the whole value (PR review):
    // the value runs to the closing quote, not the first space.
    [
        `curl -H 'X-Api-Key: ${PLACEHOLDER} horse battery' https://x`,
        "curl -H 'X-Api-Key: <redacted>' https://x",
    ],
    [`curl -H "Authorization: Token ${PLACEHOLDER} more" x`, 'curl -H "Authorization: Token <redacted>" x'],
    [`curl --header 'Cookie: session=${PLACEHOLDER}; other=1' x`, "curl --header 'Cookie: <redacted>' x"],
    [`curl -d 'user=bob&password=${PLACEHOLDER} two&x=1' x`, "curl -d 'user=bob&password=<redacted>' x"],
    [`bash -c "curl -H 'X-Api-Key: ${PLACEHOLDER} b' x"`, "bash -c \"curl -H 'X-Api-Key: <redacted>' x\""],
    [`"password=${PLACEHOLDER} it's more"`, '"password=<redacted>"'], // `'` is literal inside "…"
    [`it\\'s -H 'X-Api-Key: ${PLACEHOLDER} b'`, "it\\'s -H 'X-Api-Key: <redacted>'"], // `\'` opens no quote
    [`curl --header=X-Api-Key:\\ ${PLACEHOLDER}\\ b x`, "curl --header=X-Api-Key:<redacted> x"],
    [
        'curl -H "Authorization: Bearer $GH_TOKEN" -H "X-Api-Key: ${KEY}" x',
        'curl -H "Authorization: Bearer $GH_TOKEN" -H "X-Api-Key: ${KEY}" x',
    ],
    ["git commit -m 'rotate token handling'", "git commit -m 'rotate token <redacted>'"], // bare rule, as before
    // Credential names beyond token/secret/password, and webhook URLs (PR review).
    [`GITHUB_PAT=${PLACEHOLDER} gh auth status`, "GITHUB_PAT=<redacted> gh auth status"],
    [
        `export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T0/B0/${PLACEHOLDER}`,
        "export SLACK_WEBHOOK_URL=<redacted>",
    ],
    [
        `curl -X POST https://hooks.slack.com/services/T0/B0/${PLACEHOLDER} -d '{}'`,
        "curl -X POST https://hooks.slack.com/services/<redacted> -d '{}'",
    ],
    [
        `curl https://discord.com/api/webhooks/1234/${PLACEHOLDER}`,
        "curl https://discord.com/api/webhooks/<redacted>",
    ],
    [
        `AWS_ACCESS_KEY_ID=AKIA${PLACEHOLDER.toUpperCase()}1234 aws sts get-caller-identity`,
        "AWS_ACCESS_KEY_ID=<redacted> aws sts get-caller-identity",
    ],
    [`{"credentials": "${PLACEHOLDER}"}`, '{"credentials": "<redacted>"}'],
    [`http --auth user:${PLACEHOLDER} :8000`, "http --auth user:<redacted> :8000"],
    ["gh auth login --web", "gh auth login --web"],
    [`SIGNING_KEY=${PLACEHOLDER} make release`, "SIGNING_KEY=<redacted> make release"],
    [`gh auth login --with-token github_pat_${PLACEHOLDER}AbCd`, "gh auth login --with-token <redacted>"],
    ["PATH=/usr/bin:$PATH make", "PATH=/usr/bin:$PATH make"], // not a PAT
    ["grep -r PATTERN=foo src/", "grep -r PATTERN=foo src/"],
    ["python -c 'import expat'", "python -c 'import expat'"],
    ["CREDENTIALS_FILE=/run/creds ./app", "CREDENTIALS_FILE=/run/creds ./app"], // where, not what
    ["git log --author=me", "git log --author=me"],
];

describe("redact", () => {
    it.each(REDACTIONS)("redact(%j) -> %j", (raw, expected) => {
        expect(redact(raw)).toBe(expected);
    });

    it("is idempotent on its own output", () => {
        for (const [raw] of REDACTIONS) {
            const once = redact(raw);
            expect(redact(once)).toBe(once);
        }
    });

    // What the context tests of bash_risk_judge_test.py expected of the model payload.
    it("redacts a token in the user's prompt", () => {
        const text = redact("token=hunter2hunter2 please");
        expect(text).not.toContain("hunter2");
        expect(text).toContain(REDACTED);
    });

    it("redacts no-space prose secrets and keeps a PASSWORD_FILE path", () => {
        const text = redact("Here is my password=correct horse battery staple\nPASSWORD_FILE=/path");
        for (const word of ["correct", "horse", "battery", "staple"]) expect(text).not.toContain(word);
        expect(text).toContain("PASSWORD_FILE=/path");
    });

    it("redacts a PAT in a prompt and a webhook URL in an earlier command", () => {
        const prompt = redact(`Use GITHUB_PAT=${PLACEHOLDER}pat1 for the API`);
        const command = redact(
            `export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T0/B0/${PLACEHOLDER}hook`,
        );
        expect(prompt).not.toContain(`${PLACEHOLDER}pat1`);
        expect(command).not.toContain(`${PLACEHOLDER}hook`);
        expect(prompt).toContain(REDACTED);
        expect(command).toContain(REDACTED);
    });
});

describe("quotedSpans", () => {
    it("finds top-level quoted regions, quotes excluded", () => {
        expect([...quotedSpans(`a 'b c' "d" e`)]).toEqual([
            [3, 6],
            [9, 10],
        ]);
    });

    it("treats a backslash outside quotes as an escape", () => {
        expect([...quotedSpans("it\\'s 'x'")]).toEqual([[7, 8]]);
    });

    it("honours escapes inside double and $'' quotes but not single quotes", () => {
        expect([...quotedSpans(`"a\\"b" $'c\\'d' 'e\\'`)]).toEqual([
            [1, 5],
            [9, 13],
            [16, 18],
        ]);
    });

    it("runs an unterminated quote to the end of the text", () => {
        expect([...quotedSpans("x 'abc")]).toEqual([[3, 6]]);
    });
});
