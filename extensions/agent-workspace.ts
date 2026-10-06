import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ContextMessage,
  createHostAdapter,
  type ExtensionAPI,
  type HostAdapter,
  type SessionContext,
} from "./lib/host.ts";

export const WORKSPACE_ROOT_ENV = "AGENT_WORKSPACE_ROOT";
export const WORKSPACE_CONTEXT_MESSAGE_TYPE = "dev.derekstride.agent-workspace.context-v1";
export type SessionEntryLike = {
  type?: unknown;
  customType?: unknown;
  content?: unknown;
  details?: { sessionId?: unknown; workspacePath?: unknown };
};

export type { ContextMessage, ExtensionAPI, SessionContext } from "./lib/host.ts";

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
      // Bun resolves PATH from the environment passed to the child, not from live process.env.
      env: process.env,
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

/** Path named by an instruction: `details.workspacePath`, or parsed from legacy message content. */
export function instructionWorkspacePath(entry: SessionEntryLike): string | undefined {
  const fromDetails = entry.details?.workspacePath;
  if (typeof fromDetails === "string") return fromDetails;
  const match = typeof entry.content === "string" ? /workspace at `([^`]+)`/.exec(entry.content) : null;
  return match?.[1];
}

export function hasWorkspaceContextMessage(
  entries: readonly unknown[],
  sessionId: string,
  workspacePath: string,
): boolean {
  // Parent-session and compacted instructions must not suppress current guidance.
  // Only the most recent own instruction counts: it must describe the current path,
  // so an older match cannot mask newer guidance that names a different directory.
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as SessionEntryLike;
    if (candidate.type === "compaction") return false;
    if (candidate.type === "custom_message" && candidate.customType === WORKSPACE_CONTEXT_MESSAGE_TYPE &&
      candidate.details?.sessionId === sessionId) {
      return instructionWorkspacePath(candidate) === workspacePath;
    }
  }
  return false;
}

export function ensureWorkspaceContextMessage(
  context: SessionContext,
  workspacePath: string,
  sendMessage: (message: ContextMessage) => void,
): void {
  const sessionId = context.sessionManager.getSessionId();
  if (hasWorkspaceContextMessage(context.sessionManager.getBranch(), sessionId, workspacePath)) {
    return;
  }
  sendMessage({
    customType: WORKSPACE_CONTEXT_MESSAGE_TYPE,
    content: buildContextMessageContent(workspacePath),
    display: false,
    details: { sessionId, workspacePath },
  });
}

export function setupWorkspaceSession(context: SessionContext, pi: ExtensionAPI): string {
  const sessionId = context.sessionManager.getSessionId();
  const identity = lookupAgentIdentity(sessionId);
  const root = resolveWorkspaceRoot();
  const { workspacePath } = ensureWorkspaceDirectory(root, sessionId, identity);

  ensureWorkspaceContextMessage(context, workspacePath, (msg) => pi.sendMessage(msg));
  return workspacePath;
}

export default function agentWorkspaceExtension(pi: ExtensionAPI): void {
  let adapter: HostAdapter | undefined;

  const handleSession = (_event: unknown, context: SessionContext) => {
    setupWorkspaceSession(context, pi);
  };

  pi.on("session_start", (event, context) => {
    if (!adapter) {
      // Lazy: host capabilities are only observable on a context, so detect on
      // the first shared event and register host transitions once per instance.
      adapter = createHostAdapter(context);
      adapter.onSessionChange(pi, handleSession);
    }
    handleSession(event, context);
  });
  pi.on("session_compact", handleSession);
}
