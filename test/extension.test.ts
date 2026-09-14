import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildContextMessageContent,
  ensureWorkspaceContextMessage,
  ensureWorkspaceDirectory,
  hasWorkspaceContextMessage,
  resolveWorkspaceRoot,
  sanitizePathComponent,
  WORKSPACE_CONTEXT_MESSAGE_TYPE,
  type ContextMessage,
  type SessionContext,
} from "../extensions/agent-workspace.js";

describe("agent-workspace extension", () => {
  it("sanitizes path components safely", () => {
    expect(sanitizePathComponent("test/session/id")).toBe("test-session-id");
    expect(sanitizePathComponent("valid-session-slug")).toBe("valid-session-slug");
    expect(sanitizePathComponent("   ")).toBe("unknown-session");
  });

  it("resolves default and custom workspace roots", () => {
    delete process.env.AGENT_WORKSPACE_ROOT;
    expect(resolveWorkspaceRoot()).toBe(path.join(os.tmpdir(), "agent-workspace"));

    process.env.AGENT_WORKSPACE_ROOT = "/custom/root";
    expect(resolveWorkspaceRoot()).toBe("/custom/root");
    delete process.env.AGENT_WORKSPACE_ROOT;
  });

  it("creates workspace directory and writes metadata", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
    try {
      const sessionId = "session-123";
      const identity = {
        session_id: sessionId,
        name: "Oriole Thatcher of Lighthouse",
        slug: "oriole-thatcher-lighthouse",
      };

      const { workspacePath, metadataPath } = ensureWorkspaceDirectory(tempRoot, sessionId, identity);
      expect(workspacePath).toBe(path.join(tempRoot, "sessions", "oriole-thatcher-lighthouse"));
      expect(fs.existsSync(workspacePath)).toBe(true);
      expect(fs.existsSync(metadataPath)).toBe(true);
      for (const directory of ["notes", "plans", "drafts", "handoff"]) {
        expect(fs.existsSync(path.join(workspacePath, directory))).toBe(true);
      }

      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      expect(metadata.session_id).toBe(sessionId);
      expect(metadata.slug).toBe("oriole-thatcher-lighthouse");
      expect(metadata.name).toBe("Oriole Thatcher of Lighthouse");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to raw session ID when identity is missing", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
    try {
      const sessionId = "session-raw-456";
      const { workspacePath } = ensureWorkspaceDirectory(tempRoot, sessionId, null);
      expect(workspacePath).toBe(path.join(tempRoot, "sessions", "session-raw-456"));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("detects and injects branch-persistent context messages exactly once", () => {
    const sentMessages: ContextMessage[] = [];
    const entries: unknown[] = [];

    const context: SessionContext = {
      sessionManager: {
        getSessionId: () => "session-abc",
        getBranch: () => entries,
      },
    };

    expect(hasWorkspaceContextMessage(entries)).toBe(false);

    ensureWorkspaceContextMessage(context, "/tmp/agent-workspace/sessions/slug", (msg) => {
      sentMessages.push(msg);
      entries.push({
        type: "custom_message",
        customType: msg.customType,
        content: msg.content,
      });
    });

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].customType).toBe(WORKSPACE_CONTEXT_MESSAGE_TYPE);
    expect(sentMessages[0].content).toBe(buildContextMessageContent("/tmp/agent-workspace/sessions/slug"));
    expect(hasWorkspaceContextMessage(entries)).toBe(true);

    // Second run: no duplicate message inserted
    ensureWorkspaceContextMessage(context, "/tmp/agent-workspace/sessions/slug", (msg) => {
      sentMessages.push(msg);
    });

    expect(sentMessages.length).toBe(1);
  });
});
