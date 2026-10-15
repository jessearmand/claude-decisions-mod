import type { Register } from "claude-code";

// Wave 3 replaces this stub with the guard chain; see docs/PORTING.md.
export const register: Register = (on) => {
    on("session.start", (_$, e, next) => next(e));
};
