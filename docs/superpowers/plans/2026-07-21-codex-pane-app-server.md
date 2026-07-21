# Codex Pane App Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex CLI sessions launched in Para Code terminals use pane-bound app-servers so Para Browser MCP and Para Code Mobile work together.

**Architecture:** A bundled POSIX launcher lazily starts one Codex app-server per active terminal pane and connects the TUI through an explicit Unix socket. Mobile replaces its global-daemon client with a pool of socket-specific connections routed by confirmed pane/thread ownership.

**Tech Stack:** TypeScript, POSIX shell, Codex app-server JSON-RPC over WebSocket/Unix sockets, Mocha/Sinon, VS Code build tooling.

## Global Constraints

- Preserve existing Claude Code behavior and explicit user `--remote` usage.
- Do not start an app-server until an interactive Codex command is invoked.
- Do not silently fall back to the global Codex daemon.
- Keep socket/runtime files private and validate all pane-derived paths.
- Preserve the `codexDaemonStreaming` setting and all existing Mobile controls.
- Implement with test-first red/green cycles and do not commit until final verification and review succeed.

---

### Task 1: Pane Runtime Environment

**Files:**
- Modify: `src/vs/paradis/contrib/agentBrowser/common/paradisAgentBrowser.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/browser/paradisPaneTokenService.ts`
- Modify: `src/vs/paradis/contrib/agentBrowser/test/node/paradisGatewayEndpoint.test.ts`

**Interfaces:**
- Produce `PARADIS_CODEX_APP_SERVER_SOCKET_ENV_VAR`, `PARADIS_CODEX_LAUNCHER_DIR_ENV_VAR`, `paradisCodexPaneSocketPath(userDataPath, token)`, and extended `paradisCreateTerminalPaneEnvironment(...)`.
- Preserve `PARA_CODE_TERMINAL_PANE_ID`, `PARA_CODE_MCP_PORT_FILE`, pre-existing `PATH`, `VSCODE_PATH_PREFIX`, and user CDP variables.

- [x] Add failing tests asserting a valid pane token creates a private user-data socket path and prepends the launcher path without losing existing values.
- [x] Run `mise exec -- ./scripts/test.sh --grep 'ParadisGatewayEndpoint'` and confirm the new assertions fail because Codex pane variables are absent.
- [x] Add the constants/path helper and pass `appRoot`, `userDataPath`, and platform-specific launcher directory from `ParadisPaneTokenService`.
- [x] Run `mise exec -- npm run typecheck-client`, transpile, and rerun the focused suite until it passes.

### Task 2: Lazy Codex Launcher

**Files:**
- Create: `resources/paradis/bin/codex`
- Modify: `build/gulpfile.vscode.ts`
- Create: `src/vs/paradis/contrib/agentBrowser/test/node/paradisCodexPaneLauncher.test.ts`

**Interfaces:**
- Consume `PARA_CODE_CODEX_APP_SERVER_SOCKET` and `PARA_CODE_CODEX_LAUNCHER_DIR`.
- For managed commands invoke `real-codex app-server --listen unix://$socket` and `real-codex --remote unix://$socket <original args>`.
- For non-interactive subcommands and explicit `--remote`, invoke only the real Codex with the original arguments.

- [x] Add a fake-Codex integration test that records app-server/TUI argv and inherited pane variables through the checked-in launcher.
- [x] Run `mise exec -- ./scripts/test.sh --grep 'ParadisCodexPaneLauncher'` and confirm failure because the launcher is absent.
- [x] Implement the shell launcher with strict path filtering, mode-0700 runtime setup, bounded socket readiness, signal forwarding, stale-owner recovery, and exact exit-code propagation.
- [x] Include `resources/paradis/bin/codex` in all desktop package streams and preserve its executable mode.
- [x] Add failing/passing cases for `exec`, explicit `--remote`, prompts containing spaces/metacharacters, and owned-process cleanup.

### Task 3: Multi-App-Server Mobile Client

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisCodexLiveClient.ts`
- Create: `src/vs/paradis/contrib/mobileRelay/test/node/paradisCodexLiveClient.test.ts`

**Interfaces:**
- Add `IParadisCodexThreadTarget { threadId: string; socketPath: string }`.
- Keep the public `ParadisCodexLiveClient` methods, changing `setThreads` to accept targets and route calls by thread ID.
- Encapsulate one JSON-RPC WebSocket and its subscription state in a disposable socket-specific connection.

- [x] Start two fake WebSocket-over-Unix app-servers and add a failing test for simultaneous `thread/loaded/list`, `thread/resume`, event delivery, and model routing.
- [x] Run `mise exec -- ./scripts/test.sh --grep 'ParadisCodexLiveClient'` and confirm failure under the current single-daemon implementation.
- [x] Extract the existing per-server protocol behavior into a socket-specific connection without changing approval/model/settings parsing.
- [x] Implement the connection pool, thread ownership map, connection disposal, and per-connection failure isolation.
- [x] Add and pass a regression test that transfers one thread from socket A to socket B and rejects stale-socket operations.

### Task 4: Mobile Pane Routing

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileRelayService.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/test/node/paradisMobileAgentChat.test.ts`

**Interfaces:**
- `ParadisMobileAgentChat` consumes a pane-token-to-socket resolver supplied from `ParadisMobileRelayService.userDataPath`.
- Confirmed Codex sessions synchronize unique `{ threadId, socketPath }` targets.
- Subagent thread reads route through the root thread's owning connection before using the existing transcript fallback.

- [x] Add a failing helper-level test showing two pane sessions map to two sockets and a resumed thread maps only to its newest pane owner.
- [x] Run the Mobile suite and confirm the new test fails with the old thread-ID-only synchronization.
- [x] Pass the user-data socket resolver from the relay service, synchronize targets, and route subagent reads with the root thread ID.
- [x] Preserve enable/disable semantics and existing transcript, approval, model, and settings fallbacks.
- [x] Run the combined Codex Live Client, Mobile Agent Chat, and Para Browser suites.

### Task 5: Verification and Review

**Files:**
- Review every file reported by `git diff --name-only HEAD`.

**Interfaces:**
- No new interface; verify the complete behavior and packaging boundary.

- [x] Run `mise exec -- npm run typecheck-client` and fix every error before tests.
- [x] Run `mise exec -- npm run transpile-client` and the focused unit suites for the launcher, gateway, live client, and Mobile chat.
- [x] Run `mise exec -- npm run valid-layers-check` and the relevant build packaging check.
- [x] Launch the source build through `.agents/skills/launch/scripts/launch.sh`, open a terminal, and verify the injected launcher/socket environment without exposing secret values.
- [x] Run an end-to-end fake or local Codex app-server check proving its Para Browser MCP child receives both pane variables and Mobile can initialize on the same socket.
- [x] Review the diff for path traversal, PID/socket races, shell injection, leaked secrets, disposal leaks, accidental global-daemon behavior, and unrelated changes.
- [x] Re-run all affected verification commands after review fixes.
- [ ] Stage only intended files, commit once with a focused message, and push `fix/codex-pane-app-server` to the configured remote.
