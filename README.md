# agent-workspace

`agent-workspace` is an optional OMP extension that provisions a lightweight, per-session temporary workspace folder and injects branch-persistent instructions for coding agents.

It gives agents a dedicated scratch directory for temporary working files that survive conversation compaction without becoming repository changes.

## Responsibilities & Boundaries

- **Workspace Folder**: Creates a per-session directory at `/tmp/agent-workspace/<slug-or-id>` by default.
- **Friendly Slug**: Resolves the human-readable slug using `agent-id` when available; falls back cleanly to the session ID.
- **Compaction Recovery**: Injects a hidden workspace instruction (`dev.derekstride.agent-workspace.context-v1`) initially and again after each compaction.
- **Duplicate Prevention**: Matches instructions to the current session ID and checks only entries since the latest compaction. Forks get their own workspace guidance even when they inherit a parent's instruction; repeated lifecycle events do not add duplicates.
- **Environment Context**: Exposes `AGENT_WORKSPACE_PATH` in the process environment.
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

Link or copy the extension into your OMP extensions directory:

```bash
ln -sf "$PWD/extensions/agent-workspace.ts" "$HOME/.omp/agent/extensions/agent-workspace.ts"
```

Or install as an npm / Bun package in your OMP configuration.

## Development

```bash
bun test
bunx tsc --noEmit
```

## License

MIT. See [LICENSE.md](LICENSE.md).
