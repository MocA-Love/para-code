/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IAuxiliaryEditorPart, IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService, PreferredGroup } from '../../../../../workbench/services/editor/common/editorService.js';
import { ParadisAgentPreviewChannel } from '../../electron-browser/paradisAgentPreview.contribution.js';
import { IParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';
import {
	IParadisAuxiliaryWindowScopeService,
	IParadisTerminalScopeService,
	IParadisWorkspaceSwitchService,
	IParadisWorktree,
	IParadisWorktreeService,
	ParadisBindingScope,
} from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

interface IOpenedEditor {
	readonly resource: string;
	readonly group: string;
}

interface IHarnessOptions {
	/** ペイントークン → ターミナルインスタンスID。既定は 'pane-a' → 1 のみ。 */
	readonly instanceForToken?: (token: string) => number | undefined;
	/** インスタンスIDの所属スペース（park 中も引ける台帳の値）。 */
	readonly recordedStateKey?: string;
	readonly resolvedScope?: ParadisBindingScope;
	readonly activeStateKey?: string;
	readonly isSwitching?: boolean;
	/** ピン留めされた補助エディタウィンドウを持つスペース。 */
	readonly pinnedPartStateKey?: string;
	readonly openEditor?: () => Promise<unknown>;
	readonly stat?: () => Promise<{ readonly isDirectory: boolean }>;
	/** 直近使用順（MOST_RECENTLY_ACTIVE）でのグループ名。既定は main → main-split → auxiliary。 */
	readonly groupOrder?: readonly string[];
	/** 既に開かれているファイル（fsPath → そのファイルを開いているグループ名）。 */
	readonly openedFiles?: Readonly<Record<string, string>>;
	/** 実体のある worktree（`paradisListSpaces` に載るスペース）。既定は無し。 */
	readonly worktrees?: readonly IParadisWorktree[];
}

function createHarness(store: Pick<DisposableStore, 'add'>, options: IHarnessOptions = {}) {
	const opened: IOpenedEditor[] = [];
	let activeStateKey = options.activeStateKey;
	const onDidSwitchScope = store.add(new Emitter<string>());
	const onDidRetireScope = store.add(new Emitter<string>());

	// main のエディタ領域は分割された2グループを持ち、補助ウィンドウがもう1グループ持つ構成
	const mainGroup = { id: 1 } as unknown as IEditorGroup;
	const mainSplitGroup = { id: 3 } as unknown as IEditorGroup;
	const auxiliaryGroup = { id: 2 } as unknown as IEditorGroup;
	const groupNames = new Map<IEditorGroup, string>([[mainGroup, 'main'], [mainSplitGroup, 'main-split'], [auxiliaryGroup, 'auxiliary']]);
	const groupsByName = new Map<string, IEditorGroup>([...groupNames].map(([group, name]) => [name, group]));
	const mainPart = { activeGroup: mainGroup } as unknown as IEditorPart;
	const auxiliaryPart = { activeGroup: auxiliaryGroup } as unknown as IAuxiliaryEditorPart;
	const partsByGroup = new Map<IEditorGroup, IEditorPart>([[mainGroup, mainPart], [mainSplitGroup, mainPart], [auxiliaryGroup, auxiliaryPart]]);
	const namedGroups = (names: readonly string[]) => names.map(name => groupsByName.get(name)!);

	const editorService = {
		openEditor: async (editor: { resource: URI }, group: PreferredGroup) => {
			if (options.openEditor) {
				return options.openEditor();
			}
			opened.push({ resource: editor.resource.fsPath, group: groupNames.get(group as IEditorGroup) ?? 'unexpected' });
			return {};
		},
		// 実物と同じく「そのリソースを開いているグループ」だけを返す（引数を無視しない）
		findEditors: (resource: URI) => {
			const group = options.openedFiles?.[resource.fsPath];
			return group === undefined ? [] : [{ groupId: groupsByName.get(group)!.id }];
		},
	} as unknown as IEditorService;

	const channel = store.add(new ParadisAgentPreviewChannel(
		editorService,
		{ stat: options.stat ?? (async () => ({ isDirectory: false })) } as unknown as IFileService,
		{
			mainPart,
			getGroups: () => namedGroups(options.groupOrder ?? ['main', 'main-split', 'auxiliary']),
			// 実物は未知のグループにも mainPart を返すので、フェイクも同じ形にする
			getPart: (group: IEditorGroup) => partsByGroup.get(group) ?? mainPart,
		} as unknown as IEditorGroupsService,
		{ getInstanceForToken: options.instanceForToken ?? ((token: string) => token === 'pane-a' ? 1 : undefined) } as unknown as IParadisPaneTokenService,
		{
			getStateKeyForInstance: () => options.recordedStateKey,
			resolveScope: () => options.resolvedScope ?? { kind: 'pending' },
		} as unknown as IParadisTerminalScopeService,
		{
			get isSwitching() { return options.isSwitching ?? false; },
			get activeStateKey() { return activeStateKey; },
			repositories: [{ id: 'repo-a', name: 'Design System', uri: URI.file('/repos/a') }],
			onDidSwitchScope: onDidSwitchScope.event,
			onDidRetireScope: onDidRetireScope.event,
		} as unknown as IParadisWorkspaceSwitchService,
		{ getWorktrees: () => options.worktrees ?? [] } as unknown as IParadisWorktreeService,
		{
			getPinnedParts: (stateKey?: string) => options.pinnedPartStateKey !== undefined && stateKey === options.pinnedPartStateKey
				? [auxiliaryPart]
				: [],
		} as unknown as IParadisAuxiliaryWindowScopeService,
		new NullLogService(),
	));

	return {
		channel,
		opened,
		onDidSwitchScope,
		onDidRetireScope,
		preview: (path: string, token: string | undefined = 'pane-a') => channel.call<unknown>(undefined, 'previewFile', [token, path]),
		switchTo: (stateKey: string) => { activeStateKey = stateKey; onDidSwitchScope.fire(stateKey); },
	};
}

/** 予約分の開き直しは fire-and-forget なので、待ち合わせにマイクロタスクを消化させる。 */
function settle(): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, 0));
}

suite('ParadisAgentPreviewChannel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('does not return file paths or raw renderer exceptions over IPC', async () => {
		const privatePath = '/private/customer/project/secret.txt';
		const privateMarker = 'renderer-private-exception-marker';
		const harness = createHarness(store, {
			recordedStateKey: 'repo-a',
			activeStateKey: 'repo-a',
			openEditor: async () => { throw new Error(privateMarker); },
		});

		const result = await harness.preview(privatePath);
		const serialized = JSON.stringify(result);

		assert.strictEqual(serialized.includes(privatePath), false);
		assert.strictEqual(serialized.includes(privateMarker), false);
		assert.deepStrictEqual(result, { ok: false });
	});

	test('does not return stat failures over IPC', async () => {
		const privateMarker = 'stat-private-exception-marker';
		const harness = createHarness(store, { stat: async () => { throw new Error(privateMarker); } });

		const result = await harness.preview('/private/missing.txt');

		assert.strictEqual(JSON.stringify(result).includes(privateMarker), false);
		assert.deepStrictEqual(result, { ok: false });
	});

	test('reports a failure when no editor was opened', async () => {
		const harness = createHarness(store, {
			recordedStateKey: 'repo-a',
			activeStateKey: 'repo-a',
			openEditor: async () => undefined,
		});

		assert.deepStrictEqual(await harness.preview('/repos/a/report.html'), { ok: false });
	});

	test('opens into the main editor part when the calling pane belongs to the space on screen', async () => {
		const harness = createHarness(store, { recordedStateKey: 'repo-a', activeStateKey: 'repo-a' });

		const result = await harness.preview('/repos/a/report.html');

		assert.deepStrictEqual([result, harness.opened], [{ ok: true }, [{ resource: '/repos/a/report.html', group: 'main' }]]);
	});

	test('opens into the main editor part for panes that belong to no managed space', async () => {
		const harness = createHarness(store, { resolvedScope: { kind: 'unscoped' }, activeStateKey: 'repo-a' });

		const result = await harness.preview('/repos/a/scratch.md');

		assert.deepStrictEqual([result, harness.opened], [{ ok: true }, [{ resource: '/repos/a/scratch.md', group: 'main' }]]);
	});

	test('asks for a retry while the calling pane is not in this window ledger yet', async () => {
		const harness = createHarness(store, { instanceForToken: () => undefined, activeStateKey: 'repo-a' });

		const result = await harness.preview('/repos/a/report.html');

		assert.deepStrictEqual([result, harness.opened], [{ ok: false, reason: 'paneUnresolved' }, []]);
	});

	test('asks for a retry while the space of the calling pane is undetermined', async () => {
		const harness = createHarness(store, { resolvedScope: { kind: 'pending' }, activeStateKey: 'repo-a' });

		const result = await harness.preview('/repos/a/report.html');

		assert.deepStrictEqual([result, harness.opened], [{ ok: false, reason: 'paneUnresolved' }, []]);
	});

	test('queues the file instead of opening it in the space the user is looking at', async () => {
		const harness = createHarness(store, { recordedStateKey: 'repo-a', activeStateKey: 'repo-b' });

		const result = await harness.preview('/repos/a/report.html');

		assert.deepStrictEqual([result, harness.opened], [{ ok: true, deferred: true, spaceName: 'Design System' }, []]);
	});

	test('refuses to queue for a space the user can no longer reach', async () => {
		// 実体を失った worktree のスペース（切り替え先の一覧に載らない）に属するペイン
		const harness = createHarness(store, { recordedStateKey: 'worktree:file:///repos/a/gone', activeStateKey: 'repo-a' });

		const result = await harness.preview('/repos/a/report.html');

		assert.deepStrictEqual([result, harness.opened], [{ ok: false, reason: 'unreachableSpace' }, []]);
	});

	test('queues for a worktree space that still exists', async () => {
		const uri = URI.file('/repos/a/wt');
		const harness = createHarness(store, {
			recordedStateKey: `worktree:${uri.toString()}`,
			activeStateKey: 'repo-a',
			worktrees: [{ repositoryId: 'repo-a', name: 'feature', uri }],
		});

		const result = await harness.preview('/repos/a/wt/report.html');

		// allow-any-unicode-next-line
		assert.deepStrictEqual([result, harness.opened], [{ ok: true, deferred: true, spaceName: 'Design System ✦ feature' }, []]);
	});

	test('opens queued files once the user switches back to that space', async () => {
		const harness = createHarness(store, { recordedStateKey: 'repo-a', activeStateKey: 'repo-b' });
		await harness.preview('/repos/a/first.html');
		await harness.preview('/repos/a/second.md');
		// 同じファイルの再予約は重複させず、最後に見せたかった順序へ寄せる
		await harness.preview('/repos/a/first.html');

		harness.switchTo('repo-a');
		await settle();

		assert.deepStrictEqual(harness.opened, [
			{ resource: '/repos/a/second.md', group: 'main' },
			{ resource: '/repos/a/first.html', group: 'main' },
		]);
	});

	test('keeps only the last files when a space is queued past its limit', async () => {
		const harness = createHarness(store, { recordedStateKey: 'repo-a', activeStateKey: 'repo-b' });
		for (let index = 0; index < 10; index++) {
			await harness.preview(`/repos/a/report-${index}.html`);
		}

		harness.switchTo('repo-a');
		await settle();

		assert.deepStrictEqual(
			harness.opened.map(editor => editor.resource),
			[2, 3, 4, 5, 6, 7, 8, 9].map(index => `/repos/a/report-${index}.html`),
		);
	});

	test('reuses the group of that space that already has the file open', async () => {
		const harness = createHarness(store, {
			recordedStateKey: 'repo-a',
			activeStateKey: 'repo-a',
			openedFiles: { '/repos/a/report.html': 'main-split' },
		});

		await harness.preview('/repos/a/report.html');

		assert.deepStrictEqual(harness.opened, [{ resource: '/repos/a/report.html', group: 'main-split' }]);
	});

	test('ignores a group of another space that already has the file open', async () => {
		const harness = createHarness(store, {
			recordedStateKey: 'repo-a',
			activeStateKey: 'repo-a',
			// 別スペースにピン留めされた補助ウィンドウで同じファイルが開かれている
			openedFiles: { '/repos/a/report.html': 'auxiliary' },
		});

		await harness.preview('/repos/a/report.html');

		assert.deepStrictEqual(harness.opened, [{ resource: '/repos/a/report.html', group: 'main' }]);
	});

	test('matches each queued file against its own group', async () => {
		const harness = createHarness(store, {
			recordedStateKey: 'repo-a',
			activeStateKey: 'repo-b',
			openedFiles: { '/repos/a/second.md': 'main-split' },
		});
		await harness.preview('/repos/a/first.html');
		await harness.preview('/repos/a/second.md');

		harness.switchTo('repo-a');
		await settle();

		assert.deepStrictEqual(harness.opened, [
			{ resource: '/repos/a/first.html', group: 'main' },
			{ resource: '/repos/a/second.md', group: 'main-split' },
		]);
	});

	test('prefers the most recently used group of that space', async () => {
		const harness = createHarness(store, {
			recordedStateKey: 'repo-a',
			activeStateKey: 'repo-a',
			groupOrder: ['main-split', 'main', 'auxiliary'],
		});

		await harness.preview('/repos/a/report.html');

		assert.deepStrictEqual(harness.opened, [{ resource: '/repos/a/report.html', group: 'main-split' }]);
	});

	test('opens into an auxiliary window that is pinned to the calling pane space', async () => {
		const harness = createHarness(store, {
			recordedStateKey: 'repo-a',
			activeStateKey: 'repo-b',
			pinnedPartStateKey: 'repo-a',
		});

		const result = await harness.preview('/repos/a/report.html');

		assert.deepStrictEqual([result, harness.opened], [{ ok: true }, [{ resource: '/repos/a/report.html', group: 'auxiliary' }]]);
	});

	test('refuses to open while a space switch is in flight', async () => {
		const harness = createHarness(store, { recordedStateKey: 'repo-a', activeStateKey: 'repo-a', isSwitching: true });

		const result = await harness.preview('/repos/a/report.html');

		assert.deepStrictEqual([result, harness.opened], [{ ok: false, reason: 'switching' }, []]);
	});

	test('drops queued files for a space that is retired but keeps the others', async () => {
		const retired = createHarness(store, { recordedStateKey: 'repo-a', activeStateKey: 'repo-b' });
		await retired.preview('/repos/a/retired.html');
		// 同じ待ち合わせで「retire していなければ開く」ことも確かめ、flush が遅れただけで
		// 通ってしまう偽陽性を防ぐ
		const kept = createHarness(store, { recordedStateKey: 'repo-a', activeStateKey: 'repo-b' });
		await kept.preview('/repos/a/kept.html');

		retired.onDidRetireScope.fire('repo-a');
		retired.switchTo('repo-a');
		kept.switchTo('repo-a');
		await settle();

		assert.deepStrictEqual([retired.opened, kept.opened], [[], [{ resource: '/repos/a/kept.html', group: 'main' }]]);
	});
});
