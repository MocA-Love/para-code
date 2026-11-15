/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisClaudeResetGrantsTracker } from '../../node/paradisClaudeResetGrantsTracker.js';
import { ParadisFakeClaudeOAuth } from './paradisClaudeTestUtils.js';

class RecordingLogService extends NullLogService {
	readonly lines: string[] = [];
	override info(message: string): void {
		this.lines.push(message);
	}
}

const MINUTE = 60_000;

suite('Paradis Claude limit reset tracker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads at most every 30 minutes, waits an hour after 429, keeps the last grants and logs only counts', async () => {
		let now = 1_000_000;
		const oauth = new ParadisFakeClaudeOAuth();
		const log = new RecordingLogService();
		const tracker = new ParadisClaudeResetGrantsTracker(oauth, log, '[Test]', () => now);
		const endsAt = now + 100 * MINUTE;
		oauth.resetGrantsByToken.set('secret-token', { kind: 'ok', grants: [{ kind: 'fable', left: 2, endsAt }] });

		await tracker.refreshIfDue('acct', 'secret-token');
		now += 29 * MINUTE;
		await tracker.refreshIfDue('acct', 'secret-token');
		const afterFirst = tracker.get('acct');
		now += 2 * MINUTE;
		oauth.resetGrantsByToken.set('secret-token', { kind: 'http', status: 429 });
		await tracker.refreshIfDue('acct', 'secret-token');
		now += 31 * MINUTE;
		await tracker.refreshIfDue('acct', 'secret-token');
		const afterRateLimit = tracker.get('acct');
		now += 30 * MINUTE;
		oauth.resetGrantsByToken.set('secret-token', { kind: 'ok', grants: undefined });
		await tracker.refreshIfDue('acct', 'secret-token');
		const afterNoBlock = tracker.get('acct');
		tracker.retain(new Set());

		assert.deepStrictEqual({
			calls: oauth.resetGrantsCalls.length,
			afterFirst,
			afterRateLimit,
			afterNoBlock,
			afterRetain: tracker.get('acct'),
			log: log.lines,
			tokenLogged: log.lines.some(line => line.includes('secret-token')),
		}, {
			calls: 3,
			afterFirst: [{ kind: 'fable', left: 2, endsAt }],
			afterRateLimit: [{ kind: 'fable', left: 2, endsAt }],
			afterNoBlock: undefined,
			afterRetain: undefined,
			log: ['[Test] limit resets: 1 grant(s) (fable x2)', '[Test] limit resets: HTTP 429', '[Test] limit resets: the response has no cedar_ember block'],
			tokenLogged: false,
		});
	});

	test('drops grants once their end has passed', async () => {
		let now = 1_000_000;
		const oauth = new ParadisFakeClaudeOAuth();
		const tracker = new ParadisClaudeResetGrantsTracker(oauth, new NullLogService(), '[Test]', () => now);
		oauth.resetGrantsByToken.set('t', { kind: 'ok', grants: [{ kind: 'full', left: 1, endsAt: now + MINUTE }, { kind: 'fable', left: 1 }] });
		await tracker.refreshIfDue('acct', 't');
		now += 2 * MINUTE;
		assert.deepStrictEqual(tracker.get('acct'), [{ kind: 'fable', left: 1 }]);
	});
});
