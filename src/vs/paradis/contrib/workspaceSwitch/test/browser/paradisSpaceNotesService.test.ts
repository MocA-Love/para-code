/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { PARADIS_SPACE_NOTES_STORAGE_KEY } from '../../common/paradisSpaceNotes.js';
import { IParadisWorkspaceSwitchService } from '../../common/paradisWorkspaceSwitch.js';
import { ParadisSpaceNotesService } from '../../browser/paradisSpaceNotesService.js';

suite('ParadisSpaceNotesService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('reads, summarizes and notifies on write, then persists on dispose', () => {
		const context = createContext(store);
		const service = context.create();

		const changed: string[][] = [];
		store.add(service.onDidChangeNotes(keys => changed.push([...keys])));

		service.write('worktree:a', '- [ ] やること\n- [x] 済み');
		assert.strictEqual(service.read('worktree:a'), '- [ ] やること\n- [x] 済み');
		assert.deepStrictEqual(service.summary('worktree:a'), { open: 1, done: 1 });
		assert.deepStrictEqual(changed, [['worktree:a']]);
		assert.strictEqual(context.storage.value, undefined, 'debounced until the scheduler runs or the service is disposed');

		service.dispose();
		assert.deepStrictEqual(context.storage.writes.map(write => ({ scope: write.scope, target: write.target })), [
			{ scope: StorageScope.WORKSPACE, target: StorageTarget.MACHINE },
		]);
		assert.strictEqual(JSON.parse(context.storage.value!)['worktree:a'].text, '- [ ] やること\n- [x] 済み');
	});

	test('restores persisted notes and drops entries emptied by the user', () => {
		const context = createContext(store, JSON.stringify({ 'worktree:a': { text: 'メモ', updatedAt: 1 } }));
		const service = context.create();
		assert.strictEqual(service.read('worktree:a'), 'メモ');

		service.write('worktree:a', '   ');
		assert.strictEqual(service.read('worktree:a'), '');
		service.dispose();
		assert.deepStrictEqual(JSON.parse(context.storage.value!), {});
	});

	test('toggles a checklist line in place', () => {
		const context = createContext(store, JSON.stringify({ 'worktree:a': { text: '- [ ] a\n- [ ] b', updatedAt: 1 } }));
		const service = store.add(context.create());

		service.toggleTask('worktree:a', 1);
		assert.strictEqual(service.read('worktree:a'), '- [ ] a\n- [x] b');
		assert.deepStrictEqual(service.summary('worktree:a'), { open: 1, done: 1 });

		// チェックリストでない行・存在しないスペースでは何も起きない
		service.toggleTask('worktree:a', 5);
		service.toggleTask('worktree:missing', 0);
		assert.strictEqual(service.read('worktree:a'), '- [ ] a\n- [x] b');
	});

	test('adopts notes written by another window', () => {
		const context = createContext(store, JSON.stringify({ 'worktree:a': { text: '古い', updatedAt: 1 } }));
		const service = store.add(context.create());

		const changed: string[][] = [];
		store.add(service.onDidChangeNotes(keys => changed.push([...keys].sort())));

		context.storage.value = JSON.stringify({ 'worktree:a': { text: '新しい', updatedAt: 2 }, 'worktree:b': { text: 'b', updatedAt: 2 } });
		context.fireStorageChange();

		assert.strictEqual(service.read('worktree:a'), '新しい');
		assert.strictEqual(service.read('worktree:b'), 'b');
		assert.deepStrictEqual(changed, [['worktree:a', 'worktree:b']]);
	});

	test('keeps unsaved local edits when another window writes first', () => {
		const context = createContext(store);
		const service = store.add(context.create());

		service.write('worktree:a', 'こちらの編集');
		context.storage.value = JSON.stringify({ 'worktree:a': { text: '他ウィンドウの編集', updatedAt: 9 } });
		context.fireStorageChange();

		assert.strictEqual(service.read('worktree:a'), 'こちらの編集');
	});

	test('protects only the space being edited when another window writes', () => {
		const context = createContext(store, JSON.stringify({ 'worktree:b': { text: '古いb', updatedAt: 1 } }));
		const service = store.add(context.create());

		service.write('worktree:a', 'こちらの編集');
		context.storage.value = JSON.stringify({
			'worktree:a': { text: '他ウィンドウのa', updatedAt: 9 },
			'worktree:b': { text: '他ウィンドウのb', updatedAt: 9 },
		});
		context.fireStorageChange();

		// 編集中の a は守り、触っていない b は相手の更新を取り込む (次の保存で b を巻き戻さない)
		assert.strictEqual(service.read('worktree:a'), 'こちらの編集');
		assert.strictEqual(service.read('worktree:b'), '他ウィンドウのb');

		service.dispose();
		assert.deepStrictEqual(JSON.parse(context.storage.value!), {
			'worktree:a': { text: 'こちらの編集', updatedAt: JSON.parse(context.storage.value!)['worktree:a'].updatedAt },
			'worktree:b': { text: '他ウィンドウのb', updatedAt: 9 },
		});
	});

	test('rejects notes that would make the whole snapshot unpersistable', () => {
		const context = createContext(store);
		const service = store.add(context.create());

		service.write('x'.repeat(1_025), 'キーが長すぎる');
		service.write('', 'キーが空');
		assert.strictEqual(service.read('x'.repeat(1_025)), '');

		// 上限に達したあとも、既存スペースの更新は受け付ける
		for (let index = 0; index < 512; index++) {
			service.write(`worktree:${index}`, 'メモ');
		}
		service.write('worktree:overflow', 'あふれる分');
		assert.strictEqual(service.read('worktree:overflow'), '');
		service.write('worktree:0', '更新できる');
		assert.strictEqual(service.read('worktree:0'), '更新できる');

		service.dispose();
		assert.strictEqual(Object.keys(JSON.parse(context.storage.value!)).length, 512, 'snapshot stays persistable');
	});

	test('flushes pending edits when the workbench saves state', () => {
		const context = createContext(store);
		const service = store.add(context.create());

		service.write('worktree:a', 'まだデバウンス待ちのメモ');
		assert.strictEqual(context.storage.value, undefined);

		context.willSaveState.fire();
		assert.strictEqual(JSON.parse(context.storage.value!)['worktree:a'].text, 'まだデバウンス待ちのメモ');
	});

	test('drops the note when the space is retired', () => {
		const context = createContext(store, JSON.stringify({ 'worktree:a': { text: 'メモ', updatedAt: 1 } }));
		const service = store.add(context.create());

		const changed: string[][] = [];
		store.add(service.onDidChangeNotes(keys => changed.push([...keys])));

		context.retireScope.fire('worktree:a');
		assert.strictEqual(service.read('worktree:a'), '');
		assert.deepStrictEqual(changed, [['worktree:a']]);
	});
});

function createContext(store: Pick<DisposableStore, 'add'>, initial?: string) {
	const storage = new TestStorageService(initial);
	const storageChange = store.add(new Emitter<void>());
	const willSaveState = store.add(new Emitter<void>());
	const retireScope = store.add(new Emitter<string>());
	storage.onDidChangeValueEvent = storageChange.event;
	storage.onWillSaveState = willSaveState.event;
	return {
		storage,
		retireScope,
		willSaveState,
		fireStorageChange: () => storageChange.fire(),
		create: () => new ParadisSpaceNotesService(
			storage as unknown as IStorageService,
			{ warn() { } } as Partial<ILogService> as ILogService,
			{ onDidRetireScope: retireScope.event } as Partial<IParadisWorkspaceSwitchService> as IParadisWorkspaceSwitchService,
		),
	};
}

class TestStorageService {
	readonly writes: Array<{ key: string; value: string; scope: StorageScope; target: StorageTarget }> = [];
	onDidChangeValueEvent: unknown;
	onWillSaveState: unknown;

	constructor(public value?: string) { }

	get(key: string, scope: StorageScope): string | undefined {
		assert.strictEqual(key, PARADIS_SPACE_NOTES_STORAGE_KEY);
		assert.strictEqual(scope, StorageScope.WORKSPACE);
		return this.value;
	}

	store(key: string, value: string, scope: StorageScope, target: StorageTarget): void {
		this.writes.push({ key, value, scope, target });
		this.value = value;
	}

	onDidChangeValue(): unknown {
		return this.onDidChangeValueEvent;
	}
}
