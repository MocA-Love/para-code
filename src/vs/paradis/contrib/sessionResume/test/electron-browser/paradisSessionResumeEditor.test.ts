/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { TestEditorGroupView } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisResumeAgentInWorkspace } from '../../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { ParadisSessionResumeEditor } from '../../electron-browser/paradisSessionResumeEditor.js';
import { IParadisResumeListRequestWithUri } from '../../electron-browser/paradisSessionResumeClient.js';
import { IParadisResumePreview, IParadisResumeSession } from '../../common/paradisSessionResume.js';
import { paradisSessionResumeEditorActionOptions, paradisResumeSessionFromEditor } from '../../electron-browser/paradisSessionResumeOrchestration.js';

suite('ParadisSessionResumeEditor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const target = {
		rootUri: URI.file('/repo-worktrees/feature'),
		stateKey: 'worktree:feature',
		agent: 'claude' as const,
		sessionId: 'session-123',
	};

	test('does not list for each hidden workspace event and refreshes once after becoming visible', async () => {
		for (const eventName of ['scope', 'repository', 'worktree'] as const) {
			const scopeEmitter = new Emitter<void>();
			const repositoryEmitter = new Emitter<void>();
			const worktreeEmitter = new Emitter<void>();
			let listCount = 0;
			const client = {
				list: async () => {
					listCount++;
					return [];
				},
				preview: async () => ({ messages: [], truncated: false }),
				search: async () => [],
			};
			const instantiationService = {
				createInstance: () => client,
			} as unknown as IInstantiationService;
			const workspaceSwitchService = {
				activeStateKey: undefined,
				repositories: [],
				onDidSwitchScope: scopeEmitter.event,
				onDidChangeRepositories: repositoryEmitter.event,
			} as unknown as IParadisWorkspaceSwitchService;
			const worktreeService = {
				initializationBarrier: Promise.resolve(),
				onDidChangeWorktrees: worktreeEmitter.event,
				getWorktrees: () => [],
			} as unknown as IParadisWorktreeService;
			const storageService = new TestStorageService();
			const editor = new ParadisSessionResumeEditor(
				new TestEditorGroupView(1),
				NullTelemetryService,
				new TestThemeService(),
				storageService,
				instantiationService,
				workspaceSwitchService,
				worktreeService,
				new TestNotificationService(),
				Object.create(null),
				Object.create(null),
			);
			try {
				editor.create(document.createElement('div'));
				editor.setVisible(false);
				if (eventName === 'scope') {
					scopeEmitter.fire();
				} else if (eventName === 'repository') {
					repositoryEmitter.fire();
				} else {
					worktreeEmitter.fire();
				}
				await Promise.resolve();
				assert.strictEqual(listCount, 0, eventName);

				editor.setVisible(true);
				await timeout(1);
				assert.strictEqual(listCount, 1, eventName);
			} finally {
				editor.dispose();
				storageService.dispose();
			}
		}
	});

	test('waits for the initial refresh before setInput resolves', async () => {
		const list = new DeferredPromise<never[]>();
		let listCount = 0;
		const client = {
			list: async () => {
				listCount++;
				return list.p;
			},
			preview: async () => ({ messages: [], truncated: false }),
			search: async () => [],
		};
		const scopeEmitter = new Emitter<void>();
		const repositoryEmitter = new Emitter<void>();
		const worktreeEmitter = new Emitter<void>();
		const storageService = new TestStorageService();
		const editor = new ParadisSessionResumeEditor(
			new TestEditorGroupView(1),
			NullTelemetryService,
			new TestThemeService(),
			storageService,
			{ createInstance: () => client } as unknown as IInstantiationService,
			{
				activeStateKey: undefined,
				repositories: [],
				onDidSwitchScope: scopeEmitter.event,
				onDidChangeRepositories: repositoryEmitter.event,
			} as unknown as IParadisWorkspaceSwitchService,
			{
				initializationBarrier: Promise.resolve(),
				onDidChangeWorktrees: worktreeEmitter.event,
				getWorktrees: () => [],
			} as unknown as IParadisWorktreeService,
			new TestNotificationService(),
			Object.create(null),
			Object.create(null),
		);
		const input = new TestSessionResumeInput();
		try {
			editor.create(document.createElement('div'));
			editor.setVisible(true);
			let settled = false;
			const setInput = editor.setInput(input, undefined, Object.create(null), CancellationToken.None).then(() => { settled = true; });
			await Promise.resolve();
			await Promise.resolve();
			assert.strictEqual(listCount, 1);
			assert.strictEqual(settled, false);

			list.complete([]);
			await setInput;
			assert.strictEqual(settled, true);
			assert.strictEqual(listCount, 1);
		} finally {
			editor.dispose();
			input.dispose();
			storageService.dispose();
		}
	});

	test('uses the latest archived state for immediate checkbox and button refreshes', async () => {
		const client = new TestResumeClient();
		const fixture = createRefreshFixture(client);
		try {
			await fixture.load();
			const archivedInput = fixture.root.querySelector<HTMLInputElement>('.paradis-session-resume-check input')!;
			archivedInput.checked = true;
			archivedInput.dispatchEvent(new Event('change'));
			await timeout(1);
			assert.strictEqual(client.listRequests.length, 2);
			assert.strictEqual(client.listRequests[1].includeArchived, true);

			fixture.root.querySelector<HTMLButtonElement>('.paradis-session-resume-refresh')!.click();
			await timeout(1);
			assert.strictEqual(client.listRequests.length, 3);
			assert.strictEqual(client.listRequests[2].includeArchived, true);
		} finally {
			fixture.dispose();
		}
	});

	test('retains sessions and performs one follow-up after a failed refresh with a newer invalidation', async () => {
		const session = testSession('one', 'First session');
		const client = new TestResumeClient();
		client.listResult = async () => [session];
		const fixture = createRefreshFixture(client);
		try {
			await fixture.load();
			const failedList = new DeferredPromise<readonly IParadisResumeSession[]>();
			client.listResult = () => failedList.p;
			fixture.root.querySelector<HTMLButtonElement>('.paradis-session-resume-refresh')!.click();
			await flushMicrotasks();
			fixture.scopeEmitter.fire();
			failedList.error(new Error('list failed'));
			client.listResult = async () => [session];
			await timeout(1);
			await flushMicrotasks();

			assert.strictEqual(fixture.notifications.errors, 1);
			assert.strictEqual(fixture.root.textContent?.includes('First session'), true);
			assert.strictEqual(fixture.root.querySelector('.paradis-session-resume-refresh')?.classList.contains('loading'), false);
			assert.strictEqual(client.listRequests.length, 3);
		} finally {
			fixture.dispose();
		}
	});

	test('preserves selection, query, and filter while hidden before refreshing', async () => {
		const client = new TestResumeClient();
		client.listResult = async () => [testSession('one', 'First session'), testSession('two', 'Second session', 'codex')];
		const fixture = createRefreshFixture(client);
		try {
			await fixture.load();
			fixture.root.querySelectorAll<HTMLButtonElement>('.paradis-session-resume-row')[1].click();
			const search = fixture.root.querySelector<HTMLInputElement>('input[type="search"]')!;
			search.value = 'second';
			search.dispatchEvent(new Event('input'));
			const agent = fixture.root.querySelectorAll<HTMLSelectElement>('select')[0];
			agent.value = 'codex';
			agent.dispatchEvent(new Event('change'));

			fixture.editor.setVisible(false);
			fixture.scopeEmitter.fire();
			await flushMicrotasks();
			assert.strictEqual(client.listRequests.length, 1);
			fixture.editor.setVisible(true);
			await timeout(1);

			assert.strictEqual(search.value, 'second');
			assert.strictEqual(agent.value, 'codex');
			assert.strictEqual(fixture.root.querySelector('.paradis-session-resume-row.selected .row-title')?.textContent, 'Second session');
		} finally {
			fixture.dispose();
		}
	});

	test('reloads the selected preview after a hidden invalidation becomes visible', async () => {
		const client = new TestResumeClient();
		client.listResult = async () => [testSession('one', 'First session')];
		let previewCount = 0;
		client.previewResult = async () => ({
			messages: [{ role: 'assistant', text: ++previewCount === 1 ? 'Initial preview' : 'Refreshed preview' }],
			truncated: false,
		});
		const fixture = createRefreshFixture(client);
		try {
			await fixture.load();
			await flushMicrotasks();
			assert.strictEqual(fixture.root.textContent?.includes('Initial preview'), true);

			fixture.editor.setVisible(false);
			fixture.scopeEmitter.fire();
			fixture.editor.setVisible(true);
			await timeout(1);
			await flushMicrotasks();

			assert.strictEqual(previewCount, 2);
			assert.strictEqual(fixture.root.textContent?.includes('Refreshed preview'), true);
		} finally {
			fixture.dispose();
		}
	});

	test('ignores late list, search, and preview results after disposal', async () => {
		const session = testSession('one', 'First session');
		const client = new TestResumeClient();
		const lateList = new DeferredPromise<readonly IParadisResumeSession[]>();
		const latePreview = new DeferredPromise<{ messages: readonly []; truncated: boolean }>();
		const lateSearch = new DeferredPromise<readonly []>();
		let listCalls = 0;
		client.listResult = async () => ++listCalls === 1 ? [session] : lateList.p;
		client.previewResult = () => latePreview.p;
		client.searchResult = () => lateSearch.p;
		const fixture = createRefreshFixture(client);
		try {
			await fixture.load();
			const search = fixture.root.querySelector<HTMLInputElement>('input[type="search"]')!;
			search.value = 'first';
			search.dispatchEvent(new Event('input'));
			await timeout(300);
			fixture.root.querySelector<HTMLButtonElement>('.paradis-session-resume-refresh')!.click();
			await flushMicrotasks();
			const beforeDispose = fixture.root.innerHTML;
			fixture.editor.dispose();
			lateList.complete([session]);
			latePreview.complete({ messages: [], truncated: false });
			lateSearch.complete([]);
			await timeout(1);
			await flushMicrotasks();

			assert.strictEqual(fixture.root.innerHTML, beforeDispose);
			assert.strictEqual(fixture.notifications.errors, 0);
			assert.strictEqual(client.listRequests.length, 2);
		} finally {
			fixture.dispose();
		}
	});

	test('maps each editor button to its resume mode and permission behavior', () => {
		assert.deepStrictEqual([
			paradisSessionResumeEditorActionOptions('background'),
			paradisSessionResumeEditorActionOptions('primary'),
			paradisSessionResumeEditorActionOptions('dangerous'),
		], [
			{ mode: 'background', dangerouslyBypassPermissions: false },
			{ mode: 'foreground', dangerouslyBypassPermissions: false },
			{ mode: 'foreground', dangerouslyBypassPermissions: true },
		]);
	});

	test('switches only for a foreground resume in another space', async () => {
		const cases = [
			{ currentSpace: true, mode: 'foreground' as const, expected: ['resume'] },
			{ currentSpace: false, mode: 'background' as const, expected: ['resume'] },
			{ currentSpace: false, mode: 'foreground' as const, expected: ['switch:worktree:feature', 'resume'] },
		];

		for (const testCase of cases) {
			const events: string[] = [];
			await paradisResumeSessionFromEditor(
				{ ...target, currentSpace: testCase.currentSpace },
				{ mode: testCase.mode, dangerouslyBypassPermissions: false },
				{
					switchToStateKey: async stateKey => { events.push(`switch:${stateKey}`); },
					resumeAgent: async () => { events.push('resume'); },
				},
			);
			assert.deepStrictEqual(events, testCase.expected);
		}
	});

	test('forwards dangerous permission mode to the resume command request', async () => {
		const requests: unknown[] = [];
		await paradisResumeSessionFromEditor(
			{ ...target, currentSpace: true, agent: 'codex' },
			{ mode: 'foreground', dangerouslyBypassPermissions: true },
			{
				switchToStateKey: async () => { throw new Error('must not switch'); },
				resumeAgent: async request => { requests.push(request); },
			},
		);

		assert.deepStrictEqual(requests, [{
			rootUri: target.rootUri,
			stateKey: target.stateKey,
			agent: 'codex',
			sessionId: target.sessionId,
			dangerouslyBypassPermissions: true,
		}]);
	});

	test('does not start the agent when switching fails or is cancelled', async () => {
		for (const error of [new Error('switch failed'), new CancellationError()]) {
			let resumeCount = 0;
			await assert.rejects(paradisResumeSessionFromEditor(
				{ ...target, currentSpace: false },
				{ mode: 'foreground', dangerouslyBypassPermissions: false },
				{
					switchToStateKey: async () => { throw error; },
					resumeAgent: async () => { resumeCount++; },
				},
			), candidate => candidate === error);
			assert.strictEqual(resumeCount, 0);
		}
	});
});

class TestResumeClient {
	readonly listRequests: IParadisResumeListRequestWithUri[] = [];
	listResult: () => Promise<readonly IParadisResumeSession[]> = async () => [];
	previewResult: () => Promise<IParadisResumePreview> = async () => ({ messages: [], truncated: false });
	searchResult: () => Promise<readonly []> = async () => [];

	async list(request: IParadisResumeListRequestWithUri): Promise<readonly IParadisResumeSession[]> {
		this.listRequests.push(request);
		return this.listResult();
	}

	async preview(): Promise<IParadisResumePreview> {
		return this.previewResult();
	}

	async search(): Promise<readonly []> {
		return this.searchResult();
	}
}

interface IRefreshFixture {
	readonly editor: ParadisSessionResumeEditor;
	readonly root: HTMLElement;
	readonly scopeEmitter: Emitter<void>;
	readonly notifications: TestNotifications;
	load(): Promise<void>;
	dispose(): void;
}

function createRefreshFixture(client: TestResumeClient): IRefreshFixture {
	const scopeEmitter = new Emitter<void>();
	const repositoryEmitter = new Emitter<void>();
	const worktreeEmitter = new Emitter<void>();
	const storageService = new TestStorageService();
	const notifications = new TestNotifications();
	const markdownRendererService: IMarkdownRendererService = {
		_serviceBrand: undefined,
		render(markdown) {
			const element = document.createElement('span');
			element.textContent = markdown.value;
			return { element, dispose() { } };
		},
		setDefaultCodeBlockRenderer() { },
	};
	const editor = new ParadisSessionResumeEditor(
		new TestEditorGroupView(1),
		NullTelemetryService,
		new TestThemeService(),
		storageService,
		{ createInstance: () => client } as unknown as IInstantiationService,
		{
			activeStateKey: undefined,
			repositories: [],
			onDidSwitchScope: scopeEmitter.event,
			onDidChangeRepositories: repositoryEmitter.event,
		} as unknown as IParadisWorkspaceSwitchService,
		{
			initializationBarrier: Promise.resolve(),
			onDidChangeWorktrees: worktreeEmitter.event,
			getWorktrees: () => [],
		} as unknown as IParadisWorktreeService,
		notifications as unknown as INotificationService,
		markdownRendererService,
		Object.create(null),
	);
	const input = new TestSessionResumeInput();
	const root = document.createElement('div');
	return {
		editor,
		root,
		scopeEmitter,
		notifications,
		async load(): Promise<void> {
			editor.create(root);
			editor.setVisible(true);
			await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		},
		dispose(): void {
			editor.dispose();
			input.dispose();
			storageService.dispose();
		},
	};
}

function testSession(id: string, title: string, agent: 'claude' | 'codex' = 'claude'): IParadisResumeSession {
	return {
		catalogId: `catalog-${id}`,
		id,
		agent,
		title,
		preview: title,
		cwd: '/workspace',
		spaceStateKey: 'workspace',
		spaceName: 'Workspace',
		currentSpace: true,
		updatedAt: 1,
		archived: false,
	};
}

class TestNotifications {
	errors = 0;

	error(): void {
		this.errors++;
	}
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 4; index++) {
		await Promise.resolve();
	}
}

class TestSessionResumeInput extends EditorInput {
	readonly resource = undefined;

	override get typeId(): string {
		return 'test.paradisSessionResume';
	}

	override async resolve(): Promise<null> {
		return null;
	}
}

suite('paradisResumeAgentInWorkspace', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	interface IFixture {
		readonly accessor: ServicesAccessor;
		readonly events: string[];
		readonly ready: DeferredPromise<void>;
	}

	function createFixture(options?: { activeStateKey?: string; openError?: Error }): IFixture {
		const events: string[] = [];
		const ready = new DeferredPromise<void>();
		const instance = {
			instanceId: 17,
			processReady: ready.p.then(() => { events.push('ready'); }),
			sendText: async (command: string, shouldExecute: boolean) => { events.push(`send:${command}:${shouldExecute}`); },
		} as unknown as ITerminalInstance;
		const terminalService = {
			createTerminal: async (terminalOptions: { cwd?: URI; location?: TerminalLocation }) => {
				assert.strictEqual(terminalOptions.cwd?.toString(), URI.file('/repo-worktrees/feature').toString());
				assert.strictEqual(terminalOptions.location, TerminalLocation.Editor);
				events.push('create');
				return instance;
			},
			setActiveInstance: (candidate: ITerminalInstance) => { assert.strictEqual(candidate, instance); events.push('active'); },
		} as unknown as ITerminalService;
		const terminalEditorService = {
			openEditor: async (candidate: ITerminalInstance) => {
				assert.strictEqual(candidate, instance);
				events.push('open');
				if (options?.openError) {
					throw options.openError;
				}
			},
		} as unknown as ITerminalEditorService;
		const terminalScopeService = {
			assignInstanceScope: (instanceId: number, stateKey: string) => { events.push(`assign:${instanceId}:${stateKey}`); },
		} as unknown as IParadisTerminalScopeService;
		const switchService = {
			activeStateKey: options?.activeStateKey ?? 'another-space',
		} as unknown as IParadisWorkspaceSwitchService;
		const accessor = {
			get: (service: unknown) => {
				if (service === ITerminalService) { return terminalService; }
				if (service === ITerminalEditorService) { return terminalEditorService; }
				if (service === IParadisTerminalScopeService) { return terminalScopeService; }
				if (service === IParadisWorkspaceSwitchService) { return switchService; }
				throw new Error(`Unexpected service: ${String(service)}`);
			},
		} as ServicesAccessor;
		return { accessor, events, ready };
	}

	function request(agent: 'claude' | 'codex', dangerouslyBypassPermissions = false) {
		return {
			rootUri: URI.file('/repo-worktrees/feature'),
			stateKey: 'worktree:feature',
			agent,
			sessionId: 'session-123',
			dangerouslyBypassPermissions,
		};
	}

	test('waits for process readiness before opening, assigning, activating, and sending', async () => {
		const fixture = createFixture({ activeStateKey: 'worktree:feature' });
		const result = paradisResumeAgentInWorkspace(fixture.accessor, request('claude'));
		await Promise.resolve();
		await Promise.resolve();
		assert.deepStrictEqual(fixture.events, ['create']);

		fixture.ready.complete();
		await result;
		assert.deepStrictEqual(fixture.events, [
			'create',
			'ready',
			'open',
			'assign:17:worktree:feature',
			'active',
			'send:claude --resume session-123:true',
		]);
	});

	test('uses the agent-specific dangerous flag', async () => {
		const cases = [
			{ agent: 'claude' as const, dangerous: false, command: 'claude --resume session-123' },
			{ agent: 'claude' as const, dangerous: true, command: 'claude --dangerously-skip-permissions --resume session-123' },
			{ agent: 'codex' as const, dangerous: false, command: 'codex resume session-123' },
			{ agent: 'codex' as const, dangerous: true, command: 'codex --dangerously-bypass-approvals-and-sandbox resume session-123' },
		];
		for (const testCase of cases) {
			const fixture = createFixture();
			fixture.ready.complete();
			await paradisResumeAgentInWorkspace(fixture.accessor, request(testCase.agent, testCase.dangerous));
			assert.deepStrictEqual(fixture.events, [
				'create',
				'ready',
				'open',
				'assign:17:worktree:feature',
				`send:${testCase.command}:true`,
			]);
		}
	});

	test('rejects empty and option-like session IDs before creating a terminal', async () => {
		for (const sessionId of ['', '--dangerously-skip-permissions']) {
			const fixture = createFixture();
			await assert.rejects(paradisResumeAgentInWorkspace(fixture.accessor, {
				...request('claude'),
				sessionId,
			}), /Invalid agent session id/);
			assert.deepStrictEqual(fixture.events, []);
		}
	});

	test('does not send a command when process startup, cancellation, or editor opening fails', async () => {
		for (const error of [new Error('process failed'), new CancellationError()]) {
			const fixture = createFixture();
			const result = paradisResumeAgentInWorkspace(fixture.accessor, request('codex'));
			await Promise.resolve();
			await Promise.resolve();
			fixture.ready.error(error);
			await assert.rejects(result, candidate => candidate === error);
			assert.strictEqual(fixture.events.some(event => event.startsWith('send:')), false);
		}

		const openError = new Error('open failed');
		const fixture = createFixture({ openError });
		fixture.ready.complete();
		await assert.rejects(paradisResumeAgentInWorkspace(fixture.accessor, request('codex')), candidate => candidate === openError);
		assert.strictEqual(fixture.events.some(event => event.startsWith('send:')), false);
	});
});
