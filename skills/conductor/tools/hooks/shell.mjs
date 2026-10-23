// agent-kit's copy is canonical. A repo may vendor it and must keep the protocol version and state layout.
/** Shell-text helpers shared by the Bash hooks. Node built-ins only. */

/**
 * Splits on `&&`, `||`, `;`, `|` and newlines outside quotes, so a quoted pattern or
 * message is never read as a command. Use `commandSegments` where heredoc bodies may occur.
 * `wide` also splits on `&`, parentheses, braces and backticks, to find every command start.
 */
export function segments(command, wide = false) {
  const out = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        current += ch + (command[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === "\\") {
      current += ch + (command[i + 1] ?? "");
      i += 1;
    } else if (ch === ";" || ch === "|" || ch === "\n" || (ch === "&" && command[i + 1] === "&") || (wide && WIDE.has(ch))) {
      out.push(current);
      current = "";
      if (command[i + 1] === ch) i += 1;
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

const WIDE = new Set(["&", "(", ")", "{", "}", "`"]);

/** The heredoc tag a line opens, ignoring `<<<` here-strings and `$((1<<2))` shifts. */
function heredocTag(line) {
  const m = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(line);
  if (!m || /\$\(\([^)]*$/.test(line.slice(0, m.index))) return null;
  return m[2];
}

/** Drops heredoc bodies; an unterminated heredoc drops the rest, which only ever allows more. */
export function withoutHeredocs(command) {
  const out = [];
  let tag = null;
  for (const line of command.split("\n")) {
    if (tag) {
      if (line.trim() === tag) tag = null;
      continue;
    }
    out.push(line);
    tag = heredocTag(line);
  }
  return out.join("\n");
}

/**
 * The command with heredoc bodies removed, quoted text emptied (`"a b"` becomes `""`)
 * and newlines turned into `;`, so only words the shell would run remain.
 */
export function codeOnly(command) {
  const text = withoutHeredocs(command);
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) {
        quote = null;
        out += ch;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === "\\") {
      out += " ";
      i += 1;
    } else if (ch === "#" && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i += 1;
    } else {
      out += ch === "\n" ? ";" : ch;
    }
  }
  return out;
}

/**
 * The bodies of `sh|bash|zsh -c '...'` calls, which `codeOnly` would otherwise empty.
 * One level only: a body's own `-c` is not unwrapped.
 */
export function shellBodies(command) {
  const bodies = [];
  const opener = /(?<![\w./-])(?:ba|z|da)?sh\s+(?:-[a-zA-Z]+\s+)*?-[a-zA-Z]*c\s+(["'])/g;
  for (const m of command.matchAll(opener)) {
    const quote = m[1];
    let body = "";
    for (let i = m.index + m[0].length; i < command.length && command[i] !== quote; i += 1) {
      if (command[i] === "\\" && quote === '"') i += 1;
      body += command[i] ?? "";
    }
    bodies.push(body);
  }
  return bodies;
}

/** `segments` over the command with heredoc bodies removed, so a body is never a command. */
export const commandSegments = (command) => segments(withoutHeredocs(command));

const OPERATOR = new Set([";", "&", "|", "<", ">", "(", ")", "\n", "`", "$", "*", "?", "[", "{"]);
const DQ_ESCAPES = new Set(["$", "`", '"', "\\"]);

/**
 * The words the shell would pass as argv, with quotes, escapes and adjacent pieces joined, or null
 * when the text holds anything more than plain words: an operator, redirect, heredoc, expansion,
 * glob, tilde, comment or open quote.
 */
export function shellWords(text) {
  const words = [];
  let word = null;
  const add = (s) => {
    word = (word ?? "") + s;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === " " || ch === "\t") {
      if (word !== null) words.push(word);
      word = null;
    } else if (ch === "\\") {
      if (i + 1 >= text.length) return null;
      if (text[i + 1] !== "\n") add(text[i + 1]);
      i += 1;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      add(text.slice(i + 1, end));
      i = end;
    } else if (ch === '"') {
      add("");
      for (i += 1; text[i] !== '"'; i += 1) {
        if (i >= text.length || text[i] === "$" || text[i] === "`") return null;
        if (text[i] === "\\" && (DQ_ESCAPES.has(text[i + 1]) || text[i + 1] === "\n")) {
          i += 1;
          if (text[i] !== "\n") add(text[i]);
        } else add(text[i]);
      }
    } else if (OPERATOR.has(ch) || (ch === "#" && word === null) || (ch === "~" && (word === null || /[=:]$/.test(word)))) {
      return null;
    } else add(ch);
  }
  if (word !== null) words.push(word);
  return words;
}

const WORD_START = /[\s;&|()]/;
const MAX_DEPTH = 64;

/**
 * The command's code, then the code of every command substitution it runs (`$(...)` or backticks:
 * bare, inside double quotes, or in a heredoc whose delimiter is unquoted), each read the same way.
 * A text keeps its quoted words but loses its substitutions, comments and heredoc bodies, so
 * `segments` over it finds every command start. Single quotes and quoted-delimiter heredocs stay inert.
 * Throws a RangeError past MAX_DEPTH nested substitutions.
 */
export function codeTexts(command) {
  const texts = [];
  const n = command.length;
  /** Reads substitutions in double-quote-like text from i up to stop, or to `"` when stop is null. */
  const quoted = (i, stop, depth) => {
    let out = "";
    while (i < (stop ?? n) && (stop !== null || command[i] !== '"')) {
      if (command[i] === "\\") out += command.slice(i, (i += 2));
      else if (command[i] === "`") i = code(i + 1, "`", depth + 1);
      else if (command.startsWith("$(", i)) i = code(i + 2, ")", depth + 1);
      else out += command[i++];
    }
    return [i, out];
  };
  /** Reads code from i up to the closing `end`, pushing its text; returns the index after it. */
  const code = (i, end, depth) => {
    if (depth > MAX_DEPTH) throw new RangeError("command substitutions nest too deep to read");
    let out = "";
    const heredocs = [];
    while (i < n && command[i] !== end) {
      const ch = command[i];
      if (ch === "\\") out += command.slice(i, (i += 2));
      else if (ch === "'" || (ch === "$" && command[i + 1] === "'")) {
        let j = command.indexOf("'", i) + 1;
        while (j < n && command[j] !== "'") j += ch === "$" && command[j] === "\\" ? 2 : 1;
        out += command.slice(i, (i = Math.min(j + 1, n)));
      } else if (ch === '"') {
        const [at, text] = quoted(i + 1, null, depth);
        out += `"${text}"`;
        i = at + 1;
      } else if (ch === "`") i = code(i + 1, "`", depth + 1);
      else if (command.startsWith("$(", i)) i = code(i + 2, ")", depth + 1);
      else if (ch === "(") {
        i = code(i + 1, ")", depth + 1);
        out += ";";
      } else if (ch === "#" && (i === 0 || WORD_START.test(command[i - 1]))) {
        while (i < n && command[i] !== "\n") i += 1;
      } else if (command.startsWith("<<", i) && command[i + 2] !== "<") {
        const m = /^<<-?[ \t]*((?:[^\s;&|<>()]|'[^']*'|"[^"]*")+)/.exec(command.slice(i, i + 4096));
        if (m) heredocs.push({ tag: m[1].replace(/['"\\]/g, ""), live: !/['"\\]/.test(m[1]) });
        const len = m ? m[0].length : 2;
        out += command.slice(i, (i += len));
      } else if (ch === "\n" && heredocs.length) {
        out += ch;
        i += 1;
        for (const { tag, live } of heredocs.splice(0)) {
          let end = i;
          while (end < n) {
            const eol = command.indexOf("\n", end);
            const line = command.slice(end, eol < 0 ? n : eol);
            if (line.replace(/^\t+/, "") === tag) break;
            end = eol < 0 ? n : eol + 1;
          }
          if (live) quoted(i, end, depth);
          i = Math.min(command.indexOf("\n", end) + 1 || n, n);
        }
      } else out += command[i++];
    }
    texts.push(out);
    return i + 1;
  };
  code(0, undefined, 0);
  return texts;
}
