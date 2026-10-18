import { describe, expect, it } from "vitest";
import { onceEach } from "./notices.ts";

describe("onceEach", () => {
    it("shows each distinct message once", () => {
        const shown: string[] = [];
        const notify = onceEach((message) => shown.push(message));
        notify("model not found");
        notify("model not found");
        notify("timed out");
        expect(shown).toEqual(["model not found", "timed out"]);
    });

    it("remembers across callers that share the set", () => {
        const seen = new Set<string>();
        const first: string[] = [];
        const second: string[] = [];
        onceEach((message) => first.push(message), seen)("a");
        onceEach((message) => second.push(message), seen)("a");
        expect(first).toEqual(["a"]);
        expect(second).toEqual([]);
    });
});
