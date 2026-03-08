# Session Picker Design

Interactive session picker for claude-replay that replaces the "file required" error with a TUI-based session browser when no JSONL file is specified.

## Decisions

| Decision | Choice |
|---|---|
| CLI integration | No-arg default launches picker |
| TUI framework | Rezi (`@rezi-ui/node`) |
| Runtime dependencies | Accepted (pin exact version) |
| Output after selection | Auto-generated filename; `-o` overrides |
| Session scope | Current project + its worktrees |
| Title source | custom-title (JSONL tail) > summary (index) > project name only |
| Sort order | Reverse chronological by `modified` |
| Non-TTY fallback | Existing "input file required" error |

## CLI Integration

Running `claude-replay` with no positional argument launches the picker. All existing flags (`--theme`, `--speed`, `--turns`, etc.) remain compatible and apply after session selection.

```
claude-replay [--theme X] [--speed N] [-o file] ...
        |
        +-- positional arg given? --> existing pipeline (no change)
        |
        +-- no positional arg?
                |
                +-- stdin is not TTY? --> existing error ("input file required")
                |
                +-- stdin is TTY? --> launch picker
                        |
                        +-- detect current project from CWD
                        +-- load sessions from index
                        +-- display interactive picker (Rezi)
                        +-- user selects session
                        |
                        +-- -o given? --> write to that path
                        +-- -o not given? --> auto-generate filename
                                replay-YYYY-MM-DD-<slugified-title>.html
                                print path to stderr
```

The picker resolves the missing positional argument. The rest of the pipeline runs unchanged.

## Session Discovery

### Project mapping

Map CWD to the encoded Claude Code project directory:

```
/Users/omair/projects/claude-replay --> -Users-omair-projects-claude-replay
```

Look for `~/.claude/projects/<encoded-dir>/sessions-index.json`. Also scan directories matching `<encoded-dir>--worktrees-*` for worktree sessions.

### Data from the index

Per session entry in `sessions-index.json`:

- `fullPath` -- JSONL file path (fed to existing pipeline)
- `summary` -- auto-generated title
- `firstPrompt` -- second line preview text
- `messageCount` -- displayed in metadata
- `created`, `modified` -- duration calculation and sort
- `gitBranch` -- appended for worktree sessions

### Custom title resolution

The index lacks user-set custom titles. These live in the JSONL as `custom-title` entries appended near the end of the file. Read the last 4KB of each JSONL and search for `"custom-title"` to extract them quickly.

Title priority:

1. `custom-title` from JSONL tail scan (user explicitly named this session)
2. `summary` from index (skip if matches "User Exited...", "No prompt", "untitled")
3. No title -- show project name only; rely on `firstPrompt` on line 2

### Filtering

Remove low-value sessions:

- `messageCount <= 2` (empty or immediately-exited)
- Summary matching skip patterns (case-insensitive): "User Exited", "No prompt", "untitled"

### Sorting

By `modified` timestamp, descending (newest first).

## Display Layout

Two-line item format:

```
project-name . session title (yellow)                    N msgs . Xh Ym . Mar 07, 15:24
  First user message truncated to one line...
```

### Line 1 -- left side

- Project name in default text color (decoded from encoded dir name)
- For worktree sessions: `project-name (wt: branch-name)`
- ` . ` separator + session title in yellow (only when title exists)

### Line 1 -- right side (dim, right-aligned)

- `N msgs` from `messageCount`
- `Xh Ym` duration from `modified - created`
- `Mon DD, HH:MM` formatted `modified` timestamp

### Line 2 (indented, dim)

- `firstPrompt` truncated to terminal width minus indent

### Selection

Highlighted item gets a visual highlight bar with left accent border.

### Top bar

Fuzzy search input with match counter (e.g. `15/240`). Typing filters against session title, summary, and firstPrompt.

### Keyboard

- Arrow up/down -- navigate
- Type -- fuzzy filter
- Enter -- select session, exit picker, generate replay
- Escape -- quit without generating

### Implementation

Rezi `ui.virtualList()` with custom `renderItem` using `ui.column()` > `ui.row()` for the two-line layout. `ui.input()` at top for search, filtering items in app state.

## Error Handling

| Scenario | Behavior |
|---|---|
| No `~/.claude/projects/` directory | Print message: "No Claude Code sessions found. Run claude-replay from a project directory that has Claude Code session history." Exit 1. |
| No matching project directory for CWD | Same message as above. |
| No sessions after filtering | Show unfiltered count: "No sessions found for <project> (N sessions filtered as empty). Use claude-replay <file.jsonl> to open a specific file." Exit 1. |
| Fuzzy search yields zero matches | Show empty list with "0/N" counter. User clears search to restore. |
| Selected JSONL file no longer exists | "Session file not found: <path>" Exit 1. |
| Output file collision | Append numeric suffix: `replay-...-2.html` |
| Non-interactive terminal (piped stdin) | Fall back to existing error: "input file required" |

## File Changes

### New files

- `src/picker.mjs` -- session discovery (index parsing, custom-title tail scan, filtering, sorting) + Rezi picker UI + filename generation

### Modified files

- `bin/claude-replay.mjs` -- no-arg + TTY branch: import picker, get file path, continue pipeline
- `package.json` -- add `@rezi-ui/node` (pinned exact version)
- `README.md` -- update zero-dependencies language, document picker

### New test file

- `test/test-picker.mjs` -- unit tests for session discovery logic (index parsing, title resolution, filtering, sorting, filename generation). Does not require TTY.

### CI

No changes needed. Existing unit test and e2e pipelines unaffected.
