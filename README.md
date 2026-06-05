# Blamely

**Blamely** attributes every line of code to **AI** or **human** — across inline completions, chat apply, and agent runs. The breakdown appears in the **status bar** as you work, survives branch switches, and attaches permanently to each commit via **git notes**.

**Local-first:** all data stays on your machine. No account, no telemetry, no network access.

**Website:** [blamely.ai](https://blamely.ai) · **Issues:** [GitHub](https://github.com/blamely-ai/vscode-plugin/issues)

> Requires the **blamely CLI** — see [Requirements](#requirements--install-the-cli-first).

---

## How it works

1. **Record.** When an AI tool edits a file, its hook calls `blamely record <tool>`.
2. **Watch.** The daemon tails Cursor logs, Copilot transcripts, and filesystem activity.
3. **Attribute.** On every commit, the global `post-commit` hook diffs the commit against recorded edits and writes per-line attribution.
4. **Report.** The extension reads it back into the status bar, the Changes / History views, and the editor gutter.

---

## Requirements — install the CLI first

This extension requires the **blamely CLI** installed and running in the background.

**macOS:**
```bash
curl -sSL https://blamely.ai/blamely-mac-install.sh | bash
```

**Linux:**
```bash
curl -sSL https://blamely.ai/blamely-linux-install.sh | bash
```

**Windows** (PowerShell):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://blamely.ai/blamely-windows-install.bat | iex"
```

Installers are idempotent — safe to re-run after adding a new AI tool. Verify:

```bash
blamely status    # daemon health + detected tools
blamely doctor    # full self-check
```

Full guide: **[blamely.ai](https://blamely.ai)**

---

## What you get

- **Line-level blame** — gutter icons and tooltips, AI vs human per line.
- **Status bar** — live AI / Human lines, characters, percentage, and the active model for the current file.
- **Changes view** — per-file AI / Human breakdown for uncommitted work on the current branch.
- **History view** — per-model stats, a commit table, and timing across past commits.
- **Git notes** — per-line attribution attached to every commit via `refs/notes/blamely`.
- **Branch-scoped sessions** — attribution follows each branch and survives switches.
- **Local-first** — no account, no telemetry, no network access.
- **VS Code ⇄ JetBrains compatible** — shared `.git/blamely` data; open the same repo in either IDE.

---

## After each commit

A clear AI vs Human bar prints in your terminal right after `git commit`:

```
AI 72% (18)  [████████████████████████████░░░░░░░░░░░░]  Human 28% (7)
  claude  12 lines  (claude-opus-4-6) — 4200 in / 890 out tok
  cursor   6 lines  (composer-1)      — 1100 in / 340 out tok
```

The same data is attached to the commit as a git note (`refs/notes/blamely`) and shown in **Blamely: History** in the Source Control sidebar.

---

## Supported tools

GitHub Copilot, Cursor, JetBrains AI, Claude Code, Codex, Gemini, and other inline / chat / agent assistants.


---

## Commands

Run from the **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type `Blamely:`.

| Command | Description |
|---------|-------------|
| **Blamely: Refresh Runtime Data** | Re-read attribution from the blamely runtime and repaint the gutter, status bar, and views. |
| **Blamely: Show Blame for Current File** | Quick AI / Human summary for the active file. |
| **Blamely: Show Daemon Status** | Show blamely daemon health and detected tools. |

---

## Settings

Settings use the `blamely.*` prefix.

| Setting | Default | Description |
|---------|---------|-------------|
| `blamely.showGutterDecorations` | `true` | Show attribution gutter icons and hovers in the editor. |
| `blamely.detectInlineCompletion` | `true` | Detect inline AI completion accepts (Cursor Tab, Copilot Tab) and record them as `gen_type=completion`. |
| `blamely.aiTool` | `auto` | Which AI tool to credit for detected edits. `auto` infers from the host editor; set explicitly when running **Copilot inside Cursor** (or Cursor Tab inside VS Code). |
| `blamely.debugDetection` | `false` | Log AI-edit detection to the **Blamely** output channel (executed command ids, chat-apply / inline-accept matches, recorded edits). |

---

## License

MIT
