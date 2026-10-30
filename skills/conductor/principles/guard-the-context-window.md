# Guard the context window

**When:** A large read, a long output, or work that fans out.

**Why:** A full context degrades reasoning and drops earlier decisions. Raw dumps in your thread cost more than the answer they carry. Every turn re-reads the whole context, so a turn late in a long session costs several times one early in it.

Explorer pointers and the report shape are in roles.md. This adds the rest.

- Read the specific lines a pointer names. Do not reopen the whole file.
- Cap command output at the source. Filter, count or tail before it reaches you.
- Split fan-out into bounded pieces, each with its own scope.
- Keep decisions and verdicts in the thread. Keep logs and listings out of it.
- Write long results to a file and cite the path.
- Plan every change to a file, then make them in one edit. After an edit, read the diff, not the file again.
- Write one status line when a stage ends. Do not narrate each step. A turn with only text still re-reads the whole context.
- A delegate hands over when its context passes the limit. The binding says how it learns its size.
- An orchestrator that steers for hours hands over too, at a lower limit, because it re-reads its context on every notice. It steers, and leaves checks and merges to the delegates that own them. Any other long session hands over in place when a stage ends, so the operator never has to start a fresh one.

**Example.** Finding every caller of a function across a large repo goes to an explorer. It returns twenty `path:line` pointers. You read the five that matter.
