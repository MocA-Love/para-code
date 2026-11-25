/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { IContextViewDelegate, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IParadisAgentModelCatalogService } from '../../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../common/paradisWorkspaceSwitch.js';
import { ParadisCreateWorktreeDialog } from '../../electron-browser/paradisCreateWorktreeDialog.js';
import { IParadisWorktreeGitHost, ParadisGithubReferenceResult } from '../../electron-browser/paradisWorktreeGitChannelClient.js';
import { IParadisGithubReferenceInfo } from '../../../../common/paradisIssueDetection.js';
import { IParadisWorktreeCreateQueueService } from '../../electron-browser/paradisWorktreeCreateQueue.js';
import { IParadisHeadlessWorktreeRequest } from '../../electron-browser/paradisWorktreeHeadlessCreate.js';
import { IParadisWorktreeImage } from '../../common/paradisWorktreeImageAttach.js';

suite('create worktree dialog: setup switch', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('turning the setup switch off dims the row and creates the worktree without running setup', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		await fileService.writeFile(URI.file('/repo/.paracode.json'), VSBuffer.fromString('{ "setupScript": "npm ci" }'));
		const repository = { id: 'repo', name: 'repo', uri: URI.file('/repo') } satisfies IParadisWorkspaceRepository;
		// ダイアログが読み終えたことを、ファイルの読み取りと枝の一覧が返った時点で知る
		const configRead = new DeferredPromise<void>();
		const readFile = fileService.readFile.bind(fileService);
		fileService.readFile = (async (...args: Parameters<typeof fileService.readFile>) => {
			try {
				return await readFile(...args);
			} finally {
				configRead.complete();
			}
		}) as typeof fileService.readFile;
		const branchesListed = new DeferredPromise<void>();
		const channel = { call: async () => { branchesListed.complete(); return { branches: ['main'], head: 'main' }; }, listen: () => Event.None } as unknown as IChannel;
		const gitHost: IParadisWorktreeGitHost = { channel, path: resource => resource.path as unknown as ReturnType<IParadisWorktreeGitHost['path']> };
		const enqueued: IParadisHeadlessWorktreeRequest[] = [];
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const storage = store.add(new InMemoryStorageService());
		const dialog = new ParadisCreateWorktreeDialog(
			{ activeContainer: container } as unknown as ILayoutService,
			() => gitHost,
			{ repositories: [repository], activeRepository: repository } as unknown as IParadisWorkspaceSwitchService,
			{ getDetectedWorktrees: () => [] } as unknown as IParadisWorktreeService,
			new TestConfigurationService(),
			fileService,
			new NullLogService(),
			storage,
			{ enqueue: (request: IParadisHeadlessWorktreeRequest) => { enqueued.push(request); } } as unknown as IParadisWorktreeCreateQueueService,
			{ onDidChange: Event.None, refresh: () => { }, getAgentTemplates: () => [], isFixedBySettings: () => false } as unknown as IParadisAgentModelCatalogService,
			Object.create(null),
			NullHoverService,
			'repo',
			undefined,
		);
		try {
			await Promise.all([configRead.p, branchesListed.p]);
			await timeout(0);
			const row = container.querySelector<HTMLElement>('.pcw-setup-row')!;
			const toggle = row.querySelector<HTMLButtonElement>('button.paradis-switch')!;
			const before = { shown: !row.classList.contains('hidden'), checked: toggle.getAttribute('aria-checked'), off: row.classList.contains('off') };
			toggle.click();
			const after = { checked: toggle.getAttribute('aria-checked'), off: row.classList.contains('off') };
			container.querySelector<HTMLButtonElement>('.pcw-create')!.click();
			assert.deepStrictEqual({ before, after, runSetup: enqueued.map(request => request.runSetup) }, {
				before: { shown: true, checked: 'true', off: false },
				after: { checked: 'false', off: true },
				runSetup: [false],
			});
		} finally {
			dialog.dispose();
			container.remove();
		}
	});

	test('an Escape that cancels a Japanese conversion does not close the dialog', () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		const repository = { id: 'repo', name: 'repo', uri: URI.file('/repo') } satisfies IParadisWorkspaceRepository;
		const channel = { call: async () => ({ branches: ['main'], head: 'main' }), listen: () => Event.None } as unknown as IChannel;
		const gitHost: IParadisWorktreeGitHost = { channel, path: resource => resource.path as unknown as ReturnType<IParadisWorktreeGitHost['path']> };
		const enqueued: IParadisHeadlessWorktreeRequest[] = [];
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const storage = store.add(new InMemoryStorageService());
		const dialog = new ParadisCreateWorktreeDialog(
			{ activeContainer: container } as unknown as ILayoutService,
			() => gitHost,
			{ repositories: [repository], activeRepository: repository } as unknown as IParadisWorkspaceSwitchService,
			{ getDetectedWorktrees: () => [] } as unknown as IParadisWorktreeService,
			new TestConfigurationService(),
			fileService,
			new NullLogService(),
			storage,
			{ enqueue: (request: IParadisHeadlessWorktreeRequest) => { enqueued.push(request); } } as unknown as IParadisWorktreeCreateQueueService,
			{ onDidChange: Event.None, refresh: () => { }, getAgentTemplates: () => [], isFixedBySettings: () => false } as unknown as IParadisAgentModelCatalogService,
			Object.create(null),
			NullHoverService,
			'repo',
			undefined,
		);
		try {
			const backdrop = container.querySelector<HTMLElement>('.paradis-create-worktree-backdrop')!;
			backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, isComposing: true, bubbles: true }));
			backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, isComposing: true, bubbles: true }));
			const whileComposing = { open: container.contains(backdrop), enqueued: enqueued.length };
			backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
			assert.deepStrictEqual({ whileComposing, afterEscape: container.contains(backdrop) }, {
				whileComposing: { open: true, enqueued: 0 },
				afterEscape: false,
			});
		} finally {
			dialog.dispose();
			container.remove();
		}
	});
});

suite('create worktree dialog: closing and drafts', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** ダイアログを開く。git は名前ごとに決まった答えを返し、一覧（プルダウン）はその場の箱に描く。 */
	function open(container: HTMLElement, prefill?: IParadisHeadlessWorktreeRequest) {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		const repository = { id: 'repo', name: 'repo', uri: URI.file('/repo') } satisfies IParadisWorkspaceRepository;
		const answers: Record<string, unknown> = {
			listBranches: { branches: ['main'], head: 'main' },
			listBranchCandidates: { local: [{ name: 'feature' }], remote: [], inUse: [], hasOrigin: false },
			inspectExistingBranch: { localSha: 'a', behind: 0, ahead: 0 },
		};
		const channel = { call: async (command: string) => answers[command], listen: () => Event.None } as unknown as IChannel;
		const gitHost: IParadisWorktreeGitHost = { channel, path: resource => resource.path as unknown as ReturnType<IParadisWorktreeGitHost['path']> };
		const contextViewService = {
			showContextView: (delegate: IContextViewDelegate) => {
				const host = mainWindow.document.createElement('div');
				container.appendChild(host);
				const rendered = delegate.render(host);
				return { close: () => { rendered?.dispose(); host.remove(); delegate.onHide?.(); } };
			},
			hideContextView: () => { },
		} as unknown as IContextViewService;
		const enqueued: IParadisHeadlessWorktreeRequest[] = [];
		const storage = store.add(new InMemoryStorageService());
		const dialog = new ParadisCreateWorktreeDialog(
			{ activeContainer: container } as unknown as ILayoutService,
			() => gitHost,
			{ repositories: [repository], activeRepository: repository } as unknown as IParadisWorkspaceSwitchService,
			{ getDetectedWorktrees: () => [] } as unknown as IParadisWorktreeService,
			new TestConfigurationService(),
			fileService,
			new NullLogService(),
			storage,
			{ enqueue: (request: IParadisHeadlessWorktreeRequest) => { enqueued.push(request); } } as unknown as IParadisWorktreeCreateQueueService,
			{ onDidChange: Event.None, refresh: () => { }, getAgentTemplates: () => [], isFixedBySettings: () => false } as unknown as IParadisAgentModelCatalogService,
			contextViewService,
			NullHoverService,
			prefill ? undefined : 'repo',
			prefill,
		);
		const modal = container.querySelector<HTMLElement>('.paradis-create-worktree-dialog')!;
		return { dialog, modal, enqueued, isOpen: () => container.querySelector('.paradis-create-worktree-dialog') !== null };
	}

	const escape = (target: HTMLElement) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
	const cancelButton = (modal: HTMLElement) => [...modal.querySelectorAll<HTMLElement>('.paradis-modal-foot .paradis-button')].find(button => button.textContent === 'キャンセル')!;

	/**
	 * 下書きはモジュールの単位で持つので、テストの終わりに開き直して「キャンセル」で捨てる（次のテストへ残さない）。
	 * 開いたままのダイアログは、新しく開いたダイアログが閉じる（そのとき残した下書きも開き直しで取り出して捨てる）。
	 */
	const discardDrafts = (container: HTMLElement) => cancelButton(open(container).modal).click();

	test('a modal dialog of the M tier labelled by its title, with role=alert on the error line', () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		try {
			const { dialog, modal } = open(container);
			const title = modal.querySelector<HTMLElement>('.paradis-modal-head .paradis-modal-title')!;
			assert.deepStrictEqual({
				role: modal.getAttribute('role'),
				modal: modal.getAttribute('aria-modal'),
				labelledBy: modal.getAttribute('aria-labelledby') === title.id && title.id.length > 0,
				title: title.textContent,
				tier: modal.classList.contains('paradis-modal-m'),
				alert: modal.querySelector('.pcw-error')!.getAttribute('role'),
			}, { role: 'dialog', modal: 'true', labelledBy: true, title: '新しいスペース', tier: true, alert: 'alert' });
			dialog.dispose();
		} finally {
			discardDrafts(container);
			container.remove();
		}
	});

	test('Escape and the backdrop keep what was written; reopening the same repository brings it back; Cancel drops it', () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		try {
			const image: IParadisWorktreeImage = { name: 'shot.png', mime: 'image/png', data: VSBuffer.fromString('png') };
			// 画像はファイルを読まずに添えられないので、再表示の値で添えてから閉じる
			const first = open(container, { repositoryId: 'repo', prompt: 'fix the login error', images: [image] });
			escape(first.modal.querySelector<HTMLTextAreaElement>('textarea')!);
			const closedByEscape = !first.isOpen();

			const second = open(container);
			const restored = {
				prompt: second.modal.querySelector<HTMLTextAreaElement>('textarea')!.value,
				images: second.modal.querySelectorAll('.paradis-image-composer-thumb').length,
				note: second.modal.querySelector('.pcw-d-restored')?.textContent,
			};
			// 背景を押して閉じても残る
			const backdrop = container.querySelector<HTMLElement>('.paradis-create-worktree-backdrop')!;
			backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

			const third = open(container);
			const afterBackdrop = third.modal.querySelector<HTMLTextAreaElement>('textarea')!.value;
			cancelButton(third.modal).click();

			const fourth = open(container);
			const afterCancel = { prompt: fourth.modal.querySelector<HTMLTextAreaElement>('textarea')!.value, note: fourth.modal.querySelector('.pcw-d-restored') !== null };
			fourth.dialog.dispose();
			assert.deepStrictEqual({ closedByEscape, restored, afterBackdrop, afterCancel }, {
				closedByEscape: true,
				restored: { prompt: 'fix the login error', images: 1, note: '保存する前に閉じた編集を戻しました。いらなければ「キャンセル」で捨てられます。' },
				afterBackdrop: 'fix the login error',
				afterCancel: { prompt: '', note: false },
			});
		} finally {
			discardDrafts(container);
			container.remove();
		}
	});

	test('Escape with the branch list open closes only the list', async () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		try {
			const { dialog, modal, isOpen } = open(container);
			await timeout(0);
			[...modal.querySelectorAll<HTMLButtonElement>('.pcw-d-mode button')].find(button => button.textContent === '既存のブランチ')!.click();
			await timeout(0);
			const field = modal.querySelector<HTMLInputElement>('.pcw-d-existing input')!;
			const listOpen = () => field.getAttribute('aria-expanded') === 'true';
			const before = listOpen();
			escape(field);
			const afterFirst = { list: listOpen(), dialog: isOpen() };
			escape(field);
			assert.deepStrictEqual({ before, afterFirst, afterSecond: isOpen() }, {
				before: true,
				afterFirst: { list: false, dialog: true },
				afterSecond: false,
			});
			dialog.dispose();
		} finally {
			discardDrafts(container);
			container.remove();
		}
	});
});

suite('create worktree dialog: issues and pull requests pasted into the prompt', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const ISSUE_URL = 'https://github.com/acme/app/issues/2236';
	const PR_URL = 'https://github.com/acme/app/pull/2241';
	// allow-any-unicode-next-line
	const ISSUE: IParadisGithubReferenceInfo = { kind: 'issue', owner: 'acme', repo: 'app', number: 2236, title: 'テンプレートJSONの重説マッピング', url: ISSUE_URL, state: 'open' };
	const PR: IParadisGithubReferenceInfo = { kind: 'pr', owner: 'acme', repo: 'app', number: 2241, title: 'Fix the mapping', url: PR_URL, state: 'open', branch: 'fix/mapping' };

	interface IOpenOptions {
		readonly prompt?: string;
		/** URL ごとの gh の答え（無ければ「見つからない」）。 */
		readonly lookups?: Record<string, ParadisGithubReferenceResult>;
		/** git の答えの差し替え。 */
		readonly git?: Record<string, unknown>;
		readonly worktrees?: readonly { readonly name: string; readonly path: string }[];
	}

	function open(container: HTMLElement, options: IOpenOptions = {}) {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		const repository = { id: 'repo', name: 'repo', uri: URI.file('/repo') } satisfies IParadisWorkspaceRepository;
		const answers: Record<string, unknown> = {
			listBranches: { branches: ['main'], head: 'main' },
			listBranchCandidates: { local: [{ name: 'main' }], remote: [{ name: 'main' }, { name: 'fix/mapping' }], inUse: [], hasOrigin: false },
			inspectExistingBranch: { remoteSha: 'b', behind: 0, ahead: 0 },
			getOriginRepository: 'acme/app',
			...options.git,
		};
		const channel = { call: async (command: string) => answers[command], listen: () => Event.None } as unknown as IChannel;
		const gitHost: IParadisWorktreeGitHost = { channel, path: resource => resource.path as unknown as ReturnType<IParadisWorktreeGitHost['path']> };
		const contextViewService = { showContextView: () => ({ close: () => { } }), hideContextView: () => { } } as unknown as IContextViewService;
		const enqueued: IParadisHeadlessWorktreeRequest[] = [];
		const switched: string[] = [];
		const lookedUp: string[] = [];
		const worktrees = (options.worktrees ?? []).map(worktree => ({ repositoryId: 'repo', name: worktree.name, branch: '', uri: URI.file(worktree.path) }));
		const dialog = new ParadisCreateWorktreeDialog(
			{ activeContainer: container } as unknown as ILayoutService,
			() => gitHost,
			{ repositories: [repository], activeRepository: repository, switchToWorktree: async (worktree: { name: string }) => { switched.push(worktree.name); } } as unknown as IParadisWorkspaceSwitchService,
			{ getDetectedWorktrees: () => worktrees } as unknown as IParadisWorktreeService,
			new TestConfigurationService(),
			fileService,
			new NullLogService(),
			store.add(new InMemoryStorageService()),
			{ enqueue: (request: IParadisHeadlessWorktreeRequest) => { enqueued.push(request); } } as unknown as IParadisWorktreeCreateQueueService,
			{ onDidChange: Event.None, refresh: () => { }, getAgentTemplates: () => [], isFixedBySettings: () => false } as unknown as IParadisAgentModelCatalogService,
			contextViewService,
			NullHoverService,
			undefined,
			{ repositoryId: 'repo', prompt: options.prompt ?? '' },
			undefined,
			async (_repository, url) => {
				lookedUp.push(url);
				return options.lookups?.[url] ?? { kind: 'failed', reason: 'notFound', via: 'local' };
			},
		);
		const modal = container.querySelector<HTMLElement>('.paradis-create-worktree-dialog')!;
		const cards = () => [...modal.querySelectorAll<HTMLElement>('.pcw-d-ref')].map(card => ({
			title: card.querySelector('.pcw-d-ref-title')!.textContent,
			sub: card.querySelector('.pcw-d-ref-sub')?.textContent,
			chip: card.querySelector('.paradis-chip')?.textContent,
			buttons: [...card.querySelectorAll<HTMLElement>('.paradis-button')].map(button => button.textContent || button.getAttribute('aria-label')),
		}));
		const button = (label: string) => [...modal.querySelectorAll<HTMLElement>('.paradis-button, .pcw-d-mode button')].find(candidate => candidate.textContent === label || candidate.getAttribute('aria-label') === label)!;
		const fields = () => ({
			name: modal.querySelector<HTMLInputElement>('.pcw-name')!.placeholder,
			branch: modal.querySelector<HTMLInputElement>('.pcw-branch')!.placeholder,
			mode: [...modal.querySelectorAll<HTMLElement>('.pcw-d-mode button')].find(candidate => candidate.getAttribute('aria-pressed') === 'true')?.textContent,
			path: modal.querySelector('.pcw-path-preview')!.textContent,
		});
		const type = (selector: string, value: string) => {
			const input = modal.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
			input.value = value;
			input.dispatchEvent(new InputEvent('input', { bubbles: true }));
		};
		return { dialog, modal, enqueued, switched, lookedUp, cards, button, fields, type, create: () => button('作成').click() };
	}

	/** 下書きはモジュールの単位で持つので、開いたダイアログは「キャンセル」で閉じる（次のテストへ残さない）。 */
	async function withDialog<T>(options: IOpenOptions, run: (opened: ReturnType<typeof open>) => Promise<T>): Promise<T> {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const opened = open(container, options);
		try {
			await timeout(0);
			return await run(opened);
		} finally {
			if (container.querySelector('.paradis-create-worktree-dialog')) {
				opened.button('キャンセル').click();
			}
			container.remove();
		}
	}

	const ok = (info: IParadisGithubReferenceInfo): ParadisGithubReferenceResult => ({ kind: 'ok', info, via: 'local' });

	test('shows the issue as a card, offers its title as the space name, and a typed name wins until it is cleared', async () => {
		await withDialog({ prompt: `${ISSUE_URL} を対応して`, lookups: { [ISSUE_URL]: ok(ISSUE) } }, async dialog => {
			const offered = { cards: dialog.cards(), fields: dialog.fields(), rows: dialog.modal.querySelector<HTMLTextAreaElement>('textarea')!.rows };
			// allow-any-unicode-next-line
			dialog.type('.pcw-name', '重説マッピング修正');
			const typed = dialog.cards()[0].sub;
			dialog.type('.pcw-branch', 'my-branch');
			const bothTyped = dialog.cards()[0].sub;
			dialog.type('.pcw-name', '');
			dialog.type('.pcw-branch', '');
			const cleared = dialog.fields().name;
			dialog.create();

			assert.deepStrictEqual({ offered, typed, bothTyped, cleared, request: dialog.enqueued.map(request => ({ name: request.name, branch: request.branch, reference: request.reference, skipReference: request.skipReference })) }, {
				offered: {
					// allow-any-unicode-next-line
					cards: [{ title: 'テンプレートJSONの重説マッピング', sub: 'acme/app #2236 · Issue · スペース名とブランチ名の番号に使います', chip: 'Open', buttons: ['acme/app #2236 を名前に使わない'] }],
					// allow-any-unicode-next-line
					fields: { name: '#2236 テンプレートJSONの重説マッピング', branch: '2236-(自動生成)', mode: '新しいブランチ', path: URI.file('/repo-worktrees/2236-(自動生成)').fsPath },
					// カードが出ている間は指示の欄を 1 行ぶん縮める
					rows: 2,
				},
				// allow-any-unicode-next-line
				typed: 'acme/app #2236 · Issue · 番号だけブランチ名に使います（スペース名は打った名前）',
				// allow-any-unicode-next-line
				bothTyped: 'acme/app #2236 · Issue · スペース名は打った名前を使います',
				// allow-any-unicode-next-line
				cleared: '#2236 テンプレートJSONの重説マッピング',
				// 取れた題名を要求に載せる（作成の流れは取り直さない）。名前の欄には値を入れない
				// allow-any-unicode-next-line
				request: [{ name: '', branch: '', reference: { url: ISSUE_URL, number: 2236, kind: 'issue', title: 'テンプレートJSONの重説マッピング' }, skipReference: undefined }],
			});
		});
	});

	test('fetches half a second after typing stops, uses the first of several, lets another be picked, and stops naming when all are dismissed', async () => {
		const second = 'https://github.com/acme/app/issues/2198';
		// allow-any-unicode-next-line
		const other: IParadisGithubReferenceInfo = { ...ISSUE, number: 2198, title: 'フォントが置き換わる', url: second, state: 'closed' };
		await withDialog({ lookups: { [ISSUE_URL]: ok(ISSUE), [second]: ok(other) } }, async dialog => {
			dialog.type('textarea', `${ISSUE_URL} ${second}`);
			const beforeDebounce = dialog.lookedUp.length;
			await timeout(600);
			const both = dialog.cards().map(card => [card.sub, card.chip, card.buttons]);
			dialog.button('こちらを使う').click();
			const picked = dialog.fields().name;
			dialog.button('acme/app #2198 を名前に使わない').click();
			const afterDismiss = dialog.fields().name;
			dialog.button('acme/app #2236 を名前に使わない').click();
			const none = { cards: dialog.cards().length, fields: dialog.fields(), rows: dialog.modal.querySelector<HTMLTextAreaElement>('textarea')!.rows };
			dialog.create();

			assert.deepStrictEqual({ beforeDebounce, lookedUp: dialog.lookedUp, both, picked, afterDismiss, none, request: dialog.enqueued.map(request => [request.reference, request.skipReference]) }, {
				beforeDebounce: 0,
				lookedUp: [ISSUE_URL, second],
				both: [
					// allow-any-unicode-next-line
					['acme/app #2236 · Issue · スペース名とブランチ名の番号に使います', 'Open', ['acme/app #2236 を名前に使わない']],
					// allow-any-unicode-next-line
					['acme/app #2198 · Issue · 名前には使いません', 'Closed', ['こちらを使う', 'acme/app #2198 を名前に使わない']],
				],
				// allow-any-unicode-next-line
				picked: '#2198 フォントが置き換わる',
				// allow-any-unicode-next-line
				afterDismiss: '#2236 テンプレートJSONの重説マッピング',
				// allow-any-unicode-next-line
				none: { cards: 0, fields: { name: '(省略可)', branch: '(自動生成)', mode: '新しいブランチ', path: URI.file('/repo-worktrees/(自動生成)').fsPath }, rows: 3 },
				request: [[undefined, true]],
			});
		});
	});

	test('tells the three kinds of failure apart, never blocks Create, and lets the create flow try again', async () => {
		const urls = ['https://github.com/acme/app/issues/1', 'https://github.com/acme/app/issues/2', 'https://github.com/acme/app/issues/3'];
		const failed = (reason: 'unreachable' | 'notFound' | 'noGh'): ParadisGithubReferenceResult => ({ kind: 'failed', reason, via: 'local' });
		const lookups: Record<string, ParadisGithubReferenceResult> = { [urls[0]]: failed('unreachable'), [urls[1]]: failed('notFound'), [urls[2]]: failed('noGh') };
		await withDialog({ prompt: urls.join(' '), lookups }, async dialog => {
			const cards = dialog.cards().map(card => [card.title, card.sub, card.buttons.slice(0, 1)]);
			const fields = dialog.fields();
			lookups[urls[0]] = ok({ ...ISSUE, number: 1, title: 'Now it works' });
			// 「再試行」は既存のブランチの取得の行にもあるので、カードの中から探す
			[...dialog.modal.querySelectorAll<HTMLElement>('.pcw-d-ref .paradis-button')].find(candidate => candidate.textContent === '再試行')!.click();
			await timeout(0);
			const retried = dialog.cards()[0].title;
			dialog.button('acme/app #1 を名前に使わない').click();
			dialog.create();

			assert.deepStrictEqual({ cards, fields, retried, request: dialog.enqueued.map(request => request.reference) }, {
				cards: [
					// allow-any-unicode-next-line
					['acme/app #1 を取得できませんでした', 'GitHub に届きませんでした。スペース名は今までどおり指示から付けます', ['再試行']],
					// allow-any-unicode-next-line
					['acme/app #2 は見つからないか、読む権限がありません', 'gh にログインしているアカウントで読めるか確かめてください。スペース名は今までどおり指示から付けます', ['再試行']],
					// allow-any-unicode-next-line
					['acme/app #3 を取得できませんでした', 'gh（GitHub CLI）が使えません。gh を入れて gh auth login を済ませると取れます。スペース名は今までどおり指示から付けます', ['再試行']],
				],
				// allow-any-unicode-next-line
				fields: { name: '(省略可)', branch: '(自動生成)', mode: '新しいブランチ', path: URI.file('/repo-worktrees/(自動生成)').fsPath },
				retried: 'Now it works',
				// 取れていないカードは URL だけを載せ、作成の流れが 3 秒まで取り直す
				request: [{ url: urls[1], number: 2, kind: 'issue' }],
			});
		});
	});

	test('a pull request of this repository switches to its source branch, and choosing a new branch numbers it after that branch', async () => {
		await withDialog({ prompt: PR_URL, lookups: { [PR_URL]: ok(PR) } }, async dialog => {
			await timeout(0);
			const switched = { fields: dialog.fields(), chosen: dialog.modal.querySelector<HTMLInputElement>('.pcw-d-existing input')!.value, sub: dialog.cards()[0].sub };
			dialog.button('新しいブランチ').click();
			await timeout(0);
			const asNew = dialog.fields();
			dialog.create();

			assert.deepStrictEqual({ switched, asNew, request: dialog.enqueued.map(request => ({ branch: request.branch, existingBranch: request.existingBranch, reference: request.reference?.title })) }, {
				switched: {
					fields: { name: '#2241 Fix the mapping', branch: 'fix/mapping-2', mode: '既存のブランチ', path: URI.file('/repo-worktrees/fix-mapping').fsPath },
					chosen: 'origin/fix/mapping',
					// allow-any-unicode-next-line
					sub: 'acme/app #2241 · プルリクエスト · スペース名に使います',
				},
				// allow-any-unicode-next-line
				asNew: { name: '#2241 Fix the mapping', branch: 'fix/mapping-2', mode: '新しいブランチ', path: URI.file('/repo-worktrees/fix-mapping-2').fsPath },
				request: [{ branch: 'fix/mapping-2', existingBranch: undefined, reference: 'Fix the mapping' }],
			});
		});
	});

	test('opens the source branch as an existing one, and offers to switch when another space has it open', async () => {
		const opened = await withDialog({ prompt: PR_URL, lookups: { [PR_URL]: ok(PR) } }, async dialog => {
			await timeout(0);
			dialog.create();
			return dialog.enqueued.map(request => ({ branch: request.branch, existingBranch: request.existingBranch }));
		});
		const inUse = await withDialog({
			prompt: PR_URL, lookups: { [PR_URL]: ok(PR) }, worktrees: [{ name: 'Mapping', path: '/repo-worktrees/fix-mapping' }],
			git: { inspectExistingBranch: { remoteSha: 'b', localSha: 'b', behind: 0, ahead: 0, inUse: { branch: 'fix/mapping', path: '/repo-worktrees/fix-mapping', main: false } } },
		}, async dialog => {
			await timeout(0);
			const note = dialog.modal.querySelector('.pcw-d-branch-note')!.textContent;
			const canCreate = !dialog.button('作成').classList.contains('disabled');
			// allow-any-unicode-next-line
			dialog.button('そのスペースへ切り替える').click();
			await timeout(0);
			return { note, canCreate, switched: dialog.switched, enqueued: dialog.enqueued.length };
		});

		assert.deepStrictEqual({ opened, inUse }, {
			opened: [{ branch: '', existingBranch: { branch: 'fix/mapping', source: 'origin' } }],
			inUse: {
				// allow-any-unicode-next-line
				note: 'fix/mapping はスペース「Mapping」で開いています。git では 1 つのブランチを 2 か所で開けません。そのスペースへ切り替える',
				canCreate: false,
				switched: ['Mapping'],
				enqueued: 0,
			},
		});
	});

	test('a fork pull request opens through a local branch fetched at creation; another repository or a closed one only names the space', async () => {
		const fork = await withDialog({ prompt: PR_URL, lookups: { [PR_URL]: ok({ ...PR, branch: 'main', crossRepository: true }) }, git: { inspectExistingBranch: { behind: 0, ahead: 0 } } }, async dialog => {
			await timeout(0);
			const fields = dialog.fields();
			const note = dialog.modal.querySelector('.pcw-d-branch-note')!.textContent;
			dialog.create();
			return { mode: fields.mode, path: fields.path, note, existingBranch: dialog.enqueued[0]?.existingBranch };
		});
		const elsewhere = await withDialog({ prompt: PR_URL, lookups: { [PR_URL]: ok(PR) }, git: { getOriginRepository: 'acme/other' } }, async dialog => {
			await timeout(0);
			return dialog.fields();
		});
		const merged = await withDialog({ prompt: PR_URL, lookups: { [PR_URL]: ok({ ...PR, state: 'merged' }) } }, async dialog => {
			await timeout(0);
			return [dialog.fields().mode, dialog.fields().branch, dialog.cards()[0].chip];
		});

		assert.deepStrictEqual({ fork, elsewhere, merged }, {
			fork: {
				mode: '既存のブランチ',
				path: URI.file('/repo-worktrees/pr-2241-main').fsPath,
				// allow-any-unicode-next-line
				note: 'fork から来たプルリクエスト #2241 です。作るときに origin から取得し、ローカルブランチ pr-2241-main を作って開きます。push しても、fork の元のブランチには載りません。',
				existingBranch: { branch: 'pr-2241-main', source: 'local', pullRequestNumber: 2241 },
			},
			// 別のリポジトリの PR: 元のブランチは当てず、番号を足す今までの付け方
			elsewhere: { name: '#2241 Fix the mapping', branch: '2241-(自動生成)', mode: '新しいブランチ', path: URI.file('/repo-worktrees/2241-(自動生成)').fsPath },
			merged: ['新しいブランチ', '2241-(自動生成)', 'Merged'],
		});
	});
});
