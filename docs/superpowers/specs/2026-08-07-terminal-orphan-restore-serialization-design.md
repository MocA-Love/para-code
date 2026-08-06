# Terminal Orphan Restore Serialization Design

## Problem

After a full Para Code restart, persistent editor terminals belonging to inactive spaces can return as orphan PTYs. The terminal scope contribution reconnects and parks them so the owning space can recover them later. When a space is activated, any parked terminal that was not consumed by its serialized working set is reopened by `unparkEditorTerminals`.

That fallback currently starts an unawaited async function from the synchronous `onDidSwitchScope` event. The workspace switch sequencer therefore releases before `openEditor` finishes. A subsequent switch can overlap the in-flight restore, allowing an earlier space's terminal editor request to complete against a later space's active editor state.

## Design

Add an explicit async completion-participant API to `IParadisWorkspaceSwitchService`. Participants run after the target scope and editor state are committed but before `onDidSwitchScope` is broadcast and before the switch sequencer releases. Participant failures are logged independently and do not prevent other participants or the completion notification.

The terminal scope contribution registers one participant. It applies panel terminal visibility, awaits all fallback editor-terminal opens for the target scope, persists the resulting ownership ledger, refreshes stable scopes, and then starts any interrupted orphan-revival retry in the background as before. `unparkEditorTerminals` becomes an awaited method; each failed open returns its live instance to the same scope's park ledger. The retry itself is not a switch-completion dependency because waiting for the PTY backend there would broaden the latency impact beyond this race fix.

The same-folder state-key correction path invokes the same participants before its completion event, so worktree/repository scope corrections keep identical ordering guarantees.

## Invariants

- A switch does not release its sequencer slot until terminal fallback restoration settles.
- `onDidSwitchScope` remains a completion notification, not a control-flow trigger.
- A failed terminal open does not lose or reassign the instance; it is parked under its original target state key.
- Existing nonce identity checks, PTY persistence formats, panel group persistence, and working-set formats remain unchanged.
- Participant failures are best-effort completion failures: they are logged and later completion participants and observers still run.
- No commit or push is performed without an explicit user instruction.

## Alternatives Rejected

- Checking `activeStateKey` only after `openEditor` leaves the request racing with the next switch and requires compensating after a wrong editor has already appeared.
- Converting `onDidSwitchScope` to an async event would turn a broadcast API into orchestration and change every existing listener's contract.
- Moving terminal restoration into `ParadisWorkspaceSwitchService` would couple workspace switching directly to terminal ownership internals and duplicate the terminal scope contribution's responsibilities.

## Verification

- A service-level regression test delays a registered completion participant, starts a competing switch, and proves the competing folder mutation and completion event wait for the participant.
- A terminal-scope integration regression parks an editor terminal, delays the real `openEditor` path, and proves the same ordering. A companion test verifies that a failed open reparks the live instance under its original scope.
- Existing round-trip terminal ownership coverage continues to pass.
- Client type checking, the focused workspace-switch integration suite, and diff hygiene checks are run after implementation.
- A read-only subagent reviews the completed diff against this design and the regression requirements.
