# Terminal Space Restart Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve each restored terminal's owning Para Code space when a full desktop restart renumbers persistent PTY IDs.

**Architecture:** Carry the previous-session PTY ID on revived attach targets, then resolve ownership against a restore-only startup snapshot before recording the terminal under its current ID. Keep the existing numeric ledger format for backward compatibility.

**Tech Stack:** TypeScript, VS Code terminal services, Mocha assertions

## Global Constraints

- Do not change the existing terminal ownership storage format.
- Do not infer ownership from current cwd when an authoritative restored ID is available.
- Do not touch or stage unrelated mobile relay changes already present in the worktree.

---

### Task 1: Add the ownership regression test

**Files:**
- Modify: `src/vs/paradis/contrib/workspaceSwitch/test/common/paradisTerminalProcessScope.test.ts`

**Interfaces:**
- Consumes: `paradisRestorePersistentProcessScope(...)`
- Produces: a regression case where current PID `2` must restore from previous PID `3`

- [ ] **Step 1: Write the failing test**

Add an instance with `persistentProcessId: 2` and `restoredPersistentProcessId: 3`, a startup ledger mapping `2` to another scope and `3` to the expected scope, and assert that the expected scope is restored.

```typescript
test('restores ownership by the previous process id after a full restart renumbers ptys', () => {
	const instanceScopes = new Map<number, string>();
	const restoredScopes = new Map<number, string>([[2, 'scope:wrong-collision'], [3, 'scope:expected']]);
	const revivedInstance = {
		instanceId: 8,
		persistentProcessId: 2,
		restoredPersistentProcessId: 3,
	};

	assert.strictEqual(
		paradisRestorePersistentProcessScope(instanceScopes, restoredScopes, revivedInstance),
		'scope:expected',
	);
	assert.deepStrictEqual([...instanceScopes], [[8, 'scope:expected']]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run the fast source transpiler followed by `scripts/test.sh --grep "restores ownership by the previous process id after a full restart renumbers ptys"`.

Expected: the assertion receives the scope stored under PID `2`, proving the collision bug.

### Task 2: Propagate the previous PTY ID

**Files:**
- Modify: `src/vs/platform/terminal/common/terminal.ts`
- Modify: `src/vs/platform/terminal/node/ptyService.ts`

**Interfaces:**
- Produces: `IPtyHostAttachTarget.paradisRevivedFromPersistentProcessId?: number`

- [ ] **Step 1: Extend attach target types**

Add the optional previous-session ID to `IPtyHostAttachTarget` and `IShellLaunchConfig.attachPersistentProcess`.

```typescript
/** PARA-CODE: The process ID used by the previous PTY host before full application revival. */
paradisRevivedFromPersistentProcessId?: number;
```

- [ ] **Step 2: Populate the field for revived layout and orphan-list targets**

Build revived process details with the current `id` and the old ID in `paradisRevivedFromPersistentProcessId`. Maintain a reverse workspace/new-ID lookup when revival allocates the new PID. For orphan process enumeration, attach the old ID only after the process has actually been identified as orphaned.

```typescript
private _getRevivedFromPersistentProcessId(workspaceId: string, persistentProcessId: number): number | undefined {
	return this._revivedPtyOldIdByNewId.get(this._getRevivingProcessId(workspaceId, persistentProcessId));
}
```

```typescript
private async _buildProcessDetails(id: number, persistentProcess: PersistentTerminalProcess, revivedFromPersistentProcessId?: number): Promise<IProcessDetails> {
	const wasRevived = revivedFromPersistentProcessId !== undefined;
	const [cwd, isOrphan] = await Promise.all([persistentProcess.getCwd(), wasRevived ? true : persistentProcess.isOrphaned()]);
	const paneToken = persistentProcess.shellLaunchConfig.env?.['PARA_CODE_TERMINAL_PANE_ID'];
	return {
		id,
		title: persistentProcess.title,
		titleSource: persistentProcess.titleSource,
		pid: persistentProcess.pid,
		workspaceId: persistentProcess.workspaceId,
		workspaceName: persistentProcess.workspaceName,
		cwd,
		isOrphan,
		icon: persistentProcess.icon,
		color: persistentProcess.color,
		fixedDimensions: persistentProcess.fixedDimensions,
		environmentVariableCollections: persistentProcess.processLaunchOptions.options.environmentVariableCollections,
		reconnectionProperties: persistentProcess.shellLaunchConfig.reconnectionProperties,
		waitOnExit: persistentProcess.shellLaunchConfig.waitOnExit,
		hideFromUser: persistentProcess.shellLaunchConfig.hideFromUser,
		isFeatureTerminal: persistentProcess.shellLaunchConfig.isFeatureTerminal,
		type: persistentProcess.shellLaunchConfig.type,
		hasChildProcesses: persistentProcess.hasChildProcesses,
		shellIntegrationNonce: persistentProcess.processLaunchOptions.options.shellIntegration.nonce,
		...(typeof paneToken === 'string' && paneToken.length > 0 && paneToken.length <= 200 ? { paradisPaneToken: paneToken } : {}),
		...(revivedFromPersistentProcessId !== undefined ? { paradisRevivedFromPersistentProcessId } : {}),
		tabActions: persistentProcess.shellLaunchConfig.tabActions,
	};
}
```

### Task 3: Restore from a restore-only startup ledger

**Files:**
- Modify: `src/vs/paradis/contrib/workspaceSwitch/common/paradisTerminalProcessScope.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/browser/paradisTerminalScope.contribution.ts`

**Interfaces:**
- Consumes: `restoredPersistentProcessId?: number`
- Produces: lookup by previous ID without allowing current-ID writes to mutate the startup lookup source

- [ ] **Step 1: Prefer restored ID only for restored-ledger lookup**

Extend `IParadisScopedTerminalInstanceLike` and make restore lookup use `restoredPersistentProcessId ?? persistentProcessId`. Keep recording, pruning, and retirement keyed by the current PID.

```typescript
export interface IParadisScopedTerminalInstanceLike {
	readonly instanceId: number;
	readonly persistentProcessId?: number;
	readonly restoredPersistentProcessId?: number;
}

function restoredPersistentProcessId(instance: IParadisScopedTerminalInstanceLike): number | undefined {
	return instance.restoredPersistentProcessId ?? instance.persistentProcessId;
}
```

```typescript
const persistentProcessId = restoredPersistentProcessId(instance);
if (persistentProcessId !== undefined) {
	const restored = restoredMapping.get(persistentProcessId);
	if (restored) {
		return restored;
	}
}
```

- [ ] **Step 2: Keep a startup snapshot in the scope service**

Copy accepted startup entries into a dedicated restored map, add validated quarantined worktree entries after the worktree barrier, and use this map for panel and orphan restore lookup.

```typescript
private readonly _restoredPersistentProcessScopes: Map<number, string>;

const initialPartition = paradisPartitionPersistentProcessScopesByKnownScope(loadedMapping, this.knownStateKeys(false));
this._persistentProcessScopes = new Map(initialPartition.accepted);
this._restoredPersistentProcessScopes = new Map(initialPartition.accepted);
```

```typescript
private toRestoredScopedInstance(instance: ITerminalInstance): IParadisScopedTerminalInstanceLike {
	const attachTarget = instance.shellLaunchConfig.attachPersistentProcess;
	return {
		instanceId: instance.instanceId,
		...(attachTarget === undefined ? {} : {
			persistentProcessId: attachTarget.id,
			restoredPersistentProcessId: attachTarget.paradisRevivedFromPersistentProcessId,
		}),
	};
}
```

- [ ] **Step 3: Verify GREEN**

Run `npm run typecheck-client`, transpile sources, then run the focused regression test and the complete `paradisTerminalProcessScope` suite.

Expected: typecheck exit 0 and all focused tests pass.

### Task 4: Review, verify, commit, and push

**Files:**
- Review only the files listed in Tasks 1-3 and these design documents.

- [ ] **Step 1: Inspect the final diff**

Run `git diff --check` and a scoped `git diff`. Check security, error handling, lifecycle cleanup, stale-ledger behavior, and accidental unrelated edits.

- [ ] **Step 2: Run fresh verification**

Run `npm run typecheck-client`, transpile sources, and execute the focused workspace-switch unit suite.

- [ ] **Step 3: Commit only scoped files**

Stage the two documents, four production files, and one test file explicitly. Commit with `fix: preserve terminal space ownership across restart`.

- [ ] **Step 4: Push**

Push the current `main` branch to `origin` without staging unrelated worktree changes.
