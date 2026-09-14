# agent-workspace

`agent-workspace` is an optional OMP extension that provisions a lightweight, per-session temporary workspace folder and injects branch-persistent instructions for coding agents.

It gives agents a dedicated scratchpad directory for notes, plans, drafts, and handoff material that survives conversation compaction.

## Responsibilities & Boundaries

- **Workspace Folder**: Creates a per-session directory under `$TMPDIR/agent-workspace/sessions/<slug-or-id>`.
- **Friendly Slug**: Resolves the human-readable slug using `agent-id` when available; falls back cleanly to the session ID.
- **Compaction-Safe Context**: Injects one hidden, branch-persistent context message (`dev.derekstride.agent-workspace.context-v1`) directing the agent to store working artifacts in the workspace.
- **Cache-Friendly**: Checks the current branch for the stable custom message type before injecting, preventing prompt-cache churn.
- **Environment Context**: Exposes `AGENT_WORKSPACE_PATH` in the process environment.
- **No Overlapping Responsibilities**: Does not allocate identities (owned by `agent-id`) or manage Maildir transport/read states (owned by `agent-mail`).

## Storage Model

```text
$AGENT_WORKSPACE_ROOT/ (defaults to $TMPDIR/agent-workspace)
└── sessions/<slug-or-session-id>/
    └── metadata.json
```

The workspace directory is intended for agents to place files such as notes, plans, scripts, and drafts:

```text
<workspace>/
├── metadata.json
├── notes/
├── plans/
├── drafts/
└── handoff/
```

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
