# Codex Pane App Server Design

## Problem

Para Browser MCP identifies its owning terminal with `PARA_CODE_TERMINAL_PANE_ID` and locates the Para Browser gateway through `PARA_CODE_MCP_PORT_FILE`. Codex MCP processes are children of the app-server, not the TUI. The current long-lived shared Codex daemon is started by the Para Code shared process without either terminal variable, so its Para Browser MCP child cannot identify a pane even when the TUI itself runs inside a Para Code terminal.

The same shared daemon also retains MCP process groups for loaded threads. In the observed environment it held about 41 groups and approximately 4 GiB of aggregate RSS. A pane app-server used approximately 105–135 MiB before MCP startup and approximately 0.95 GiB with the current full MCP configuration loaded. The pane process tree exists only while its interactive Codex session is active, so the replacement bounds that cost to active panes and releases it when the session exits. It must also preserve Para Code Mobile's live Codex events and controls without introducing another permanently growing global daemon.

## Design

Each Para Code terminal receives a pane-specific Codex app-server socket path together with the existing Para Browser variables. Para Code prepends a bundled `codex` launcher to that terminal's `PATH`, and its shell integration restores that precedence after user startup files modify `PATH`. The launcher resolves the user's real Codex executable after removing its own directory, passes non-interactive subcommands through unchanged, and handles interactive `codex`, `resume`, `fork`, `archive`, `delete`, and `unarchive` commands through `--remote unix://<pane-socket>`.

The launcher starts `codex app-server --listen unix://<pane-socket>` lazily. That app-server inherits the pane token and MCP port-file variables before any thread or MCP server is created. The launcher keeps only the app-server it owns alive while the interactive Codex command is running, forwards termination signals, and removes its PID/socket records when the command ends. Runtime files live in a mode-0700 directory below Para Code's user-data directory. Existing explicit `--remote` calls and unsupported remote subcommands bypass this management.

Para Code Mobile replaces its single global-daemon connection with a connection pool keyed by pane socket path. Confirmed Codex pane sessions supply `{ threadId, socketPath }` targets. Each pool member retains the existing initialize, loaded-thread discovery, subscription, approval, model, settings, and thread-read behavior. Public operations route by thread ID to the owning connection. When a resumed thread moves to another pane, updating the target atomically disconnects the old socket and subscribes through the new one.

The existing `codexDaemonStreaming` setting remains compatible: it enables or disables pooled app-server streaming instead of starting a global daemon. Para Browser MCP itself does not depend on Mobile being enabled; the pane launcher is injected for every supported local terminal.

## Security and Failure Handling

- Socket and PID paths are derived only from Para Code-generated pane tokens and remain below a private user-data directory.
- The launcher never uses `eval` or a shell command string for user arguments; it forwards the original argument vector with quoting intact.
- A PID record is trusted only when it contains bounded decimal process IDs and the live process command matches the exact pane app-server socket. A live launcher owner reuses that server; dead-owner records and sockets are reclaimed before startup.
- The launcher removes only its own exact directory from `PATH`, preventing recursive execution while preserving user wrappers such as agent messaging shims.
- If app-server startup fails or the socket does not become ready within ten seconds, the launcher terminates the child and reports an error instead of silently falling back to the shared daemon.
- If Mobile cannot connect to one pane server, other pane connections remain usable and the existing transcript fallback continues.

## Compatibility

- Claude Code behavior is unchanged.
- Direct absolute-path Codex invocations and user-specified `--remote` endpoints remain under user control.
- Windows retains the current behavior because Codex Unix-socket Mobile integration is already unsupported there.
- Existing global Codex daemons are not killed; Para Code terminal sessions use their explicit pane socket and therefore do not attach to the global daemon.

## Verification

- Unit-test terminal environment creation, path preservation, socket-path validation, and unsupported-platform behavior.
- Execute the bundled launcher against a fake Codex executable to prove environment inheritance, explicit `--remote` injection, non-interactive passthrough, signal cleanup, and argument preservation.
- Exercise two Unix-socket fake app-servers concurrently and verify thread-specific Mobile event/control routing plus pane transfer.
- Run client type checking, focused Para Browser/Mobile tests, layer checks, and a source-launched Para Code smoke check.
