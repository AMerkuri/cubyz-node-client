const WHITESPACE = /[\s]/;

export type ZonValue =
  | string
  | number
  | boolean
  | null
  | ZonValue[]
  | { [key: string]: ZonValue };

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

class ZonParser {
  private readonly text: string;
  private readonly length: number;
  public pos: number;

  constructor(text: string) {
    this.text = text;
    this.length = text.length;
    this.pos = 0;
  }

  parseValue(): ZonValue {
    this.skipWhitespace();
    if (this.pos >= this.length) {
      throw new Error("Unexpected end of input");
    }
    const char = this.text[this.pos];
    if (char === "{") {
      return this.parseCompound();
    }
    if (char === '"') {
      return this.parseString();
    }
    if (this.text.startsWith("null", this.pos)) {
      this.pos += 4;
      return null;
    }
    if (this.text.startsWith("true", this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.text.startsWith("false", this.pos)) {
      this.pos += 5;
      return false;
    }
    if (char === ".") {
      const next = this.text[this.pos + 1];
      if (next && isDigit(next)) {
        return this.parseNumber();
      }
      return this.parseIdentifier();
    }
    return this.parseNumber();
  }

  private parseCompound(): ZonValue {
    this.expect("{");
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.pos += 1;
      return [];
    }
    const isObject = this.detectObject();
    if (isObject) {
      return this.parseObjectBody();
    }
    return this.parseArrayBody();
  }

  private detectObject(): boolean {
    const snapshot = this.pos;
    this.skipWhitespace();
    if (this.pos >= this.length) {
      this.pos = snapshot;
      return false;
    }
    if (this.text[this.pos] === ".") {
      this.pos += 1;
      if (this.pos >= this.length) {
        this.pos = snapshot;
        return false;
      }
    }
    const char = this.text[this.pos];
    if (!isIdentifierStart(char)) {
      this.pos = snapshot;
      return false;
    }
    while (this.pos < this.length && isIdentifierChar(this.text[this.pos])) {
      this.pos += 1;
    }
    this.skipWhitespace();
    const result = this.peek() === "=";
    this.pos = snapshot;
    return result;
  }

  private parseObjectBody(): { [key: string]: ZonValue } {
    const obj: { [key: string]: ZonValue } = {};
    while (true) {
      this.skipWhitespace();
      const key = this.parseIdentifier();
      this.skipWhitespace();
      this.expect("=");
      const value = this.parseValue();
      obj[key] = value;
      this.skipWhitespace();
      const char = this.peek();
      if (char === ",") {
        this.pos += 1;
        continue;
      }
      if (char === "}") {
        this.pos += 1;
        break;
      }
      throw new Error(`Unexpected character in object: ${char ?? "EOF"}`);
    }
    return obj;
  }

  private parseArrayBody(): ZonValue[] {
    const arr: ZonValue[] = [];
    while (true) {
      const value = this.parseValue();
      arr.push(value);
      this.skipWhitespace();
      const char = this.peek();
      if (char === ",") {
        this.pos += 1;
        continue;
      }
      if (char === "}") {
        this.pos += 1;
        break;
      }
      throw new Error(`Unexpected character in array: ${char ?? "EOF"}`);
    }
    return arr;
  }

  private parseIdentifier(): string {
    if (this.pos >= this.length) {
      throw new Error("Unexpected end of input when reading identifier");
    }
    if (this.text[this.pos] === ".") {
      this.pos += 1;
      if (this.pos >= this.length) {
        throw new Error("Unexpected end of input after '.' in identifier");
      }
    }
    const char = this.text[this.pos];
    if (!isIdentifierStart(char)) {
      throw new Error(`Invalid identifier start: ${char}`);
    }
    const start = this.pos;
    this.pos += 1;
    while (this.pos < this.length && isIdentifierChar(this.text[this.pos])) {
      this.pos += 1;
    }
    return this.text.slice(start, this.pos);
  }

  private parseString(): string {
    this.expect('"');
    let result = "";
    while (this.pos < this.length) {
      const char = this.text[this.pos];
      this.pos += 1;
      if (char === '"') {
        return result;
      }
      if (char === "\\") {
        if (this.pos >= this.length) {
          throw new Error("Unterminated escape sequence");
        }
        const next = this.text[this.pos];
        this.pos += 1;
        switch (next) {
          case '"':
            result += '"';
            break;
          case "\\":
            result += "\\";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          default:
            result += next;
            break;
        }
      } else {
        result += char;
      }
    }
    throw new Error("Unterminated string literal");
  }

  private parseNumber(): number {
    const start = this.pos;
    let sign = 1;
    if (this.peek() === "+" || this.peek() === "-") {
      sign = this.peek() === "-" ? -1 : 1;
      this.pos += 1;
    }

    const remainingLower = this.text.slice(this.pos).toLowerCase();
    if (remainingLower.startsWith("nan")) {
      this.pos += 3;
      return Number.NaN;
    }
    if (remainingLower.startsWith("infinity")) {
      this.pos += 8;
      return sign === -1 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    }
    if (remainingLower.startsWith("inf")) {
      this.pos += 3;
      return sign === -1 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    }

    let hasDigits = false;
    let allowUnderscore = false;

    const consumeDigits = (): boolean => {
      let consumed = false;
      while (this.pos < this.length) {
        const ch = this.text[this.pos];
        if (isDigit(ch)) {
          consumed = true;
          hasDigits = true;
          allowUnderscore = true;
          this.pos += 1;
          continue;
        }
        if (ch === "_" && allowUnderscore) {
          allowUnderscore = false;
          this.pos += 1;
          continue;
        }
        break;
      }
      return consumed;
    };

    consumeDigits();
    if (this.peek() === ".") {
      this.pos += 1;
      allowUnderscore = false;
      const fractionDigits = consumeDigits();
      if (!fractionDigits && !hasDigits) {
        const lookahead = this.text.slice(
          start,
          Math.min(this.length, this.pos + 10),
        );
        throw new Error(`Invalid number literal: ${lookahead}`);
      }
    }

    allowUnderscore = false;
    if (this.peek() === "e" || this.peek() === "E") {
      this.pos += 1;
      if (this.peek() === "+" || this.peek() === "-") {
        this.pos += 1;
      }
      const exponentDigits = consumeDigits();
      if (!exponentDigits) {
        const lookahead = this.text.slice(
          start,
          Math.min(this.length, this.pos + 10),
        );
        throw new Error(`Invalid exponent in number: ${lookahead}`);
      }
    }
    if (!hasDigits) {
      const lookahead = this.text.slice(
        start,
        Math.min(this.length, this.pos + 10),
      );
      throw new Error(`Invalid number literal: ${lookahead}`);
    }
    const raw = this.text.slice(start, this.pos);
    const value = Number(raw);
    if (Number.isNaN(value)) {
      throw new Error(`Failed to parse number: ${raw}`);
    }
    return value;
  }

  public skipWhitespace(): void {
    while (this.pos < this.length && WHITESPACE.test(this.text[this.pos])) {
      this.pos += 1;
    }
  }

  private expect(char: string): void {
    if (this.peek() !== char) {
      throw new Error(`Expected '${char}' but found '${this.peek() ?? "EOF"}'`);
    }
    this.pos += 1;
  }

  private peek(): string | undefined {
    if (this.pos >= this.length) {
      return undefined;
    }
    return this.text[this.pos];
  }
}

export function parseZon(text: string): ZonValue {
  const parser = new ZonParser(text);
  const value = parser.parseValue();
  parser.skipWhitespace();
  if (parser.pos !== text.length) {
    throw new Error("Trailing data after ZON parse");
  }
  return value;
}
