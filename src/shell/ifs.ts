/**
 * Field splitting by IFS, as bash does it for unquoted expansions and `read`.
 *
 * `IFS=,; X=rm,-rf,/; $X` runs `rm -rf /`, and `IFS=x read A B <<< rxm` sets
 * A=r, B=m. Whitespace characters in IFS collapse and are trimmed at both ends;
 * any other IFS character ends a field on its own, taking the IFS whitespace
 * around it along. An empty IFS does not split at all.
 *
 * Ported from shell_ifs.py.
 */

import { rstripChars, stripChars } from "../util/text.ts";

export const DEFAULT = " \t\n";
const WHITESPACE = " \t\n";

/**
 * The fields of `text`. With `maxFields` (as `read` with that many names),
 * the last field keeps the rest of the text, less trailing IFS whitespace.
 */
export function split(text: string, ifs: string = DEFAULT, maxFields?: number): string[] {
    if (ifs === "") return text ? [text] : [];
    const space = [...ifs].filter((c) => WHITESPACE.includes(c)).join("");
    const stripped = space ? stripChars(text, space) : text;
    const fields: string[] = [];
    let start = 0;
    let index = 0;
    while (index < stripped.length) {
        if (maxFields !== undefined && fields.length === maxFields - 1) {
            return [...fields, lastField(stripped.slice(start), ifs, space)];
        }
        if (ifs.includes(stripped[index] as string)) {
            fields.push(stripped.slice(start, index));
            start = index = delimiterEnd(stripped, index, ifs, space);
        } else {
            index += 1;
        }
    }
    if (start < stripped.length) fields.push(stripped.slice(start));
    return fields;
}

/**
 * Where the delimiter starting at `index` ends: IFS whitespace around at
 * most one other IFS character.
 */
function delimiterEnd(text: string, start: number, ifs: string, space: string): number {
    let otherSeen = !space.includes(text[start] as string);
    let index = start + 1;
    while (index < text.length && ifs.includes(text[index] as string)) {
        if (!space.includes(text[index] as string)) {
            if (otherSeen) break; // `a,,b`: the second comma starts an empty field's end
            otherSeen = true;
        }
        index += 1;
    }
    return index;
}

/**
 * What `read`'s last name gets: the rest of the line, less trailing IFS
 * whitespace; a rest that is one field and a closing delimiter (`b,`) is
 * just that field.
 */
function lastField(text: string, ifs: string, space: string): string {
    const rest = space ? rstripChars(text, space) : text;
    let index = 0;
    while (index < rest.length && !ifs.includes(rest[index] as string)) index += 1;
    if (index < rest.length && delimiterEnd(rest, index, ifs, space) === rest.length)
        return rest.slice(0, index);
    return rest;
}
