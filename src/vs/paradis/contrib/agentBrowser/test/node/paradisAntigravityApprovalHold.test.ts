/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_ANTIGRAVITY_APPROVAL_HOLD_MS } from '../../common/paradisAntigravityApproval.js';
import { ParadisAntigravityApprovalHold } from '../../node/paradisAntigravityApprovalHold.js';

suite('Para Browser Antigravity CLI approval hold', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { present?: boolean; gate?: boolean } = {}) {
		let now = 1_000;
		let seq = 0;
		const hold = new ParadisAntigravityApprovalHold({ now: () => now, newId: () => (++seq).toString(16).padStart(32, '0'), manualSweep: true });
		const state = { present: options.present ?? true, gate: options.gate ?? true };
		hold.setPresence(() => state.present);
		hold.setGate(() => state.gate);
		return { hold, state, advance: (ms: number) => { now += ms; hold.sweep(); } };
	}
	const request = (toolUseId: string, toolName = 'run_command') => ({ sessionId: 'c1', toolUseId, toolName });

	test('waits only while the mobile app watches the main conversation, for tools that may ask', () => {
		const watched = setup();
		const away = setup({ present: false });
		const notGated = setup({ gate: false });
		const id = watched.hold.register('pane', request('call_1'));
		assert.deepStrictEqual({
			id,
			again: watched.hold.register('pane', request('call_1')),
			readOnlyTool: watched.hold.register('pane', request('call_2', 'read_file')),
			badId: watched.hold.register('pane', { sessionId: 'c1', toolUseId: 'call 3', toolName: 'run_command' }),
			noSession: watched.hold.register('pane', { sessionId: undefined, toolUseId: 'call_4', toolName: 'run_command' }),
			away: away.hold.register('pane', request('call_1')),
			notGated: notGated.hold.register('pane', request('call_1')),
			waiting: [watched.hold.isWaiting('pane', 'call_1'), watched.hold.isWaiting('other', 'call_1')],
		}, {
			id: '00000000000000000000000000000001',
			again: undefined,
			readOnlyTool: undefined,
			badId: undefined,
			noSession: undefined,
			away: undefined,
			notGated: undefined,
			waiting: [true, false],
		});
		watched.hold.dispose();
		away.hold.dispose();
		notGated.hold.dispose();
	});

	test('returns the card answer to the waiting script, also when the answer comes first', async () => {
		const { hold } = setup();
		const first = hold.register('pane', request('call_1'))!;
		const second = hold.register('pane', request('call_2'))!;
		const waiting = hold.wait('pane', first);
		const answers = [hold.answer('pane', 'call_1', 'allow'), hold.answer('other', 'call_2', 'deny'), hold.answer('pane', 'call_2', 'deny'), hold.answer('pane', 'call_2', 'allow')];
		assert.deepStrictEqual({
			answers,
			first: await waiting,
			second: await hold.wait('pane', second),
			wrongPane: await hold.wait('other', first),
			afterwards: [hold.isWaiting('pane', 'call_1'), hold.isWaiting('pane', 'call_2')],
		}, {
			answers: [true, false, true, false],
			first: 'allow',
			second: 'deny',
			wrongPane: undefined,
			afterwards: [false, false],
		});
		hold.dispose();
	});

	test('gives up without an answer at the limit, when the mobile app leaves, when no wait comes, or when the script hangs up', async () => {
		const limit = setup();
		const atLimit = limit.hold.wait('pane', limit.hold.register('pane', request('call_1'))!);
		limit.advance(PARADIS_ANTIGRAVITY_APPROVAL_HOLD_MS);

		const leaving = setup();
		const left = leaving.hold.wait('pane', leaving.hold.register('pane', request('call_1'))!);
		leaving.state.present = false;
		leaving.advance(10_000);
		const stillWaiting = leaving.hold.isWaiting('pane', 'call_1');
		leaving.advance(30_000);

		const orphan = setup();
		const orphanId = orphan.hold.register('pane', request('call_1'))!;
		orphan.advance(20_000);

		const hangUp = setup();
		const controller = new AbortController();
		const hungUp = hangUp.hold.wait('pane', hangUp.hold.register('pane', request('call_1'))!, controller.signal);
		controller.abort();

		assert.deepStrictEqual({
			atLimit: await atLimit,
			stillWaiting,
			left: await left,
			orphan: [await orphan.hold.wait('pane', orphanId), orphan.hold.answer('pane', 'call_1', 'allow')],
			hungUp: [await hungUp, hangUp.hold.answer('pane', 'call_1', 'allow')],
		}, {
			atLimit: undefined,
			stillWaiting: true,
			left: undefined,
			orphan: [undefined, false],
			hungUp: [undefined, false],
		});
		for (const { hold } of [limit, leaving, orphan, hangUp]) {
			hold.dispose();
		}
	});
});
