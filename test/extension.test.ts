import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import agentWorkspaceExtension, {
  ensureWorkspaceDirectory,
  resolveWorkspaceRoot,
  sanitizePathComponent,
  WORKSPACE_CONTEXT_MESSAGE_TYPE,
  type ContextMessage,
  type ExtensionAPI,
  type SessionContext,
} from "../extensions/agent-workspace.js";

describe("agent-workspace extension", () => {
  it("sanitizes path components safely", () => {
    expect(sanitizePathComponent("test/session/id")).toBe("test-session-id");
    expect(sanitizePathComponent("valid-session-slug")).toBe("valid-session-slug");
    expect(sanitizePathComponent("   ")).toBe("unknown-session");
  });

  it("resolves default and custom workspace roots", () => {
    const previousRoot = process.env.AGENT_WORKSPACE_ROOT;
    try {
      delete process.env.AGENT_WORKSPACE_ROOT;
      expect(resolveWorkspaceRoot()).toBe("/tmp/agent-workspace");
      process.env.AGENT_WORKSPACE_ROOT = "/custom/root";
      expect(resolveWorkspaceRoot()).toBe("/custom/root");
    } finally {
      if (previousRoot === undefined) delete process.env.AGENT_WORKSPACE_ROOT;
      else process.env.AGENT_WORKSPACE_ROOT = previousRoot;
    }
  });

  it("creates an empty workspace and preserves files on subsequent initialization", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
    try {
      const sessionId = "session-123";
      const identity = {
        session_id: sessionId,
        name: "Oriole Thatcher of Lighthouse",
        slug: "oriole-thatcher-lighthouse",
      };

      const { workspacePath } = ensureWorkspaceDirectory(tempRoot, sessionId, identity);
      expect(workspacePath).toBe(path.join(tempRoot, "oriole-thatcher-lighthouse"));
      expect(fs.readdirSync(workspacePath)).toEqual([]);

      fs.writeFileSync(path.join(workspacePath, "scratch.txt"), "keep my work");
      ensureWorkspaceDirectory(tempRoot, sessionId, identity);
      expect(fs.readdirSync(workspacePath)).toEqual(["scratch.txt"]);
      expect(fs.readFileSync(path.join(workspacePath, "scratch.txt"), "utf-8")).toBe("keep my work");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to raw session ID when identity is missing", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
    try {
      const sessionId = "session-raw-456";
      const { workspacePath } = ensureWorkspaceDirectory(tempRoot, sessionId, null);
      expect(workspacePath).toBe(path.join(tempRoot, "session-raw-456"));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("restores workspace guidance after compaction and resume without duplicates", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
    const previousEnvironment = ["AGENT_WORKSPACE_ROOT", "AGENT_WORKSPACE_PATH", "PATH"]
      .map((key) => [key, process.env[key]] as const);
    const entries: unknown[] = [];
    const sentMessages: ContextMessage[] = [];
    const handlers = new Map<string, (event: unknown, context: SessionContext) => void>();
    const context: SessionContext = {
      sessionManager: {
        getSessionId: () => "session-abc",
        getBranch: () => entries,
      },
    };
    const api: ExtensionAPI = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message) {
        sentMessages.push(message);
        entries.push({ type: "custom_message", ...message });
      },
    };

    try {
      process.env.AGENT_WORKSPACE_ROOT = tempRoot;
      process.env.PATH = ""; // Exercise the optional-Agent-ID fallback, not the user's registry.
      agentWorkspaceExtension(api);
      handlers.get("session_start")?.({}, context);
      handlers.get("session_start")?.({}, context);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].display).toBe(false);
      expect(sentMessages[0].content).toContain(process.env.AGENT_WORKSPACE_PATH!);

      entries.push({ type: "compaction" });
      handlers.get("session_compact")?.({}, context);
      expect(sentMessages).toHaveLength(2);
      expect(entries.at(-1)).toMatchObject({
        type: "custom_message",
        customType: WORKSPACE_CONTEXT_MESSAGE_TYPE,
      });
      handlers.get("session_compact")?.({}, context);
      expect(sentMessages).toHaveLength(2);

      // Resume a branch compacted before the extension could restore its instruction.
      entries.push({ type: "compaction" });
      agentWorkspaceExtension(api);
      handlers.get("session_start")?.({}, context);
      handlers.get("session_switch")?.({}, context);
      expect(sentMessages).toHaveLength(3);
    } finally {
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("gives a fork its own workspace instruction despite inherited parent history", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
    const previousEnvironment = ["AGENT_WORKSPACE_ROOT", "AGENT_WORKSPACE_PATH", "PATH"]
      .map((key) => [key, process.env[key]] as const);
    let sessionId = "parent-session";
    let entries: unknown[] = [];
    const sentMessages: ContextMessage[] = [];
    const handlers = new Map<string, (event: unknown, context: SessionContext) => void>();
    const context: SessionContext = {
      sessionManager: {
        getSessionId: () => sessionId,
        getBranch: () => entries,
      },
    };
    const api: ExtensionAPI = {
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message) {
        sentMessages.push(message);
        entries.push({ type: "custom_message", ...message });
      },
    };

    try {
      process.env.AGENT_WORKSPACE_ROOT = tempRoot;
      process.env.PATH = "";
      agentWorkspaceExtension(api);
      handlers.get("session_start")?.({}, context);
      const parentEntries = entries;
      const parentWorkspace = process.env.AGENT_WORKSPACE_PATH!;

      sessionId = "fork-session";
      entries = [...parentEntries];
      handlers.get("session_branch")?.({}, context);
      const forkWorkspace = path.join(tempRoot, sessionId);
      expect(process.env.AGENT_WORKSPACE_PATH).toBe(forkWorkspace);
      expect(fs.readdirSync(forkWorkspace)).toEqual([]);
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1].content).toContain(forkWorkspace);
      expect(sentMessages[1].content).not.toContain(parentWorkspace);
      expect(sentMessages[1].display).toBe(false);

      handlers.get("session_branch")?.({}, context);
      handlers.get("session_start")?.({}, context);
      expect(sentMessages).toHaveLength(2);

      sessionId = "parent-session";
      entries = parentEntries;
      handlers.get("session_switch")?.({}, context);
      expect(process.env.AGENT_WORKSPACE_PATH).toBe(parentWorkspace);
      expect(sentMessages).toHaveLength(2);
    } finally {
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
