/**
 * Arduino Lab — dependency-free C++/Arduino syntax highlighter.
 *
 * The Sketch Lab editor renders highlighted source behind a transparent
 * <textarea> (the classic overlay trick), so this module turns raw sketch
 * text into per-line HTML with escaped content and <span> token classes.
 *
 * Line-based state machine: block comments and preprocessor blocks span
 * lines, so the tokenizer carries a one-bit state between lines. Everything
 * else (keywords, types, strings, chars, numbers, function calls) is
 * identified with per-line regexes — fast enough to run on every keystroke
 * for sketch-sized (≤ 20 KB) sources.
 */

const KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "default", "break",
  "continue", "return", "goto", "try", "catch", "throw", "new", "delete",
  "this", "sizeof", "static", "extern", "inline", "explicit", "friend",
  "virtual", "override", "namespace", "using", "template", "typename",
  "class", "struct", "union", "enum", "public", "private", "protected",
  "operator", "const_cast", "static_cast", "reinterpret_cast", "dynamic_cast",
]);

const TYPES = new Set([
  "void", "bool", "char", "int", "float", "double", "long", "short", "signed",
  "unsigned", "const", "volatile", "static", "auto", "size_t", "true", "false",
  "NULL", "nullptr", "uint8_t", "uint16_t", "uint32_t", "uint64_t", "int8_t",
  "int16_t", "int32_t", "int64_t", "intptr_t", "uintptr_t", "byte", "word",
  "boolean", "String", "String0", "__FlashStringHelper", "PROGMEM", "PGM_P",
]);

const ARDUINO_API = new Set([
  "setup", "loop", "pinMode", "digitalWrite", "digitalRead", "analogRead",
  "analogWrite", "analogReference", "tone", "noTone", "pulseIn", "pulseInLong",
  "shiftOut", "shiftIn", "delay", "delayMicroseconds", "micros", "millis",
  "attachInterrupt", "detachInterrupt", "digitalPinToInterrupt", "interrupts",
  "noInterrupts", "random", "randomSeed", "map", "constrain", "min", "max",
  "abs", "sqrt", "pow", "sin", "cos", "tan", "yield", "Serial", "Serial1",
  "Serial2", "Serial3", "SPI", "Wire", "HIGH", "LOW", "INPUT", "OUTPUT",
  "INPUT_PULLUP", "LED_BUILTIN", "CHANGE", "RISING", "FALLING", "DEC", "HEX",
  "OCT", "BIN", "F", "strcpy", "strncpy", "strcat", "strlen", "strcmp",
  "strcasecmp", "strncmp", "strstr", "snprintf", "sprintf", "strtok", "memcpy",
  "memset", "memmove", "strtoul", "strtol", "atoi", "atol",
]);

export type TokenKind =
  | "plain"
  | "comment"
  | "blockComment"
  | "preprocessor"
  | "string"
  | "char"
  | "number"
  | "keyword"
  | "type"
  | "api"
  | "funcall";

export const TOKEN_COLOR: Record<TokenKind, string> = {
  plain: "text-slate-300",
  comment: "text-slate-500 italic",
  blockComment: "text-slate-500 italic",
  preprocessor: "text-amber-300",
  string: "text-emerald-300",
  char: "text-emerald-300",
  number: "text-orange-300",
  keyword: "text-violet-300",
  type: "text-sky-300",
  api: "text-cyan-300",
  funcall: "text-yellow-200",
};

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const NUMBER_RE = /^(0[xXbB][0-9a-fA-F']+|\d[\d'.]*[fFuUlL]*|[eE][+-]?\d+)/;
const WS_RE = /^\s+/;

interface Token {
  kind: TokenKind;
  text: string;
}

/**
 * Tokenize one physical line. `inBlockComment` is carried in/out so
 * multi-line /* … *​/ comments highlight correctly.
 */
function tokenizeLine(line: string, inBlockComment: boolean): { tokens: Token[]; inBlockComment: boolean } {
  const tokens: Token[] = [];
  let rest = line;
  let inComment = inBlockComment;

  // A line inside a block comment is a comment until the terminator appears.
  if (inComment) {
    const endIdx = rest.indexOf("*/");
    if (endIdx < 0) {
      return { tokens: [{ kind: "blockComment", text: rest }], inBlockComment: true };
    }
    tokens.push({ kind: "blockComment", text: rest.slice(0, endIdx + 2) });
    rest = rest.slice(endIdx + 2);
    inComment = false;
  }

  // Preprocessor directive: whole-line styling (continuations ignored).
  if (tokens.length === 0 && /^\s*#/.test(rest)) {
    tokens.push({ kind: "preprocessor", text: rest });
    return { tokens, inBlockComment: false };
  }

  while (rest.length > 0) {
    const ws = WS_RE.exec(rest);
    if (ws) {
      tokens.push({ kind: "plain", text: ws[0] });
      rest = rest.slice(ws[0].length);
      continue;
    }

    // Line comment runs to end of line.
    if (rest.startsWith("//")) {
      tokens.push({ kind: "comment", text: rest });
      rest = "";
      continue;
    }

    // Block comment open: find the terminator, else carry state to next line.
    if (rest.startsWith("/*")) {
      const endIdx = rest.indexOf("*/", 2);
      if (endIdx < 0) {
        tokens.push({ kind: "blockComment", text: rest });
        rest = "";
        inComment = true;
        continue;
      }
      tokens.push({ kind: "blockComment", text: rest.slice(0, endIdx + 2) });
      rest = rest.slice(endIdx + 2);
      continue;
    }

    // String literal (honors escaped quotes).
    if (rest.startsWith('"')) {
      let i = 1;
      while (i < rest.length) {
        if (rest[i] === "\\") i += 2;
        else if (rest[i] === '"') {
          i += 1;
          break;
        } else i += 1;
      }
      tokens.push({ kind: "string", text: rest.slice(0, i) });
      rest = rest.slice(i);
      continue;
    }

    // Char literal.
    if (rest.startsWith("'")) {
      let i = 1;
      while (i < rest.length) {
        if (rest[i] === "\\") i += 2;
        else if (rest[i] === "'") {
          i += 1;
          break;
        } else i += 1;
      }
      tokens.push({ kind: "char", text: rest.slice(0, i) });
      rest = rest.slice(i);
      continue;
    }

    const num = NUMBER_RE.exec(rest);
    if (num && /^[0-9]/.test(rest)) {
      tokens.push({ kind: "number", text: num[0] });
      rest = rest.slice(num[0].length);
      continue;
    }

    const ident = IDENT_RE.exec(rest);
    if (ident) {
      const word = ident[0];
      const after = rest.slice(word.length);
      let kind: TokenKind = "plain";
      if (KEYWORDS.has(word)) kind = "keyword";
      else if (TYPES.has(word)) kind = "type";
      else if (ARDUINO_API.has(word)) kind = "api";
      else if (/^\s*\(/.test(after)) kind = "funcall";
      tokens.push({ kind, text: word });
      rest = after;
      continue;
    }

    // Anything else (operators, punctuation) — one char at a time.
    tokens.push({ kind: "plain", text: rest[0]! });
    rest = rest.slice(1);
  }

  return { tokens, inBlockComment: inComment };
}

/**
 * Highlight a whole sketch into per-line HTML strings. Render with
 * `dangerouslySetInnerHTML` — every token's text is escaped, so the output
 * is safe even when the source contains angle brackets or quotes.
 */
export function highlightCpp(source: string): string[] {
  const lines = source.split("\n");
  const out: string[] = [];
  let inBlockComment = false;
  for (const line of lines) {
    const { tokens, inBlockComment: next } = tokenizeLine(line, inBlockComment);
    inBlockComment = next;
    out.push(tokens.map((t) => `<span class="${TOKEN_COLOR[t.kind]}">${escapeHtml(t.text)}</span>`).join(""));
  }
  return out;
}
