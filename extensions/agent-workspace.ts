import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const WORKSPACE_ROOT_ENV = "AGENT_WORKSPACE_ROOT";
export const WORKSPACE_PATH_ENV = "AGENT_WORKSPACE_PATH";
export const WORKSPACE_CONTEXT_MESSAGE_TYPE = "dev.derekstride.agent-workspace.context-v1";
export const METADATA_VERSION = 1;

export type SessionMetadata = {
  version: number;
  session_id: string;
  slug?: string;
  name?: string;
  created_at: string;
  updated_at: string;
};

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
  return path.join(os.tmpdir(), "agent-workspace");
}

export function sanitizePathComponent(value: string): string {
  const sanitized = value.trim().replace(/[/\\?%*:|"<>]/g, "-");
  return sanitized.length > 0 ? sanitized : "unknown-session";
}

export function ensureWorkspaceDirectory(
  root: string,
  sessionId: string,
  identity: AgentIdLookup | null,
): { workspacePath: string; metadataPath: string } {
  const folderName = sanitizePathComponent(identity?.slug || sessionId);
  const workspacePath = path.join(root, "sessions", folderName);
  fs.mkdirSync(workspacePath, { recursive: true });
  for (const directory of ["notes", "plans", "drafts", "handoff"]) {
    fs.mkdirSync(path.join(workspacePath, directory), { recursive: true });
  }

  const metadataPath = path.join(workspacePath, "metadata.json");
  const now = new Date().toISOString();

  let metadata: SessionMetadata;
  if (fs.existsSync(metadataPath)) {
    try {
      const contents = fs.readFileSync(metadataPath, "utf-8");
      const existing = JSON.parse(contents) as SessionMetadata;
      metadata = {
        ...existing,
        updated_at: now,
      };
      if (identity?.slug) metadata.slug = identity.slug;
      if (identity?.name) metadata.name = identity.name;
    } catch {
      metadata = {
        version: METADATA_VERSION,
        session_id: sessionId,
        slug: identity?.slug,
        name: identity?.name,
        created_at: now,
        updated_at: now,
      };
    }
  } else {
    metadata = {
      version: METADATA_VERSION,
      session_id: sessionId,
      slug: identity?.slug,
      name: identity?.name,
      created_at: now,
      updated_at: now,
    };
  }

  const temporaryPath = path.join(workspacePath, `.metadata.json.tmp-${Date.now()}`);
  fs.writeFileSync(temporaryPath, JSON.stringify(metadata, null, 2) + "\n", "utf-8");
  fs.renameSync(temporaryPath, metadataPath);

  return { workspacePath, metadataPath };
}

export function buildContextMessageContent(workspacePath: string): string {
  return [
    `Use your per-session workspace at \`${workspacePath}\` for working notes, plans, drafts, and handoff material that should survive compaction.`,
    "Durable repository changes belong in project files and git commits; inter-agent messaging belongs in `agent-mail`.",
  ].join("\n");
}

export function hasWorkspaceContextMessage(entries: readonly unknown[]): boolean {
  return entries.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as SessionEntryLike;
    return candidate.type === "custom_message" && candidate.customType === WORKSPACE_CONTEXT_MESSAGE_TYPE;
  });
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
  pi.on("session_shutdown", () => {
    delete process.env[WORKSPACE_PATH_ENV];
  });
}
