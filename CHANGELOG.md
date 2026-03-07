# Changelog

## 0.1.2

- Fix: expanding a block while paused then stepping forward now reveals the next block instead of jumping to the next turn
- Fix: expanded blocks are now collapsed when rewinding
- Fix: `#turn=0` deep link shows splash screen instead of blank page
- Add Playwright e2e integration tests (25 tests covering playback, stepping, expand/collapse, keyboard shortcuts, navbar, progress bar, speed control, chapters)

## 0.1.1

- Fix README screenshot layout for npm

## 0.1.0 — Initial release

### Player
- Interactive playback with block-by-block animation
- Step forward/back through individual blocks within turns
- Session timer (elapsed / total) with per-second ticking during playback
- Speed control (0.5x to 5x), timer scales with playback speed
- Progress bar with turn dots, bookmark dots, and hover tooltip
- Bookmarks / chapters with dropdown navigation
- Toggle visibility of thinking blocks and tool calls
- Keyboard shortcuts: Space/K (play/pause), arrows/H/L (step)
- Splash screen with play button, skip via click or keyboard
- Bottom-anchored scrolling with smooth animations
- Embeddable via iframe with adaptive layout

### Themes
- Built-in themes: `tokyo-night` (default), `monokai`, `solarized-dark`, `github-light`, `dracula`, `bubbles`
- Custom themes via `--theme-file` with JSON color overrides
- `extraCss` support for full layout customization

### Parser
- Handles Claude Code streaming format (incremental content blocks)
- Merges consecutive command messages (slash commands + stdout)
- Strips internal tags (`<system-reminder>`, `<local-command-caveat>`, etc.)
- Filters empty turns and "No response requested." boilerplate
- Time range and turn range filtering

### Output
- Single self-contained HTML file, zero external dependencies
- Deflate + base64 compression (~60-70% size reduction)
- Minified CSS/JS via esbuild
- Automatic secret redaction (API keys, tokens, connection strings, etc.)
