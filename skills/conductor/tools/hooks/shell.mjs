// agent-kit's copy is canonical. A repo may vendor it and must keep the protocol version and state layout.
/** Shell-text helpers shared by the Bash hooks. Node built-ins only. */

/**
 * Splits on `&&`, `||`, `;`, `|` and newlines outside quotes, so a quoted pattern or
 * message is never read as a command. Use `commandSegments` where heredoc bodies may occur.
 */
export function segments(command) {
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
    } else if (ch === ";" || ch === "|" || ch === "\n" || (ch === "&" && command[i + 1] === "&")) {
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
