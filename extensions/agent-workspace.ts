import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const WORKSPACE_ROOT_ENV = "AGENT_WORKSPACE_ROOT";
export const WORKSPACE_PATH_ENV = "AGENT_WORKSPACE_PATH";
export const WORKSPACE_CONTEXT_MESSAGE_TYPE = "dev.derekstride.agent-workspace.context-v1";
export type SessionEntryLike = {
  type?: unknown;
  customType?: unknown;
};

export type ContextMessage = {
  customType: string;
  content: string;
  display: boolean;
};

export type SessionContext = {
  sessionManager: {
    getSessionId(): string;
    getBranch(): readonly unknown[];
  };
};

export type ExtensionAPI = {
  on(event: "session_start", handler: (event: unknown, context: SessionContext) => void): void;
  on(event: "session_switch", handler: (event: unknown, context: SessionContext) => void): void;
  on(event: "session_fork", handler: (event: unknown, context: SessionContext) => void): void;
  on(event: "session_compact", handler: (event: unknown, context: SessionContext) => void): void;
  on(event: "session_shutdown", handler: (event: unknown, context: SessionContext) => void): void;
  sendMessage(message: ContextMessage): void;
};

export type AgentIdLookup = {
  session_id: string;
  name?: string;
  slug?: string;
};

export function lookupAgentIdentity(sessionId: string): AgentIdLookup | null {
  try {
    const output = execFileSync("agent-id", ["lookup", sessionId, "--json"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(output) as AgentIdLookup;
    if (parsed && typeof parsed === "object" && parsed.session_id === sessionId) {
      return parsed;
    }
  } catch {
    // Agent ID is optional; ignore failures and fall back to raw session ID
  }
  return null;
}

export function resolveWorkspaceRoot(): string {
  const custom = process.env[WORKSPACE_ROOT_ENV];
  if (custom && custom.trim() !== "") {
    return custom;
  }
  return "/tmp/agent-workspace";
}

export function sanitizePathComponent(value: string): string {
  const sanitized = value.trim().replace(/[/\\?%*:|"<>]/g, "-");
  return sanitized.length > 0 ? sanitized : "unknown-session";
}

export function ensureWorkspaceDirectory(
  root: string,
  sessionId: string,
  identity: AgentIdLookup | null,
): { workspacePath: string } {
  const folderName = sanitizePathComponent(identity?.slug || sessionId);
  const workspacePath = path.join(root, folderName);
  fs.mkdirSync(workspacePath, { recursive: true });
  return { workspacePath };
}

export function buildContextMessageContent(workspacePath: string): string {
  return [
    `Use your per-session workspace at \`${workspacePath}\` for temporary working files that should not become repository changes.`,
    "Create files only when useful to the task, using whatever layout fits. Files survive conversation compaction but remain temporary storage.",
  ].join("\n");
}

export function hasWorkspaceContextMessage(entries: readonly unknown[]): boolean {
  // A historical instruction must not suppress reinsertion after compaction.
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as SessionEntryLike;
    if (candidate.type === "compaction") return false;
    if (candidate.type === "custom_message" && candidate.customType === WORKSPACE_CONTEXT_MESSAGE_TYPE) {
      return true;
    }
  }
  return false;
}

export function ensureWorkspaceContextMessage(
  context: SessionContext,
  workspacePath: string,
  sendMessage: (message: ContextMessage) => void,
): void {
  if (hasWorkspaceContextMessage(context.sessionManager.getBranch())) {
    return;
  }
  sendMessage({
    customType: WORKSPACE_CONTEXT_MESSAGE_TYPE,
    content: buildContextMessageContent(workspacePath),
    display: false,
  });
}

export function setupWorkspaceSession(context: SessionContext, pi: ExtensionAPI): string {
  const sessionId = context.sessionManager.getSessionId();
  const identity = lookupAgentIdentity(sessionId);
  const root = resolveWorkspaceRoot();
  const { workspacePath } = ensureWorkspaceDirectory(root, sessionId, identity);

  process.env[WORKSPACE_PATH_ENV] = workspacePath;
  ensureWorkspaceContextMessage(context, workspacePath, (msg) => pi.sendMessage(msg));
  return workspacePath;
}

export default function agentWorkspaceExtension(pi: ExtensionAPI): void {
  const handleSession = (_event: unknown, context: SessionContext) => {
    setupWorkspaceSession(context, pi);
  };

  pi.on("session_start", handleSession);
  pi.on("session_switch", handleSession);
  pi.on("session_fork", handleSession);
  pi.on("session_compact", handleSession);
  pi.on("session_shutdown", () => {
    delete process.env[WORKSPACE_PATH_ENV];
  });
}
