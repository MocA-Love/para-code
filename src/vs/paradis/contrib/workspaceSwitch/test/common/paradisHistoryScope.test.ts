/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IWorkspaceFolder, IWorkspaceFoldersChangeEvent } from '../../../../../platform/workspace/common/workspace.js';
import { paradisHistorySpacesKey, paradisHistoryStorageKey, paradisHistorySwitchPlan, paradisMigratedHistoryEntries, paradisTrackHistorySpaces } from '../../common/paradisHistoryScope.js';

suite('paradisHistoryScope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const BASE_KEY = 'history.entries';

	test('derives a per-space key only while a single folder is open', () => {
		const backend = folder('/develop/paradis/sample-app/backend');
		const worktree = folder('/develop/paradis/sample-app-worktrees/feature-branch/backend');
		const backendKey = paradisHistoryStorageKey(BASE_KEY, [backend]);

		assert.deepStrictEqual({
			// キーの形は固定する。変わると全ユーザーの履歴が無言で孤児になる
			shape: /^history\.entries\.[0-9a-f]{1,8}$/.test(backendKey),
			stable: paradisHistoryStorageKey(BASE_KEY, [folder('/develop/paradis/sample-app/backend')]) === backendKey,
			// 大文字小文字と末尾スラッシュの違いで別バケットにしない
			normalized: paradisHistoryStorageKey(BASE_KEY, [folder('/develop/paradis/Sample-App/backend/')]) === backendKey,
			perSpace: paradisHistoryStorageKey(BASE_KEY, [worktree]) !== backendKey,
			noFolder: paradisHistoryStorageKey(BASE_KEY, []),
			multiRoot: paradisHistoryStorageKey(BASE_KEY, [backend, worktree]),
			spacesKey: paradisHistorySpacesKey(BASE_KEY),
		}, {
			shape: true,
			stable: true,
			normalized: true,
			perSpace: true,
			noFolder: BASE_KEY,
			multiRoot: BASE_KEY,
			spacesKey: 'history.entries.spaces',
		});
	});

	test('drops editors that leaked in from the next space, and keeps everything else', () => {
		const previous = folder('/develop/paradis/sample-app/backend');
		const next = folder('/develop/paradis/sample-app-worktrees/feature-branch/backend');
		const plan = paradisHistorySwitchPlan(event([previous], [next]), [next]);

		assert.deepStrictEqual({
			// 切り替え中に開かれた切り替え先のファイルは、切り替え元の履歴へ書き戻さない
			leakedFromNextSpace: plan?.isForeign(URI.file('/develop/paradis/sample-app-worktrees/feature-branch/backend/.env')),
			// 切り替え元自身のファイルと、どちらにも属さないファイルは残す
			ownFile: plan?.isForeign(URI.file('/develop/paradis/sample-app/backend/.env')),
			outsideBothSpaces: plan?.isForeign(URI.file('/Downloads/notes.md')),
		}, {
			leakedFromNextSpace: true,
			ownFile: false,
			outsideBothSpaces: false,
		});
	});

	test('keeps nested spaces from evicting each other', () => {
		// 親ディレクトリと、その配下のディレクトリを別々のスペースとして開いている場合。
		// 切り替え先が親でも、切り替え元 (配下) のファイルは切り替え元の履歴に残す
		const previous = folder('/develop/paradis/sample-app/backend');
		const next = folder('/develop/paradis/sample-app');
		const plan = paradisHistorySwitchPlan(event([previous], [next]), [next]);

		assert.strictEqual(plan?.isForeign(URI.file('/develop/paradis/sample-app/backend/.env')), false);
	});

	test('has nothing to strip when the transition is not a single-folder swap', () => {
		// これらの遷移でも保存先キーは変わり得るが、取り除くべき「紛れ込み」は判定できない。
		// 履歴の切り替え自体は呼び出し側がキーの変化で判断する
		const backend = folder('/develop/paradis/sample-app/backend');
		const other = folder('/develop/paradis/other');

		assert.deepStrictEqual({
			folderAddedOnly: paradisHistorySwitchPlan(event([], [other]), [backend, other]),
			becameMultiRoot: paradisHistorySwitchPlan(event([backend], [other]), [backend, other]),
			leftMultiRoot: paradisHistorySwitchPlan(event([backend, other], [backend]), [backend]),
		}, {
			folderAddedOnly: undefined,
			becameMultiRoot: undefined,
			leftMultiRoot: undefined,
		});
	});

	test('migrates only the entries that belong to the space', () => {
		const backend = folder('/develop/paradis/sample-app/backend');
		const entries = [
			{ resource: URI.file('/develop/paradis/sample-app/backend/.env') },
			{ resource: URI.file('/develop/paradis/sample-app-worktrees/feature-branch/backend/.env') },
			{ resource: URI.file('/Downloads/notes.md') },
		];

		assert.deepStrictEqual(
			paradisMigratedHistoryEntries(entries, [backend]).map(entry => entry.resource.path),
			['/develop/paradis/sample-app/backend/.env']
		);
	});

	test('tracks spaces most-recently-used and evicts the oldest beyond the limit', () => {
		const first = paradisTrackHistorySpaces([], 'a', 3);
		const second = paradisTrackHistorySpaces(first.keys, 'b', 3);
		const third = paradisTrackHistorySpaces(second.keys, 'c', 3);
		const revisited = paradisTrackHistorySpaces(third.keys, 'a', 3);
		const overflowing = paradisTrackHistorySpaces(revisited.keys, 'd', 3);

		assert.deepStrictEqual({
			afterThree: third.keys,
			revisitedMovesToFront: revisited.keys,
			revisitedEvictsNothing: revisited.evicted,
			overflowingKeys: overflowing.keys,
			overflowingEvicted: overflowing.evicted,
		}, {
			afterThree: ['c', 'b', 'a'],
			revisitedMovesToFront: ['a', 'c', 'b'],
			revisitedEvictsNothing: [],
			overflowingKeys: ['d', 'a', 'c'],
			overflowingEvicted: ['b'],
		});
	});

	function folder(path: string): IWorkspaceFolder {
		const uri = URI.file(path);

		return {
			uri,
			name: path.split('/').pop() ?? path,
			index: 0,
			toResource: relativePath => URI.file(`${path}/${relativePath}`)
		};
	}

	function event(removed: IWorkspaceFolder[], added: IWorkspaceFolder[]): IWorkspaceFoldersChangeEvent {
		return { added, removed, changed: [] };
	}
});
