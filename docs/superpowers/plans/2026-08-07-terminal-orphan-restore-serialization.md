# Terminal Orphan Restore Serialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent restarted inactive-space editor terminals from completing restoration after a later space switch has begun.

**Architecture:** Add an awaited workspace-switch completion participant registry and move terminal scope restoration from the synchronous completion event into one participant. Keep the sequencer held until participants settle, then broadcast the existing completion event.

**Tech Stack:** TypeScript, VS Code services and lifecycle primitives, Mocha assertions

## Global Constraints

- Preserve all existing terminal persistence and nonce identity formats.
- Keep participant failures isolated and logged so completion observers still run.
- Do not modify unrelated files or the user's untracked `mmmo.html`.
- Do not commit or push without an explicit user instruction.

---

### Task 1: Serialize async switch completion work

**Files:**
- Modify: `src/vs/paradis/contrib/workspaceSwitch/common/paradisWorkspaceSwitch.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/browser/paradisWorkspaceSwitchService.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchIntegration.test.ts`

**Interfaces:**
- Produces: `registerSwitchCompletionParticipant(participant: (stateKey: string) => void | Promise<void>): IDisposable`
- Produces: completion ordering in which registered participants settle before `onDidSwitchScope` and before the sequencer starts a competing switch

- [x] **Step 1: Write the failing integration test**

Register a participant that blocks on a `DeferredPromise`, start switches to `space-b` and `space-c`, and assert that the second folder update and the `space-b` completion event have not happened while the participant is blocked.

```typescript
const participantStarted = new DeferredPromise<void>();
const releaseParticipant = new DeferredPromise<void>();
testDisposables.add(harness.workspaceSwitchService.registerSwitchCompletionParticipant(async stateKey => {
	if (stateKey === 'space-b') {
		participantStarted.complete();
		await releaseParticipant.p;
	}
}));
```

- [x] **Step 2: Run the focused test and verify RED**

Run `npm run typecheck-client` only after the test API is declared enough to compile, then run `scripts/test.sh --grep "waits for completion participants before releasing the next space switch"`.

Expected: before the production await is added, the competing switch starts or the completion event fires while the participant remains blocked.

- [x] **Step 3: Add the participant registry and awaited runner**

Store participants in a `Set`, return a disposable registration, and execute a stable snapshot sequentially. Catch and log each participant error before proceeding to the next participant.

```typescript
registerSwitchCompletionParticipant(participant: (stateKey: string) => void | Promise<void>): IDisposable {
	this._switchCompletionParticipants.add(participant);
	return toDisposable(() => this._switchCompletionParticipants.delete(participant));
}
```

- [x] **Step 4: Await participants in both completion paths**

Await participants before firing `onDidSwitchScope` in the normal/rollback path and in the same-folder state-key correction path. Keep the existing event as the final broadcast notification.

- [x] **Step 5: Run the focused test and verify GREEN**

Run `npm run typecheck-client`, then run `scripts/test.sh --grep "waits for completion participants before releasing the next space switch"`.

Expected: typecheck exits 0 and the focused regression passes.

### Task 2: Await terminal fallback restoration

**Files:**
- Modify: `src/vs/paradis/contrib/workspaceSwitch/browser/paradisTerminalScope.contribution.ts`
- Verify: `src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchIntegration.test.ts`
- Verify: `src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisTerminalEditorPark.test.ts`

**Interfaces:**
- Consumes: `registerSwitchCompletionParticipant(...)`
- Produces: awaited `applyScope(targetStateKey): Promise<void>` and `unparkEditorTerminals(targetStateKey): Promise<void>`

- [x] **Step 1: Register terminal restoration as a completion participant**

Replace the terminal contribution's `onDidSwitchScope` control-flow listener with a registered async participant that awaits `applyScope` and then starts the existing interrupted orphan-revival retry in the background.

- [x] **Step 2: Make terminal fallback opens awaitable**

Return a promise from `unparkEditorTerminals`, await each `openEditor`, and repark any live instance whose open fails. Remove the detached async IIFE.

- [x] **Step 3: Keep terminal bookkeeping after restoration**

In `applyScope`, await editor-terminal restoration before persisting the mapping and refreshing stable scopes.

- [x] **Step 4: Verify the focused suites**

Run `npm run typecheck-client`, then run `scripts/test.sh --grep "ParadisWorkspaceSwitchService integration|ParadisTerminalEditorPark"`.

Expected: typecheck exits 0 and all selected tests pass.

### Task 3: Review and final verification

**Files:**
- Review only the two design documents and the production/test files listed above.

**Interfaces:**
- Produces: reviewed, verified working-tree changes without committing or pushing

- [x] **Step 1: Check the scoped diff**

Run `git diff --check`, `git status --short`, and a scoped `git diff`. Confirm that `mmmo.html` and unrelated files are untouched.

- [x] **Step 2: Run fresh verification**

Run `npm run typecheck-client` followed by the focused workspace-switch and terminal park tests.

- [x] **Step 3: Request subagent review**

Ask a read-only reviewer to inspect the working-tree diff against `docs/superpowers/specs/2026-08-07-terminal-orphan-restore-serialization-design.md`, with emphasis on ordering, rollback, same-URI correction, lifecycle disposal, failure isolation, and regression coverage.

- [x] **Step 4: Address findings and re-verify**

Fix every valid Critical or Important issue, rerun the relevant failing/passing tests and typecheck, and perform a final `git diff --check`.

Review follow-up: add a real `ParadisTerminalWorkspaceScope` integration test with a delayed `openEditor`, verify it fails when the production await is temporarily removed, and cover same-scope repark after an open failure. Document the completion-participant non-reentrancy contract.
