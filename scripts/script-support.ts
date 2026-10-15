/**
 * What the two benchmark scripts share: hand-rolled argv parsing (no
 * dependencies), a bounded worker pool standing in for Python's
 * ThreadPoolExecutor, column padding for the reports, and a Config with
 * another decision model.
 */

import type { Config } from "../src/config.ts";

/** `--name value` and `--name=value` pairs; a flag without a value is "". */
export function parseArgs(argv: readonly string[]): Record<string, string> {
    const args: Record<string, string> = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i] ?? "";
        if (!arg.startsWith("--")) continue;
        const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
        if (name === undefined || name === "") continue;
        if (inline !== undefined) {
            args[name] = inline;
            continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
            args[name] = next;
            i += 1;
        } else {
            args[name] = "";
        }
    }
    return args;
}

export function numberArg(args: Record<string, string>, name: string, fallback: number): number {
    const value = args[name];
    if (value === undefined || value.trim() === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`--${name} expects a number, got ${JSON.stringify(value)}`);
    return parsed;
}

/** `Promise.all` with at most `workers` calls in flight; results keep the input order. */
export async function mapPool<T, R>(
    items: readonly T[],
    workers: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await fn(items[index] as T, index);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, worker));
    return results;
}

/** Python `f"{text:<width}"`. */
export function pad(text: string, width: number): string {
    return text.padEnd(width);
}

/** Python `f"{text:>width}"`. */
export function padLeft(text: string, width: number): string {
    return text.padStart(width);
}

export function rate(numerator: number, denominator: number): string {
    return denominator ? `${numerator}/${denominator}` : "-";
}

/** The same configuration with another decision model. */
export function withModel(config: Config, model: string | undefined): Config {
    return model ? { ...config, judge: { ...config.judge, model } } : config;
}
