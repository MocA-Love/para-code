/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisScopeRetirementJournal, ParadisScopeRetirementJournalLoadState } from '../../common/paradisScopeRetirementJournal.js';

suite('ParadisScopeRetirementJournal', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps a committed repository retirement until every durable boundary is complete', () => {
		const journal = ParadisScopeRetirementJournal.load(undefined).journal;
		journal.stage('transaction-a', ['space-a', 'worktree:a'], 'space-a');

		const restored = ParadisScopeRetirementJournal.load(journal.serialize());
		assert.strictEqual(restored.state, ParadisScopeRetirementJournalLoadState.Valid);
		assert.deepStrictEqual(restored.journal.entries, [{
			id: 'transaction-a',
			stateKeys: ['space-a', 'worktree:a'],
			repositoryId: 'space-a',
			eventsPending: true,
			repositoryPending: true,
			pendingStateKeys: ['space-a', 'worktree:a']
		}]);

		restored.journal.completeEvents('transaction-a');
		restored.journal.completeRepository('space-a');
		restored.journal.acknowledgeStateKey('space-a');
		assert.deepStrictEqual(restored.journal.pendingStateKeys, ['worktree:a']);
		assert.strictEqual(restored.journal.entries.length, 1);

		restored.journal.acknowledgeStateKey('worktree:a');
		assert.strictEqual(restored.journal.entries.length, 0);
	});

	test('does not require a repository boundary for worktree-only retirement', () => {
		const journal = ParadisScopeRetirementJournal.load(undefined).journal;
		journal.stage('transaction-b', ['worktree:b']);
		journal.completeEvents('transaction-b');
		assert.strictEqual(journal.entries.length, 1);
		journal.acknowledgeStateKey('worktree:b');
		assert.strictEqual(journal.entries.length, 0);
	});

	test('treats malformed retirement intent as corrupt instead of deleting scope state', () => {
		const loaded = ParadisScopeRetirementJournal.load('{"version":1,"entries":[{"stateKeys":[]}]}');
		assert.strictEqual(loaded.state, ParadisScopeRetirementJournalLoadState.Corrupt);
		assert.deepStrictEqual(loaded.journal.entries, []);
	});
});
