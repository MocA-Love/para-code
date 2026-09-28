/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_RELAY_REVOKE_OUTBOX_LIMIT, paradisClassifyRevokeResponse, paradisEnqueueRevoke, paradisRevokeRetried, paradisRevokeRetryDelayMs, paradisSanitizeRevokeOutbox } from '../../common/paradisRelayRevokeOutbox.js';
import { paradisParseRelayState } from '../../node/paradisMobileRelayStateFile.js';

suite('paradisRelayRevokeOutbox (W2-35)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 以前は fetch が返れば成功とみなし、401 や 5xx でも送り直さなかった。
	test('only a 2xx (or a relay that no longer knows the device) confirms the revoke', () => {
		assert.deepStrictEqual(
			[200, 204, 404, 400, 401, 403, 408, 409, 429, 500, 503, undefined].map(paradisClassifyRevokeResponse),
			['done', 'done', 'done', 'drop', 'retry', 'retry', 'retry', 'drop', 'retry', 'retry', 'retry', 'retry'],
		);
	});

	test('queues once per device and mobile, bounded, and backs off up to 10 minutes with jitter', () => {
		let outbox = paradisEnqueueRevoke([], 'dev', 'm1', 100);
		outbox = paradisEnqueueRevoke(outbox, 'dev', 'm1', 200);
		outbox = paradisEnqueueRevoke(outbox, 'dev', 'm2', 300);
		let many = outbox;
		for (let i = 0; i < PARADIS_RELAY_REVOKE_OUTBOX_LIMIT + 3; i++) {
			many = paradisEnqueueRevoke(many, 'dev', `x${i}`, i);
		}
		assert.deepStrictEqual({
			outbox,
			bounded: many.length,
			delays: [1, 2, 5, 30].map(attempts => paradisRevokeRetryDelayMs(attempts, 0.5)),
			jitter: [paradisRevokeRetryDelayMs(1, 0), paradisRevokeRetryDelayMs(1, 1)],
			retried: paradisRevokeRetried(outbox[0], 1_000, 0.5),
		}, {
			outbox: [
				{ deviceId: 'dev', mobileId: 'm1', since: 100, attempts: 0, nextAt: 100 },
				{ deviceId: 'dev', mobileId: 'm2', since: 300, attempts: 0, nextAt: 300 },
			],
			bounded: PARADIS_RELAY_REVOKE_OUTBOX_LIMIT,
			delays: [30_000, 60_000, 480_000, 600_000],
			jitter: [22_500, 37_500],
			retried: { deviceId: 'dev', mobileId: 'm1', since: 100, attempts: 1, nextAt: 31_000 },
		});
	});

	test('survives a round trip through the state file and drops malformed entries', () => {
		const state = paradisParseRelayState(JSON.stringify({
			mobiles: [],
			pendingRelayRevokes: [
				{ deviceId: 'dev', mobileId: 'm1', since: 1, attempts: 2, nextAt: 5 },
				{ deviceId: 'dev', since: 1 },
				'garbage',
				{ deviceId: 'dev', mobileId: 'm2', since: 2, attempts: -1 },
			],
		}));
		assert.deepStrictEqual(paradisSanitizeRevokeOutbox(state?.pendingRelayRevokes), [
			{ deviceId: 'dev', mobileId: 'm1', since: 1, attempts: 2, nextAt: 5 },
			{ deviceId: 'dev', mobileId: 'm2', since: 2, attempts: 0, nextAt: 0 },
		]);
		// 旧版の台帳（取り消し待ちが無い）も読める
		assert.deepStrictEqual(paradisSanitizeRevokeOutbox(paradisParseRelayState(JSON.stringify({ mobiles: [] }))?.pendingRelayRevokes), []);
	});
});
