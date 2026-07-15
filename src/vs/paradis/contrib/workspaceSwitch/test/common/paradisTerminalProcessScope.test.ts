/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains a PARA-CODE comment)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCollectRetiringTerminalInstanceIds, paradisLookupInstanceScope, paradisMergePersistentProcessScopesForStorage, paradisParseTerminalProcessScopeStorage, paradisPartitionPersistentProcessScopesByKnownScope, paradisPrunePersistentProcessScopes, paradisRecordInstanceScopes, paradisRecordPersistentProcessScopes, paradisResolveInitialCwdScope, paradisResolveTerminalScopeCandidate, paradisRestorePersistentProcessScope, paradisRetireInstanceScope, paradisRetireTerminalScope, paradisSerializeTerminalProcessScopeStorage } from '../../common/paradisTerminalProcessScope.js';

suite('paradisRecordInstanceScopes / paradisLookupInstanceScope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recovers the original scope for a terminal group recreated after the original group object was disposed', () => {
		// 元のグループが scope B にタグ付けされた時点で記録される
		const instanceScopes = new Map<number, string>();
		paradisRecordInstanceScopes(instanceScopes, [{ instanceId: 7, persistentProcessId: 42 }], 'worktree:B');

		// グループが dispose され、同じ ITerminalInstance (= 同じ instanceId) が新しい
		// グループオブジェクトに包まれて再表示された状況をシミュレートする。新しいグループは
		// _groupRepositories にエントリを持たない (未タグ) が、instanceScopes には残っている。
		const restoredMapping = new Map<number, string>();
		const resolved = paradisLookupInstanceScope(instanceScopes, restoredMapping, [{ instanceId: 7, persistentProcessId: 42 }]);

		assert.strictEqual(resolved, 'worktree:B', 'must recover the original scope instead of falling through to "untagged" (which the caller would then bind to whatever scope happens to be active right now)');
	});

	test('records the scope even when persistentProcessId is not assigned yet (terminal tagged right after creation)', () => {
		// createTerminal 直後のタグ付けでは persistentProcessId はまだ未確定。それでも
		// instanceId は同期採番済みなので、記録・復元が成立しなければならない
		const instanceScopes = new Map<number, string>();
		paradisRecordInstanceScopes(instanceScopes, [{ instanceId: 7, persistentProcessId: undefined }], 'worktree:B');

		const resolved = paradisLookupInstanceScope(instanceScopes, new Map(), [{ instanceId: 7, persistentProcessId: undefined }]);

		assert.strictEqual(resolved, 'worktree:B');
	});

	test('prefers the live (this-session) record over a stale on-disk restored mapping', () => {
		const instanceScopes = new Map<number, string>();
		const restoredMapping = new Map<number, string>([[42, 'worktree:stale-from-previous-session']]);

		paradisRecordInstanceScopes(instanceScopes, [{ instanceId: 7, persistentProcessId: 42 }], 'worktree:current');

		assert.strictEqual(paradisLookupInstanceScope(instanceScopes, restoredMapping, [{ instanceId: 7, persistentProcessId: 42 }]), 'worktree:current');
	});

	test('falls back to the restored (previous session) mapping by persistentProcessId when nothing has been tagged yet this session', () => {
		const instanceScopes = new Map<number, string>();
		const restoredMapping = new Map<number, string>([[42, 'worktree:from-disk']]);

		assert.strictEqual(paradisLookupInstanceScope(instanceScopes, restoredMapping, [{ instanceId: 7, persistentProcessId: 42 }]), 'worktree:from-disk');
	});

	test('returns undefined for an instance that was never seen (a genuinely brand new terminal)', () => {
		const instanceScopes = new Map<number, string>();
		const restoredMapping = new Map<number, string>();

		assert.strictEqual(paradisLookupInstanceScope(instanceScopes, restoredMapping, [{ instanceId: 999, persistentProcessId: 999 }]), undefined);
	});

	test('scans every instance in a multi-pane group until a match is found', () => {
		const instanceScopes = new Map<number, string>([[2, 'worktree:second-pane']]);
		const restoredMapping = new Map<number, string>();

		const resolved = paradisLookupInstanceScope(instanceScopes, restoredMapping, [
			{ instanceId: 1 },
			{ instanceId: 2 },
		]);

		assert.strictEqual(resolved, 'worktree:second-pane');
	});

	test('updates the persistentProcessId ledger when the process id becomes available and restores a replacement instance from it', () => {
		const instanceScopes = new Map<number, string>([[7, 'worktree:B']]);
		const persistentScopes = new Map<number, string>();
		paradisRecordPersistentProcessScopes(instanceScopes, persistentScopes, [{ instanceId: 7, persistentProcessId: 42 }]);

		assert.deepStrictEqual([...persistentScopes], [[42, 'worktree:B']]);
		assert.strictEqual(
			paradisLookupInstanceScope(new Map(), persistentScopes, [{ instanceId: 8, persistentProcessId: 42 }]),
			'worktree:B',
		);
	});

	test('restores an ungrouped live instance from the persistent process ledger before cwd fallback', () => {
		const instanceScopes = new Map<number, string>();
		const persistentScopes = new Map<number, string>([[42, 'worktree:B']]);

		assert.strictEqual(
			paradisRestorePersistentProcessScope(instanceScopes, persistentScopes, { instanceId: 8, persistentProcessId: 42 }),
			'worktree:B',
		);
		assert.deepStrictEqual([...instanceScopes], [[8, 'worktree:B']]);
	});

	test('prunes restored process entries that have no live terminal after reconnect', () => {
		const persistentScopes = new Map<number, string>([
			[11, 'scope:live-panel'],
			[22, 'scope:stale'],
			[33, 'scope:live-background'],
		]);

		paradisPrunePersistentProcessScopes(persistentScopes, [
			{ instanceId: 1, persistentProcessId: 11 },
			{ instanceId: 3, persistentProcessId: 33 },
		]);

		assert.deepStrictEqual([...persistentScopes], [
			[11, 'scope:live-panel'],
			[33, 'scope:live-background'],
		]);
	});

	test('resolves an untagged terminal by the longest registered repository or worktree root match of its initial cwd', () => {
		assert.strictEqual(paradisResolveInitialCwdScope('/repos/project/worktrees/topic/packages/app', [
			{ root: '/repos/project', stateKey: 'repository' },
			{ root: '/repos/project/worktrees/topic', stateKey: 'worktree:topic' },
			{ root: '/repos/project/worktrees/other', stateKey: 'worktree:other' },
		]), 'worktree:topic');
		assert.strictEqual(paradisResolveInitialCwdScope('/repos/project-other', [
			{ root: '/repos/project', stateKey: 'repository' },
		]), undefined, 'prefix-only path collisions must not count as descendants');
	});

	test('does not change ownership when the terminal later cd-s outside its initial root', () => {
		const instanceScopes = new Map<number, string>();
		paradisRecordInstanceScopes(instanceScopes, [{ instanceId: 7 }], 'worktree:topic');
		assert.strictEqual(
			paradisLookupInstanceScope(instanceScopes, new Map(), [{ instanceId: 7 }]),
			'worktree:topic',
			'ownership comes from the immutable ledger, not the current cwd',
		);
	});

	test('terminal dispose removes only that identity while scope retirement removes every ledger entry owned by the scope', () => {
		const instanceScopes = new Map<number, string>([[1, 'scope:a'], [2, 'scope:a'], [3, 'scope:b']]);
		const persistentScopes = new Map<number, string>([[11, 'scope:a'], [22, 'scope:a'], [33, 'scope:b']]);

		paradisRetireInstanceScope(instanceScopes, persistentScopes, { instanceId: 1, persistentProcessId: 11 });
		assert.deepStrictEqual([...instanceScopes], [[2, 'scope:a'], [3, 'scope:b']]);
		assert.deepStrictEqual([...persistentScopes], [[22, 'scope:a'], [33, 'scope:b']]);

		paradisRetireTerminalScope(instanceScopes, persistentScopes, 'scope:a');
		assert.deepStrictEqual([...instanceScopes], [[3, 'scope:b']]);
		assert.deepStrictEqual([...persistentScopes], [[33, 'scope:b']]);
	});

	test('renderer shutdown retires the instance identity but preserves its persistent process scope for reconnect', () => {
		const instanceScopes = new Map<number, string>([[4, 'scope:reload']]);
		const persistentScopes = new Map<number, string>([[44, 'scope:reload']]);

		paradisRetireInstanceScope(instanceScopes, persistentScopes, { instanceId: 4, persistentProcessId: 44 }, undefined, true);

		assert.deepStrictEqual([...instanceScopes], []);
		assert.deepStrictEqual([...persistentScopes], [[44, 'scope:reload']]);
	});

	test('a delayed dispose from a detached instance cannot erase the persistent mapping already reattached to a replacement instance', () => {
		const instanceScopes = new Map<number, string>([[1, 'scope:a'], [2, 'scope:a']]);
		const persistentScopes = new Map<number, string>([[11, 'scope:a']]);
		const persistentOwners = new Map<number, number>([[11, 2]]);

		paradisRetireInstanceScope(instanceScopes, persistentScopes, { instanceId: 1, persistentProcessId: 11 }, persistentOwners);

		assert.deepStrictEqual([...instanceScopes], [[2, 'scope:a']]);
		assert.deepStrictEqual([...persistentScopes], [[11, 'scope:a']]);
	});

	test('keeps active scope as a candidate until both initial cwd and the worktree snapshot are ready', () => {
		const base = {
			initialCwdResolved: false,
			worktreeSnapshotReady: false,
			activeStateKeyCandidate: 'scope:active-at-create',
		};
		assert.deepStrictEqual(paradisResolveTerminalScopeCandidate(base), { status: 'pending' });
		assert.deepStrictEqual(paradisResolveTerminalScopeCandidate({ ...base, worktreeSnapshotReady: true }), { status: 'pending' });
		assert.deepStrictEqual(paradisResolveTerminalScopeCandidate({
			...base,
			initialCwdResolved: true,
			worktreeSnapshotReady: true,
			initialCwdStateKey: 'worktree:late',
		}), { status: 'resolved', stateKey: 'worktree:late' });
		assert.deepStrictEqual(paradisResolveTerminalScopeCandidate({ ...base, explicitStateKey: 'scope:explicit' }), { status: 'resolved', stateKey: 'scope:explicit' });
		assert.deepStrictEqual(paradisResolveTerminalScopeCandidate({ ...base, persistentStateKey: 'scope:restored' }), { status: 'resolved', stateKey: 'scope:restored' });
	});

	test('falls back to the active scope captured at creation only after cwd and worktree resolution', () => {
		assert.deepStrictEqual(paradisResolveTerminalScopeCandidate({
			initialCwdResolved: true,
			worktreeSnapshotReady: true,
			activeStateKeyCandidate: 'scope:created-here',
		}), { status: 'resolved', stateKey: 'scope:created-here' });
	});

	test('rejects malformed persistent scope storage atomically and bounds its size', () => {
		assert.deepStrictEqual([...paradisParseTerminalProcessScopeStorage(JSON.stringify([
			{ persistentProcessId: 11, repositoryId: 'scope:a' },
			{ persistentProcessId: 22, repositoryId: 'worktree:b' },
		]))!], [[11, 'scope:a'], [22, 'worktree:b']]);
		assert.strictEqual(paradisParseTerminalProcessScopeStorage(JSON.stringify([
			{ persistentProcessId: 11, repositoryId: 'scope:a' },
			{ persistentProcessId: -1, repositoryId: 'scope:invalid' },
		])), undefined, 'one malformed entry rejects the complete snapshot');
		assert.strictEqual(paradisParseTerminalProcessScopeStorage(JSON.stringify([
			{ persistentProcessId: 11, repositoryId: 'scope:a' },
			{ persistentProcessId: 11, repositoryId: 'scope:duplicate' },
		])), undefined);
		assert.strictEqual(paradisParseTerminalProcessScopeStorage(JSON.stringify([
			{ persistentProcessId: Number.MAX_SAFE_INTEGER + 1, repositoryId: 'scope:unsafe-pid' },
		])), undefined);
		assert.strictEqual(paradisParseTerminalProcessScopeStorage(JSON.stringify([
			{ persistentProcessId: 11, repositoryId: 'scope:\ncontrol' },
		])), undefined);
		assert.strictEqual(paradisParseTerminalProcessScopeStorage(JSON.stringify(Array.from({ length: 4_097 }, (_, index) => ({
			persistentProcessId: index + 1,
			repositoryId: `scope:${index}`,
		})))), undefined);
		assert.strictEqual(paradisParseTerminalProcessScopeStorage('x'.repeat(300_000)), undefined);
	});

	test('never writes a persistent scope snapshot that the bounded reader would reject', () => {
		const valid = new Map<number, string>([[11, 'scope:a'], [22, 'worktree:b']]);
		const serialized = paradisSerializeTerminalProcessScopeStorage(valid);
		assert.ok(serialized !== undefined);
		assert.deepStrictEqual([...paradisParseTerminalProcessScopeStorage(serialized)!], [...valid]);
		assert.strictEqual(paradisSerializeTerminalProcessScopeStorage(new Map(Array.from({ length: 4_097 }, (_, index) => [index + 1, `scope:${index}`] as const))), undefined);
		assert.strictEqual(paradisSerializeTerminalProcessScopeStorage(new Map([[1, `scope:${'x'.repeat(4_096)}`]])), undefined);
		assert.strictEqual(paradisSerializeTerminalProcessScopeStorage(new Map(Array.from({ length: 100 }, (_, index) => [index + 1, `scope:${index}:${'x'.repeat(3_000)}`] as const))), undefined);
	});

	test('quarantines unknown scopes until the worktree snapshot can validate them', () => {
		const parsed = new Map<number, string>([[11, 'repository:a'], [22, 'worktree:known'], [33, 'worktree:removed']]);
		const beforeSnapshot = paradisPartitionPersistentProcessScopesByKnownScope(parsed, new Set(['repository:a']));
		assert.deepStrictEqual([...beforeSnapshot.accepted], [[11, 'repository:a']]);
		assert.deepStrictEqual([...beforeSnapshot.quarantined], [[22, 'worktree:known'], [33, 'worktree:removed']]);
		const afterSnapshot = paradisPartitionPersistentProcessScopesByKnownScope(beforeSnapshot.quarantined, new Set(['repository:a', 'worktree:known']));
		assert.deepStrictEqual([...afterSnapshot.accepted], [[22, 'worktree:known']]);
		assert.deepStrictEqual([...afterSnapshot.quarantined], [[33, 'worktree:removed']]);
		assert.deepStrictEqual([...paradisMergePersistentProcessScopesForStorage(
			new Map([[22, 'worktree:quarantined'], [44, 'worktree:old']]),
			new Map([[44, 'scope:current']]),
		)], [[22, 'worktree:quarantined'], [44, 'scope:current']], 'quarantine survives pre-barrier persistence but cannot overwrite a current owner');
	});

	test('identifies every live terminal owned by a retiring scope before ledger deletion', () => {
		const instanceScopes = new Map<number, string>([[1, 'scope:retired'], [2, 'scope:retired'], [3, 'scope:other'], [4, 'scope:retired']]);
		const persistentScopes = new Map<number, string>([[55, 'scope:retired']]);
		assert.deepStrictEqual(paradisCollectRetiringTerminalInstanceIds(instanceScopes, persistentScopes, 'scope:retired', [
			{ instanceId: 1 }, // visible panel
			{ instanceId: 2 }, // background
			{ instanceId: 3 }, // another scope
			{ instanceId: 4 }, // parked editor
			{ instanceId: 5, persistentProcessId: 55 }, // restored/parked panel
		]), [1, 2, 4, 5]);
	});
});
