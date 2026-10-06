import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import agentWorkspaceExtension, {
  ensureWorkspaceDirectory,
  hasWorkspaceContextMessage,
  resolveWorkspaceRoot,
  sanitizePathComponent,
  WORKSPACE_CONTEXT_MESSAGE_TYPE,
} from "../extensions/agent-workspace.ts";
import { createHarness, fakeAgentIdPath, legacyInstruction, restoreEnv, saveEnv } from "./fixtures.ts";

// OMP contexts expose managed timers; the adapter uses that capability to select OMP lifecycle events.
// OMP keeps the extension runtime across new/resume/fork (session_switch), branching into a new
// session file (session_branch), and in-session tree navigation (session_tree).
const ompTimers = {
  setInterval: () => ({}),
  clearTimer: () => {},
};

let savedEnv: Record<string, string | undefined>;
let root: string;

beforeEach(() => {
  savedEnv = saveEnv();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-omp-"));
  process.env.AGENT_WORKSPACE_ROOT = root;
  process.env.PATH = ""; // Exercise the optional-Agent-ID fallback, not the user's registry.
  delete process.env.AGENT_WORKSPACE_PATH;
});

afterEach(() => {
  restoreEnv(savedEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

const harness = (sessionId: string) => createHarness(sessionId, ompTimers);

describe("agent-workspace shared behavior (OMP host)", () => {
  it("sanitizes path components safely", () => {
    expect(sanitizePathComponent("test/session/id")).toBe("test-session-id");
    expect(sanitizePathComponent("valid-session-slug")).toBe("valid-session-slug");
    expect(sanitizePathComponent("   ")).toBe("unknown-session");
  });

  it("resolves default and custom workspace roots", () => {
    delete process.env.AGENT_WORKSPACE_ROOT;
    expect(resolveWorkspaceRoot()).toBe("/tmp/agent-workspace");
    process.env.AGENT_WORKSPACE_ROOT = "/custom/root";
    expect(resolveWorkspaceRoot()).toBe("/custom/root");
  });

  it("creates an empty workspace and preserves files on subsequent initialization", () => {
    const identity = { session_id: "session-123", slug: "oriole-thatcher-lighthouse" };
    const { workspacePath } = ensureWorkspaceDirectory(root, "session-123", identity);
    expect(workspacePath).toBe(path.join(root, "oriole-thatcher-lighthouse"));
    expect(fs.readdirSync(workspacePath)).toEqual([]);
    fs.writeFileSync(path.join(workspacePath, "scratch.txt"), "keep my work");
    ensureWorkspaceDirectory(root, "session-123", identity);
    expect(fs.readFileSync(path.join(workspacePath, "scratch.txt"), "utf-8")).toBe("keep my work");
    expect(ensureWorkspaceDirectory(root, "raw-456", null).workspacePath).toBe(path.join(root, "raw-456"));
  });

  it("uses the agent-id slug when the lookup succeeds", () => {
    const fake = fakeAgentIdPath("oriole-thatcher-lighthouse");
    try {
      process.env.PATH = fake.PATH;
      const h = harness("omp-session");
      agentWorkspaceExtension(h.api);
      h.fire("session_start");
      expect(h.sent[0].details).toEqual({ sessionId: "omp-session", workspacePath: path.join(root, "oriole-thatcher-lighthouse") });
    } finally {
      fs.rmSync(fake.bin, { recursive: true, force: true });
    }
  });

  it("dedupes on the most recent own instruction only", () => {
    const sid = "omp-session";
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    const msg = (workspacePath: string, sessionId = sid) => ({
      type: "custom_message", customType: WORKSPACE_CONTEXT_MESSAGE_TYPE, details: { sessionId, workspacePath },
    });
    expect(hasWorkspaceContextMessage([msg(a)], sid, a)).toBe(true);
    expect(hasWorkspaceContextMessage([msg(a)], sid, b)).toBe(false);
    // A -> B -> A: the old A message must not suppress guidance while the newest says B.
    expect(hasWorkspaceContextMessage([msg(a), msg(b)], sid, a)).toBe(false);
    expect(hasWorkspaceContextMessage([msg(a), msg(b), msg(a)], sid, a)).toBe(true);
    // Compaction and other sessions' messages.
    expect(hasWorkspaceContextMessage([msg(a), { type: "compaction" }], sid, a)).toBe(false);
    expect(hasWorkspaceContextMessage([msg(a, "parent")], sid, a)).toBe(false);
    // Legacy instructions without details.workspacePath are matched by content.
    expect(hasWorkspaceContextMessage([legacyInstruction(sid, a, WORKSPACE_CONTEXT_MESSAGE_TYPE)], sid, a)).toBe(true);
    expect(hasWorkspaceContextMessage([legacyInstruction(sid, a, WORKSPACE_CONTEXT_MESSAGE_TYPE)], sid, b)).toBe(false);
  });

  it("refreshes guidance when the resolved path changes and keeps old directories", () => {
    const h = harness("omp-session");
    agentWorkspaceExtension(h.api);
    h.fire("session_start");
    const rawPath = path.join(root, "omp-session");
    fs.writeFileSync(path.join(rawPath, "keep.txt"), "old");
    expect(h.sent).toHaveLength(1);

    // Identity becomes available on a later resume: the newest instruction names the raw path.
    const fake = fakeAgentIdPath("late-slug");
    try {
      process.env.PATH = fake.PATH;
      h.fire("session_switch", { type: "session_switch", reason: "resume" });
      const slugPath = path.join(root, "late-slug");
      expect(h.sent).toHaveLength(2);
      expect(h.sent[1].details.workspacePath).toBe(slugPath);
      expect(h.sent[1].content).toContain(slugPath);
      expect(fs.readFileSync(path.join(rawPath, "keep.txt"), "utf-8")).toBe("old");

      // Same path again: ordinary dedupe.
      h.fire("session_switch", { type: "session_switch", reason: "resume" });
      expect(h.sent).toHaveLength(2);
    } finally {
      fs.rmSync(fake.bin, { recursive: true, force: true });
    }

    // Identity unavailable again (A -> B -> A): refresh despite the older A instruction.
    process.env.PATH = "";
    h.fire("session_switch", { type: "session_switch", reason: "resume" });
    expect(h.sent).toHaveLength(3);
    expect(h.sent[2].details.workspacePath).toBe(rawPath);

    // Root change is also a path change.
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-omp-root2-"));
    try {
      process.env.AGENT_WORKSPACE_ROOT = otherRoot;
      h.fire("session_switch", { type: "session_switch", reason: "resume" });
      expect(h.sent).toHaveLength(4);
      expect(h.sent[3].details.workspacePath).toBe(path.join(otherRoot, "omp-session"));
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("failed reprovisioning preserves workspace files and recovers on retry", () => {
    const h = harness("omp-session");
    agentWorkspaceExtension(h.api);
    h.fire("session_start");
    const workspace = path.join(root, "omp-session");
    fs.writeFileSync(path.join(workspace, "keep.txt"), "keep my work");
    h.state.entries.push({ type: "compaction" });
    const blockedRoot = path.join(root, "not-a-directory");
    fs.writeFileSync(blockedRoot, "blocked");
    process.env.AGENT_WORKSPACE_ROOT = blockedRoot;

    expect(() => h.fire("session_compact")).toThrow();
    expect(h.sent).toHaveLength(1);

    process.env.AGENT_WORKSPACE_ROOT = root;
    h.fire("session_compact");
    expect(h.sent).toHaveLength(2);
    expect(fs.readFileSync(path.join(workspace, "keep.txt"), "utf8")).toBe("keep my work");
  });

  it("does not publish workspace guidance until setup succeeds", () => {
    const h = harness("omp-session");
    const sendMessage = h.api.sendMessage;
    h.api.sendMessage = () => { throw new Error("context unavailable"); };
    agentWorkspaceExtension(h.api);

    expect(() => h.fire("session_start")).toThrow("context unavailable");
    expect(h.sent).toHaveLength(0);

    h.api.sendMessage = sendMessage;
    h.fire("session_start");
    expect(h.sent).toHaveLength(1);
  });

  it("legacy instruction naming the current path still dedupes", () => {
    const h = harness("omp-session");
    h.state.entries.push(legacyInstruction("omp-session", path.join(root, "omp-session"), WORKSPACE_CONTEXT_MESSAGE_TYPE));
    agentWorkspaceExtension(h.api);
    h.fire("session_start");
    expect(h.sent).toHaveLength(0);
  });
});

describe("agent-workspace OMP lifecycle", () => {
  it("registers OMP transition listeners lazily", () => {
    const h = harness("omp-session");
    agentWorkspaceExtension(h.api);
    expect([...h.handlers.keys()].sort()).toEqual(["session_compact", "session_start"]);

    h.fire("session_start");
    expect([...h.handlers.keys()].sort()).toEqual([
      "session_branch", "session_compact", "session_start", "session_switch", "session_tree",
    ]);
  });

  it("startup creates an empty workspace and injects one hidden instruction", () => {
    const h = harness("omp-session");
    agentWorkspaceExtension(h.api);
    h.fire("session_start");
    h.fire("session_start");

    const workspace = path.join(root, "omp-session");
    expect(fs.readdirSync(workspace)).toEqual([]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].customType).toBe(WORKSPACE_CONTEXT_MESSAGE_TYPE);
    expect(h.sent[0].display).toBe(false);
    expect(h.sent[0].details).toEqual({ sessionId: "omp-session", workspacePath: workspace });
    expect(h.sent[0].content).toContain(workspace);
  });

  it("restores workspace guidance after compaction and resume without duplicates", () => {
    const h = harness("omp-session");
    agentWorkspaceExtension(h.api);
    h.fire("session_start");
    expect(h.sent).toHaveLength(1);

    h.state.entries.push({ type: "compaction" });
    h.fire("session_compact", { type: "session_compact" });
    expect(h.sent).toHaveLength(2);
    expect(h.state.entries.at(-1)).toMatchObject({ type: "custom_message", customType: WORKSPACE_CONTEXT_MESSAGE_TYPE });
    h.fire("session_compact", { type: "session_compact" });
    expect(h.sent).toHaveLength(2);

    // Resume a branch compacted before the extension could restore its instruction.
    h.state.entries.push({ type: "compaction" });
    h.fire("session_switch", { type: "session_switch", reason: "resume" });
    expect(h.sent).toHaveLength(3);
    h.fire("session_switch", { type: "session_switch", reason: "resume" });
    expect(h.sent).toHaveLength(3);
  });

  it("gives a fork its own workspace instruction despite inherited parent history", () => {
    const h = harness("parent-session");
    agentWorkspaceExtension(h.api);
    h.fire("session_start");
    const parentEntries = h.state.entries;
    const parentWorkspace = h.sent[0].details.workspacePath;

    // OMP keeps the runtime and fires session_switch with reason "fork".
    h.state.sessionId = "fork-session";
    h.state.entries = [...parentEntries];
    h.fire("session_switch", { type: "session_switch", reason: "fork", previousSessionFile: "/parent.jsonl" });
    const forkWorkspace = path.join(root, "fork-session");

    expect(fs.readdirSync(forkWorkspace)).toEqual([]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].content).toContain(forkWorkspace);
    expect(h.sent[1].content).not.toContain(parentWorkspace);
    expect(h.sent[1].details).toEqual({ sessionId: "fork-session", workspacePath: forkWorkspace });

    h.fire("session_switch", { type: "session_switch", reason: "fork" });
    expect(h.sent).toHaveLength(2);

    // Switching back to the parent reuses its existing workspace instruction.
    h.state.sessionId = "parent-session";
    h.state.entries = parentEntries;
    h.fire("session_switch", { type: "session_switch", reason: "resume" });
    expect(h.sent).toHaveLength(2);
  });

  it("new session switches to a different workspace and keeps the old directory", () => {
    const h = harness("first-session");
    agentWorkspaceExtension(h.api);
    h.fire("session_start");
    const first = h.sent[0].details.workspacePath;

    h.state.sessionId = "second-session";
    h.state.entries = [];
    h.fire("session_switch", { type: "session_switch", reason: "new" });
    expect(h.sent[1].details).toEqual({ sessionId: "second-session", workspacePath: path.join(root, "second-session") });
    expect(h.sent).toHaveLength(2);
    expect(fs.existsSync(first)).toBe(true);
  });

  it("branching into a new session file (session_branch) gets its own workspace like a fork", () => {
    const h = harness("parent-session");
    agentWorkspaceExtension(h.api);
    h.fire("session_start");
    const parentEntries = h.state.entries;

    h.state.sessionId = "branch-session";
    h.state.entries = [...parentEntries];
    h.fire("session_branch", { type: "session_branch", previousSessionFile: "/parent.jsonl" });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].details).toEqual({ sessionId: "branch-session", workspacePath: path.join(root, "branch-session") });
    h.fire("session_branch", { type: "session_branch", previousSessionFile: "/parent.jsonl" });
    expect(h.sent).toHaveLength(2);
  });

  it("tree navigation (session_tree) re-checks the active branch without duplicating instructions", () => {
    const h = harness("omp-session");
    agentWorkspaceExtension(h.api);
    h.fire("session_start");
    h.fire("session_tree", { type: "session_tree", newLeafId: "b", oldLeafId: "a" });
    expect(h.sent).toHaveLength(1);

    // Navigating to a leaf on an older branch that predates the instruction.
    h.state.entries = [];
    h.fire("session_tree", { type: "session_tree", newLeafId: "c", oldLeafId: "b" });
    expect(h.sent).toHaveLength(2);
  });

  it("does not expose the workspace path through the environment or Bash tool", () => {
    const h = harness("omp-session");
    agentWorkspaceExtension(h.api);
    expect(process.env.AGENT_WORKSPACE_PATH).toBeUndefined();

    h.fire("session_start");
    expect(process.env.AGENT_WORKSPACE_PATH).toBeUndefined();
    expect(h.handlers.has("tool_call")).toBe(false);

    const call = { toolName: "bash", input: { command: "pwd", timeout: 5 } };
    h.fire("tool_call", call);
    expect(call.input).toEqual({ command: "pwd", timeout: 5 });
  });
});
