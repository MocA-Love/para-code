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
import { IParadisWorktreeGitHost } from '../../electron-browser/paradisWorktreeGitChannelClient.js';
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
