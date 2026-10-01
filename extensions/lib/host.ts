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

export type ToolCallEvent = {
  toolName: string;
  input: Record<string, unknown>;
};

export type InputReplacement = { input: Record<string, unknown> };
export type ToolCallHandler = (event: unknown, context: SessionContext) => InputReplacement | void;

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
  on(event: "tool_call", handler: ToolCallHandler): void;
  sendMessage(message: ContextMessage): void;
};

export type HostAdapter = {
  kind: "omp" | "pi";
  /** Register the host's post-start session transition listeners. */
  onSessionChange(api: ExtensionAPI, refresh: LifecycleHandler): void;
  /**
   * Make `workspacePath` visible to the host's Bash tool for this call.
   * Pi spawns Bash with `process.env`, so nothing is needed. OMP's persistent
   * shell never reads runtime `process.env`, so the OMP adapter prefixes an
   * `export` in that shell (no subshell, so `cd` and other shell-local state
   * keep working). Composable contract shared with sibling adapters: mutate
   * `event.input` in place AND return that same object as `{ input }`, so any
   * handler order composes under OMP's last-result-wins runner. A null path
   * marks failed setup and unsets the shell export; undefined leaves it alone.
   */
  exposeWorkspacePath(event: unknown, workspacePath: string | null | undefined): InputReplacement | void;
};

export const WORKSPACE_PATH_ENV = "AGENT_WORKSPACE_PATH";

function bashCall(event: unknown): ToolCallEvent | undefined {
  if (typeof event !== "object" || event === null) return;
  const call = event as Partial<ToolCallEvent>;
  if (call.toolName !== "bash" || !call.input || typeof call.input.command !== "string") return;
  return call as ToolCallEvent;
}

/** `export VAR='value';` plus a newline: a shell delimiter so following commands stay recognizable to other matchers. */
export function exportPrefix(workspacePath: string): string {
  return `export ${WORKSPACE_PATH_ENV}='${workspacePath.replaceAll("'", "'\\''")}';\n`;
}

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
      exposeWorkspacePath(event, workspacePath) {
        if (workspacePath === undefined) return;
        const call = bashCall(event);
        if (!call) return;
        const prefix = workspacePath === null ? `unset ${WORKSPACE_PATH_ENV};\n` : exportPrefix(workspacePath);
        call.input.command = prefix + (call.input.command as string);
        return { input: call.input };
      },
    };
  }

  return {
    kind: "pi",
    onSessionChange(api, refresh) {
      // session_shutdown + session_start already cover new, resume, fork, and reload.
      api.on("session_tree", refresh);
    },
    exposeWorkspacePath() {
      // Pi's Bash tool inherits process.env, which the shared code already sets.
    },
  };
}
