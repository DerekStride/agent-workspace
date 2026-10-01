import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import agentWorkspaceExtension, {
  ensureWorkspaceDirectory,
  hasWorkspaceContextMessage,
  resolveWorkspaceRoot,
  sanitizePathComponent,
  WORKSPACE_CONTEXT_MESSAGE_TYPE,
} from "../extensions/agent-workspace.ts";
import { createHostAdapter, exportPrefix } from "../extensions/lib/host.ts";
import { createHarness, fakeAgentIdPath, legacyInstruction, restoreEnv, saveEnv } from "./fixtures.ts";

// Pi contexts have no managed timers; the adapter therefore selects Pi lifecycle events.
// Pi restarts the extension runtime for new/resume/fork and re-emits session_start with a reason.

let savedEnv: Record<string, string | undefined>;
let root: string;

beforeEach(() => {
  savedEnv = saveEnv();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-pi-"));
  process.env.AGENT_WORKSPACE_ROOT = root;
  process.env.PATH = ""; // Exercise the optional-Agent-ID fallback, not the user's registry.
  delete process.env.AGENT_WORKSPACE_PATH;
});

afterEach(() => {
  restoreEnv(savedEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

const harness = (sessionId: string) => createHarness(sessionId);

// --- Shared behavior (kept in lockstep with test/extension.test.ts) ---

test("sanitizes path components safely", () => {
  assert.equal(sanitizePathComponent("test/session/id"), "test-session-id");
  assert.equal(sanitizePathComponent("valid-session-slug"), "valid-session-slug");
  assert.equal(sanitizePathComponent("   "), "unknown-session");
});

test("resolves default and custom workspace roots", () => {
  delete process.env.AGENT_WORKSPACE_ROOT;
  assert.equal(resolveWorkspaceRoot(), "/tmp/agent-workspace");
  process.env.AGENT_WORKSPACE_ROOT = "/custom/root";
  assert.equal(resolveWorkspaceRoot(), "/custom/root");
});

test("creates an empty workspace and preserves files on subsequent initialization", () => {
  const identity = { session_id: "session-123", slug: "oriole-thatcher-lighthouse" };
  const { workspacePath } = ensureWorkspaceDirectory(root, "session-123", identity);
  assert.equal(workspacePath, path.join(root, "oriole-thatcher-lighthouse"));
  assert.deepEqual(fs.readdirSync(workspacePath), []);
  fs.writeFileSync(path.join(workspacePath, "scratch.txt"), "keep my work");
  ensureWorkspaceDirectory(root, "session-123", identity);
  assert.equal(fs.readFileSync(path.join(workspacePath, "scratch.txt"), "utf-8"), "keep my work");
  assert.equal(ensureWorkspaceDirectory(root, "raw-456", null).workspacePath, path.join(root, "raw-456"));
});

test("uses the agent-id slug when the lookup succeeds", () => {
  const fake = fakeAgentIdPath("oriole-thatcher-lighthouse");
  try {
    process.env.PATH = fake.PATH;
    const h = harness("pi-session");
    agentWorkspaceExtension(h.api);
    h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(process.env.AGENT_WORKSPACE_PATH, path.join(root, "oriole-thatcher-lighthouse"));
    assert.deepEqual(h.sent[0].details, { sessionId: "pi-session", workspacePath: path.join(root, "oriole-thatcher-lighthouse") });
  } finally {
    fs.rmSync(fake.bin, { recursive: true, force: true });
  }
});

test("dedupes on the most recent own instruction only", () => {
  const sid = "pi-session";
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  const msg = (workspacePath: string, sessionId = sid) => ({
    type: "custom_message", customType: WORKSPACE_CONTEXT_MESSAGE_TYPE, details: { sessionId, workspacePath },
  });
  assert.equal(hasWorkspaceContextMessage([msg(a)], sid, a), true);
  assert.equal(hasWorkspaceContextMessage([msg(a)], sid, b), false);
  // A -> B -> A: the old A message must not suppress guidance while the newest says B.
  assert.equal(hasWorkspaceContextMessage([msg(a), msg(b)], sid, a), false);
  assert.equal(hasWorkspaceContextMessage([msg(a), msg(b), msg(a)], sid, a), true);
  // Compaction and other sessions' messages.
  assert.equal(hasWorkspaceContextMessage([msg(a), { type: "compaction" }], sid, a), false);
  assert.equal(hasWorkspaceContextMessage([msg(a, "parent")], sid, a), false);
  // Legacy instructions without details.workspacePath are matched by content.
  assert.equal(hasWorkspaceContextMessage([legacyInstruction(sid, a, WORKSPACE_CONTEXT_MESSAGE_TYPE)], sid, a), true);
  assert.equal(hasWorkspaceContextMessage([legacyInstruction(sid, a, WORKSPACE_CONTEXT_MESSAGE_TYPE)], sid, b), false);
});

test("refreshes guidance when the resolved path changes and keeps old directories", () => {
  const h = harness("pi-session");
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "startup" });
  const rawPath = path.join(root, "pi-session");
  fs.writeFileSync(path.join(rawPath, "keep.txt"), "old");
  assert.equal(h.sent.length, 1);

  // Identity becomes available on a later resume: the newest instruction names the raw path.
  const fake = fakeAgentIdPath("late-slug");
  try {
    process.env.PATH = fake.PATH;
    agentWorkspaceExtension(h.api);
    h.fire("session_start", { type: "session_start", reason: "resume" });
    const slugPath = path.join(root, "late-slug");
    assert.equal(process.env.AGENT_WORKSPACE_PATH, slugPath);
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[1].details.workspacePath, slugPath);
    assert.ok(h.sent[1].content.includes(slugPath));
    assert.equal(fs.readFileSync(path.join(rawPath, "keep.txt"), "utf-8"), "old");

    // Same path again: ordinary dedupe.
    h.fire("session_start", { type: "session_start", reason: "reload" });
    assert.equal(h.sent.length, 2);
  } finally {
    fs.rmSync(fake.bin, { recursive: true, force: true });
  }

  // Identity unavailable again (A -> B -> A): refresh despite the older A instruction.
  process.env.PATH = "";
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "resume" });
  assert.equal(process.env.AGENT_WORKSPACE_PATH, rawPath);
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2].details.workspacePath, rawPath);

  // Root change is also a path change.
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-pi-root2-"));
  try {
    process.env.AGENT_WORKSPACE_ROOT = otherRoot;
    h.fire("session_start", { type: "session_start", reason: "reload" });
    assert.equal(h.sent.length, 4);
    assert.equal(h.sent[3].details.workspacePath, path.join(otherRoot, "pi-session"));
  } finally {
    fs.rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("clears its owned path when reprovisioning fails and recovers on retry", () => {
  const h = harness("pi-session");
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { reason: "startup" });
  const owned = process.env.AGENT_WORKSPACE_PATH!;
  fs.writeFileSync(path.join(owned, "keep.txt"), "keep my work");
  h.state.entries.push({ type: "compaction" });
  const blockedRoot = path.join(root, "not-a-directory");
  fs.writeFileSync(blockedRoot, "blocked");
  process.env.AGENT_WORKSPACE_ROOT = blockedRoot;

  assert.throws(() => h.fire("session_compact"));
  assert.equal(process.env.AGENT_WORKSPACE_PATH, undefined);
  assert.equal(h.sent.length, 1);
  const call = { toolName: "bash", input: { command: "pwd", timeout: 5 } };
  assert.equal(h.handlers.get("tool_call")!(call, h.context), undefined);
  assert.deepEqual(call.input, { command: "pwd", timeout: 5 });

  process.env.AGENT_WORKSPACE_ROOT = root;
  h.fire("session_compact");
  assert.equal(process.env.AGENT_WORKSPACE_PATH, owned);
  assert.equal(h.sent.length, 2);
  assert.equal(fs.readFileSync(path.join(owned, "keep.txt"), "utf8"), "keep my work");
});

test("does not export a workspace until its context is published", () => {
  const h = harness("pi-session");
  const sendMessage = h.api.sendMessage;
  h.api.sendMessage = () => { throw new Error("context unavailable"); };
  agentWorkspaceExtension(h.api);

  assert.throws(() => h.fire("session_start", { reason: "startup" }), /context unavailable/);
  assert.equal(process.env.AGENT_WORKSPACE_PATH, undefined);
  assert.equal(h.sent.length, 0);

  h.api.sendMessage = sendMessage;
  h.fire("session_start", { reason: "startup" });
  assert.equal(process.env.AGENT_WORKSPACE_PATH, path.join(root, "pi-session"));
  assert.equal(h.sent.length, 1);
});

test("legacy instruction naming the current path still dedupes", () => {
  const h = harness("pi-session");
  h.state.entries.push(legacyInstruction("pi-session", path.join(root, "pi-session"), WORKSPACE_CONTEXT_MESSAGE_TYPE));
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "resume" });
  assert.equal(h.sent.length, 0);
});

// --- Pi lifecycle ---

test("detects Pi from a context without managed timers", () => {
  const adapter = createHostAdapter({ sessionManager: { getSessionId: () => "x", getBranch: () => [] } });
  assert.equal(adapter.kind, "pi");
  const omp = createHostAdapter({
    sessionManager: { getSessionId: () => "x", getBranch: () => [] },
    setInterval: () => ({}),
    clearTimer: () => {},
  });
  assert.equal(omp.kind, "omp");
});

test("registers Pi transition listeners lazily on the first session_start", () => {
  const h = harness("pi-session");
  agentWorkspaceExtension(h.api);
  assert.deepEqual([...h.handlers.keys()].sort(), ["session_compact", "session_shutdown", "session_start", "tool_call"]);

  h.fire("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual([...h.handlers.keys()].sort(), [
    "session_compact", "session_shutdown", "session_start", "session_tree", "tool_call",
  ]);
  assert.equal(h.handlers.has("session_switch"), false);
  assert.equal(h.handlers.has("session_branch"), false);
});

test("startup creates an empty workspace, exports the path, and injects one hidden instruction", () => {
  const h = harness("pi-session");
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "startup" });

  const workspace = path.join(root, "pi-session");
  assert.equal(process.env.AGENT_WORKSPACE_PATH, workspace);
  assert.deepEqual(fs.readdirSync(workspace), []);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].customType, WORKSPACE_CONTEXT_MESSAGE_TYPE);
  assert.equal(h.sent[0].display, false);
  assert.deepEqual(h.sent[0].details, { sessionId: "pi-session", workspacePath: workspace });
  assert.ok(h.sent[0].content.includes(workspace));

  // Reload replaces the runtime: shutdown then a fresh instance starting on the same branch.
  h.fire("session_shutdown", { type: "session_shutdown", reason: "reload" });
  assert.equal(process.env.AGENT_WORKSPACE_PATH, undefined);
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "reload" });
  assert.equal(process.env.AGENT_WORKSPACE_PATH, workspace);
  assert.equal(h.sent.length, 1);
});

test("resume keeps one instruction per branch and re-injects after compaction", () => {
  const h = harness("pi-session");
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "resume" });
  h.fire("session_start", { type: "session_start", reason: "resume" });
  assert.equal(h.sent.length, 1);

  h.state.entries.push({ type: "compaction" });
  h.fire("session_compact", { type: "session_compact", reason: "manual" });
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.state.entries.at(-1), { type: "custom_message", ...h.sent[1] });
  h.fire("session_compact", { type: "session_compact", reason: "threshold" });
  assert.equal(h.sent.length, 2);

  // A branch compacted before the extension could restore its instruction.
  h.state.entries.push({ type: "compaction" });
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "resume" });
  assert.equal(h.sent.length, 3);
});

test("fork starts a new runtime and gets its own workspace despite inherited history", () => {
  const h = harness("parent-session");
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "startup" });
  const parentWorkspace = process.env.AGENT_WORKSPACE_PATH!;
  const parentEntries = h.state.entries;

  h.fire("session_shutdown", { type: "session_shutdown", reason: "fork" });
  h.state.sessionId = "fork-session";
  h.state.entries = [...parentEntries];
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "fork", previousSessionFile: "/parent.jsonl" });

  const forkWorkspace = path.join(root, "fork-session");
  assert.equal(process.env.AGENT_WORKSPACE_PATH, forkWorkspace);
  assert.deepEqual(fs.readdirSync(forkWorkspace), []);
  assert.equal(h.sent.length, 2);
  assert.ok(h.sent[1].content.includes(forkWorkspace));
  assert.ok(!h.sent[1].content.includes(parentWorkspace));
  assert.deepEqual(h.sent[1].details, { sessionId: "fork-session", workspacePath: forkWorkspace });

  h.fire("session_start", { type: "session_start", reason: "fork" });
  assert.equal(h.sent.length, 2);
});

test("new session replaces the runtime and points at a different workspace", () => {
  const h = harness("first-session");
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "startup" });
  const first = process.env.AGENT_WORKSPACE_PATH!;

  h.fire("session_shutdown", { type: "session_shutdown", reason: "new" });
  h.state.sessionId = "second-session";
  h.state.entries = [];
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "new" });

  assert.equal(process.env.AGENT_WORKSPACE_PATH, path.join(root, "second-session"));
  assert.notEqual(process.env.AGENT_WORKSPACE_PATH, first);
  assert.equal(h.sent.length, 2);
  assert.ok(fs.existsSync(first));
});

test("tree navigation re-checks the active branch without duplicating instructions", () => {
  const h = harness("pi-session");
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "startup" });
  h.fire("session_tree", { type: "session_tree", newLeafId: "b", oldLeafId: "a" });
  assert.equal(h.sent.length, 1);

  // Navigating to a leaf on an older branch that predates the instruction.
  h.state.entries = [];
  h.fire("session_tree", { type: "session_tree", newLeafId: "c", oldLeafId: "b" });
  assert.equal(h.sent.length, 2);
});

test("shutdown clears only the environment value this instance exported", () => {
  const h = harness("pi-session");
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "startup" });
  const owned = process.env.AGENT_WORKSPACE_PATH!;

  process.env.AGENT_WORKSPACE_PATH = "/owned/by/another/instance";
  h.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(process.env.AGENT_WORKSPACE_PATH, "/owned/by/another/instance");

  process.env.AGENT_WORKSPACE_PATH = owned;
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "startup" });
  h.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(process.env.AGENT_WORKSPACE_PATH, undefined);
  h.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }); // idempotent
  assert.equal(process.env.AGENT_WORKSPACE_PATH, undefined);
});

test("leaves bash tool calls untouched on Pi (native process environment)", () => {
  const h = harness("pi-session");
  agentWorkspaceExtension(h.api);
  h.fire("session_start", { type: "session_start", reason: "startup" });
  const call = { type: "tool_call", toolName: "bash", input: { command: "pwd", timeout: 5 } };
  const result = h.handlers.get("tool_call")?.(call, h.context);
  assert.equal(result, undefined);
  assert.deepEqual(call.input, { command: "pwd", timeout: 5 });
  // Composition: a sibling handler that mutates in place on Pi still sees the untouched command.
  const mailStyle = (event: { input: Record<string, unknown> }) => { event.input.command = `(\n${event.input.command}\n)`; };
  for (const order of [[() => h.handlers.get("tool_call")!(call, h.context), () => mailStyle(call)], [() => mailStyle(call), () => h.handlers.get("tool_call")!(call, h.context)]]) {
    call.input.command = "pwd";
    for (const step of order) step();
    assert.equal(call.input.command, "(\npwd\n)");
  }
  const read = { toolName: "read", input: { path: "/etc/hosts" } };
  assert.equal(h.handlers.get("tool_call")?.(read, h.context), undefined);
  assert.deepEqual(read.input, { path: "/etc/hosts" });
});

test("export prefix quotes paths safely and ends with a newline", () => {
  assert.equal(exportPrefix("/tmp/plain"), "export AGENT_WORKSPACE_PATH='/tmp/plain';\n");
  assert.equal(exportPrefix("/tmp/it's"), "export AGENT_WORKSPACE_PATH='/tmp/it'\\''s';\n");
});
