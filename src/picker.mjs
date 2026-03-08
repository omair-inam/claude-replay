/**
 * Session discovery and interactive picker for Claude Code sessions.
 */

import {
  readdirSync,
  existsSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createNodeApp } from "@rezi-ui/node";
import { ui, rgb } from "@rezi-ui/core";

// ---------------------------------------------------------------------------
// Task 2: Encode CWD to project directory
// ---------------------------------------------------------------------------

/**
 * Encode an absolute path to Claude Code's project directory name format.
 * /Users/omair/projects/foo → -Users-omair-projects-foo
 * @param {string} cwd
 * @returns {string}
 */
export function encodeProjectDir(cwd) {
  const normalized = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return normalized.replace(/\//g, "-");
}

// ---------------------------------------------------------------------------
// Task 3: Find project directories (including worktrees)
// ---------------------------------------------------------------------------

/**
 * Find Claude Code project directories matching the given CWD.
 * Includes the main project dir and any worktree dirs.
 * @param {string} cwd - Absolute path to the project
 * @param {string} [claudeDir] - Path to ~/.claude (override for testing)
 * @returns {{ path: string, dirName: string, isWorktree: boolean, worktreeBranch: string|null }[]}
 */
export function findProjectDirs(cwd, claudeDir) {
  const claudeBase = claudeDir || join(homedir(), ".claude");
  const projectsDir = join(claudeBase, "projects");
  if (!existsSync(projectsDir)) return [];

  const encoded = encodeProjectDir(cwd);
  const results = [];

  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === encoded) {
      results.push({
        path: join(projectsDir, name),
        dirName: name,
        isWorktree: false,
        worktreeBranch: null,
      });
    } else if (name.startsWith(encoded + "--worktrees-")) {
      const branch = name.slice((encoded + "--worktrees-").length);
      results.push({
        path: join(projectsDir, name),
        dirName: name,
        isWorktree: true,
        worktreeBranch: branch,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Task 4: Load sessions by scanning .jsonl files
// ---------------------------------------------------------------------------

/**
 * Test whether a user message string is system noise (not a real user prompt).
 * @param {string} text
 * @returns {boolean}
 */
function isSystemNoise(text) {
  if (!text || text.length < 3) return true;
  if (text.startsWith("<local-command-caveat>")) return true;
  if (text.startsWith("<local-command-stdout>")) return true;
  if (text.startsWith("<command-message>")) return true;
  if (text.startsWith("<command-name>")) return true;
  if (text.startsWith("<system-reminder>")) return true;
  if (text.startsWith("<system>")) return true;
  if (text.startsWith("Warmup")) return true;
  return false;
}

/**
 * Extract the text content from a user message entry.
 * @param {object} obj - Parsed JSONL entry
 * @returns {string|null}
 */
function extractUserText(obj) {
  const msg = obj.message?.content;
  if (typeof msg === "string") return msg;
  if (Array.isArray(msg)) {
    const tp = msg.find((p) => p.type === "text");
    if (tp) return tp.text;
  }
  return null;
}

/**
 * Read the first 16KB of a JSONL file and return the first non-noise user prompt.
 * @param {string} fullPath
 * @returns {string|null}
 */
function extractFirstRealPrompt(fullPath) {
  try {
    const fd = openSync(fullPath, "r");
    try {
      const size = Math.min(fstatSync(fd).size, 16384);
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      for (const line of buf.toString("utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.type === "user" || obj.type === "human") {
            const text = extractUserText(obj);
            if (text && !isSystemNoise(text)) return text;
          }
        } catch { /* skip */ }
      }
    } finally {
      closeSync(fd);
    }
  } catch { /* non-fatal */ }
  return null;
}

/**
 * Extract metadata from a JSONL session file via single-pass parse.
 * Counts messages using claude-history's rules: skip warmup, empty, system noise,
 * deduplicate streaming assistant entries by message.id.
 * @param {string} fullPath
 * @param {number} fileSize
 * @returns {{ firstPrompt: string|null, summary: string|null, messageCount: number }|null}
 */
function extractFileMetadata(fullPath, fileSize) {
  if (fileSize === 0) return null;

  let content;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }

  let messageCount = 0;
  let firstPrompt = null;
  let summary = null;
  let seenRealUser = false;
  let skipNextAssistant = false;
  const seenAsstIds = new Set();

  let pos = 0;
  while (pos < content.length) {
    const nl = content.indexOf("\n", pos);
    const end = nl === -1 ? content.length : nl;
    const line = content.substring(pos, end);
    pos = end + 1;
    if (line.length < 3) continue;

    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === "user" || obj.type === "human") {
      const text = extractUserText(obj);
      if (!text || text.trim().length === 0) continue;
      if (text === "Warmup" || text.startsWith("Warmup")) {
        skipNextAssistant = true;
        continue;
      }
      if (isSystemNoise(text)) continue;
      messageCount++;
      seenRealUser = true;
      if (!firstPrompt) firstPrompt = text;
    } else if (obj.type === "assistant") {
      if (skipNextAssistant) { skipNextAssistant = false; continue; }
      if (!seenRealUser) continue;
      const msgId = obj.message?.id;
      if (msgId) {
        if (seenAsstIds.has(msgId)) continue;
        seenAsstIds.add(msgId);
      }
      const c = obj.message?.content;
      if (!c || (Array.isArray(c) && c.length === 0)) continue;
      messageCount++;
    } else if (obj.type === "summary" && obj.summary) {
      summary = obj.summary;
    }
  }

  if (messageCount === 0 && !firstPrompt) return null;
  return { firstPrompt, summary, messageCount };
}

/**
 * Load sessions by scanning .jsonl files in each project dir.
 * Uses sessions-index.json as supplementary metadata when available.
 * Excludes agent-*.jsonl subconversation files.
 * @param {{ path: string, dirName: string, isWorktree: boolean, worktreeBranch: string|null }[]} projectDirs
 * @returns {object[]}
 */
export function loadSessions(projectDirs) {
  const sessions = [];

  for (const pd of projectDirs) {
    // Build index lookup for metadata enrichment
    const indexMap = new Map();
    const indexPath = join(pd.path, "sessions-index.json");
    if (existsSync(indexPath)) {
      try {
        const data = JSON.parse(readFileSync(indexPath, "utf-8"));
        if (Array.isArray(data.entries)) {
          for (const entry of data.entries) {
            indexMap.set(entry.sessionId, entry);
          }
        }
      } catch { /* ignore corrupt index */ }
    }

    // Scan for .jsonl files — the authoritative source of sessions
    let dirEntries;
    try {
      dirEntries = readdirSync(pd.path, { withFileTypes: true });
    } catch { continue; }

    for (const dirEntry of dirEntries) {
      if (!dirEntry.isFile()) continue;
      if (!dirEntry.name.endsWith(".jsonl") || dirEntry.name.startsWith("agent-")) continue;

      const fullPath = join(pd.path, dirEntry.name);
      const sessionId = dirEntry.name.slice(0, -6); // strip .jsonl
      const indexEntry = indexMap.get(sessionId);

      if (indexEntry) {
        // Use index metadata, override fullPath with actual file location
        sessions.push({
          ...indexEntry,
          fullPath,
          isWorktree: pd.isWorktree,
          worktreeBranch: pd.worktreeBranch,
        });
      } else {
        // Extract metadata directly from the file
        let fileStat;
        try { fileStat = statSync(fullPath); } catch { continue; }

        const meta = extractFileMetadata(fullPath, fileStat.size);
        if (!meta) continue;

        sessions.push({
          sessionId,
          fullPath,
          summary: meta.summary,
          firstPrompt: meta.firstPrompt,
          messageCount: meta.messageCount,
          created: fileStat.birthtime.toISOString(),
          modified: fileStat.mtime.toISOString(),
          gitBranch: null,
          isWorktree: pd.isWorktree,
          worktreeBranch: pd.worktreeBranch,
        });
      }
    }
  }

  return sessions;
}

// ---------------------------------------------------------------------------
// Task 5: Extract custom title from JSONL tail
// ---------------------------------------------------------------------------

/**
 * Extract the last custom-title from a JSONL file by reading the tail.
 * Reads the last 4KB to avoid scanning large files.
 * @param {string} jsonlPath
 * @returns {string|null}
 */
export function extractCustomTitle(jsonlPath) {
  let fd;
  try {
    fd = openSync(jsonlPath, "r");
  } catch {
    return null;
  }

  try {
    const stat = fstatSync(fd);
    const readSize = Math.min(stat.size, 4096);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    const tail = buf.toString("utf-8");

    let lastTitle = null;
    for (const line of tail.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.includes('"custom-title"')) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.type === "custom-title" && obj.customTitle) {
          lastTitle = obj.customTitle;
        }
      } catch {
        continue;
      }
    }

    return lastTitle;
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Task 6: Title resolution priority chain
// ---------------------------------------------------------------------------

const SKIP_SUMMARY_PATTERNS = [/^user exited/i, /^no prompt$/i, /^untitled$/i];

/**
 * Resolve the display title for a session.
 * Priority: customTitle > summary (if not a skip pattern) > null
 * @param {{ customTitle: string|null, summary: string|null }} session
 * @returns {string|null}
 */
export function resolveTitle(session) {
  if (session.customTitle) return session.customTitle;
  if (session.summary && !SKIP_SUMMARY_PATTERNS.some((p) => p.test(session.summary))) {
    return session.summary;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Task 7: Filter low-value sessions
// ---------------------------------------------------------------------------

/**
 * Filter out low-value sessions.
 * Returns filtered array with a `totalBeforeFilter` property.
 * @param {object[]} sessions
 * @returns {object[] & { totalBeforeFilter: number }}
 */
export function filterSessions(sessions) {
  const total = sessions.length;
  const filtered = sessions.filter((s) => {
    if (s.fullPath && !existsSync(s.fullPath)) return false;
    if ((s.messageCount ?? 0) <= 2) return false;
    if (!s.customTitle && s.summary && SKIP_SUMMARY_PATTERNS.some((p) => p.test(s.summary))) return false;
    return true;
  });
  filtered.totalBeforeFilter = total;
  return filtered;
}

// ---------------------------------------------------------------------------
// Task 8: Format duration and date
// ---------------------------------------------------------------------------

/**
 * Format milliseconds to a compact duration string.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

/**
 * Format an ISO date string to "Mon DD, HH:MM" in local time.
 * @param {string} isoString
 * @returns {string}
 */
export function formatDate(isoString) {
  const d = new Date(isoString);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${mon} ${day}, ${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Task 9: Generate output filename
// ---------------------------------------------------------------------------

/**
 * Generate an output filename from a session title and date.
 * @param {string|null} title
 * @param {string} datePrefix - YYYY-MM-DD format
 * @returns {string}
 */
export function generateFilename(title, datePrefix) {
  const slug = (title || "session")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `replay-${datePrefix}-${slug}.html`;
}

/**
 * Find a non-colliding filename by appending -2, -3, etc.
 * @param {string} filename
 * @returns {string}
 */
export function uniqueFilename(filename) {
  if (!existsSync(filename)) return filename;
  const base = filename.replace(/\.html$/, "");
  let i = 2;
  while (existsSync(`${base}-${i}.html`)) i++;
  return `${base}-${i}.html`;
}

// ---------------------------------------------------------------------------
// Task 10: Session discovery orchestrator
// ---------------------------------------------------------------------------

/**
 * Decode an encoded project dir name to a human-readable project name.
 * -Users-omair-projects-foo → foo
 * @param {string} encoded
 * @returns {string}
 */
export function decodeProjectName(encoded) {
  const stripped = encoded.replace(/^-+/, "");
  const parts = stripped.split("-");
  if (parts.length >= 4) {
    return parts.slice(3).join("-");
  }
  return parts[parts.length - 1] || stripped;
}

/**
 * Discover all sessions for the current project.
 * Finds project dirs, loads index, enriches with custom titles, filters, sorts.
 * @param {string} cwd
 * @param {string} [claudeDir]
 * @returns {{ sessions: object[], projectName: string, totalBeforeFilter: number }}
 */
export function discoverSessions(cwd, claudeDir) {
  const projectDirs = findProjectDirs(cwd, claudeDir);
  const projectName = projectDirs.length > 0
    ? decodeProjectName(projectDirs.find((d) => !d.isWorktree)?.dirName || projectDirs[0].dirName)
    : basename(cwd);

  const raw = loadSessions(projectDirs);

  // Enrich with custom titles and clean up firstPrompt noise
  for (const session of raw) {
    session.customTitle = existsSync(session.fullPath)
      ? extractCustomTitle(session.fullPath)
      : null;
    session.title = resolveTitle(session);
    session.durationMs = session.modified && session.created
      ? new Date(session.modified).getTime() - new Date(session.created).getTime()
      : 0;
    // If firstPrompt is system noise, extract a real one from file head
    if (isSystemNoise(session.firstPrompt) && existsSync(session.fullPath)) {
      session.firstPrompt = extractFirstRealPrompt(session.fullPath);
    }
  }

  const filtered = filterSessions(raw);

  // Sort by modified descending (newest first)
  filtered.sort((a, b) => {
    const tA = a.modified ? new Date(a.modified).getTime() : 0;
    const tB = b.modified ? new Date(b.modified).getTime() : 0;
    return tB - tA;
  });

  return {
    sessions: filtered,
    projectName,
    totalBeforeFilter: filtered.totalBeforeFilter,
  };
}

// ---------------------------------------------------------------------------
// Task 11: Interactive session picker TUI
// ---------------------------------------------------------------------------

const YELLOW = rgb(255, 214, 102);
const SLATE = rgb(140, 155, 175);
const ACCENT = rgb(187, 154, 247);

/**
 * Show the interactive session picker TUI.
 * @param {object[]} sessions - Enriched session objects from discoverSessions
 * @param {string} projectName
 * @returns {Promise<object|null>} Selected session or null if user cancelled
 */
export async function showPicker(sessions, projectName) {
  let selected = null;

  const app = createNodeApp({
    initialState: {
      query: "",
    },
  });

  const exit = () => { app.stop(); };

  // Build key handlers: printable chars → query, backspace → delete, escape → exit
  // virtualList handles arrow keys, Enter, page up/down natively
  const keyHandlers = {
    escape: { handler: () => { exit(); } },
    backspace: { handler: (ctx) => ctx.update((s) => ({ ...s, query: s.query.slice(0, -1) })) },
    space: { handler: (ctx) => ctx.update((s) => ({ ...s, query: s.query + " " })) },
  };
  for (let c = 97; c <= 122; c++) {
    const ch = String.fromCharCode(c);
    keyHandlers[ch] = { handler: (ctx) => ctx.update((s) => ({ ...s, query: s.query + ch })) };
  }
  for (let c = 48; c <= 57; c++) {
    const ch = String.fromCharCode(c);
    keyHandlers[ch] = { handler: (ctx) => ctx.update((s) => ({ ...s, query: s.query + ch })) };
  }
  for (const ch of "-_./:@#") {
    keyHandlers[ch] = { handler: (ctx) => ctx.update((s) => ({ ...s, query: s.query + ch })) };
  }
  app.keys(keyHandlers);

  app.view((state) => {
    const query = state.query.toLowerCase();
    const filtered = query
      ? sessions.filter((s) =>
          (s.customTitle || "").toLowerCase().includes(query) ||
          (s.summary || "").toLowerCase().includes(query) ||
          (s.firstPrompt || "").toLowerCase().includes(query)
        )
      : sessions;

    const counter = `${filtered.length}/${sessions.length}`;

    return ui.column({ gap: 0 }, [
      ui.row({ gap: 1, items: "center", pb: 1 }, [
        ui.text("> ", { fg: ACCENT }),
        state.query
          ? ui.text(`${state.query}█`)
          : ui.text("Filter sessions...", { dim: true }),
        ui.spacer({ flex: 1 }),
        ui.text(counter, { dim: true }),
      ]),
      ui.virtualList({
        id: "sessions",
        items: filtered,
        itemHeight: 2,
        keyboardNavigation: true,
        focusConfig: { autoFocus: true },
        renderItem: (session, index, focused) => {
          const name = session.isWorktree
            ? `${projectName} (wt: ${session.worktreeBranch})`
            : projectName;
          // Line 1: project · customTitle · summary  |  meta
          const customTitlePart = session.customTitle ? ` · ${session.customTitle}` : "";
          const summaryPart = session.summary && session.summary !== session.customTitle
            ? ` · ${session.summary}` : "";
          const meta = [
            `${session.messageCount} msgs`,
            formatDuration(session.durationMs),
            formatDate(session.modified),
          ].join(" · ");

          // Line 2: first real user prompt (preview)
          const preview = (session.firstPrompt || "").replace(/\n/g, " ").slice(0, 120);

          return ui.column({ gap: 0, pl: 1, style: focused ? { bg: rgb(36, 37, 58) } : {} }, [
            ui.row({ gap: 0 }, [
              ui.text(name),
              ui.text(customTitlePart, { fg: YELLOW }),
              ui.text(summaryPart, { fg: SLATE, flex: 1, textOverflow: "ellipsis" }),
              ui.text(` ${meta}`, { dim: true }),
            ]),
            ui.text(`  ${preview}`, { dim: true }),
          ]);
        },
        onSelect: (item) => {
          selected = item;
          exit();
        },
      }),
    ]);
  });

  await app.run();
  return selected;
}
