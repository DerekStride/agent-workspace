# Agent Workspace repository guide

## Documentation boundaries

- `README.md` is for people evaluating, installing, and operating agent-workspace.
- `AGENTS.md` owns implementation details, contributor commands, and host compatibility rules.
- The extension injects its own short workspace instruction into session context; there is no separate skill or prime command.

## Product boundary

agent-workspace provisions one temporary directory per session under `$AGENT_WORKSPACE_ROOT` (default `/tmp/agent-workspace`), exports it as `AGENT_WORKSPACE_PATH`, and keeps a hidden `custom_message` (`dev.derekstride.agent-workspace.context-v1`) on the active branch so the instruction survives compaction. It does not allocate identities (`agent-id`) or transport messages (`agent-mail`).

`agent-id` is optional. When `agent-id lookup <session-id> --json` succeeds, the workspace folder is the immutable slug; otherwise it is the sanitized session ID. Never require `agent-id` and never add host-specific identity fallbacks.

## Code map

| Path | Responsibility |
|---|---|
| `extensions/agent-workspace.ts` | Shared behavior: slug lookup, directory creation, environment export, per-branch instruction dedupe |
| `extensions/lib/host.ts` | Host detection and the OMP/Pi lifecycle event differences |
| `index.ts` | Package entry used by the OMP manifest; re-exports the extension |
| `test/extension.test.ts` | OMP host suite (Bun) |
| `test/extension.pi.test.ts` | Pi host suite (Node `node:test`) |
| `test/fixtures.ts` | Shared harness and helpers used by both suites |

## Lifecycle and state

`hasWorkspaceContextMessage()` walks the current branch backwards from the leaf: a `compaction` entry ends the search (re-inject), and the most recent own `custom_message` (`details.sessionId` equals the current session) decides. It satisfies the check only when it names the currently resolved path (`details.workspacePath`, or the path parsed from legacy message content), so guidance is refreshed when the resolved directory changes (identity availability or `AGENT_WORKSPACE_ROOT`), including A → B → A, while same-path reloads still dedupe. Older directories and their files are never moved or deleted. Inherited parent-session messages never suppress a fork's own instruction.

Each extension instance remembers the path it exported. Before re-provisioning, it releases its previous path and publishes the new environment value only after workspace setup and guidance succeed. Failed setup leaves the workspace unavailable until a successful retry; OMP Bash calls explicitly unset any stale shell export in the meantime. Re-provisioning and `session_shutdown` delete `AGENT_WORKSPACE_PATH` only when the process value still equals the owned path, so a replacement runtime that already exported its own value is left alone. Cleanup is idempotent.

## OMP and Pi host adapter

Keep host differences in `extensions/lib/host.ts`; the shared file must not branch on host.

- Detection is lazy and capability-based: `session_start` is registered at factory time; the first `session_start` creates the adapter from the context. OMP contexts expose both `setInterval` and `clearTimer`; anything else is treated as Pi. The adapter then registers host transition listeners once per instance. Do not detect hosts through process environment markers (`AI_AGENT`, `PI_*`), which nested agents inherit.
- Shared events: `session_start`, `session_compact`, `session_shutdown`.
- OMP (verified against 18.4.4 `session/agent-session.ts`): `session_switch` fires with reason `new`, `resume`, or `fork` and keeps the extension runtime; `session_branch` fires after `branch()` creates a new session file from an entry; `session_tree` fires after in-session `navigateTree()`. These are three distinct operations; all re-run the workspace setup.
- Pi (verified against 0.99.1): runtime replacement restarts the extension, so `session_start` carries `reason: startup | reload | new | resume | fork`; `session_tree` fires after tree navigation. Pi has no `session_switch`/`session_branch`.
- Neither host's Bash tool reads `input.env`. Pi spawns Bash with `process.env`, so setting `AGENT_WORKSPACE_PATH` there is enough. OMP's embedded persistent shell takes its environment from a login-shell snapshot plus per-command defaults and never sees runtime `process.env` changes, so the OMP adapter handles `tool_call` for `bash`: it prefixes `export AGENT_WORKSPACE_PATH='<path>';` plus a newline to the command (no subshell; the rest of the input is verbatim; non-Bash tools untouched). The `;` is a shell delimiter so sibling command matchers (Agent Mail, Agent ID) still recognize the following invocation. Composable contract shared by the sibling adapters: mutate `event.input` in place **and** return that same object as `{ input }`. OMP's runner gives every handler the original `event.input` and applies the last returned `input`, so with this contract every handler order composes; the OMP suite proves both orders with a mail-style wrapper and executes the composed command. Pi's adapter is a no-op (Pi's Bash inherits `process.env`). Remaining limits: the persistent shell keeps the last exported value until OMP disposes it at process exit (no Bash runs at shutdown); an explicit inline `AGENT_WORKSPACE_PATH=x cmd` still wins because it follows the export. OMP resets cwd and shell variables between Bash calls even without this extension, so re-prefixing every call is what keeps the value current after `session_switch`.
- `execFileSync` receives `env: process.env` explicitly because Bun resolves `PATH` from the child environment, not from live `process.env`.

Maintain both suites together: `test/extension.test.ts` drives OMP's real event names (`session_switch` with reasons, `session_branch`, `session_tree`) under Bun; `test/extension.pi.test.ts` drives Pi's `session_start` reasons and `session_tree` under Node. Both import `test/fixtures.ts`; duplicated shared-behavior cases in each suite are intentional. When changing shared behavior (directory layout, slug fallback, dedupe and path-change refresh, environment ownership, Bash visibility), add matching assertions to both suites. Keep the `pi` and `omp` manifests in `package.json` explicit so tests and adapter helpers are never loaded as extensions.

## Development

```bash
bun install
bun run typecheck
bun run test:omp
bun run test:pi
```

The OMP suite needs Bun 1.3.14+; the Pi suite needs Node 24+ (native TypeScript type stripping). Mocked contexts establish contract shape only; verify lifecycle changes against the installed hosts:

```bash
omp plugin install "$PWD"
pi install "$PWD"
```

For an isolated live check without touching global settings, start a host with `--no-extensions -e "$PWD/extensions/agent-workspace.ts"` and a dedicated `--session-dir`, then confirm the session JSONL contains exactly one workspace `custom_message` per active branch and that `echo $AGENT_WORKSPACE_PATH` in the Bash tool matches the created directory.
