// Shared host-neutral test fixtures. Both host suites import these so shared
// behavior is asserted identically; host-specific lifecycle stays in each suite.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ContextMessage, ExtensionAPI, SessionContext } from "../extensions/agent-workspace.ts";

export const ENV_KEYS = ["AGENT_WORKSPACE_ROOT", "AGENT_WORKSPACE_PATH", "PATH"] as const;

export type Harness = {
  api: ExtensionAPI;
  context: SessionContext;
  handlers: Map<string, (event: unknown, context: SessionContext) => void>;
  sent: ContextMessage[];
  state: { sessionId: string; entries: unknown[] };
  fire: (event: string, payload?: unknown) => void;
};

/** A fake host. `contextExtras` carries host capabilities (OMP managed timers). */
export function createHarness(sessionId: string, contextExtras: Partial<SessionContext> = {}): Harness {
  const handlers = new Map<string, (event: unknown, context: SessionContext) => void>();
  const sent: ContextMessage[] = [];
  const state = { sessionId, entries: [] as unknown[] };
  const context: SessionContext = {
    sessionManager: {
      getSessionId: () => state.sessionId,
      getBranch: () => state.entries,
    },
    ...contextExtras,
  };
  const api: ExtensionAPI = {
    on(event, handler) { handlers.set(event, handler); },
    sendMessage(message) {
      sent.push(message);
      state.entries.push({ type: "custom_message", ...message });
    },
  };
  return { api, context, handlers, sent, state, fire: (event, payload = {}) => handlers.get(event)?.(payload, context) };
}

export function saveEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

export function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

/** A PATH containing a fake `agent-id` that resolves every session to `slug`. */
export function fakeAgentIdPath(slug: string): { bin: string; PATH: string } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-bin-"));
  fs.writeFileSync(path.join(bin, "agent-id"), `#!/bin/sh
printf '{"session_id":"%s","name":"Test Agent","slug":"${slug}"}\\n' "$2"
`, { mode: 0o755 });
  return { bin, PATH: `${bin}:/usr/bin:/bin` };
}

/** A legacy (pre-workspacePath) instruction entry as written by earlier versions. */
export function legacyInstruction(sessionId: string, workspacePath: string, customType: string): unknown {
  return {
    type: "custom_message",
    customType,
    content: `Use your per-session workspace at \`${workspacePath}\` for temporary working files that should not become repository changes.`,
    display: false,
    details: { sessionId },
  };
}
