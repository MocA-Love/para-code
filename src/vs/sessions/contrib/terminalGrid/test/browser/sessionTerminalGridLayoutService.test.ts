/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ISerializedGrid, ISerializedNode, Orientation } from '../../../../../base/browser/ui/grid/grid.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import type { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ISessionTerminalGridLayoutEntry, ISessionTerminalGridTerminalGeneration, SessionTerminalGridIdentity } from '../../browser/sessionTerminalGridLayout.js';
import { ISessionTerminalGridLayoutSource, SessionTerminalGridLayoutService } from '../../browser/sessionTerminalGridLayoutService.js';

const STORAGE_KEY = 'paradis.terminalGrid.layouts.v2';

/**
 * 数値 ID 時代のキー。**書き込みは v2 キーへ移した**ので、旧ビルドが v2 のエントリを読んで
 * 弾き、次の保存で丸ごと落としてしまう事故が起きない（旧キーは旧ビルドのために据え置く）。
 */
const LEGACY_STORAGE_KEY = 'paradis.terminalGrid.layouts';

function leaf(terminal: SessionTerminalGridIdentity, size = 100): ISerializedNode {
	return { type: 'leaf', data: { terminal }, size };
}

function layoutOf(...terminals: SessionTerminalGridIdentity[]): ISerializedGrid {
	return { root: { type: 'branch', data: terminals.map(terminal => leaf(terminal)), size: 200 }, orientation: Orientation.VERTICAL, width: 800, height: 400 };
}

function entryOf(...terminals: number[]): ISessionTerminalGridLayoutEntry {
	return { terminals, layout: layoutOf(...terminals) };
}

/** nonce ベース (v2) のエントリ。葉も nonce でないと検証を通らない。 */
function v2EntryOf(...terminals: string[]): ISessionTerminalGridLayoutEntry {
	return { version: 2, terminals, layout: layoutOf(...terminals) };
}

class TestLayoutSource implements ISessionTerminalGridLayoutSource {
	constructor(
		private readonly _entry: ISessionTerminalGridLayoutEntry | undefined,
		private readonly _generations: readonly ISessionTerminalGridTerminalGeneration[] = [],
		private readonly _nonces: readonly string[] = [],
	) { }

	getGridLayoutEntry(): ISessionTerminalGridLayoutEntry | undefined {
		return this._entry;
	}

	getGridLayoutTerminalGenerations(): readonly ISessionTerminalGridTerminalGeneration[] {
		return this._generations;
	}

	getGridLayoutTerminalNonces(): readonly string[] {
		return this._nonces;
	}
}

function createService(disposables: Pick<DisposableStore, 'add'>, stored?: readonly ISessionTerminalGridLayoutEntry[]): { service: SessionTerminalGridLayoutService; storageService: IStorageService } {
	const storageService = disposables.add(new TestStorageService());
	if (stored) {
		storageService.store(STORAGE_KEY, JSON.stringify(stored), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
	const lifecycleService = { onWillShutdown: Event.None } as ILifecycleService;
	const service = disposables.add(new SessionTerminalGridLayoutService(storageService, lifecycleService));
	return { service, storageService };
}

function readStored(storageService: IStorageService): ISessionTerminalGridLayoutEntry[] {
	return JSON.parse(storageService.get(STORAGE_KEY, StorageScope.WORKSPACE) ?? '[]');
}

suite('SessionTerminalGridLayoutService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('a group claims only the entry that covers all of its panes, once', () => {
		const { service } = createService(disposables, [entryOf(1, 2), entryOf(3, 4, 5)]);

		const claims = [
			// Covered by the second entry even though one of its panes did not come back.
			service.takeRestoredLayout(new Set([3, 4])),
			// Already consumed by the claim above.
			service.takeRestoredLayout(new Set([3, 4])),
			// A pane outside every stored entry: no group may inherit a layout it is not part of.
			service.takeRestoredLayout(new Set([1, 9])),
			service.takeRestoredLayout(new Set([1, 2])),
		];

		assert.deepStrictEqual(claims.map(claim => claim && claim.root), [
			{ type: 'branch', data: [leaf(3), leaf(4)], size: 200 },
			undefined,
			undefined,
			{ type: 'branch', data: [leaf(1), leaf(2)], size: 200 },
		]);
	});

	test('saving keeps unclaimed entries and rewrites them to this session ids', () => {
		// Space A came back as 31/32 (revived from 1/2) and rearranged itself; space B is restored but
		// never visited, so nothing claims its entry and it only reports its new ids.
		const { service, storageService } = createService(disposables, [entryOf(1, 2), entryOf(3, 4)]);
		disposables.add(service.registerSource(new TestLayoutSource(entryOf(31, 32), [{ restored: 1, current: 31 }, { restored: 2, current: 32 }])));
		disposables.add(service.registerSource(new TestLayoutSource(undefined, [{ restored: 3, current: 33 }, { restored: 4, current: 34 }])));
		service.takeRestoredLayout(new Set([1, 2]));

		service.flush();

		assert.deepStrictEqual(readStored(storageService), [entryOf(31, 32), entryOf(33, 34)]);
	});

	test('saving keeps what another window added while this one was running', () => {
		const { service, storageService } = createService(disposables, [entryOf(1, 2)]);
		disposables.add(service.registerSource(new TestLayoutSource(entryOf(1, 2))));
		service.takeRestoredLayout(new Set([1, 2]));
		storageService.store(STORAGE_KEY, JSON.stringify([entryOf(1, 2), entryOf(7, 8)]), StorageScope.WORKSPACE, StorageTarget.MACHINE);

		service.flush();

		assert.deepStrictEqual(readStored(storageService), [entryOf(1, 2), entryOf(7, 8)]);
	});

	test('saving does not roll back another window update to an entry it cannot account for', () => {
		// 7/8 was already in storage at startup but belongs to another window, so this one has no live
		// terminal to explain it and must leave whatever is stored for it alone.
		const { service, storageService } = createService(disposables, [entryOf(1, 2), entryOf(7, 8)]);
		disposables.add(service.registerSource(new TestLayoutSource(entryOf(1, 2))));
		service.takeRestoredLayout(new Set([1, 2]));
		const rearranged = { terminals: [7, 8], layout: layoutOf(8, 7) };
		storageService.store(STORAGE_KEY, JSON.stringify([entryOf(1, 2), rearranged]), StorageScope.WORKSPACE, StorageTarget.MACHINE);

		service.flush();

		assert.deepStrictEqual(readStored(storageService), [entryOf(1, 2), rearranged]);
	});

	// パネルを1枚閉じてレイアウトを名乗らなくなったグループの v2 エントリが、
	// 「別ウィンドウのもの」として永久に居座らないこと。放置すると死んだエントリが
	// 保存枠を埋め、まだ訪れていないスペースの正当なレイアウトを押し出す。
	test('drops the stored entry of a group that no longer describes a layout', () => {
		const { service, storageService } = createService(disposables, [v2EntryOf('nonce-a', 'nonce-b')]);
		// レイアウトは名乗らない（ペインが1枚になった）が、残ったペインの身元は名乗る。
		disposables.add(service.registerSource(new TestLayoutSource(undefined, [], ['nonce-a'])));

		service.flush();

		assert.deepStrictEqual(readStored(storageService), []);
	});

	test('keeps the stored entry of a group that belongs to another window', () => {
		const foreign = v2EntryOf('nonce-x', 'nonce-y');
		const { service, storageService } = createService(disposables, [foreign]);
		disposables.add(service.registerSource(new TestLayoutSource(undefined, [], ['nonce-a'])));

		service.flush();

		assert.deepStrictEqual(readStored(storageService), [foreign]);
	});

	test('picks up the pre-v2 layout once and then leaves the old key to older builds', () => {
		const storageService = disposables.add(new TestStorageService());
		const legacy = [entryOf(1, 2)];
		storageService.store(LEGACY_STORAGE_KEY, JSON.stringify(legacy), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const lifecycleService = { onWillShutdown: Event.None } as ILifecycleService;
		const service = disposables.add(new SessionTerminalGridLayoutService(storageService, lifecycleService));
		disposables.add(service.registerSource(new TestLayoutSource(entryOf(31, 32), [{ restored: 1, current: 31 }, { restored: 2, current: 32 }])));

		// 旧キーのレイアウトはそのまま引き継げる（アップグレードで並びが消えない）。
		assert.notStrictEqual(service.takeRestoredLayout(new Set([1, 2])), undefined);

		service.flush();

		assert.deepStrictEqual({
			v2: JSON.parse(storageService.get(STORAGE_KEY, StorageScope.WORKSPACE) ?? '[]'),
			// **旧キーは書き換えない。** 旧ビルドは数値 ID しか読めないので、v2 を旧キーへ書くと
			// 旧ビルドが弾いて次の保存で丸ごと落とす。据え置けば互いのデータを壊さない。
			legacyUntouched: JSON.parse(storageService.get(LEGACY_STORAGE_KEY, StorageScope.WORKSPACE) ?? '[]'),
		}, { v2: [entryOf(31, 32)], legacyUntouched: legacy });
	});
});
