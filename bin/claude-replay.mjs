#!/usr/bin/env node

/**
 * CLI entry point for claude-replay.
 */

import { parseArgs } from "node:util";
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { parseTranscript, filterTurns, detectFormat, applyPacedTiming } from "../src/parser.mjs";
import { render } from "../src/renderer.mjs";
import { getTheme, loadThemeFile, listThemes } from "../src/themes.mjs";

const options = {
  output: { type: "string", short: "o" },
  turns: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  speed: { type: "string", default: "1" },
  "no-thinking": { type: "boolean", default: false },
  "no-tool-calls": { type: "boolean", default: false },
  theme: { type: "string", default: "tokyo-night" },
  "theme-file": { type: "string" },
  "list-themes": { type: "boolean", default: false },
  "no-redact": { type: "boolean", default: false },
  title: { type: "string" },
  "user-label": { type: "string", default: "User" },
  "assistant-label": { type: "string" },
  timing: { type: "string" },
  mark: { type: "string", multiple: true },
  bookmarks: { type: "string" },
  "no-minify": { type: "boolean", default: false },
  "no-compress": { type: "boolean", default: false },
  "filename-prefix": { type: "string", default: "" },
  meta: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

let parsed;
try {
  parsed = parseArgs({ options, allowPositionals: true });
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}

const { values, positionals } = parsed;

if (values.help) {
  console.log(`Usage: claude-replay [input.jsonl] [options]

Convert Claude Code session transcripts into embeddable HTML replays.
Run with no arguments to launch an interactive session picker.

Options:
  -o, --output FILE|DIR   Output HTML file, or directory when using picker (default: stdout)
  --turns N-M             Only include turns N through M
  --from TIMESTAMP        Start time filter (ISO 8601)
  --to TIMESTAMP          End time filter (ISO 8601)
  --speed N               Initial playback speed (default: 1.0)
  --no-thinking           Hide thinking blocks by default
  --no-tool-calls         Hide tool call blocks by default
  --title TEXT             Page title (default: derived from input path)
  --no-redact             Disable secret redaction in output
  --theme NAME            Built-in theme (default: tokyo-night)
  --theme-file FILE       Custom theme JSON file (overrides --theme)
  --user-label NAME       Label for user messages (default: User)
  --assistant-label NAME  Label for assistant messages (default: auto-detected)
  --timing MODE           Timestamp mode: auto, real, paced (default: auto)
  --mark "N:Label"        Add a bookmark at turn N (repeatable)
  --bookmarks FILE        JSON file with bookmarks [{turn, label}]
  --no-minify             Use unminified template (default: minified if available)
  --no-compress           Embed raw JSON instead of compressed (for older browsers)
  --list-themes           List available built-in themes and exit
  --filename-prefix STR   Prefix for auto-generated filenames (picker only, default: none)
  --meta                  Write a .meta.json sidecar with session metadata (picker only)
  -h, --help              Show this help message`);
  process.exit(0);
}

if (values["list-themes"]) {
  for (const name of listThemes()) {
    console.log(name);
  }
  process.exit(0);
}

let inputFile = positionals[0];
let pickerMeta = null;
if (!inputFile) {
  if (!process.stdin.isTTY) {
    console.error("Error: input file is required. Usage: claude-replay <input.jsonl> [options]");
    process.exit(1);
  }

  const { discoverSessions, showPicker, generateFilename, uniqueFilename } = await import("../src/picker.mjs");
  const { sessions, projectName, totalBeforeFilter } = discoverSessions(process.cwd());

  if (sessions.length === 0) {
    const msg = totalBeforeFilter > 0
      ? `No sessions found for ${projectName} (${totalBeforeFilter} sessions filtered as empty). Use claude-replay <file.jsonl> to open a specific file.`
      : `No Claude Code sessions found. Run claude-replay from a project directory that has Claude Code session history.`;
    console.error(msg);
    process.exit(1);
  }

  const picked = await showPicker(sessions, projectName);
  if (!picked) process.exit(0); // User cancelled with Escape

  inputFile = picked.fullPath;

  // Auto-generate output filename
  const datePrefix = picked.modified
    ? new Date(picked.modified).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const prefix = values["filename-prefix"];
  const generatedName = generateFilename(picked.title, datePrefix, prefix);

  if (values.output) {
    // If -o is a directory, write into it with the generated filename
    let isDir = false;
    try {
      isDir = statSync(values.output).isDirectory();
    } catch {
      isDir = values.output.endsWith("/");
    }
    if (isDir) {
      if (!existsSync(values.output)) {
        mkdirSync(values.output, { recursive: true });
      }
      values.output = uniqueFilename(join(values.output, generatedName));
    }
  } else {
    values.output = uniqueFilename(generatedName);
  }

  pickerMeta = {
    filename: basename(values.output),
    title: picked.title || basename(values.output, ".html"),
    date: picked.modified || new Date().toISOString(),
    messageCount: picked.messageCount ?? 0,
    project: projectName,
  };
}

if (!existsSync(inputFile)) {
  console.error(`Error: file not found: ${inputFile}`);
  process.exit(1);
}

// Resolve theme
let theme;
if (values["theme-file"]) {
  if (!existsSync(values["theme-file"])) {
    console.error(`Error: theme file not found: ${values["theme-file"]}`);
    process.exit(1);
  }
  try {
    theme = loadThemeFile(values["theme-file"]);
  } catch (e) {
    console.error(`Error loading theme file: ${e.message}`);
    process.exit(1);
  }
} else {
  try {
    theme = getTheme(values.theme);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

// Parse turn range
let turnRange;
if (values.turns) {
  const parts = values.turns.split("-");
  if (parts.length !== 2) {
    console.error(`Error: invalid turn range '${values.turns}' (expected N-M)`);
    process.exit(1);
  }
  const start = parseInt(parts[0], 10);
  const end = parseInt(parts[1], 10);
  if (isNaN(start) || isNaN(end)) {
    console.error(`Error: invalid turn range '${values.turns}' (expected integers)`);
    process.exit(1);
  }
  turnRange = [start, end];
}

// Parse and filter
const format = detectFormat(inputFile);
let turns = parseTranscript(inputFile);
turns = filterTurns(turns, {
  turnRange,
  timeFrom: values.from,
  timeTo: values.to,
});

if (turns.length === 0) {
  console.error("Warning: no turns found after filtering.");
}

// Apply timing mode: auto (default), real, paced
const timing = values.timing || "auto";
if (!["auto", "real", "paced"].includes(timing)) {
  console.error(`Error: unknown --timing mode "${timing}". Use auto, real, or paced.`);
  process.exit(1);
}
const hasTimestamps = turns.some((t) => t.timestamp);
if (timing === "paced" || (timing === "auto" && !hasTimestamps)) {
  applyPacedTiming(turns);
}

const speed = parseFloat(values.speed) || 1.0;

// Derive title: CLI override > parent folder name > filename
let title = values.title;
if (!title) {
  const dir = basename(dirname(inputFile));
  // Claude projects dirs look like "-Users-enrico-Personal-project-name"
  // Extract the last segment as the project name
  const parts = dir.replace(/^-+/, "").split("-");
  const projectName = parts.length > 1 ? parts.slice(-2).join("-") : parts[0];
  if (projectName && projectName !== "." && projectName !== "/") {
    title = "Replay — " + projectName;
  } else {
    title = "Replay — " + basename(inputFile, ".jsonl");
  }
}

// Parse bookmarks from --mark and --bookmarks
let bookmarks = [];

if (values.mark) {
  for (const m of values.mark) {
    const sep = m.indexOf(":");
    if (sep === -1) {
      console.error(`Error: invalid --mark format '${m}' (expected N:Label)`);
      process.exit(1);
    }
    const turn = parseInt(m.slice(0, sep), 10);
    const label = m.slice(sep + 1);
    if (isNaN(turn)) {
      console.error(`Error: invalid turn number in --mark '${m}'`);
      process.exit(1);
    }
    bookmarks.push({ turn, label });
  }
}

if (values.bookmarks) {
  if (!existsSync(values.bookmarks)) {
    console.error(`Error: bookmarks file not found: ${values.bookmarks}`);
    process.exit(1);
  }
  try {
    const data = JSON.parse(readFileSync(values.bookmarks, "utf-8"));
    if (!Array.isArray(data)) {
      console.error("Error: bookmarks file must contain a JSON array");
      process.exit(1);
    }
    for (const item of data) {
      if (typeof item.turn !== "number" || typeof item.label !== "string") {
        console.error(`Error: each bookmark must have numeric 'turn' and string 'label'`);
        process.exit(1);
      }
      bookmarks.push({ turn: item.turn, label: item.label });
    }
  } catch (e) {
    if (e.message.startsWith("Error:")) throw e;
    console.error(`Error: failed to parse bookmarks file: ${e.message}`);
    process.exit(1);
  }
}

bookmarks.sort((a, b) => a.turn - b.turn);

const html = render(turns, {
  speed,
  showThinking: !values["no-thinking"],
  showToolCalls: !values["no-tool-calls"],
  theme,
  redactSecrets: !values["no-redact"],
  userLabel: values["user-label"],
  assistantLabel: values["assistant-label"] || (format === "cursor" ? "Assistant" : "Claude"),
  title,
  bookmarks,
  minified: !values["no-minify"],
  compress: !values["no-compress"],
});

if (values.output) {
  writeFileSync(values.output, html);
  console.error(`Wrote ${values.output} (${turns.length} turns)`);

  // Write sidecar metadata if requested (picker only)
  if (values.meta && !pickerMeta) {
    console.error("Warning: --meta only works with the interactive picker");
  }
  if (values.meta && pickerMeta) {
    const metaPath = values.output.replace(/\.html$/, ".meta.json");
    writeFileSync(metaPath, JSON.stringify(pickerMeta, null, 2) + "\n");
    console.error(`Wrote ${metaPath}`);
  }
} else {
  process.stdout.write(html);
}
