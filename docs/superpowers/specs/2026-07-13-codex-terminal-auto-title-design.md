# Codex terminal auto-title design

## Goal

When an interactive Codex TUI runs in a Para Code integrated terminal, replace the temporary `codex | <thread UUID>` tab label with a short content-derived title. Normal starts and `codex resume` flows must work without modifying Codex itself or persisting a synthetic terminal rename.

## Safety invariants

- Never mutate Codex state while discovering a thread. Open the newest `state_N.sqlite` with `readOnly: true` and treat schema mismatch as a no-op.
- Never start a Codex App Server for title discovery.
- Never use the normal terminal API rename path for an automatic title. Manual/API titles remain authoritative and persistent; automatic titles are transient display state.
- Never identify Codex from a substring match alone. Require a trusted, high-confidence direct Codex command and an exact `codex | <canonical UUID>` OSC title on the same terminal run.
- Never apply an asynchronous result to a reused terminal run. Revalidate run generation, process ID, thread ID, source sequence, command state, configuration, and absence of a manual title immediately before applying.
- On ambiguity or failure, preserve the existing terminal title.

## Architecture

### Codex terminal run controller

An Electron terminal contribution owns one `RunState` for its terminal instance. It observes trusted shell command execution/finish, raw sequence-title changes, relaunch/disposal, and relevant configuration changes within that instance's lifecycle.

Each run state records a monotonically increasing generation, process ID, command ID, thread UUID, expected OSC sequence, and invocation kind. A new command, relaunch, command finish, manual rename, sequence change, setting disablement, or disposal invalidates the run and releases its transient title.

Supported interactive commands have an executable basename of `codex`, `codex.exe`, or `codex.cmd`, with ordinary TUI arguments including `resume`, `-C`, and model/config flags. Non-interactive server/automation subcommands such as `exec`, `app-server`, and `mcp-server` are excluded. Replayed command metadata is not accepted as proof of a live run.

### Read-only Codex thread reader

A narrow Node-side service receives a canonical UUID, invocation kind, and cwd, then returns only a validated prompt string. Thread ID, source, cwd, schema, and rollout path are validated inside the shared process and are not exposed to the renderer.

It selects the newest `state_N.sqlite`, opens it with Node SQLite read-only mode, checks required columns with `PRAGMA table_info(threads)`, and performs an indexed `WHERE id = ?` lookup. It validates that the rollout path is an absolute JSONL file under the effective Codex home. When the SQLite preview is empty or unavailable, it reads the rollout incrementally and extracts the first real user message while excluding injected environment and AGENTS instructions. Incomplete trailing JSONL records are ignored.

The reader never writes metadata, invokes `thread/resume`, or starts an App Server. Schema, path, home, lock, or parse failures return no result.

### Transient terminal title

Terminal instances gain a generic, non-persisted transient title lease. The display priority is:

1. manual/API static title;
2. active transient title;
3. the existing configured label computed from sequence/process/cwd.

The lease is scoped to an expected terminal run and source sequence. It does not change `staticTitle`, `titleSource`, the PTY title, or serialized persistent-terminal state. Disposing the lease recomputes the ordinary label. A manual rename, a new raw OSC title, relaunch, or process/command completion automatically invalidates it.

When no transient title exists, all existing terminal behavior is unchanged.

### Title generation

The persisted Codex thread title is preferred when present. Otherwise, the first real user request is normalized, bounded, and converted to a short deterministic title. This path does not depend on network access, authentication, a model call, or a second Codex process.

No generated title is written back through Codex `thread/name/set`.

## Data flow

1. A trusted direct Codex TUI command begins on a terminal instance; the controller creates a new run generation.
2. The same terminal emits an exact `codex | <UUID>` sequence title.
3. The controller requests read-only thread metadata for that UUID.
4. The reader validates the SQLite row and obtains the first real request from preview or rollout JSONL.
5. The controller revalidates the complete run identity and applies the normalized short title through a transient-title lease.
6. Command completion, manual rename, Codex `/rename`, relaunch, a different sequence, setting disablement, or disposal releases the lease.

For a resumed thread with an existing Codex name, Codex's own non-UUID title is respected and no synthetic title is applied. For an unnamed resumed thread, the stored first request supplies the title immediately.

## Configuration and compatibility

The existing Para Code setting continues to request `app-name` and `thread-title` from Codex so the UUID can act as a correlation signal. The controller also respects `terminal.integrated.tabs.allowAgentCliTitle`, task terminals, explicit title templates, manual static titles, and unsupported/remote Codex homes by failing closed.

Claude, Copilot, and Gemini detection and title behavior are not changed. Codex-specific matching is narrowed from the current substring rule to the exact candidate format for this feature.

## Verification coverage

Focused automated coverage should include:

- exact Codex UUID OSC acceptance and near-match rejection;
- trusted/high-confidence command requirements and replay rejection;
- normal start, `resume`, resume picker, flags, and direct executable launch;
- exclusion of `exec`, `app-server`, tasks, explicit templates, and disabled settings;
- concurrent terminals and the same thread resumed in multiple terminals;
- stale async results after relaunch, terminal reuse, process change, or a newer run;
- manual terminal rename and Codex `/rename` precedence;
- command finish, process exit, disposal, background/editor terminals, and window reload;
- read-only SQLite schema/path validation and JSONL fallback parsing;
- generated-title normalization, length bounds, and empty-input behavior;
- unchanged Claude, Copilot, Gemini, and ordinary terminal label computation.

## Non-goals

- Renaming the Codex thread itself.
- Supporting ambiguous aliases, shell functions, or wrapper chains that cannot be proven to launch Codex.
- Titling non-interactive Codex automation/server commands.
- Repairing or migrating Codex state.
