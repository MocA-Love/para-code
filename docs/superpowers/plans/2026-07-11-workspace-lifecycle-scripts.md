# Workspace Lifecycle Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add repository-defined setup and teardown scripts to Para Code's worktree lifecycle, editable from the Workspaces view and stored in `.paracode.json`.

**Architecture:** A small lifecycle-config module owns JSONC parsing and lossless top-level field updates. The existing shared-process worktree channel executes scripts through the resolved user shell, while a workbench helper enforces Workspace Trust, loads the parent repository config, and invokes the channel from create/remove flows.

**Tech Stack:** TypeScript, VS Code services and IPC, Node `child_process.execFile`, JSONC parser, Mocha/TDD tests.

## Global Constraints

- Configuration keys are exactly `setupScript` and `teardownScript` at the top level of the parent repository's `.paracode.json`.
- The environment variable is exactly `PARACODE_PROJECT_ROOT_PATH` and contains the parent repository's absolute native path.
- Both scripts run with the target worktree as their current working directory.
- Setup runs after worktree creation and switching, but before auto-run presets, default terminal creation, and agent launch.
- Setup failure leaves the worktree intact and skips all later setup actions.
- Teardown runs after removal confirmation but before switching away from the worktree and before Git removal.
- Teardown failure leaves the worktree intact and aborts removal.
- Existing `presets` and unknown `.paracode.json` fields must survive edits.
- Malformed JSONC must never be overwritten or silently treated as an empty configuration.
- Repository-provided scripts require Workspace Trust.
- All source files retain the Microsoft copyright header, use tabs, and localize user-visible strings.
- Run TypeScript compilation before any focused test command.

---

### Task 1: Lifecycle Configuration Model and JSONC Updates

**Files:**
- Create: `src/vs/paradis/contrib/workspaceSwitch/common/paradisWorkspaceLifecycle.ts`
- Create: `src/vs/paradis/contrib/workspaceSwitch/test/common/paradisWorkspaceLifecycle.test.ts`
- Modify: `src/vs/paradis/contrib/terminalPresets/common/paradisTerminalPresets.ts`

**Interfaces:**
- Consumes: `PARADIS_WORKSPACE_PRESET_FILE` (`'.paracode.json'`) and `parse` from `base/common/jsonc`.
- Produces: `ParadisWorkspaceLifecycleKind`, `IParadisWorkspaceLifecycleConfig`, `paradisParseWorkspaceLifecycleConfig(content)`, and `paradisUpdateWorkspaceLifecycleConfig(content, config)`.

- [ ] **Step 1: Write failing parser and updater tests**

```ts
suite('Paradis workspace lifecycle configuration', () => {
	test('reads trimmed script strings and ignores wrong types', () => {
		assert.deepStrictEqual(paradisParseWorkspaceLifecycleConfig(`{
			// repository lifecycle
			"setupScript": " bun install ",
			"teardownScript": false
		}`), { setupScript: 'bun install' });
	});

	test('throws for malformed JSONC', () => {
		assert.throws(() => paradisParseWorkspaceLifecycleConfig('{ "setupScript": '));
	});

	test('updates scripts while preserving existing fields', () => {
		const updated = paradisUpdateWorkspaceLifecycleConfig(
			'{ "presets": [{ "name": "dev" }], "future": 7 }',
			{ setupScript: 'bun install', teardownScript: undefined }
		);
		assert.deepStrictEqual(JSON.parse(updated), {
			presets: [{ name: 'dev' }],
			future: 7,
			setupScript: 'bun install'
		});
	});
});
```

- [ ] **Step 2: Compile, then run the focused test and verify RED**

Run: `rtk npm run typecheck-client`

Expected: FAIL because `paradisWorkspaceLifecycle.ts` does not exist yet. Do not run Mocha until compilation succeeds; add only an empty exported module if needed to reach the behavioral RED state.

Run after compilation succeeds: `rtk scripts/test.sh --grep "Paradis workspace lifecycle configuration"`

Expected: FAIL because the parser/updater functions are not implemented.

- [ ] **Step 3: Implement the lifecycle model and updater**

```ts
export type ParadisWorkspaceLifecycleKind = 'setup' | 'teardown';

export interface IParadisWorkspaceLifecycleConfig {
	readonly setupScript?: string;
	readonly teardownScript?: string;
}

type ParadisWorkspaceConfigFile = {
	setupScript?: unknown;
	teardownScript?: unknown;
	[key: string]: unknown;
};

function normalizeScript(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function parseConfigFile(content: string): ParadisWorkspaceConfigFile {
	let parsed: unknown;
	try {
		parsed = parseJsonc<unknown>(content);
	} catch {
		throw new Error('Invalid .paracode.json configuration.');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Invalid .paracode.json configuration.');
	}
	return parsed as ParadisWorkspaceConfigFile;
}

export function paradisParseWorkspaceLifecycleConfig(content: string): IParadisWorkspaceLifecycleConfig {
	const parsed = parseConfigFile(content);
	return {
		setupScript: normalizeScript(parsed.setupScript),
		teardownScript: normalizeScript(parsed.teardownScript),
	};
}

export function paradisUpdateWorkspaceLifecycleConfig(content: string | undefined, config: IParadisWorkspaceLifecycleConfig): string {
	const parsed = content === undefined ? {} : parseConfigFile(content);
	const setupScript = normalizeScript(config.setupScript);
	const teardownScript = normalizeScript(config.teardownScript);
	if (setupScript) { parsed.setupScript = setupScript; } else { delete parsed.setupScript; }
	if (teardownScript) { parsed.teardownScript = teardownScript; } else { delete parsed.teardownScript; }
	return `${JSON.stringify(parsed, undefined, '\t')}\n`;
}
```

Import `parse as parseJsonc` from `../../../../base/common/jsonc.js` and export `PARADIS_WORKSPACE_PRESET_FILE` unchanged for both preset and lifecycle consumers.

- [ ] **Step 4: Compile and verify GREEN**

Run: `rtk npm run typecheck-client`

Expected: PASS.

Run: `rtk scripts/test.sh --grep "Paradis workspace lifecycle configuration"`

Expected: all lifecycle configuration tests PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/workspaceSwitch/common/paradisWorkspaceLifecycle.ts src/vs/paradis/contrib/workspaceSwitch/test/common/paradisWorkspaceLifecycle.test.ts src/vs/paradis/contrib/terminalPresets/common/paradisTerminalPresets.ts
rtk git commit -m "feat: add workspace lifecycle configuration"
```

---

### Task 2: Shared-Process Lifecycle Script Runner

**Files:**
- Modify: `src/vs/paradis/contrib/workspaceSwitch/common/paradisWorktreeCreate.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/node/paradisWorktreeGitChannel.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/test/node/paradisWorktreeGitChannel.test.ts`

**Interfaces:**
- Consumes: `ParadisCachedShellEnv`, injected `cp.execFile`, and the existing `PARADIS_WORKTREE_GIT_CHANNEL`.
- Produces: `IParadisRunLifecycleScriptRequest` and `ParadisWorktreeGitService.runLifecycleScript(request): Promise<void>`; IPC command `runLifecycleScript`.

- [ ] **Step 1: Add failing execution tests**

```ts
test('runs lifecycle script in worktree with project root environment', async () => {
	const calls: Array<{ command: string; args: readonly string[]; cwd?: string; root?: string }> = [];
	const service = createService((command, args, options, callback) => {
		calls.push({ command, args, cwd: options.cwd, root: options.env?.PARACODE_PROJECT_ROOT_PATH });
		callback(null, '', '');
		return undefined as never;
	});
	await service.runLifecycleScript({
		kind: 'setup', repoPath: '/repo', worktreePath: '/repo-worktrees/task', script: 'bun install'
	});
	assert.deepStrictEqual(calls, [{
		command: process.env.SHELL || '/bin/sh',
		args: ['-lc', 'bun install'],
		cwd: '/repo-worktrees/task',
		root: '/repo'
	}]);
});

test('rejects a non-zero lifecycle script exit', async () => {
	const service = createService((_command, _args, _options, callback) => {
		callback(Object.assign(new Error('exit 7'), { code: 7 }), '', 'failed setup');
		return undefined as never;
	});
	await assert.rejects(
		service.runLifecycleScript({ kind: 'setup', repoPath: '/repo', worktreePath: '/worktree', script: 'false' }),
		/Setup script failed.*failed setup/i
	);
});
```

- [ ] **Step 2: Compile, then run the focused test and verify RED**

Run: `rtk npm run typecheck-client`

Expected: FAIL until the request type and method skeleton exist.

Run after compilation succeeds: `rtk scripts/test.sh --grep "lifecycle script"`

Expected: FAIL because no child process is executed with the required cwd/environment.

- [ ] **Step 3: Add the request type and minimal runner**

```ts
export interface IParadisRunLifecycleScriptRequest {
	readonly kind: 'setup' | 'teardown';
	readonly repoPath: string;
	readonly worktreePath: string;
	readonly script: string;
}
```

```ts
async runLifecycleScript(request: IParadisRunLifecycleScriptRequest): Promise<void> {
	if (!request.script.trim() || !request.repoPath || !request.worktreePath) {
		throw new Error('Invalid lifecycle script request.');
	}
	const env = await this.cachedShellEnv.getEnv();
	const shell = env.SHELL || (isWindows ? env.ComSpec : undefined) || (isWindows ? 'cmd.exe' : '/bin/sh');
	const args = isWindows ? ['/d', '/s', '/c', request.script] : ['-lc', request.script];
	await new Promise<void>((resolve, reject) => {
		this.execFile(shell, args, {
			cwd: request.worktreePath,
			encoding: 'utf8',
			env: { ...env, PARACODE_PROJECT_ROOT_PATH: request.repoPath }
		}, (error, _stdout, stderr) => {
			if (!error) { resolve(); return; }
			const label = request.kind === 'setup' ? 'Setup' : 'Teardown';
			reject(new Error(`${label} script failed${typeof error.code === 'number' ? ` (exit ${error.code})` : ''}: ${stderr?.trim() || error.message}`));
		});
	});
}
```

Add `case 'runLifecycleScript'` to the channel and use platform helpers for Windows detection. Keep script text unchanged.

- [ ] **Step 4: Compile and verify GREEN**

Run: `rtk npm run typecheck-client`

Expected: PASS.

Run: `rtk scripts/test.sh --grep "ParadisWorktreeGit\|lifecycle script"`

Expected: existing Git channel tests and new runner tests PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/workspaceSwitch/common/paradisWorktreeCreate.ts src/vs/paradis/contrib/workspaceSwitch/node/paradisWorktreeGitChannel.ts src/vs/paradis/contrib/workspaceSwitch/test/node/paradisWorktreeGitChannel.test.ts
rtk git commit -m "feat: run workspace lifecycle scripts"
```

---

### Task 3: Trusted Workbench Lifecycle Orchestration

**Files:**
- Create: `src/vs/paradis/contrib/workspaceSwitch/electron-browser/paradisWorkspaceLifecycleService.ts`
- Create: `src/vs/paradis/contrib/workspaceSwitch/test/electron-browser/paradisWorkspaceLifecycleService.test.ts`

**Interfaces:**
- Consumes: `IFileService`, `IWorkspaceTrustManagementService`, `ISharedProcessService`, parser from Task 1, request type from Task 2.
- Produces: `paradisReadWorkspaceLifecycleConfig(fileService, repositoryUri)` and `paradisRunWorkspaceLifecycleScript(accessor, kind, repository, worktreeUri): Promise<boolean>`.

- [ ] **Step 1: Write failing orchestration tests**

```ts
test('loads parent config and sends setup request', async () => {
	const fixture = createLifecycleFixture({ setupScript: 'bun install' });
	assert.strictEqual(await fixture.run('setup'), true);
	assert.deepStrictEqual(fixture.calls, [{
		kind: 'setup', repoPath: '/repo', worktreePath: '/worktree', script: 'bun install'
	}]);
});

test('does not run absent script', async () => {
	const fixture = createLifecycleFixture({});
	assert.strictEqual(await fixture.run('teardown'), false);
	assert.deepStrictEqual(fixture.calls, []);
});

test('rejects repository script in an untrusted workspace', async () => {
	const fixture = createLifecycleFixture({ setupScript: 'bun install' }, { trusted: false });
	await assert.rejects(fixture.run('setup'), /Workspace Trust/i);
});
```

- [ ] **Step 2: Compile, then run focused tests and verify RED**

Run: `rtk npm run typecheck-client`

Expected: FAIL until the exported helpers exist.

Run after compilation succeeds: `rtk scripts/test.sh --grep "workspace lifecycle service"`

Expected: FAIL because config loading, trust enforcement, and IPC dispatch are absent.

- [ ] **Step 3: Implement loading and dispatch**

```ts
export async function paradisReadWorkspaceLifecycleConfig(fileService: IFileService, repositoryUri: URI): Promise<IParadisWorkspaceLifecycleConfig> {
	const configUri = joinPath(repositoryUri, PARADIS_WORKSPACE_PRESET_FILE);
	try {
		return paradisParseWorkspaceLifecycleConfig((await fileService.readFile(configUri)).value.toString());
	} catch (error) {
		if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) { return {}; }
		throw error;
	}
}

export async function paradisRunWorkspaceLifecycleScript(accessor: ServicesAccessor, kind: ParadisWorkspaceLifecycleKind, repository: IParadisWorkspaceRepository, worktreeUri: URI): Promise<boolean> {
	const trustService = accessor.get(IWorkspaceTrustManagementService);
	const config = await paradisReadWorkspaceLifecycleConfig(accessor.get(IFileService), repository.uri);
	const script = kind === 'setup' ? config.setupScript : config.teardownScript;
	if (!script) { return false; }
	if (!trustService.isWorkspaceTrusted()) { throw new Error('Workspace Trust is required to run repository lifecycle scripts.'); }
	await accessor.get(ISharedProcessService).getChannel(PARADIS_WORKTREE_GIT_CHANNEL).call('runLifecycleScript', [{
		kind, repoPath: repository.uri.fsPath, worktreePath: worktreeUri.fsPath, script
	}]);
	return true;
}
```

- [ ] **Step 4: Compile and verify GREEN**

Run: `rtk npm run typecheck-client`

Expected: PASS.

Run: `rtk scripts/test.sh --grep "workspace lifecycle service"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/workspaceSwitch/electron-browser/paradisWorkspaceLifecycleService.ts src/vs/paradis/contrib/workspaceSwitch/test/electron-browser/paradisWorkspaceLifecycleService.test.ts
rtk git commit -m "feat: orchestrate trusted lifecycle scripts"
```

---

### Task 4: Setup and Teardown Lifecycle Integration

**Files:**
- Modify: `src/vs/paradis/contrib/workspaceSwitch/electron-browser/paradisCreateWorktreeDialog.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/electron-browser/paradisCreateWorktree.contribution.ts`
- Create: `src/vs/paradis/contrib/workspaceSwitch/test/electron-browser/paradisWorktreeLifecycleOrder.test.ts`

**Interfaces:**
- Consumes: `paradisRunWorkspaceLifecycleScript` from Task 3.
- Produces: creation/removal ordering with failure short-circuit behavior.

- [ ] **Step 1: Write failing order tests around exported sequence helpers**

```ts
test('setup runs before auto-run and agent launch', async () => {
	const events: string[] = [];
	await paradisCompleteCreatedWorktree({
		runSetup: async () => { events.push('setup'); },
		runAutoRun: async () => { events.push('autoRun'); return true; },
		openDefaultTerminal: async () => { events.push('terminal'); },
		launchAgent: async () => { events.push('agent'); }
	});
	assert.deepStrictEqual(events, ['setup', 'autoRun', 'agent']);
});

test('setup failure skips all later creation actions', async () => {
	const events: string[] = [];
	await assert.rejects(paradisCompleteCreatedWorktree({
		runSetup: async () => { events.push('setup'); throw new Error('failed'); },
		runAutoRun: async () => { events.push('autoRun'); return false; },
		openDefaultTerminal: async () => { events.push('terminal'); },
		launchAgent: async () => { events.push('agent'); }
	}), /failed/);
	assert.deepStrictEqual(events, ['setup']);
});

test('teardown failure prevents switch and removal', async () => {
	const events: string[] = [];
	await assert.rejects(paradisRemoveWorktreeSequence({
		runTeardown: async () => { events.push('teardown'); throw new Error('failed'); },
		switchToParent: async () => { events.push('switch'); },
		remove: async () => { events.push('remove'); }
	}), /failed/);
	assert.deepStrictEqual(events, ['teardown']);
});
```

- [ ] **Step 2: Compile, then run focused tests and verify RED**

Run: `rtk npm run typecheck-client`

Expected: FAIL until the small sequence helpers are exported.

Run after compilation succeeds: `rtk scripts/test.sh --grep "worktree lifecycle order"`

Expected: FAIL because the callbacks are not sequenced.

- [ ] **Step 3: Implement minimal sequence helpers and wire production callbacks**

```ts
export async function paradisCompleteCreatedWorktree(actions: IParadisCreatedWorktreeActions): Promise<void> {
	await actions.runSetup();
	const autoRunExecuted = await actions.runAutoRun();
	if (!autoRunExecuted) { await actions.openDefaultTerminal(); }
	await actions.launchAgent();
}

export async function paradisRemoveWorktreeSequence(actions: IParadisRemoveWorktreeActions): Promise<void> {
	await actions.runTeardown();
	await actions.switchToParent();
	await actions.remove();
}
```

In `_doCreate`, call setup after `switchToWorktree` and before `paradisRunAutoRunPresets`. Preserve the existing `worktreeCreated` catch branch so setup failure reports “worktree was created but setup failed,” disposes the dialog, and leaves the worktree registered.

In `ParadisRemoveWorktreeAction.run`, call teardown immediately after confirmation and before the active-worktree switch. Catch errors, log them, show `dialogService.error`, and return without switching or removing. Keep the existing normal/force Git removal behavior inside the `remove` callback.

- [ ] **Step 4: Compile and verify GREEN**

Run: `rtk npm run typecheck-client`

Expected: PASS.

Run: `rtk scripts/test.sh --grep "worktree lifecycle order\|ParadisWorktreeGit"`

Expected: lifecycle ordering and existing Git removal tests PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/workspaceSwitch/electron-browser/paradisCreateWorktreeDialog.ts src/vs/paradis/contrib/workspaceSwitch/electron-browser/paradisCreateWorktree.contribution.ts src/vs/paradis/contrib/workspaceSwitch/test/electron-browser/paradisWorktreeLifecycleOrder.test.ts
rtk git commit -m "feat: integrate worktree lifecycle scripts"
```

---

### Task 5: Workspaces Script Editor Dialog

**Files:**
- Create: `src/vs/paradis/contrib/workspaceSwitch/electron-browser/paradisWorkspaceLifecycleDialog.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/electron-browser/paradisCreateWorktree.contribution.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/browser/paradisWorkspacesView.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/electron-browser/media/paradisCreateWorktreeDialog.css`
- Modify: `src/vs/paradis/paradis.electron-browser.contribution.ts`
- Create: `src/vs/paradis/contrib/workspaceSwitch/test/electron-browser/paradisWorkspaceLifecycleDialog.test.ts`

**Interfaces:**
- Consumes: Task 1 parser/updater, `IFileService`, selected `IParadisWorkspaceRepository`.
- Produces: command `paradis.workspaceSwitch.configureLifecycleScripts` and `openParadisWorkspaceLifecycleDialog(accessor, repository)`.

- [ ] **Step 1: Write failing save-behavior tests**

```ts
test('preserves unknown fields when saving scripts', async () => {
	const fixture = createDialogSaveFixture('{ "presets": [], "future": true }');
	await fixture.save({ setupScript: 'bun install', teardownScript: 'docker image prune' });
	assert.deepStrictEqual(JSON.parse(fixture.written), {
		presets: [], future: true, setupScript: 'bun install', teardownScript: 'docker image prune'
	});
});

test('does not create a missing file for two blank scripts', async () => {
	const fixture = createDialogSaveFixture(undefined);
	await fixture.save({ setupScript: ' ', teardownScript: '' });
	assert.strictEqual(fixture.writeCount, 0);
});

test('does not overwrite malformed JSONC', async () => {
	const fixture = createDialogSaveFixture('{ bad json');
	await assert.rejects(fixture.save({ setupScript: 'bun install' }), /Invalid .paracode.json/);
	assert.strictEqual(fixture.writeCount, 0);
});
```

- [ ] **Step 2: Compile, then run focused tests and verify RED**

Run: `rtk npm run typecheck-client`

Expected: FAIL until the dialog save helper exists.

Run after compilation succeeds: `rtk scripts/test.sh --grep "workspace lifecycle dialog"`

Expected: FAIL because file-preserving save behavior is absent.

- [ ] **Step 3: Implement the save helper, dialog, command, and context menu entry**

```ts
export async function paradisSaveWorkspaceLifecycleConfig(fileService: IFileService, repositoryUri: URI, config: IParadisWorkspaceLifecycleConfig): Promise<void> {
	const configUri = joinPath(repositoryUri, PARADIS_WORKSPACE_PRESET_FILE);
	let existing: string | undefined;
	try { existing = (await fileService.readFile(configUri)).value.toString(); }
	catch (error) {
		if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) { throw error; }
	}
	if (existing === undefined && !config.setupScript?.trim() && !config.teardownScript?.trim()) { return; }
	const updated = paradisUpdateWorkspaceLifecycleConfig(existing, config);
	await fileService.writeFile(configUri, VSBuffer.fromString(updated));
}
```

Build a modal matching the existing worktree dialog conventions: title, explanatory text mentioning `.paracode.json` and `PARACODE_PROJECT_ROOT_PATH`, two labeled textareas, Cancel and Save buttons, busy state, inline parse/write errors, Escape handling, and disposal registration. All labels and messages use `localize`.

Register `paradis.workspaceSwitch.configureLifecycleScripts` in the Electron contribution. In `ParadisWorkspacesView`, add the parent-row action **Setup/Teardown Scripts...** that passes the repository object. Do not add the action to worktree rows.

- [ ] **Step 4: Compile and verify GREEN**

Run: `rtk npm run typecheck-client`

Expected: PASS.

Run: `rtk scripts/test.sh --grep "workspace lifecycle dialog\|Paradis workspace lifecycle configuration"`

Expected: dialog save and config tests PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/workspaceSwitch/electron-browser/paradisWorkspaceLifecycleDialog.ts src/vs/paradis/contrib/workspaceSwitch/electron-browser/paradisCreateWorktree.contribution.ts src/vs/paradis/contrib/workspaceSwitch/browser/paradisWorkspacesView.ts src/vs/paradis/contrib/workspaceSwitch/electron-browser/media/paradisCreateWorktreeDialog.css src/vs/paradis/paradis.electron-browser.contribution.ts src/vs/paradis/contrib/workspaceSwitch/test/electron-browser/paradisWorkspaceLifecycleDialog.test.ts
rtk git commit -m "feat: edit workspace lifecycle scripts"
```

---

### Task 6: Final Validation and User-Facing Documentation

**Files:**
- Modify: `src/vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: validated feature and changelog entry.

- [ ] **Step 1: Add a concise changelog entry**

```markdown
- WorkspacesビューからリポジトリごとのSetup／Teardownスクリプトを設定し、worktreeの作成・削除時に自動実行できるようになりました。
```

- [ ] **Step 2: Run required compilation before tests**

Run: `rtk npm run typecheck-client`

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run all focused feature tests**

Run: `rtk scripts/test.sh --grep "workspace lifecycle|worktree lifecycle|ParadisWorktreeGit"`

Expected: all matching tests PASS with no warnings or unhandled rejections.

- [ ] **Step 4: Run layering and diff checks**

Run: `rtk npm run valid-layers-check`

Expected: PASS.

Run: `rtk git diff --check`

Expected: no output.

- [ ] **Step 5: Manually verify the end-to-end flow in the development build**

Use a disposable test repository with a `.paracode.json` that writes marker files. Verify: the editor preserves `presets`; setup sees `PARACODE_PROJECT_ROOT_PATH` and creates its marker in the worktree; a failing setup leaves the worktree and does not launch the agent; teardown runs before deletion; a failing teardown leaves the worktree untouched.

- [ ] **Step 6: Commit final documentation**

```bash
rtk git add src/vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md
rtk git commit -m "docs: document workspace lifecycle scripts"
```
