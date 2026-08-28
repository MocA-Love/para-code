/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { BrowserViewStorageScope, IBrowserSessionOptions } from '../../../../../platform/browserView/common/browserView.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { paradisResolveBrowserSessionOptions } from '../../common/paradisBrowserProfileRouting.js';
import { ParadisBrowserProfilesService } from '../../electron-browser/paradisBrowserProfilesService.js';

const PROFILES_STORAGE_KEY = 'paradis.browser.profiles';
const PROFILE_VIEWS_STORAGE_KEY = 'paradis.browser.profileViews';

const FALLBACK: IBrowserSessionOptions = { scope: BrowserViewStorageScope.Global };

suite('ParadisBrowserProfilesService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(options?: { readonly trusted?: boolean }) {
		const storage = store.add(new InMemoryStorageService());
		const cleared: string[] = [];
		const openedViewIds: string[] = [];
		const disposedViewIds: string[] = [];

		const mainProcessService = {
			getChannel: () => ({
				call: async (command: string, arg?: unknown) => {
					if (command === 'clearProfileData') {
						cleared.push(String((arg as unknown[])?.[0]));
						return undefined;
					}
					if (command === 'getProfileStats') {
						return { cookieCount: 0, openViewCount: 0 };
					}
					// resolveViewSession: main はこのビューを知らない、という素直な答え。
					return undefined;
				},
				listen: () => Event.None,
			}),
		} as unknown as IMainProcessService;

		const known = new Map<string, BrowserEditorInput>();
		const browserViewWorkbenchService = {
			onDidChangeBrowserViews: Event.None,
			getKnownBrowserViews: () => known,
			getOrCreateLazy: (id: string) => {
				openedViewIds.push(id);
				const input = {
					onWillDispose: Event.None,
					serialize: () => ({ id }),
					dispose: () => {
						disposedViewIds.push(id);
						known.delete(id);
					},
				} as unknown as BrowserEditorInput;
				known.set(id, input);
				return input;
			},
		} as unknown as IBrowserViewWorkbenchService;

		const editorService = { openEditor: async () => undefined } as unknown as IEditorService;
		const editorGroupsService = { groups: [] } as unknown as IEditorGroupsService;
		const lifecycleService = { willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService;
		const workspaceContextService = { getWorkbenchState: () => WorkbenchState.FOLDER } as unknown as IWorkspaceContextService;
		const workspaceTrustManagementService = {
			isWorkspaceTrusted: () => options?.trusted !== false,
		} as unknown as IWorkspaceTrustManagementService;

		const service = store.add(new ParadisBrowserProfilesService(
			storage,
			mainProcessService,
			browserViewWorkbenchService,
			editorService,
			editorGroupsService,
			lifecycleService,
			workspaceContextService,
			workspaceTrustManagementService,
			new NullLogService(),
		));
		return { service, storage, cleared, openedViewIds, disposedViewIds };
	}

	test('creating, renaming and re-colouring a profile keeps one persisted ledger', () => {
		const { service, storage } = createService();

		const created = service.create('  TEST  ', '#3fb950');
		assert.ok(created.ok);
		assert.strictEqual(created.profile.name, 'TEST');

		assert.ok(service.rename(created.profile.id, 'PRD').ok);
		service.setColor(created.profile.id, '#a371f7');

		const persisted = JSON.parse(storage.get(PROFILES_STORAGE_KEY, StorageScope.APPLICATION)!);
		assert.deepStrictEqual(
			persisted.map((entry: { id: string; name: string; color: string }) => ({ id: entry.id, name: entry.name, color: entry.color })),
			[{ id: created.profile.id, name: 'PRD', color: '#a371f7' }],
		);
		// リネームでIDは変わらない = パーティションも変わらない = ログイン状態が残る。
		assert.strictEqual(service.list()[0].id, created.profile.id);
	});

	test('empty and duplicate names are rejected with a reason instead of creating a profile', () => {
		const { service } = createService();
		service.create('TEST', '#3fb950');

		assert.deepStrictEqual(
			[service.create('   ', '#3fb950').ok, service.create('test', '#3fb950').ok, service.list().length],
			[false, false, 1],
		);
	});

	test('opening in a profile reserves the new view so the router hands it the profile session', async () => {
		const { service, openedViewIds } = createService();
		const created = service.create('TEST', '#3fb950');
		assert.ok(created.ok);

		await service.openInProfile(created.profile.id, 'https://example.com/');
		assert.strictEqual(openedViewIds.length, 1);

		// 実際に upstream が通る経路（モジュールレベルのレジストリ）で確かめる。
		assert.deepStrictEqual(
			paradisResolveBrowserSessionOptions(openedViewIds[0], FALLBACK),
			{ scope: BrowserViewStorageScope.Profile, profileId: created.profile.id },
		);
		// 別のビューIDには一切影響しない（既定のまま）。
		assert.strictEqual(paradisResolveBrowserSessionOptions('some-other-view', FALLBACK), FALLBACK);
	});

	test('removing a profile drops its view mappings and clears its stored data in main', async () => {
		const { service, storage, cleared, openedViewIds } = createService();
		const created = service.create('TEST', '#3fb950');
		assert.ok(created.ok);
		await service.openInProfile(created.profile.id);
		const viewId = openedViewIds[0];

		await service.remove(created.profile.id);

		assert.deepStrictEqual(
			{
				profiles: service.list().length,
				views: JSON.parse(storage.get(PROFILE_VIEWS_STORAGE_KEY, StorageScope.WORKSPACE)!),
				cleared,
				// 台帳から消えた以上、そのビューは既定のセッションへ戻る（消したプロファイルの
				// パーティションを作り直さない）。
				routed: paradisResolveBrowserSessionOptions(viewId, FALLBACK),
			},
			{ profiles: 0, views: {}, cleared: [created.profile.id], routed: FALLBACK },
		);
	});

	test('a profile written by another window is picked up instead of being overwritten', () => {
		const { service, storage } = createService();
		const mine = service.create('MINE', '#3fb950');
		assert.ok(mine.ok);

		// 別ウィンドウが同じ APPLICATION キーを書いた、という外部変更を再現する。
		const theirs = [
			...JSON.parse(storage.get(PROFILES_STORAGE_KEY, StorageScope.APPLICATION)!),
			{ id: 'b1c2d3e4f506', name: 'THEIRS', color: '#4daafc', createdAt: 5, lastUsedAt: 5 },
		];
		storage.store(PROFILES_STORAGE_KEY, JSON.stringify(theirs), StorageScope.APPLICATION, StorageTarget.MACHINE, true /* external */);

		// 読み直していないと、この touch() が古い配列で丸ごと上書きして THEIRS を消す。
		service.touch(mine.profile.id);

		assert.deepStrictEqual(
			JSON.parse(storage.get(PROFILES_STORAGE_KEY, StorageScope.APPLICATION)!)
				.map((entry: { name: string }) => entry.name)
				.sort(),
			['MINE', 'THEIRS'],
		);
	});

	test('a profile added by another window survives even if its change event has not arrived yet', () => {
		const { service, storage } = createService();
		const mine = service.create('MINE', '#3fb950');
		assert.ok(mine.ok);

		// 通知が届く前に他ウィンドウが書いた状態（external を立てない = 購読は反応しない）。
		// 保存直前の読み直しが無いと、この後の touch() が丸ごと後勝ちで THEIRS を消す。
		const theirs = [
			...JSON.parse(storage.get(PROFILES_STORAGE_KEY, StorageScope.APPLICATION)!),
			{ id: 'b1c2d3e4f506', name: 'THEIRS', color: '#4daafc', createdAt: 5, lastUsedAt: 5 },
		];
		storage.store(PROFILES_STORAGE_KEY, JSON.stringify(theirs), StorageScope.APPLICATION, StorageTarget.MACHINE);

		service.touch(mine.profile.id);

		assert.deepStrictEqual(
			JSON.parse(storage.get(PROFILES_STORAGE_KEY, StorageScope.APPLICATION)!)
				.map((entry: { name: string }) => entry.name)
				.sort(),
			['MINE', 'THEIRS'],
		);
	});

	test('deleting a profile first closes the tabs still using it', async () => {
		const { service, disposedViewIds, openedViewIds } = createService();
		const created = service.create('TEST', '#3fb950');
		assert.ok(created.ok);
		await service.openInProfile(created.profile.id);

		await service.remove(created.profile.id);

		// 開いたままだと、消した直後に生きたページが同じパーティションへ書き戻し、
		// 台帳にもう無いので二度と消せない孤児になる。
		assert.deepStrictEqual(disposedViewIds, [openedViewIds[0]]);
	});

	test('an untrusted workspace never gets a persistent profile session', async () => {
		const { service, openedViewIds } = createService({ trusted: false });
		// 台帳へは直接作れる（信頼を得たあとに使える）が、開くことは拒否される。
		const created = service.create('TEST', '#3fb950');
		assert.ok(created.ok);

		assert.strictEqual(service.canUseProfiles(), false);
		assert.strictEqual(await service.openInProfile(created.profile.id), undefined);
		assert.strictEqual(openedViewIds.length, 0);
	});

	test('a persisted view mapping is restored, so a profile tab reopens in the same profile', () => {
		// 先に台帳を書いた状態から起動し直す（アプリ再起動後の復元経路）。
		const first = createService();
		const created = first.service.create('TEST', '#3fb950');
		assert.ok(created.ok);

		const profilesJson = first.storage.get(PROFILES_STORAGE_KEY, StorageScope.APPLICATION)!;
		const restoredStorage = store.add(new InMemoryStorageService());
		restoredStorage.store(PROFILES_STORAGE_KEY, profilesJson, StorageScope.APPLICATION, StorageTarget.MACHINE);
		restoredStorage.store(
			PROFILE_VIEWS_STORAGE_KEY,
			JSON.stringify({ 'restored-view': { scope: 'profile', profileId: created.profile.id }, 'broken-view': { scope: 'nope' } }),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);

		const emitter = store.add(new Emitter<void>());
		const service = store.add(new ParadisBrowserProfilesService(
			restoredStorage,
			{ getChannel: () => ({ call: async () => undefined, listen: () => Event.None }) } as unknown as IMainProcessService,
			{
				onDidChangeBrowserViews: emitter.event,
				getKnownBrowserViews: () => new Map<string, BrowserEditorInput>(),
			} as unknown as IBrowserViewWorkbenchService,
			{ openEditor: async () => undefined } as unknown as IEditorService,
			{ groups: [] } as unknown as IEditorGroupsService,
			{ willShutdown: false, onWillShutdown: Event.None } as unknown as ILifecycleService,
			{ getWorkbenchState: () => WorkbenchState.FOLDER } as unknown as IWorkspaceContextService,
			{ isWorkspaceTrusted: () => true } as unknown as IWorkspaceTrustManagementService,
			new NullLogService(),
		));

		assert.deepStrictEqual(
			[
				paradisResolveBrowserSessionOptions('restored-view', FALLBACK),
				// 壊れた1件は捨てられ、既定へ落ちるだけ（他の行は生きている）。
				paradisResolveBrowserSessionOptions('broken-view', FALLBACK),
			],
			[{ scope: BrowserViewStorageScope.Profile, profileId: created.profile.id }, FALLBACK],
		);
		assert.strictEqual(service.list().length, 1);
	});
});
