/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains a PARA-CODE comment)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisLookupProcessScope, paradisRecordProcessScopes } from '../../common/paradisTerminalProcessScope.js';

suite('paradisRecordProcessScopes / paradisLookupProcessScope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recovers the original scope for a terminal group recreated after the original group object was disposed', () => {
		// 元のグループが scope B にタグ付けされた時点で記録される
		const processScopes = new Map<number, string>();
		paradisRecordProcessScopes(processScopes, [{ persistentProcessId: 42 }], 'worktree:B');

		// グループが dispose され、同じ persistentProcessId を持つインスタンスが新しい
		// グループオブジェクトに包まれて再表示された状況をシミュレートする。新しいグループは
		// _groupRepositories にエントリを持たない (未タグ) が、processScopes には残っている。
		const restoredMapping = new Map<number, string>();
		const resolved = paradisLookupProcessScope(processScopes, restoredMapping, [{ persistentProcessId: 42 }]);

		assert.strictEqual(resolved, 'worktree:B', 'must recover the original scope instead of falling through to "untagged" (which the caller would then bind to whatever scope happens to be active right now)');
	});

	test('prefers the live (this-session) record over a stale on-disk restored mapping', () => {
		const processScopes = new Map<number, string>();
		const restoredMapping = new Map<number, string>([[42, 'worktree:stale-from-previous-session']]);

		paradisRecordProcessScopes(processScopes, [{ persistentProcessId: 42 }], 'worktree:current');

		assert.strictEqual(paradisLookupProcessScope(processScopes, restoredMapping, [{ persistentProcessId: 42 }]), 'worktree:current');
	});

	test('falls back to the restored (previous session) mapping when nothing has been tagged yet this session', () => {
		const processScopes = new Map<number, string>();
		const restoredMapping = new Map<number, string>([[42, 'worktree:from-disk']]);

		assert.strictEqual(paradisLookupProcessScope(processScopes, restoredMapping, [{ persistentProcessId: 42 }]), 'worktree:from-disk');
	});

	test('returns undefined for a persistentProcessId that was never seen (a genuinely brand new terminal)', () => {
		const processScopes = new Map<number, string>();
		const restoredMapping = new Map<number, string>();

		assert.strictEqual(paradisLookupProcessScope(processScopes, restoredMapping, [{ persistentProcessId: 999 }]), undefined);
	});

	test('scans every instance in a multi-pane group until a match is found', () => {
		const processScopes = new Map<number, string>([[2, 'worktree:second-pane']]);
		const restoredMapping = new Map<number, string>();

		const resolved = paradisLookupProcessScope(processScopes, restoredMapping, [
			{ persistentProcessId: 1 },
			{ persistentProcessId: 2 },
		]);

		assert.strictEqual(resolved, 'worktree:second-pane');
	});

	test('recordProcessScopes ignores instances without a persistentProcessId (not yet connected)', () => {
		const processScopes = new Map<number, string>();
		paradisRecordProcessScopes(processScopes, [{ persistentProcessId: undefined }], 'worktree:B');

		assert.strictEqual(processScopes.size, 0);
	});
});
