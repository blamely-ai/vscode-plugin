# Blamely — AI & Human

Track, report, and commit AI & human code in your VS Code workspace. **blamely.ai**

## Features

- **AI Suggestion Interception** — Monitors GitHub Copilot and Cursor AI inline completions
- **Batched Heuristic Fallback** — Advanced queueing detects whole-block chat generations, properly attributing empty lines to AI.
- **Model & Prompt Inference** — Infers active context (e.g. `github.copilot` vs `cursor-ai`) and extracts prompts from surrounding comments.
- **Line-Level Blame** — Maintains per-file blame maps attributing each line to AI or human
- **Invisible Data Persistence** — Automatically stores state inside your `.git/ai-trace/` folder to survive IDE restarts without polluting your workspace or `.gitignore`.
- **Native Git Notes Integration** — Generates a transparent YAML report (`report.yml`) and attaches it natively to every commit using `git notes --ref=ai-trace`.
- **Status Bar** — Always visible `🤖 AI: X% | 👤 Human: Y%` indicator
- **Gutter Decorations** — Color-coded icons per line (🤖 AI / 👤 Human)
- **Sidebar Tree View** — Per-file AI & Human under the SCM panel

## Installation

1. Clone this repository
2. Run `npm install`
3. Run `npm run compile`
4. Press `F5` in VSCode to launch the Extension Development Host

## Commands

| Command | Description |
|---------|-------------|
| `Blamely: Generate Report Now` | Regenerate reports manually |
| `Blamely: Show Blame for Current File` | Show AI & Human for the active file |
| `Blamely: Install Git Commit Hook` | Install the pre-commit hook manually |
| `Blamely: Show Report for Latest Commit (Git Note)` | Show the Git Note containing the most recent commit's report |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `aiTrace.suggestionTimeout` | `30000` | Timeout (ms) before a pending suggestion is marked rejected |
| `aiTrace.autoInstallHook` | `true` | Auto-install Git pre-commit hook on activation |
| `aiTrace.excludePatterns` | `["node_modules", ".git", "dist"]` | File patterns to exclude from tracking |
| `aiTrace.reportOnSave` | `true` | Regenerate reports on every file save |
| `aiTrace.showGutterDecorations` | `true` | Show AI & Human gutter decorations |

## `report.yml` Format (Sample)

```yaml
scope: "this_commit"
generated_at: "2026-03-05T00:43:50Z"
detector_version: "0.8.0"
branch: "main"
commit_hash: "3317ed295e"
commit_message: "[AI-assisted] feat: update time-to-fix analysis"

ai_sources:
  - copilot/cursor_inline

files:
  - path: "src/utils/parser.ts"
    source: "copilot/cursor_inline"
    model: "github-copilot"
    prompt: "// Parse the execution results"
    ai_lines_added: 22
    human_lines_added: 65
    ai_entries: 8
    human_entries: 12
    total_entries: 20
    percentage: "40.0%"
```

## Data Persistence

Trace history and configuration data are stored completely transparently inside your `.git` folder. This means your workspace and file explorer are never cluttered with `.json` trace files or `.md` reports, and you do not have to update your `.gitignore`.

When building the final UI context upon commit, the extension calculates the exact AI impact for that commit and attaches it invisibly using `git notes`, then pushes the note to your remote.

```text
<project-root>/
    └── .git/
        └── ai-trace/
            ├── session.json                   ← Active session tracking state
            └── snapshots/
                └── <file>.blame.json          ← Per-file blame maps (preserves state across IDE reloads)
```

**Remote History via `git notes`**

You can view the Blamely report for any commit directly in VS Code using the command palette:
**"Blamely: Show Report for Latest Commit (Git Note)"**

Or view it in the terminal alongside the commit log:
```bash
git log -1 --show-notes=ai-trace
```

## License

MIT
