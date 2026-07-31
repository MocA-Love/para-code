/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains a PARA-CODE comment)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { errorHandler, setUnexpectedErrorHandler } from '../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCreateDeserializedTerminalEditorInput } from './paradisTerminalEditorInputFixture.js';
import { paradisClearTerminalReviveIndex, paradisRefreshTerminalReviveIndex, paradisRegisterTerminalReviveIndexSource, paradisResolveRevivedTerminalEditorInput } from '../../browser/paradisTerminalEditorRevive.js';

suite('paradisTerminalEditorRevive', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * 索引の供給元が投げるケースは、production では `onUnexpectedError` で可視化する設計。
	 * テストランナーはそれを失敗として扱うため、その区間だけハンドラを差し替える。
	 */
	function collectUnexpectedErrors(): DisposableStore {
		const disposables = store.add(new DisposableStore());
		const original = errorHandler.getUnexpectedErrorHandler();
		setUnexpectedErrorHandler(() => null);
		disposables.add({ dispose: () => setUnexpectedErrorHandler(original) });
		return disposables;
	}

	function register(orphans: ReadonlyMap<string, number>, held: ReadonlySet<number>): DisposableStore {
		const disposables = store.add(new DisposableStore());
		disposables.add(paradisRegisterTerminalReviveIndexSource({
			listOrphanPtyIdsByNonce: async () => orphans,
			listHeldPtyIds: () => held,
		}));
		disposables.add({ dispose: () => paradisClearTerminalReviveIndex() });
		return disposables;
	}

	test('rewrites the stale id to the current one when the nonce identifies an orphan pty', async () => {
		register(new Map([['nonce-a', 77]]), new Set());
		await paradisRefreshTerminalReviveIndex('worktree:target');

		// 保存された id は前世代の 12 だが、nonce で今世代の 77 と同定できる。
		assert.deepStrictEqual(
			paradisResolveRevivedTerminalEditorInput(paradisCreateDeserializedTerminalEditorInput(12, 'nonce-a')),
			{ id: 77, pid: 0, shellIntegrationNonce: 'nonce-a', findRevivedId: false });
	});

	test('refuses to attach to a pty id this window already holds when the nonce proves nothing', async () => {
		// 実機で起きた形: park 中の別スペースの端末が id 37 を握っている状態で、
		// 別スペースの古いスナップショットが同じ 37 を要求してくる。
		register(new Map(), new Set([37]));
		await paradisRefreshTerminalReviveIndex('worktree:target');

		const resolved = paradisResolveRevivedTerminalEditorInput(paradisCreateDeserializedTerminalEditorInput(37, 'nonce-stale'));

		assert.strictEqual(resolved.findRevivedId, false);
		assert.notStrictEqual(resolved.id, 37);
	});

	test('falls back to the upstream revived-id lookup for an id nobody holds', async () => {
		register(new Map(), new Set([37]));
		await paradisRefreshTerminalReviveIndex('worktree:target');

		assert.deepStrictEqual(
			paradisResolveRevivedTerminalEditorInput(paradisCreateDeserializedTerminalEditorInput(41, 'nonce-unknown')),
			{ id: 41, pid: 0, shellIntegrationNonce: 'nonce-unknown', findRevivedId: true });
	});

	test('an unusable nonce still gets the held-id guard', async () => {
		register(new Map([['', 99]]), new Set([37]));
		await paradisRefreshTerminalReviveIndex('worktree:target');

		// 空 nonce は同一性の証拠にならないので 99 へは繋がず、掴まれている 37 も避ける。
		const resolved = paradisResolveRevivedTerminalEditorInput(paradisCreateDeserializedTerminalEditorInput(37, ''));

		assert.strictEqual(resolved.findRevivedId, false);
		assert.notStrictEqual(resolved.id, 37);
		assert.notStrictEqual(resolved.id, 99);
	});

	test('hands out an orphan id only once per refresh, so two inputs cannot attach to the same pty', async () => {
		register(new Map([['nonce-a', 77]]), new Set());
		await paradisRefreshTerminalReviveIndex('worktree:target');

		assert.strictEqual(paradisResolveRevivedTerminalEditorInput(paradisCreateDeserializedTerminalEditorInput(12, 'nonce-a')).id, 77);
		// 2度目は索引から消えている。同じ id を払い出すと、この修正が防ぎたい二重アタッチになる。
		const second = paradisResolveRevivedTerminalEditorInput(paradisCreateDeserializedTerminalEditorInput(12, 'nonce-a'));
		assert.notStrictEqual(second.id, 77);
	});

	test('does not hand out an orphan id that is already held', async () => {
		// スナップショット取得後に誰かが掴んだケース。索引を信じ切らず直前に確かめる。
		register(new Map([['nonce-a', 77]]), new Set([77]));
		await paradisRefreshTerminalReviveIndex('worktree:target');

		assert.notStrictEqual(paradisResolveRevivedTerminalEditorInput(paradisCreateDeserializedTerminalEditorInput(12, 'nonce-a')).id, 77);
	});

	test('a cleared index stops resolving, so paths that never refreshed stay on the safe side', async () => {
		register(new Map([['nonce-a', 77]]), new Set());
		await paradisRefreshTerminalReviveIndex('worktree:target');
		paradisClearTerminalReviveIndex();

		assert.deepStrictEqual(
			paradisResolveRevivedTerminalEditorInput(paradisCreateDeserializedTerminalEditorInput(12, 'nonce-a')),
			{ id: 12, pid: 0, shellIntegrationNonce: 'nonce-a', findRevivedId: true });
	});

	test('a failing held-id lookup refuses to attach instead of dropping the guard', async () => {
		collectUnexpectedErrors();
		const disposables = store.add(new DisposableStore());
		disposables.add(paradisRegisterTerminalReviveIndexSource({
			listOrphanPtyIdsByNonce: async () => new Map([['nonce-a', 77]]),
			listHeldPtyIds: () => { throw new Error('no live instances'); },
		}));
		disposables.add({ dispose: () => paradisClearTerminalReviveIndex() });
		await paradisRefreshTerminalReviveIndex('worktree:target');

		// 安全弁が最も必要な場面なので、素通し (findRevivedId: true) には倒さない。
		const resolved = paradisResolveRevivedTerminalEditorInput(paradisCreateDeserializedTerminalEditorInput(12, 'nonce-a'));
		assert.strictEqual(resolved.findRevivedId, false);
		assert.notStrictEqual(resolved.id, 77);
		assert.notStrictEqual(resolved.id, 12);
	});

	test('an unreachable pty host neither throws out of the switch nor blocks resolving', async () => {
		collectUnexpectedErrors();
		const disposables = store.add(new DisposableStore());
		disposables.add(paradisRegisterTerminalReviveIndexSource({
			listOrphanPtyIdsByNonce: async () => { throw new Error('pty host unavailable'); },
			listHeldPtyIds: () => new Set<number>(),
		}));
		disposables.add({ dispose: () => paradisClearTerminalReviveIndex() });

		// refresh が投げると切替がロールバックしてしまうので、ここは必ず解決すること。
		await paradisRefreshTerminalReviveIndex('worktree:target');

		assert.deepStrictEqual(
			paradisResolveRevivedTerminalEditorInput(paradisCreateDeserializedTerminalEditorInput(5, 'nonce-a')),
			{ id: 5, pid: 0, shellIntegrationNonce: 'nonce-a', findRevivedId: true });
	});
});
