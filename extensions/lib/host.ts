// Structural host contracts: keep OMP-only APIs optional and confined to this adapter.
export type SessionContext = {
  sessionManager: {
    getSessionId(): string;
    getBranch(): readonly unknown[];
  };
  setInterval?(callback: () => void, delay: number): unknown;
  clearTimer?(timer: unknown): void;
};

export type ContextMessage = {
  customType: string;
  content: string;
  display: boolean;
  details: { sessionId: string; workspacePath: string };
};

export type LifecycleHandler = (event: unknown, context: SessionContext) => void;

/**
 * Lifecycle events across both hosts. Each host fires only its own names; the
 * adapter registers the transition listeners that exist on the detected host.
 *
 * - Shared: `session_start`, `session_compact`, `session_shutdown`.
 * - OMP: `session_switch` (new/resume/fork keep the runtime), `session_branch`
 *   (branching into a new session file), and `session_tree` (in-session tree
 *   navigation). These are distinct operations, not duplicate notifications.
 * - Pi: `session_start` carries `reason` for startup/reload/new/resume/fork
 *   because runtime replacement restarts the extension; `session_tree` fires
 *   after tree navigation.
 */
export type LifecycleEvent =
  | "session_start"
  | "session_compact"
  | "session_shutdown"
  | "session_switch"
  | "session_branch"
  | "session_tree";

export type ExtensionAPI = {
  on(event: LifecycleEvent, handler: LifecycleHandler): void;
  sendMessage(message: ContextMessage): void;
};

export type HostAdapter = {
  kind: "omp" | "pi";
  /** Register the host's post-start session transition listeners. */
  onSessionChange(api: ExtensionAPI, refresh: LifecycleHandler): void;
};

export function createHostAdapter(context: SessionContext): HostAdapter {
  // Detect capabilities, not process.env: OMP launched by Pi can inherit PI_*.
  const managedTimers =
    typeof context.setInterval === "function" && typeof context.clearTimer === "function";

  if (managedTimers) {
    return {
      kind: "omp",
      onSessionChange(api, refresh) {
        api.on("session_switch", refresh);
        api.on("session_branch", refresh);
        api.on("session_tree", refresh);
      },
    };
  }

  return {
    kind: "pi",
    onSessionChange(api, refresh) {
      // session_shutdown + session_start already cover new, resume, fork, and reload.
      api.on("session_tree", refresh);
    },
  };
}
