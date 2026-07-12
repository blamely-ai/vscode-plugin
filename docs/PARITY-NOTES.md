# Cross-plugin parity notes

The VS Code (TypeScript) and IntelliJ (Kotlin) plugins are parallel implementations
of the same detection/attribution design; fixes are hand-ported between them, and
the Go CLI (`blamely-cli`) is the reference implementation for everything shared
(attribution engine, working-log schema/store, content hashing, daemon protocol).

## Must stay identical (drift here is a bug)

- Attribution v2 engine (`attribute`, LCS align, moves, overrode, splitLines) —
  pinned by the shared `golden_vectors.json` (byte-identical in all three repos).
- Working-log schema `blamely/working-log/1`, on-disk layout
  `.git/blamely/working_logs/<branch>/<base_sha>/<path>.json`, `sanitizeComponent`
  charset, atomic write + lockfile constants (5s timeout / 10s stale / 15ms poll).
- content_sha (sha256 of line, trailing CR stripped) and content_sha_norm
  (whitespace-collapsed); blank lines never hashed.
- Daemon `EditPayload` field names incl. `removed_lines`; confirmed signals send
  `confidence: "high"` so the daemon never re-tags them as chat.
- UX timing constants: FLUSH_DEBOUNCE 400ms, PENDING_AI_TTL 12s, DETECTING_TTL 8s,
  stash window 10s, HEAD poll 3s, periodic backstop 30s, MIN_COMPLETION_CHARS 8,
  inline/chat pending windows 500/1500ms, v1 line caps (10k per-edit / 50k absolute).

## Intentional differences (do NOT "fix" these)

- **Antigravity single-AI heuristics are VS Code-only.** Antigravity is a VS Code
  fork; the IntelliJ plugin cannot host it.
- **Agent-mode capture architecture differs by design.** VS Code stashes a
  pre-apply snapshot and defers attribution to the daemon's chat/transcript
  watchers, which only watch VS Code/Cursor `workspaceStorage`. IntelliJ's
  `AgentEditDetector` (idea.log tail + VFS listener) records agent edits
  in-plugin because no daemon watcher covers JetBrains.
- **`resolveTool()` auto-detection is IDE-specific**: VS Code checks installed/
  active extensions and the app name; IntelliJ checks registered action IDs.
- **Clipboard read strategy**: VS Code caches the clipboard and refreshes it;
  IntelliJ reads fresh on each candidate. Both are gated to substantial inserts.
