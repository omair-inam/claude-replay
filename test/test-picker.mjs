import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  encodeProjectDir,
  findProjectDirs,
  loadSessions,
  extractCustomTitle,
  resolveTitle,
  filterSessions,
  formatDuration,
  formatDate,
  generateFilename,
  uniqueFilename,
  discoverSessions,
} from "../src/picker.mjs";

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/** Create a temp directory simulating ~/.claude/projects/ structure. */
function makeTempClaudeDir() {
  const base = mkdtempSync(join(tmpdir(), "picker-test-"));
  const projects = join(base, ".claude", "projects");
  mkdirSync(projects, { recursive: true });
  return { base, projects };
}

// ---------------------------------------------------------------------------
// Task 2: encodeProjectDir
// ---------------------------------------------------------------------------

describe("encodeProjectDir", () => {
  it("encodes absolute path by replacing / with - and prepending -", () => {
    assert.equal(
      encodeProjectDir("/Users/omair/projects/claude-replay"),
      "-Users-omair-projects-claude-replay"
    );
  });

  it("handles paths with trailing slash", () => {
    assert.equal(
      encodeProjectDir("/Users/omair/projects/claude-replay/"),
      "-Users-omair-projects-claude-replay"
    );
  });

  it("handles single-segment paths", () => {
    assert.equal(encodeProjectDir("/tmp"), "-tmp");
  });
});

// ---------------------------------------------------------------------------
// Task 3: findProjectDirs
// ---------------------------------------------------------------------------

describe("findProjectDirs", () => {
  it("finds the exact project directory", () => {
    const { base, projects } = makeTempClaudeDir();
    const dir = join(projects, "-Users-omair-projects-foo");
    mkdirSync(dir);
    writeFileSync(join(dir, "sessions-index.json"), "{}");

    const result = findProjectDirs("/Users/omair/projects/foo", join(base, ".claude"));
    assert.equal(result.length, 1);
    assert.equal(result[0].dirName, "-Users-omair-projects-foo");
    assert.equal(result[0].isWorktree, false);
  });

  it("includes worktree directories", () => {
    const { base, projects } = makeTempClaudeDir();
    const main = join(projects, "-Users-omair-projects-foo");
    const wt = join(projects, "-Users-omair-projects-foo--worktrees-feature-x");
    mkdirSync(main);
    mkdirSync(wt);
    writeFileSync(join(main, "sessions-index.json"), "{}");
    writeFileSync(join(wt, "sessions-index.json"), "{}");

    const result = findProjectDirs("/Users/omair/projects/foo", join(base, ".claude"));
    assert.equal(result.length, 2);
    const names = result.map((r) => r.dirName).sort();
    // Lexicographic sort: plain dir comes before --worktrees- suffix
    assert.ok(!names[0].includes("--worktrees-"));
    assert.ok(names[1].includes("--worktrees-"));
  });

  it("returns empty array when no project directory exists", () => {
    const { base } = makeTempClaudeDir();
    const result = findProjectDirs("/Users/omair/projects/nonexistent", join(base, ".claude"));
    assert.equal(result.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Task 4: loadSessions
// ---------------------------------------------------------------------------

describe("loadSessions", () => {
  it("uses index metadata when .jsonl file and index entry both exist", () => {
    const { projects } = makeTempClaudeDir();
    const dir = join(projects, "-Users-omair-projects-foo");
    mkdirSync(dir);

    // Create the actual JSONL file
    writeFileSync(join(dir, "abc-123.jsonl"), [
      JSON.stringify({ type: "user", message: { content: "Add login flow" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Sure" }] } }),
    ].join("\n"));

    // Create index with richer metadata
    writeFileSync(join(dir, "sessions-index.json"), JSON.stringify({
      version: 1,
      entries: [{
        sessionId: "abc-123",
        fullPath: join(dir, "abc-123.jsonl"),
        summary: "Built auth system",
        firstPrompt: "Add login flow",
        messageCount: 25,
        created: "2026-03-01T10:00:00Z",
        modified: "2026-03-01T12:30:00Z",
        gitBranch: "main",
      }],
    }));

    const sessions = loadSessions([{
      path: dir,
      dirName: "-Users-omair-projects-foo",
      isWorktree: false,
      worktreeBranch: null,
    }]);

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, "abc-123");
    assert.equal(sessions[0].summary, "Built auth system");
    assert.equal(sessions[0].fullPath, join(dir, "abc-123.jsonl"));
    assert.equal(sessions[0].isWorktree, false);
  });

  it("discovers .jsonl files not in the index", () => {
    const { projects } = makeTempClaudeDir();
    const dir = join(projects, "-Users-omair-projects-foo");
    mkdirSync(dir);

    // No index — just a JSONL file
    writeFileSync(join(dir, "def-456.jsonl"), [
      JSON.stringify({ type: "user", message: { content: "Hello world" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hi" }] } }),
    ].join("\n"));

    const sessions = loadSessions([{
      path: dir,
      dirName: "-Users-omair-projects-foo",
      isWorktree: false,
      worktreeBranch: null,
    }]);

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, "def-456");
    assert.equal(sessions[0].firstPrompt, "Hello world");
    assert.equal(sessions[0].messageCount, 2);
  });

  it("skips agent-*.jsonl files", () => {
    const { projects } = makeTempClaudeDir();
    const dir = join(projects, "-Users-omair-projects-foo");
    mkdirSync(dir);

    writeFileSync(join(dir, "main-session.jsonl"), [
      JSON.stringify({ type: "user", message: { content: "Fix the login bug" } }),
    ].join("\n"));
    writeFileSync(join(dir, "agent-sub-1.jsonl"), [
      JSON.stringify({ type: "user", message: { content: "Sub-agent task" } }),
    ].join("\n"));

    const sessions = loadSessions([{
      path: dir,
      dirName: "-Users-omair-projects-foo",
      isWorktree: false,
      worktreeBranch: null,
    }]);

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, "main-session");
  });

  it("tags worktree sessions", () => {
    const { projects } = makeTempClaudeDir();
    const dir = join(projects, "-Users-omair-projects-foo--worktrees-feat-x");
    mkdirSync(dir);

    writeFileSync(join(dir, "wt-1.jsonl"), [
      JSON.stringify({ type: "user", message: { content: "Fix bug" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "On it" }] } }),
    ].join("\n"));

    const sessions = loadSessions([{
      path: dir,
      dirName: "-Users-omair-projects-foo--worktrees-feat-x",
      isWorktree: true,
      worktreeBranch: "feat-x",
    }]);

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].isWorktree, true);
    assert.equal(sessions[0].worktreeBranch, "feat-x");
  });

  it("returns empty array when no .jsonl files exist", () => {
    const { projects } = makeTempClaudeDir();
    const dir = join(projects, "-Users-omair-projects-foo");
    mkdirSync(dir);

    const sessions = loadSessions([{
      path: dir,
      dirName: "-Users-omair-projects-foo",
      isWorktree: false,
      worktreeBranch: null,
    }]);

    assert.equal(sessions.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Task 5: extractCustomTitle
// ---------------------------------------------------------------------------

describe("extractCustomTitle", () => {
  it("extracts the last custom-title from a JSONL file", () => {
    const dir = mkdtempSync(join(tmpdir(), "title-test-"));
    const path = join(dir, "session.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "user", message: { content: "hello" }, timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "custom-title", customTitle: "first name", sessionId: "abc" }),
      JSON.stringify({ type: "custom-title", customTitle: "renamed session", sessionId: "abc" }),
    ].join("\n"));

    assert.equal(extractCustomTitle(path), "renamed session");
  });

  it("returns null when no custom-title exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "title-test-"));
    const path = join(dir, "session.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "user", message: { content: "hello" }, timestamp: "2026-01-01T00:00:00Z" }),
    ].join("\n"));

    assert.equal(extractCustomTitle(path), null);
  });

  it("returns null for nonexistent file", () => {
    assert.equal(extractCustomTitle("/nonexistent/file.jsonl"), null);
  });
});

// ---------------------------------------------------------------------------
// Task 6: resolveTitle
// ---------------------------------------------------------------------------

describe("resolveTitle", () => {
  it("prefers customTitle when present", () => {
    assert.equal(resolveTitle({ customTitle: "My Session", summary: "auto summary" }), "My Session");
  });

  it("falls back to summary when no customTitle", () => {
    assert.equal(resolveTitle({ customTitle: null, summary: "Built auth system" }), "Built auth system");
  });

  it("returns null for skip-pattern summaries", () => {
    assert.equal(resolveTitle({ customTitle: null, summary: "User Exited Claude Code Session" }), null);
    assert.equal(resolveTitle({ customTitle: null, summary: "No prompt" }), null);
    assert.equal(resolveTitle({ customTitle: null, summary: "untitled" }), null);
  });

  it("returns null when both are absent", () => {
    assert.equal(resolveTitle({ customTitle: null, summary: null }), null);
  });
});

// ---------------------------------------------------------------------------
// Task 7: filterSessions
// ---------------------------------------------------------------------------

describe("filterSessions", () => {
  const makeSessions = (overrides) =>
    overrides.map((o, i) => ({
      sessionId: `s${i}`,
      fullPath: null,
      summary: "Good session",
      firstPrompt: "Do something",
      messageCount: 10,
      created: "2026-03-01T10:00:00Z",
      modified: "2026-03-01T12:00:00Z",
      ...o,
    }));

  it("filters out sessions with messageCount <= 2", () => {
    const sessions = makeSessions([{ messageCount: 1 }, { messageCount: 10 }]);
    const result = filterSessions(sessions);
    assert.equal(result.length, 1);
    assert.equal(result[0].messageCount, 10);
  });

  it("filters out skip-pattern summaries", () => {
    const sessions = makeSessions([
      { summary: "User Exited Claude Code Session" },
      { summary: "No prompt" },
      { summary: "untitled" },
      { summary: "Real work" },
    ]);
    const result = filterSessions(sessions);
    assert.equal(result.length, 1);
    assert.equal(result[0].summary, "Real work");
  });

  it("keeps sessions with good data", () => {
    const sessions = makeSessions([{ messageCount: 50, summary: "Big session" }]);
    const result = filterSessions(sessions);
    assert.equal(result.length, 1);
  });

  it("returns totalBeforeFilter count", () => {
    const sessions = makeSessions([{ messageCount: 1 }, { messageCount: 10 }]);
    const result = filterSessions(sessions);
    assert.equal(result.totalBeforeFilter, 2);
  });

  it("keeps sessions with skip-pattern summary if customTitle is set", () => {
    const sessions = makeSessions([
      { summary: "User Exited Claude Code Session", customTitle: "My Named Session" },
    ]);
    const result = filterSessions(sessions);
    assert.equal(result.length, 1);
  });

  it("filters out sessions whose JSONL file does not exist", () => {
    const sessions = makeSessions([
      { fullPath: "/nonexistent/missing.jsonl", messageCount: 10 },
      { fullPath: null, messageCount: 10 },
    ]);
    const result = filterSessions(sessions);
    assert.equal(result.length, 1);
    assert.equal(result[0].fullPath, null);
  });
});

// ---------------------------------------------------------------------------
// Task 8: formatDuration and formatDate
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("formats hours and minutes", () => {
    // 2h 30m = 9000000ms
    assert.equal(formatDuration(9000000), "2h 30m");
  });

  it("formats minutes only when under 1 hour", () => {
    assert.equal(formatDuration(1800000), "30m");
  });

  it("formats as <1m for very short durations", () => {
    assert.equal(formatDuration(30000), "<1m");
  });

  it("handles zero", () => {
    assert.equal(formatDuration(0), "<1m");
  });
});

describe("formatDate", () => {
  it("formats ISO date to Mon DD, HH:MM", () => {
    // March 7, 2026 15:24 UTC — the exact format depends on locale but test the shape
    const result = formatDate("2026-03-07T15:24:00Z");
    assert.match(result, /Mar 07, \d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// Task 9: generateFilename
// ---------------------------------------------------------------------------

describe("generateFilename", () => {
  it("generates slug from title and date", () => {
    assert.equal(
      generateFilename("Image Attribution Implementation", "2026-03-07"),
      "replay-2026-03-07-image-attribution-implementation.html"
    );
  });

  it("strips non-alphanumeric characters", () => {
    assert.equal(
      generateFilename("Fix: login bug (#42)", "2026-03-07"),
      "replay-2026-03-07-fix-login-bug-42.html"
    );
  });

  it("truncates long titles", () => {
    const longTitle = "a".repeat(100);
    const result = generateFilename(longTitle, "2026-03-07");
    assert.ok(result.length < 120);
  });

  it("uses 'session' when title is null", () => {
    assert.equal(
      generateFilename(null, "2026-03-07"),
      "replay-2026-03-07-session.html"
    );
  });
});

describe("uniqueFilename", () => {
  it("returns original when no collision", () => {
    assert.equal(uniqueFilename("/nonexistent/replay.html"), "/nonexistent/replay.html");
  });

  it("appends -2 when file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "unique-test-"));
    const file = join(dir, "replay.html");
    writeFileSync(file, "");
    assert.equal(uniqueFilename(file), join(dir, "replay-2.html"));
  });
});

// ---------------------------------------------------------------------------
// Task 10: discoverSessions
// ---------------------------------------------------------------------------

describe("discoverSessions", () => {
  it("discovers, enriches, filters, and sorts sessions", () => {
    const { base, projects } = makeTempClaudeDir();
    const dir = join(projects, "-Users-omair-projects-foo");
    mkdirSync(dir);

    // Write index with two sessions
    writeFileSync(join(dir, "sessions-index.json"), JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId: "old",
          fullPath: join(dir, "old.jsonl"),
          summary: "Old session",
          firstPrompt: "First thing",
          messageCount: 10,
          created: "2026-03-01T10:00:00Z",
          modified: "2026-03-01T12:00:00Z",
          gitBranch: "main",
        },
        {
          sessionId: "new",
          fullPath: join(dir, "new.jsonl"),
          summary: "New session",
          firstPrompt: "Second thing",
          messageCount: 20,
          created: "2026-03-05T10:00:00Z",
          modified: "2026-03-05T14:00:00Z",
          gitBranch: "main",
        },
        {
          sessionId: "empty",
          fullPath: join(dir, "empty.jsonl"),
          summary: "User Exited Claude Code Session",
          firstPrompt: "",
          messageCount: 1,
          created: "2026-03-06T10:00:00Z",
          modified: "2026-03-06T10:00:00Z",
          gitBranch: "main",
        },
      ],
    }));

    // Write JSONL files (new.jsonl has a custom title)
    writeFileSync(join(dir, "old.jsonl"), JSON.stringify({ type: "user", message: { content: "hi" } }));
    writeFileSync(join(dir, "new.jsonl"), [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({ type: "custom-title", customTitle: "My Custom Title", sessionId: "new" }),
    ].join("\n"));
    writeFileSync(join(dir, "empty.jsonl"), JSON.stringify({ type: "user", message: { content: "" } }));

    const result = discoverSessions("/Users/omair/projects/foo", join(base, ".claude"));

    // empty session should be filtered out
    assert.equal(result.sessions.length, 2);
    // Newest first
    assert.equal(result.sessions[0].sessionId, "new");
    assert.equal(result.sessions[1].sessionId, "old");
    // Custom title resolved
    assert.equal(result.sessions[0].title, "My Custom Title");
    assert.equal(result.sessions[1].title, "Old session");
    // Project name decoded
    assert.equal(result.projectName, "foo");
  });
});
