import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KNOWN_ENV_NAMES } from "./host.ts";

describe("engine host environment snapshot", () => {
    it("reads every known environment name with a literal $.env.get call", () => {
        const source = readFileSync(new URL("./engine-host.ts", import.meta.url), "utf-8");
        for (const name of KNOWN_ENV_NAMES) {
            expect(source, `missing $.env.get("${name}")`).toContain(`$.env.get("${name}")`);
        }
        const literal = [...source.matchAll(/\$\.env\.get\("([A-Z_]+)"\)/g)].map((match) => match[1]);
        expect(new Set(literal)).toEqual(new Set(KNOWN_ENV_NAMES));
    });
});
