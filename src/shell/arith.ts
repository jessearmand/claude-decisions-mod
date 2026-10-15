/**
 * Bash integer arithmetic, as in array subscripts and `$((...))`.
 *
 * Evaluates the operators bash's arithmetic supports, with its precedence and
 * 64-bit wrapping: `X[1&1]`, `X[i<<1]`, `X[n?1:0]`. A variable named in the
 * expression is itself evaluated as arithmetic, as bash does. Anything not
 * modelled (an assignment, an unknown variable, a malformed expression) gives
 * undefined, so callers treat the value as unknown.
 *
 * Values are `bigint` so the 64-bit wrap-around is exact.
 *
 * Ported from shell_arith.py.
 */

const TOKEN =
    /\s*(?:(?<number>0[xX][0-9a-fA-F]+|\d+#[0-9A-Za-z@_]+|\d+)|(?<name>\$?\{?[A-Za-z_][A-Za-z0-9_]*\}?)|(?<op>\*\*|<<|>>|<=|>=|==|!=|&&|\|\||\+\+|--|[-+*/%<>&|^!~?:(),=]))/y;
// Binary operators by precedence, loosest first (`?:` and `,` are handled apart).
const BINARY: ReadonlyArray<readonly string[]> = [
    ["||"],
    ["&&"],
    ["|"],
    ["^"],
    ["&"],
    ["==", "!="],
    ["<", "<=", ">", ">="],
    ["<<", ">>"],
    ["+", "-"],
    ["*", "/", "%"],
];
const MAX_DEPTH = 8;
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ@_";
const MASK_64 = (1n << 64n) - 1n;

/** A variable's value, or undefined when it is not known. */
export type Lookup = (name: string) => string | undefined;

class UnsupportedArithmetic extends Error {}

type TokenKind = "number" | "name" | "op";
type ArithToken = readonly [kind: TokenKind, text: string];

/** The value of `expression`, or undefined when it is not known. */
export function evaluate(expression: string, lookup: Lookup, depth = 0): bigint | undefined {
    try {
        const tokens = tokenize(expression);
        const parser = new Parser(tokens, lookup, depth);
        const value = parser.comma();
        if (parser.index !== tokens.length) return undefined;
        return value;
    } catch {
        // Python caught _Unsupported, ZeroDivisionError, RecursionError and ValueError.
        return undefined;
    }
}

function tokenize(expression: string): ArithToken[] {
    const text = expression.replaceAll("$((", "(("); // `$((n))` inside a subscript: parentheses
    const tokens: ArithToken[] = [];
    let index = 0;
    while (index < text.length) {
        if (text.slice(index).trim() === "") break;
        TOKEN.lastIndex = index;
        const match = TOKEN.exec(text);
        if (!match || TOKEN.lastIndex === index) throw new UnsupportedArithmetic(text.slice(index));
        const groups = match.groups ?? {};
        const kind: TokenKind =
            groups.number !== undefined ? "number" : groups.name !== undefined ? "name" : "op";
        tokens.push([kind, groups[kind] as string]);
        index = TOKEN.lastIndex;
    }
    return tokens;
}

/** Bash arithmetic is 64-bit signed. */
function wrap(value: bigint): bigint {
    return BigInt.asIntN(64, value);
}

/** Python `int(text, base)`: every character must be a digit of the base. */
function parseDigits(digits: string, base: number, original: string): bigint {
    if (digits === "") throw new UnsupportedArithmetic(original);
    let value = 0n;
    for (const char of digits) {
        const digit = ALPHABET.indexOf(char);
        if (digit < 0 || digit >= base) throw new UnsupportedArithmetic(original);
        value = value * BigInt(base) + BigInt(digit);
    }
    return value;
}

function number(text: string): bigint {
    if (text.toLowerCase().startsWith("0x")) return parseDigits(text.slice(2).toLowerCase(), 16, text);
    if (text.includes("#")) {
        const [baseText, digits] = text.split("#", 2) as [string, string];
        const base = Number(baseText);
        if (!(base >= 2 && base <= 64)) throw new UnsupportedArithmetic(text);
        return parseDigits(base <= 36 ? digits.toLowerCase() : digits, base, text);
    }
    if (text.length > 1 && text.startsWith("0")) return parseDigits(text, 8, text);
    return parseDigits(text, 10, text);
}

class Parser {
    index = 0;
    constructor(
        private readonly tokens: readonly ArithToken[],
        private readonly lookup: Lookup,
        private readonly depth: number,
    ) {}

    private peek(): string | undefined {
        const token = this.tokens[this.index];
        return token !== undefined && token[0] === "op" ? token[1] : undefined;
    }

    private take(op: string): void {
        if (this.peek() !== op) throw new UnsupportedArithmetic(op);
        this.index += 1;
    }

    comma(): bigint {
        let value = this.ternary();
        while (this.peek() === ",") {
            this.index += 1;
            value = this.ternary();
        }
        return value;
    }

    ternary(): bigint {
        const condition = this.binary(0);
        if (this.peek() !== "?") {
            if (this.peek() === "=") throw new UnsupportedArithmetic("assignment");
            return condition;
        }
        this.index += 1;
        const yes = this.comma();
        this.take(":");
        const no = this.ternary();
        return condition !== 0n ? yes : no;
    }

    binary(level: number): bigint {
        if (level === BINARY.length) return this.power();
        let left = this.binary(level + 1);
        const operators = BINARY[level] as readonly string[];
        for (let op = this.peek(); op !== undefined && operators.includes(op); op = this.peek()) {
            this.index += 1;
            const right = this.binary(level + 1);
            left = apply(op, left, right);
        }
        return left;
    }

    power(): bigint {
        const base = this.unary();
        if (this.peek() === "**") {
            this.index += 1;
            const exponent = this.power();
            if (exponent < 0n) throw new UnsupportedArithmetic("negative exponent");
            return wrap(modPow(base, exponent));
        }
        return base;
    }

    unary(): bigint {
        const op = this.peek();
        if (op === "++" || op === "--") throw new UnsupportedArithmetic("increment");
        if (op === "-" || op === "+" || op === "!" || op === "~") {
            this.index += 1;
            const value = this.unary();
            if (op === "-") return wrap(-value);
            if (op === "+") return value;
            if (op === "!") return value === 0n ? 1n : 0n;
            return wrap(~value);
        }
        return this.primary();
    }

    primary(): bigint {
        const token = this.tokens[this.index];
        if (token === undefined) throw new UnsupportedArithmetic("end");
        const [kind, text] = token;
        this.index += 1;
        if (kind === "number") return wrap(number(text));
        if (kind === "name") {
            if (this.peek() === "++" || this.peek() === "--") throw new UnsupportedArithmetic("increment");
            return this.variable(text.replace(/^\$+/, "").replace(/^[{}]+|[{}]+$/g, ""));
        }
        if (text === "(") {
            const value = this.comma();
            this.take(")");
            return value;
        }
        throw new UnsupportedArithmetic(text);
    }

    private variable(name: string): bigint {
        const value = this.lookup(name);
        if (value === undefined) throw new UnsupportedArithmetic(name);
        if (value.trim() === "") return 0n; // an empty or unset variable is 0
        if (this.depth >= MAX_DEPTH) throw new UnsupportedArithmetic("depth");
        const result = evaluate(value, this.lookup, this.depth + 1);
        if (result === undefined) throw new UnsupportedArithmetic(name);
        return result;
    }
}

/** `pow(base, exponent, 1 << 64)`. */
function modPow(base: bigint, exponent: bigint): bigint {
    let result = 1n;
    let factor = base & MASK_64;
    let remaining = exponent;
    while (remaining > 0n) {
        if (remaining & 1n) result = (result * factor) & MASK_64;
        factor = (factor * factor) & MASK_64;
        remaining >>= 1n;
    }
    return result;
}

function apply(op: string, left: bigint, right: bigint): bigint {
    if (op === "/" || op === "%") {
        if (right === 0n) throw new UnsupportedArithmetic("division by zero");
        // BigInt division truncates toward zero, as bash (and the Python port) does.
        const quotient = left / right;
        return wrap(op === "/" ? quotient : left - right * quotient);
    }
    if (op === "<<" || op === ">>") {
        const shift = right & 63n;
        return op === "<<" ? wrap(left << shift) : left >> shift;
    }
    const truthy = (value: bigint): boolean => value !== 0n;
    const flag = (value: boolean): bigint => (value ? 1n : 0n);
    switch (op) {
        case "||":
            return flag(truthy(left) || truthy(right));
        case "&&":
            return flag(truthy(left) && truthy(right));
        case "|":
            return wrap(left | right);
        case "^":
            return wrap(left ^ right);
        case "&":
            return wrap(left & right);
        case "==":
            return flag(left === right);
        case "!=":
            return flag(left !== right);
        case "<":
            return flag(left < right);
        case "<=":
            return flag(left <= right);
        case ">":
            return flag(left > right);
        case ">=":
            return flag(left >= right);
        case "+":
            return wrap(left + right);
        case "-":
            return wrap(left - right);
        case "*":
            return wrap(left * right);
        default:
            throw new UnsupportedArithmetic(op);
    }
}
