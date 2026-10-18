/**
 * The matcher shared by bash patterns and Python's fnmatch once each is read
 * into tokens: `*` matches any run of characters, every other token exactly one.
 *
 * Backtracking on every `*` (or a regular expression of `.*` pieces) takes time
 * exponential in the number of stars: `*a*a*a…b` against a run of `a` stalls the
 * hook before the tool runs. Only the most recent `*` ever needs to be retried,
 * since every token after it matches a fixed length, so the walk below remembers
 * that one star and is bounded by text length times pattern length.
 */

/** One position of a pattern: a `*`, or a test on exactly one character. */
export type WildcardToken =
    | { readonly star: true }
    | { readonly star: false; readonly test: (char: string) => boolean };

export const STAR: WildcardToken = { star: true };

/** A token matching exactly `char`. */
export function literal(char: string): WildcardToken {
    return { star: false, test: (candidate) => candidate === char };
}

/** A token matching any one character. */
export const ANY: WildcardToken = { star: false, test: () => true };

/** Whether all of `text` (code points) matches `tokens`. */
export function wildcardMatch(text: readonly string[], tokens: readonly WildcardToken[]): boolean {
    let t = 0;
    let p = 0;
    let starAt = -1; // the token index just after the last `*` seen
    let starText = 0; // where the text stood when that `*` was last retried
    while (t < text.length) {
        const token = tokens[p];
        if (token?.star) {
            p += 1;
            starAt = p;
            starText = t;
        } else if (token !== undefined && token.test(text[t] as string)) {
            p += 1;
            t += 1;
        } else if (starAt >= 0) {
            // Let the last `*` swallow one more character and retry what follows it.
            starText += 1;
            t = starText;
            p = starAt;
        } else {
            return false;
        }
    }
    while (tokens[p]?.star) p += 1;
    return p === tokens.length;
}
