# agent-workspace

`agent-workspace` is an optional OMP/Pi extension that provisions a lightweight, per-session temporary workspace folder and injects branch-persistent instructions for coding agents.

It gives agents a dedicated scratch directory for temporary working files that survive conversation compaction without becoming repository changes.

## Responsibilities & Boundaries

- **Workspace Folder**: Creates a per-session directory at `/tmp/agent-workspace/<slug-or-id>` by default.
- **Friendly Slug**: Resolves the human-readable slug using `agent-id` when available; falls back cleanly to the session ID.
- **Compaction Recovery**: Injects a hidden workspace instruction (`dev.derekstride.agent-workspace.context-v1`) initially and again after each compaction.
- **Duplicate Prevention**: Matches instructions to the current session ID and checks only entries since the latest compaction. Forks get their own workspace guidance even when they inherit a parent's instruction; repeated lifecycle events (resume, reload, session switch, tree navigation) do not add duplicates.
- **Environment Context**: Exposes `AGENT_WORKSPACE_PATH` to the host's Bash tool (Pi inherits the process environment; OMP's persistent shell receives an export on each Bash call). It is cleared from the process environment on shutdown.
- **Path Changes**: If the resolved directory changes for the same session (for example `agent-id` becomes available or `AGENT_WORKSPACE_ROOT` changes), fresh guidance is injected; earlier directories are left untouched.
- **Host Support**: Runs unchanged on OMP and Pi; host lifecycle differences live in a small adapter.
- **No Overlapping Responsibilities**: Does not allocate identities (owned by `agent-id`) or manage Maildir transport/read states (owned by `agent-mail`).

## Storage Model

```text
$AGENT_WORKSPACE_ROOT/ (defaults to /tmp/agent-workspace)
└── <slug-or-session-id>/
```

New workspaces are empty: no `metadata.json` or preset subdirectories. Agents choose the files and layout appropriate to the task. Initializing an existing workspace preserves its contents.

Set `AGENT_WORKSPACE_ROOT` to override the root. `AGENT_WORKSPACE_PATH` contains the full current session directory. Temporary files survive conversation compaction, but may be removed by system cleanup.

Existing workspaces from the previous OS-temporary-directory and `sessions/` layout are not moved or deleted.

## Installation

Install the repository as a package for your host. From a local checkout:

```bash
omp plugin install "$PWD"
pi install "$PWD"
```

Or from the repository URL:

```bash
omp plugin install https://github.com/DerekStride/agent-workspace
pi install git:github.com/DerekStride/agent-workspace
```

Reload your agent after installing. [`agent-id`](https://github.com/DerekStride/agent-id) is optional; without it, workspace folders use the raw session ID.

## Development

See [AGENTS.md](AGENTS.md) for the code map, host adapter rules, and test commands.

```bash
bun run test:omp
bun run test:pi
bun run typecheck
```

## License

MIT. See [LICENSE.md](LICENSE.md).
