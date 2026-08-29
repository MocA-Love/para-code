/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	beginParadisOfficeRecovery,
	createParadisOfficeRecoveryState,
	reduceParadisOfficeRecovery,
	type IParadisOfficeRecoverySnapshot,
} from '../../common/paradisOfficeRecovery.js';

const FIRST: IParadisOfficeRecoverySnapshot = Object.freeze({
	source: Object.freeze({ mode: 'document', source: Object.freeze({ kind: 'file', uri: 'file:///first.docx', displayName: 'first.docx' }) }),
	viewState: Object.freeze({ zoom: 1, activeStory: 'all' }),
});
const SECOND: IParadisOfficeRecoverySnapshot = Object.freeze({
	source: Object.freeze({ mode: 'document', source: Object.freeze({ kind: 'file', uri: 'file:///second.docx', displayName: 'second.docx' }) }),
	viewState: Object.freeze({ zoom: 1.5, activeStory: 'headers' }),
});

suite('ParadisOfficeRecovery', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('cancel restores the previously committed source descriptor and view state', () => {
		let transition = beginParadisOfficeRecovery(createParadisOfficeRecoveryState(), FIRST);
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 1, hasExpectedRoot: true });
		transition = beginParadisOfficeRecovery(transition.state, SECOND);

		const cancelled = reduceParadisOfficeRecovery(transition.state, { type: 'cancelled', generation: 2 });

		assert.deepStrictEqual(cancelled, {
			state: {
				phase: 'ready', generation: 3, retryCount: 0, pendingWatch: false,
				active: FIRST, committed: FIRST,
			},
			effects: [{ type: 'restore', generation: 3, snapshot: FIRST }],
		});
	});

	test('an elapsed render budget walks the same bounded ladder as a blank render', () => {
		// 「一度も答えが来ない」表示は、白紙と同じ手順で畳む。作り直し2回で直らなければ、
		// 利用者に理由と操作を出して**必ず止まる**こと（無限に作り直さない）。
		const opened = beginParadisOfficeRecovery(createParadisOfficeRecoveryState(), FIRST);
		const first = reduceParadisOfficeRecovery(opened.state, { type: 'renderTimedOut', generation: 1 });
		const second = reduceParadisOfficeRecovery(first.state, { type: 'renderTimedOut', generation: 2 });
		const third = reduceParadisOfficeRecovery(second.state, { type: 'renderTimedOut', generation: 3 });

		assert.deepStrictEqual({
			effects: [...first.effects, ...second.effects, ...third.effects],
			state: third.state,
		}, {
			effects: [
				{ type: 'remount', generation: 2 },
				{ type: 'recreate', generation: 3 },
				{ type: 'showError', generation: 3, code: 'render.blank', actions: ['retry', 'openExternally'] },
			],
			state: {
				phase: 'failed', generation: 3, retryCount: 2, pendingWatch: false, active: FIRST,
				error: {
					stage: 'render', code: 'blank', safeMessage: 'The Office renderer produced no visible content.',
					severity: 'error', retryable: true, recoverable: true, userAction: 'retry',
				},
			},
		});
	});

	test('an elapsed budget from a superseded generation changes nothing', () => {
		// 読み直しをまたいで鳴った古い時計で作り直すと、いま出ている表示を壊す。
		const opened = beginParadisOfficeRecovery(createParadisOfficeRecoveryState(), FIRST);
		const advanced = reduceParadisOfficeRecovery(opened.state, { type: 'renderTimedOut', generation: 1 });

		assert.deepStrictEqual(
			reduceParadisOfficeRecovery(advanced.state, { type: 'renderTimedOut', generation: 1 }),
			{ state: advanced.state, effects: [] },
		);
	});

	test('blank detection requests one remount without changing the semantic snapshot', () => {
		const opened = beginParadisOfficeRecovery(createParadisOfficeRecoveryState(), FIRST);

		const blank = reduceParadisOfficeRecovery(opened.state, { type: 'rendered', generation: 1, hasExpectedRoot: false });

		assert.deepStrictEqual(blank, {
			state: {
				phase: 'loading', generation: 2, retryCount: 1, pendingWatch: false,
				active: FIRST,
			},
			effects: [{ type: 'remount', generation: 2 }],
		});
	});

	test('a second blank recreates the isolated webview exactly once', () => {
		let transition = beginParadisOfficeRecovery(createParadisOfficeRecoveryState(), FIRST);
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 1, hasExpectedRoot: false });

		const secondBlank = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 2, hasExpectedRoot: false });

		assert.deepStrictEqual(secondBlank.effects, [{ type: 'recreate', generation: 3 }]);
		assert.strictEqual(secondBlank.state.retryCount, 2);
	});

	test('a third blank stops with render.blank and bounded user actions', () => {
		let transition = beginParadisOfficeRecovery(createParadisOfficeRecoveryState(), FIRST);
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 1, hasExpectedRoot: false });
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 2, hasExpectedRoot: false });

		const failed = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 3, hasExpectedRoot: false });

		assert.deepStrictEqual(failed, {
			state: {
				phase: 'failed', generation: 3, retryCount: 2, pendingWatch: false,
				active: FIRST,
				error: {
					stage: 'render', code: 'blank', safeMessage: 'The Office renderer produced no visible content.',
					severity: 'error', retryable: true, recoverable: true, userAction: 'retry',
				},
			},
			effects: [{ type: 'showError', generation: 3, code: 'render.blank', actions: ['retry', 'openExternally'] }],
		});
	});

	test('a user retry starts a fresh bounded cycle after the final error', () => {
		let transition = beginParadisOfficeRecovery(createParadisOfficeRecoveryState(), FIRST);
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 1, hasExpectedRoot: false });
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 2, hasExpectedRoot: false });
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 3, hasExpectedRoot: false });

		const retry = reduceParadisOfficeRecovery(transition.state, { type: 'retry' });

		assert.deepStrictEqual(retry.effects, [{ type: 'load', generation: 4 }]);
		assert.strictEqual(retry.state.retryCount, 0);
	});

	test('file disappearance retains the last render and reappearance reloads it', () => {
		let transition = beginParadisOfficeRecovery(createParadisOfficeRecoveryState(), FIRST);
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 1, hasExpectedRoot: true });
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'watchChanged' });

		const disappeared = reduceParadisOfficeRecovery(transition.state, { type: 'sourceUnavailable', generation: 2 });
		const reappeared = reduceParadisOfficeRecovery(disappeared.state, { type: 'watchChanged' });

		assert.deepStrictEqual(disappeared.effects, [{ type: 'restore', generation: 2, snapshot: FIRST }]);
		assert.deepStrictEqual(reappeared.effects, [{ type: 'load', generation: 3 }]);
	});

	test('a rapid watcher burst coalesces to one trailing reload', () => {
		let transition = beginParadisOfficeRecovery(createParadisOfficeRecoveryState(), FIRST);
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 1, hasExpectedRoot: true });
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'watchChanged' });
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'watchChanged' });
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'watchChanged' });

		const loaded = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 2, hasExpectedRoot: true });

		assert.deepStrictEqual(loaded.effects, [{ type: 'load', generation: 3 }]);
		assert.strictEqual(loaded.state.pendingWatch, false);
	});

	test('a reappearance observed during a failed watcher read performs one trailing reload', () => {
		let transition = beginParadisOfficeRecovery(createParadisOfficeRecoveryState(), FIRST);
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 1, hasExpectedRoot: true });
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'watchChanged' });
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'watchChanged' });

		const failedRead = reduceParadisOfficeRecovery(transition.state, { type: 'sourceUnavailable', generation: 2 });

		assert.deepStrictEqual(failedRead.effects, [{ type: 'load', generation: 3 }]);
		assert.strictEqual(failedRead.state.phase, 'loading');
		assert.strictEqual(failedRead.state.pendingWatch, false);
	});

	test('stale generations cannot replace the current render or spend retries', () => {
		let transition = beginParadisOfficeRecovery(createParadisOfficeRecoveryState(), FIRST);
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 1, hasExpectedRoot: true });
		transition = reduceParadisOfficeRecovery(transition.state, { type: 'watchChanged' });

		const stale = reduceParadisOfficeRecovery(transition.state, { type: 'rendered', generation: 1, hasExpectedRoot: false });

		assert.deepStrictEqual(stale, { state: transition.state, effects: [] });
	});
});
