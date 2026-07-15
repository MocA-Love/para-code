/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_TERMINAL_RELAY_FLUSH_CHARS, paradisCreateTerminalOutputConsumer, paradisQueueTerminalRelayOutput } from '../../common/paradisTerminalOutputHotPath.js';

interface TestRelayState {
	suspended: boolean;
	droppedWhileSuspended: boolean;
	pending: string[];
	pendingChars: number;
	coalesceTimer: number | undefined;
}

suite('ParadisTerminalOutputHotPath', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('selects direct single consumers and dispatches relay before Agent hints when combined', () => {
		const calls: string[] = [];
		const relay = (data: string) => calls.push(`relay:${data}`);
		const hint = (data: string) => calls.push(`hint:${data}`);
		assert.strictEqual(paradisCreateTerminalOutputConsumer(undefined, undefined), undefined);
		assert.strictEqual(paradisCreateTerminalOutputConsumer(relay, undefined), relay);
		assert.strictEqual(paradisCreateTerminalOutputConsumer(undefined, hint), hint);
		paradisCreateTerminalOutputConsumer(relay, hint)!('output');
		assert.deepStrictEqual(calls, ['relay:output', 'hint:output']);
	});

	test('coalesces below 64KiB and flushes immediately at the bound', () => {
		const state = createRelayState();
		let scheduled = 0;
		let flushed = 0;
		const flush = () => {
			flushed++;
			state.pending = [];
			state.pendingChars = 0;
			state.coalesceTimer = undefined;
		};
		const schedule = () => {
			scheduled++;
			state.coalesceTimer = scheduled;
		};

		paradisQueueTerminalRelayOutput(state, 'a'.repeat(PARADIS_TERMINAL_RELAY_FLUSH_CHARS - 2), flush, schedule);
		paradisQueueTerminalRelayOutput(state, 'b', flush, schedule);
		assert.strictEqual(scheduled, 1, 'an existing timer must coalesce subsequent chunks');
		assert.strictEqual(flushed, 0);
		assert.strictEqual(state.pendingChars, PARADIS_TERMINAL_RELAY_FLUSH_CHARS - 1);

		paradisQueueTerminalRelayOutput(state, 'c', flush, schedule);
		assert.strictEqual(flushed, 1);
		assert.strictEqual(scheduled, 1);
		assert.deepStrictEqual(state.pending, []);
		assert.strictEqual(state.pendingChars, 0);
		assert.strictEqual(state.coalesceTimer, undefined);
	});

	test('scheduled owner flush drains pending output and allows a new timer', () => {
		const state = createRelayState();
		let scheduledCallback: (() => void) | undefined;
		const flushed: string[] = [];
		const flush = () => {
			flushed.push(state.pending.join(''));
			state.pending = [];
			state.pendingChars = 0;
			state.coalesceTimer = undefined;
		};
		const schedule = () => {
			state.coalesceTimer = 1;
			scheduledCallback = flush;
		};

		paradisQueueTerminalRelayOutput(state, 'first', flush, schedule);
		assert.ok(scheduledCallback);
		scheduledCallback();
		assert.deepStrictEqual(flushed, ['first']);

		paradisQueueTerminalRelayOutput(state, 'second', flush, schedule);
		assert.strictEqual(state.coalesceTimer, 1);
		assert.deepStrictEqual(state.pending, ['second']);
	});

	test('drops suspended output without scheduling or retaining it', () => {
		const state = createRelayState();
		state.suspended = true;
		let flushes = 0;
		let schedules = 0;

		paradisQueueTerminalRelayOutput(state, 'dropped', () => flushes++, () => schedules++);

		assert.strictEqual(state.droppedWhileSuspended, true);
		assert.deepStrictEqual(state.pending, []);
		assert.strictEqual(state.pendingChars, 0);
		assert.strictEqual(state.coalesceTimer, undefined);
		assert.strictEqual(flushes, 0);
		assert.strictEqual(schedules, 0);
	});
});

function createRelayState(): TestRelayState {
	return {
		suspended: false,
		droppedWhileSuspended: false,
		pending: [],
		pendingChars: 0,
		coalesceTimer: undefined,
	};
}
