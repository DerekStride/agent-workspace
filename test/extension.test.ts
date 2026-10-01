import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
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
      expect(process.env.AGENT_WORKSPACE_PATH).toBe(path.join(root, "oriole-thatcher-lighthouse"));
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
      expect(process.env.AGENT_WORKSPACE_PATH).toBe(slugPath);
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
    expect(process.env.AGENT_WORKSPACE_PATH).toBe(rawPath);
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

  it("legacy instruction naming the current path still dedupes", () => {
    const h = harness("omp-session");
    h.state.entries.push(legacyInstruction("omp-session", path.join(root, "omp-session"), WORKSPACE_CONTEXT_MESSAGE_TYPE));
    agentWorkspaceExtension(h.api);
    h.fire("session_start");
    expect(h.sent).toHaveLength(0);
  });
});

describe("agent-workspace OMP lifecycle", () => {
  it("registers OMP transition listeners lazily and clears only its own environment value", () => {
    const h = harness("omp-session");
    agentWorkspaceExtension(h.api);
    expect([...h.handlers.keys()].sort()).toEqual(["session_compact", "session_shutdown", "session_start", "tool_call"]);

    h.fire("session_start");
    expect([...h.handlers.keys()].sort()).toEqual([
      "session_branch", "session_compact", "session_shutdown", "session_start", "session_switch", "session_tree", "tool_call",
    ]);
    const owned = process.env.AGENT_WORKSPACE_PATH!;
    expect(owned).toBe(path.join(root, "omp-session"));

    // A replacement runtime already exported its own path: leave it alone.
    process.env.AGENT_WORKSPACE_PATH = "/somewhere/else";
    h.fire("session_shutdown");
    expect(process.env.AGENT_WORKSPACE_PATH).toBe("/somewhere/else");

    h.fire("session_switch", { type: "session_switch", reason: "resume" });
    expect(process.env.AGENT_WORKSPACE_PATH).toBe(owned);
    h.fire("session_shutdown");
    expect(process.env.AGENT_WORKSPACE_PATH).toBeUndefined();
    h.fire("session_shutdown"); // idempotent
    expect(process.env.AGENT_WORKSPACE_PATH).toBeUndefined();
  });

  it("startup creates an empty workspace, exports the path, and injects one hidden instruction", () => {
    const h = harness("omp-session");
    agentWorkspaceExtension(h.api);
    h.fire("session_start");
    h.fire("session_start");

    const workspace = path.join(root, "omp-session");
    expect(process.env.AGENT_WORKSPACE_PATH).toBe(workspace);
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
    const parentWorkspace = process.env.AGENT_WORKSPACE_PATH!;

    // OMP keeps the runtime and fires session_switch with reason "fork".
    h.state.sessionId = "fork-session";
    h.state.entries = [...parentEntries];
    h.fire("session_switch", { type: "session_switch", reason: "fork", previousSessionFile: "/parent.jsonl" });
    const forkWorkspace = path.join(root, "fork-session");
    expect(process.env.AGENT_WORKSPACE_PATH).toBe(forkWorkspace);
    expect(fs.readdirSync(forkWorkspace)).toEqual([]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].content).toContain(forkWorkspace);
    expect(h.sent[1].content).not.toContain(parentWorkspace);
    expect(h.sent[1].details).toEqual({ sessionId: "fork-session", workspacePath: forkWorkspace });

    h.fire("session_switch", { type: "session_switch", reason: "fork" });
    expect(h.sent).toHaveLength(2);

    // Switching back to the parent restores its environment without a new instruction.
    h.state.sessionId = "parent-session";
    h.state.entries = parentEntries;
    h.fire("session_switch", { type: "session_switch", reason: "resume" });
    expect(process.env.AGENT_WORKSPACE_PATH).toBe(parentWorkspace);
    expect(h.sent).toHaveLength(2);
  });

  it("new session switches to a different workspace and keeps the old directory", () => {
    const h = harness("first-session");
    agentWorkspaceExtension(h.api);
    h.fire("session_start");
    const first = process.env.AGENT_WORKSPACE_PATH!;

    h.state.sessionId = "second-session";
    h.state.entries = [];
    h.fire("session_switch", { type: "session_switch", reason: "new" });
    expect(process.env.AGENT_WORKSPACE_PATH).toBe(path.join(root, "second-session"));
    expect(process.env.AGENT_WORKSPACE_PATH).not.toBe(first);
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
    expect(process.env.AGENT_WORKSPACE_PATH).toBe(path.join(root, "branch-session"));
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

  it("prefixes an export of the owned path into OMP bash calls and leaves everything else alone", () => {
    const h = harness("omp-session");
    agentWorkspaceExtension(h.api);
    const call = { type: "tool_call", toolName: "bash", input: { command: "pwd", timeout: 5, cwd: "/elsewhere" } };
    const toolCall = (event: unknown) => h.handlers.get("tool_call")?.(event, h.context) as { input: Record<string, unknown> } | undefined;

    // No owned path yet: untouched.
    expect(toolCall(call)).toBeUndefined();
    expect(call.input.command).toBe("pwd");

    h.fire("session_start");
    const owned = process.env.AGENT_WORKSPACE_PATH!;
    const result = toolCall(call);
    const expected = `export AGENT_WORKSPACE_PATH='${owned}';\npwd`;
    expect(result).toEqual({ input: { command: expected, timeout: 5, cwd: "/elsewhere" } });
    expect(result!.input).toBe(call.input); // same object: mutate and return, composable with other handlers
    expect(expected.split("\n")).toHaveLength(2); // exactly one export line, no subshell, no cd

    // Inline override is preserved verbatim and still follows (so wins over) the export.
    const inline = { toolName: "bash", input: { command: "AGENT_WORKSPACE_PATH=/x ./script.sh" } };
    expect(toolCall(inline)?.input.command).toBe(`export AGENT_WORKSPACE_PATH='${owned}';\nAGENT_WORKSPACE_PATH=/x ./script.sh`);

    // Non-bash tools and malformed inputs are untouched.
    const read = { toolName: "read", input: { path: "/etc/hosts" } };
    expect(toolCall(read)).toBeUndefined();
    expect(read.input).toEqual({ path: "/etc/hosts" });
    expect(toolCall({ toolName: "bash", input: {} })).toBeUndefined();

    // Quoting: a path containing a single quote.
    process.env.AGENT_WORKSPACE_ROOT = path.join(root, "it's");
    h.fire("session_switch", { type: "session_switch", reason: "resume" });
    const quoted = toolCall({ toolName: "bash", input: { command: "true" } })?.input.command as string;
    expect(quoted).toBe(`export AGENT_WORKSPACE_PATH='${path.join(root, "it'\\''s", "omp-session")}';\ntrue`);

    // Follows the current session after a switch.
    h.state.sessionId = "other-session";
    h.state.entries = [];
    h.fire("session_switch", { type: "session_switch", reason: "new" });
    expect(toolCall({ toolName: "bash", input: { command: "true" } })?.input.command).toContain("/other-session';\n");
  });

  it("composes with another rewriting tool_call handler in either order", () => {
    // Sibling adapters (Agent Mail/ID) follow the same contract: mutate event.input, return the same object.
    const mailStyle = (event: { input: Record<string, unknown> }) => {
      if (!/(?:^|[;&|\n])\s*agent-mail(?=\s|$)/.test(event.input.command as string)) return;
      event.input.command = `(\nexport AGENT_MAIL_ID='mail-id'\n${event.input.command}\n)`;
      return { input: event.input };
    };
    const h = harness("omp-session");
    agentWorkspaceExtension(h.api);
    h.fire("session_start");
    const owned = process.env.AGENT_WORKSPACE_PATH!;
    const ours = (event: { input: Record<string, unknown> }) => h.handlers.get("tool_call")!(event, h.context);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-mail-"));
    fs.writeFileSync(path.join(bin, "agent-mail"), '#!/bin/sh\necho "mail=${AGENT_MAIL_ID-unset} ws=${AGENT_WORKSPACE_PATH-unset}"\n', { mode: 0o755 });
    const run = (command: string) =>
      execFileSync("/bin/sh", ["-c", command], { encoding: "utf-8", env: { PATH: `${bin}:/usr/bin:/bin` } }).trim();

    try {
      for (const order of [[ours, mailStyle], [mailStyle, ours]]) {
        const call = { toolName: "bash", input: { command: "agent-mail send --to me" } };
        let last: unknown;
        for (const handler of order) last = handler(call) ?? last;
        expect((last as { input: unknown }).input).toBe(call.input); // last result still carries both rewrites
        expect(call.input.command).toContain(`export AGENT_WORKSPACE_PATH='${owned}';`);
        expect(call.input.command).toContain("export AGENT_MAIL_ID='mail-id'");
        expect(run(call.input.command as string)).toBe(`mail=mail-id ws=${owned}`);
      }
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});
