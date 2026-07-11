/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains a PARA-CODE comment)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalExitReason } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalInstance } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisParkTerminalEditorInstance, paradisTakeParkedTerminalEditorInstance, paradisTakeParkedTerminalEditorInstancesForScope, paradisRetireParkedTerminalEditorInstances } from '../../browser/paradisTerminalEditorPark.js';

interface IFakeTerminalInstance {
	readonly instance: ITerminalInstance;
	readonly disposedWith: (TerminalExitReason | undefined)[];
}

suite('paradisTerminalEditorPark', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createFakeInstance(instanceId: number, persistentProcessId: number | undefined): IFakeTerminalInstance {
		const disposedWith: (TerminalExitReason | undefined)[] = [];
		const onDisposedEmitter = store.add(new Emitter<ITerminalInstance>());
		const instance = {
			instanceId,
			persistentProcessId,
			shouldPersist: true,
			onDisposed: onDisposedEmitter.event,
			dispose: (reason?: TerminalExitReason) => {
				disposedWith.push(reason);
				onDisposedEmitter.fire(instance);
			}
		} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
		return { instance, disposedWith };
	}

	test('parked instance can be taken back by persistentProcessId (working set revive path)', () => {
		const fake = createFakeInstance(1, 101);
		assert.strictEqual(paradisParkTerminalEditorInstance(fake.instance, 'worktree:A'), true);

		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(101), fake.instance);
		// 取り出し済みなので二度目は引けない
		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(101), undefined);
	});

	test('does not park an instance whose persistentProcessId is not assigned yet', () => {
		const fake = createFakeInstance(2, undefined);
		assert.strictEqual(paradisParkTerminalEditorInstance(fake.instance, 'worktree:A'), false);
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
		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(103), undefined);
		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(104), undefined);
		assert.strictEqual(paradisTakeParkedTerminalEditorInstance(105), other.instance);
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
