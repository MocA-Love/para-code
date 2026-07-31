/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains a PARA-CODE comment)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalExitReason } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalInstance } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisCreateDeserializedTerminalEditorInput } from './paradisTerminalEditorInputFixture.js';
import { paradisParkTerminalEditorInstance, paradisTakeParkedTerminalEditorInstance, paradisTakeParkedTerminalEditorInstancesForScope, paradisRetireParkedTerminalEditorInstances } from '../../browser/paradisTerminalEditorPark.js';
import { paradisClearTerminalReviveIndex, paradisRefreshTerminalReviveIndex, paradisRegisterTerminalReviveIndexSource } from '../../browser/paradisTerminalEditorRevive.js';

interface IFakeTerminalInstance {
	readonly instance: ITerminalInstance;
	readonly disposedWith: (TerminalExitReason | undefined)[];
}

suite('paradisTerminalEditorPark', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createFakeInstance(instanceId: number, persistentProcessId: number | undefined, shellIntegrationNonce = `nonce-${instanceId}`): IFakeTerminalInstance {
		const disposedWith: (TerminalExitReason | undefined)[] = [];
		const onDisposedEmitter = store.add(new Emitter<ITerminalInstance>());
		let isDisposed = false;
		const instance = {
			instanceId,
			persistentProcessId,
			shellIntegrationNonce,
			shouldPersist: true,
			get isDisposed() { return isDisposed; },
			onDisposed: onDisposedEmitter.event,
			dispose: (reason?: TerminalExitReason) => {
				isDisposed = true;
				disposedWith.push(reason);
				onDisposedEmitter.fire(instance);
			}
		} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
		return { instance, disposedWith };
	}

	test('parked instance can be taken back by shell integration nonce (working set revive path)', () => {
		const fake = createFakeInstance(1, 101);
		assert.strictEqual(paradisParkTerminalEditorInstance(fake.instance, 'worktree:A'), true);

		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(101, 'nonce-1')), fake.instance);
		// 取り出し済みなので二度目は引けない
		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(101, 'nonce-1')), undefined);
	});

	test('a stale working set whose pty id collides is refused, so another space keeps its terminal', () => {
		// 実機で起きた形: pty host の採番リセットで、別スペースの古いスナップショットが
		// 同じ id 37 を要求してくる。nonce が違うので取り違えてはならない。
		const agentTerminal = createFakeInstance(9, 37, 'nonce-agent-in-other-space');
		assert.strictEqual(paradisParkTerminalEditorInstance(agentTerminal.instance, 'worktree:AZ-5'), true);

		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(37, 'nonce-stale-from-AZ-0')), undefined);
		// 奪われていないので、本来の持ち主のスコープからはそのまま回収できる
		assert.deepStrictEqual(paradisTakeParkedTerminalEditorInstancesForScope('worktree:AZ-5'), [agentTerminal.instance]);
	});

	test('while restoring a space, a parked instance owned by another space is not handed over', async () => {
		// nonce は「どの端末か」しか証明しない。`assignInstanceScope` で端末のスペースを付け替えられる
		// ため、複数スペースの working set に同じ nonce が残る構成は作れてしまう。
		const fake = createFakeInstance(20, 120, 'nonce-shared');
		assert.strictEqual(paradisParkTerminalEditorInstance(fake.instance, 'worktree:owner'), true);

		const disposables = store.add(new DisposableStore());
		disposables.add({ dispose: () => paradisClearTerminalReviveIndex() });
		disposables.add(paradisRegisterTerminalReviveIndexSource({
			listOrphanPtyIdsByNonce: async () => new Map(),
			listHeldPtyIds: () => new Set<number>(),
		}));

		await paradisRefreshTerminalReviveIndex('worktree:other');
		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(120, 'nonce-shared')), undefined);

		await paradisRefreshTerminalReviveIndex('worktree:owner');
		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(120, 'nonce-shared')), fake.instance);
	});

	test('outside a space restore the ownership check does not apply', () => {
		const fake = createFakeInstance(21, 121, 'nonce-free');
		paradisParkTerminalEditorInstance(fake.instance, 'worktree:owner');

		// 起動時のエディタ復元など、切替以外の経路は従来どおり nonce だけで引ける。
		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(121, 'nonce-free')), fake.instance);
	});

	test('an input without a usable nonce never reuses a parked instance', () => {
		const fake = createFakeInstance(10, 110);
		paradisParkTerminalEditorInstance(fake.instance, 'worktree:A');

		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(110, '')), undefined);
		assert.deepStrictEqual(paradisTakeParkedTerminalEditorInstancesForScope('worktree:A'), [fake.instance]);
	});

	test('does not park an instance whose persistentProcessId is not assigned yet', () => {
		const fake = createFakeInstance(2, undefined);
		assert.strictEqual(paradisParkTerminalEditorInstance(fake.instance, 'worktree:A'), false);
	});

	test('does not park an instance without a usable nonce (a DetachedTerminal has an empty one)', () => {
		const fake = createFakeInstance(11, 111, '');
		assert.strictEqual(paradisParkTerminalEditorInstance(fake.instance, 'worktree:A'), false);
	});

	test('refuses to park over a live instance holding the same nonce instead of silently evicting it', () => {
		const first = createFakeInstance(12, 112, 'shared-nonce');
		const second = createFakeInstance(13, 112, 'shared-nonce');
		assert.strictEqual(paradisParkTerminalEditorInstance(first.instance, 'worktree:A'), true);

		assert.strictEqual(paradisParkTerminalEditorInstance(second.instance, 'worktree:A'), false);
		// 追い出されていないので、最初のインスタンスは台帳から回収できるまま
		assert.deepStrictEqual(paradisTakeParkedTerminalEditorInstancesForScope('worktree:A'), [first.instance]);
	});

	test('drains only the instances parked under the requested scope, preserving other scopes', () => {
		const mine1 = createFakeInstance(3, 103);
		const mine2 = createFakeInstance(4, 104);
		const other = createFakeInstance(5, 105);
		paradisParkTerminalEditorInstance(mine1.instance, 'worktree:mine');
		paradisParkTerminalEditorInstance(mine2.instance, 'worktree:mine');
		paradisParkTerminalEditorInstance(other.instance, 'worktree:other');

		const drained = paradisTakeParkedTerminalEditorInstancesForScope('worktree:mine');

		assert.deepStrictEqual(drained, [mine1.instance, mine2.instance]);
		// 対象スコープの分は台帳から消え、他スコープの分は残る
		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(103, 'nonce-3')), undefined);
		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(104, 'nonce-4')), undefined);
		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(105, 'nonce-5')), other.instance);
	});

	test('draining a scope with no parked instances returns an empty list', () => {
		assert.deepStrictEqual(paradisTakeParkedTerminalEditorInstancesForScope('worktree:empty'), []);
	});

	test('drained instances are not disposed (they are handed back for reopening)', () => {
		const fake = createFakeInstance(6, 106);
		paradisParkTerminalEditorInstance(fake.instance, 'worktree:reopen');

		const drained = paradisTakeParkedTerminalEditorInstancesForScope('worktree:reopen');

		assert.strictEqual(drained.length, 1);
		assert.deepStrictEqual(fake.disposedWith, []);
	});

	test('retire disposes parked instances of the scope, while a drained scope is unaffected', () => {
		const retired = createFakeInstance(7, 107);
		paradisParkTerminalEditorInstance(retired.instance, 'worktree:retired');

		paradisRetireParkedTerminalEditorInstances('worktree:retired');

		assert.deepStrictEqual(retired.disposedWith, [TerminalExitReason.User]);
		assert.deepStrictEqual(paradisTakeParkedTerminalEditorInstancesForScope('worktree:retired'), []);
	});

	test('an instance disposed while parked is removed from the ledger and is not drained later', () => {
		const fake = createFakeInstance(8, 108);
		paradisParkTerminalEditorInstance(fake.instance, 'worktree:dying');

		fake.instance.dispose(TerminalExitReason.Process);

		assert.deepStrictEqual(paradisTakeParkedTerminalEditorInstancesForScope('worktree:dying'), []);
	});
});
