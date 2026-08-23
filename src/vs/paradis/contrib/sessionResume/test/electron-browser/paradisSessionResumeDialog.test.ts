/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisResumeAgentInWorkspace } from '../../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { ParadisSessionResumeDialog, paradisOpenSessionResumeDialog } from '../../electron-browser/paradisSessionResumeDialog.js';
import { IParadisResumeListRequestWithUri } from '../../electron-browser/paradisSessionResumeClient.js';
import { IParadisResumePreview, IParadisResumeSession } from '../../common/paradisSessionResume.js';
import { paradisSessionResumeEditorActionOptions, paradisResumeSessionFromEditor } from '../../electron-browser/paradisSessionResumeOrchestration.js';

/** 自動更新は750ms遅延で走るので、それを跨いで待つ。 */
const AUTOMATIC_REFRESH_WAIT_MS = 800;

suite('ParadisSessionResumeDialog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const target = {
		rootUri: URI.file('/repo-worktrees/feature'),
		stateKey: 'worktree:feature',
		agent: 'claude' as const,
		sessionId: 'session-123',
	};

	test('starts the initial load while being constructed', async () => {
		const list = new DeferredPromise<readonly IParadisResumeSession[]>();
		const client = new TestResumeClient();
		client.listResult = () => list.p;
		const fixture = createRefreshFixture(client);
		try {
			await flushMicrotasks();
			assert.strictEqual(client.listRequests.length, 1);

			list.complete([testSession('one', 'First session')]);
			await fixture.load();
			assert.strictEqual(fixture.root.textContent?.includes('First session'), true);
		} finally {
			fixture.dispose();
		}
	});

	test('refreshes for each workspace event while the dialog is open', async () => {
		for (const eventName of ['scope', 'repository', 'worktree'] as const) {
			const client = new TestResumeClient();
			const fixture = createRefreshFixture(client);
			try {
				await fixture.load();
				assert.strictEqual(client.listRequests.length, 1, eventName);

				fixture.fire(eventName);
				await timeout(AUTOMATIC_REFRESH_WAIT_MS);
				assert.strictEqual(client.listRequests.length, 2, eventName);
			} finally {
				fixture.dispose();
			}
		}
	});

	test('stops refreshing and removes the backdrop once closed', async () => {
		const client = new TestResumeClient();
		const fixture = createRefreshFixture(client);
		try {
			await fixture.load();
			fixture.dialog.close();
			assert.strictEqual(fixture.root.querySelector('.paradis-session-resume-backdrop'), null);

			fixture.fire('scope');
			await timeout(AUTOMATIC_REFRESH_WAIT_MS);
			assert.strictEqual(client.listRequests.length, 1);
		} finally {
			fixture.dispose();
		}
	});

	test('opens a single dialog even when requested twice', async () => {
		const client = new TestResumeClient();
		const stubs = createDialogStubs(client);
		try {
			paradisOpenSessionResumeDialog(stubs.instantiationService);
			paradisOpenSessionResumeDialog(stubs.instantiationService);
			await flushMicrotasks();

			assert.strictEqual(stubs.root.querySelectorAll('.paradis-session-resume-backdrop').length, 1);
			assert.strictEqual(stubs.dialogs.length, 1);
		} finally {
			stubs.dispose();
		}
	});

	test('clears the search box on Escape before closing the dialog', async () => {
		const client = new TestResumeClient();
		client.listResult = async () => [testSession('one', 'First session')];
		const fixture = createRefreshFixture(client);
		try {
			await fixture.load();
			const search = fixture.root.querySelector<HTMLInputElement>('input[type="search"]')!;
			search.value = 'first';
			search.dispatchEvent(new Event('input'));

			pressEscape(search);
			assert.deepStrictEqual([search.value, fixture.root.querySelector('.paradis-session-resume-backdrop') !== null], ['', true]);

			pressEscape(search);
			assert.strictEqual(fixture.root.querySelector('.paradis-session-resume-backdrop'), null);
		} finally {
			fixture.dispose();
		}
	});

	test('shows the detail back button only in the one-column container', async () => {
		const client = new TestResumeClient();
		client.listResult = async () => [testSession('one', 'First session')];
		const fixture = createRefreshFixture(client);
		const stylesheet = document.createElement('link');
		stylesheet.rel = 'stylesheet';
		stylesheet.href = new URL('../../electron-browser/media/paradisSessionResume.css', import.meta.url).href;
		const stylesheetLoaded = new Promise<void>((resolve, reject) => {
			stylesheet.addEventListener('load', () => resolve(), { once: true });
			stylesheet.addEventListener('error', () => reject(new Error('Failed to load session resume stylesheet')), { once: true });
		});
		document.head.appendChild(stylesheet);
		document.body.appendChild(fixture.root);
		try {
			await stylesheetLoaded;
			await fixture.load();
			fixture.root.querySelector<HTMLButtonElement>('.paradis-session-resume-row')!.click();
			await flushMicrotasks();
			const modal = fixture.root.querySelector<HTMLElement>('.paradis-session-resume-modal')!;
			const backButton = fixture.root.querySelector<HTMLElement>('.paradis-session-resume-detail-back')!;
			const view = fixture.root.ownerDocument.defaultView!;
			modal.style.maxWidth = 'none';

			modal.style.width = '599px';
			await new Promise<void>(resolve => view.requestAnimationFrame(() => resolve()));
			const narrowDisplay = view.getComputedStyle(backButton).display;

			modal.style.width = '600px';
			await new Promise<void>(resolve => view.requestAnimationFrame(() => resolve()));
			const wideDisplay = view.getComputedStyle(backButton).display;

			assert.deepStrictEqual({ narrowDisplay, wideDisplay }, {
				narrowDisplay: 'inline-flex',
				wideDisplay: 'none',
			});
		} finally {
			fixture.root.remove();
			stylesheet.remove();
			fixture.dispose();
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
			fixture.fire('scope');
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

	test('preserves selection, query, and filter across an invalidation refresh', async () => {
		const client = new TestResumeClient();
		client.listResult = async () => [testSession('one', 'First session'), testSession('two', 'Second session', 'codex')];
		const fixture = createRefreshFixture(client);
		try {
			await fixture.load();
			fixture.root.querySelectorAll<HTMLButtonElement>('.paradis-session-resume-row')[1].click();
			const search = fixture.root.querySelector<HTMLInputElement>('input[type="search"]')!;
			search.value = 'second';
			search.dispatchEvent(new Event('input'));
			const codexFilter = fixture.root.querySelector<HTMLButtonElement>('button[data-agent-filter="codex"]')!;
			codexFilter.click();

			fixture.fire('scope');
			await timeout(AUTOMATIC_REFRESH_WAIT_MS);
			assert.strictEqual(client.listRequests.length, 2);

			assert.strictEqual(search.value, 'second');
			assert.strictEqual(codexFilter.getAttribute('aria-pressed'), 'true');
			assert.strictEqual(fixture.root.querySelector('.paradis-session-resume-row.selected .row-title')?.textContent, 'Second session');
		} finally {
			fixture.dispose();
		}
	});

	test('reloads the selected preview after an invalidation', async () => {
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
			assert.strictEqual(fixture.root.textContent?.includes('Initial preview'), true);

			fixture.fire('scope');
			await timeout(AUTOMATIC_REFRESH_WAIT_MS);
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
			// close() で背景ごとDOMから外れるため、比較は外れた後も残るモーダルの中身で行う。
			const modal = fixture.root.querySelector<HTMLElement>('.paradis-session-resume-modal')!;
			const beforeDispose = modal.innerHTML;
			fixture.dialog.close();
			lateList.complete([session]);
			latePreview.complete({ messages: [], truncated: false });
			lateSearch.complete([]);
			await timeout(1);
			await flushMicrotasks();

			assert.strictEqual(modal.innerHTML, beforeDispose);
			assert.strictEqual(fixture.notifications.errors, 0);
			assert.strictEqual(client.listRequests.length, 2);
		} finally {
			fixture.dispose();
		}
	});

	test('maps each dialog button to its resume mode and permission behavior', () => {
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

type WorkspaceEvent = 'scope' | 'repository' | 'worktree';

interface IDialogStubs {
	/** ダイアログの背景を受け取るコンテナ（`ILayoutService.activeContainer` の代わり）。 */
	readonly root: HTMLElement;
	readonly notifications: TestNotifications;
	readonly instantiationService: IInstantiationService;
	/** `paradisOpenSessionResumeDialog` 経由も含め、実際に作られたダイアログ。 */
	readonly dialogs: ParadisSessionResumeDialog[];
	createDialog(): ParadisSessionResumeDialog;
	fire(event: WorkspaceEvent): void;
	dispose(): void;
}

function createDialogStubs(client: TestResumeClient): IDialogStubs {
	const scopeEmitter = new Emitter<void>();
	const repositoryEmitter = new Emitter<void>();
	const worktreeEmitter = new Emitter<void>();
	const notifications = new TestNotifications();
	const root = document.createElement('div');
	const dialogs: ParadisSessionResumeDialog[] = [];
	const markdownRendererService: IMarkdownRendererService = {
		_serviceBrand: undefined,
		render(markdown) {
			const element = document.createElement('span');
			element.textContent = markdown.value;
			return { element, dispose() { } };
		},
		setDefaultCodeBlockRenderer() { },
	};
	const instantiationService = {
		createInstance: (ctor: unknown) => ctor === ParadisSessionResumeDialog ? createDialog() : client,
	} as unknown as IInstantiationService;

	function createDialog(): ParadisSessionResumeDialog {
		const dialog = new ParadisSessionResumeDialog(
			{ activeContainer: root } as unknown as ILayoutService,
			instantiationService,
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
		dialogs.push(dialog);
		return dialog;
	}

	return {
		root,
		notifications,
		instantiationService,
		dialogs,
		createDialog,
		fire(event: WorkspaceEvent): void {
			if (event === 'scope') {
				scopeEmitter.fire();
			} else if (event === 'repository') {
				repositoryEmitter.fire();
			} else {
				worktreeEmitter.fire();
			}
		},
		dispose(): void {
			for (const dialog of dialogs) {
				dialog.dispose();
			}
		},
	};
}

interface IRefreshFixture extends IDialogStubs {
	readonly dialog: ParadisSessionResumeDialog;
	/** 構築時に始まる初回取得とプレビュー読み込みが落ち着くまで待つ。 */
	load(): Promise<void>;
}

function createRefreshFixture(client: TestResumeClient): IRefreshFixture {
	const stubs = createDialogStubs(client);
	return {
		...stubs,
		dialog: stubs.createDialog(),
		async load(): Promise<void> {
			await timeout(1);
			await flushMicrotasks();
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

function pressEscape(target: HTMLElement): void {
	target.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 27, bubbles: true }));
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 4; index++) {
		await Promise.resolve();
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
