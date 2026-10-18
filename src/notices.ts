/**
 * Notices a guard raises for the user (GuardDeps.notify), shown once each.
 *
 * A failure such as a wrong model id repeats on every tool call; the user
 * needs to read it once, not on every command.
 */

/** `show`, called at most once for each distinct message. */
export function onceEach(
    show: (message: string) => void,
    shown: Set<string> = new Set(),
): (message: string) => void {
    return (message) => {
        if (shown.has(message)) return;
        shown.add(message);
        show(message);
    };
}
