/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains a PARA-CODE comment)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisLookupInstanceScope, paradisRecordInstanceScopes } from '../../common/paradisTerminalProcessScope.js';

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
});
