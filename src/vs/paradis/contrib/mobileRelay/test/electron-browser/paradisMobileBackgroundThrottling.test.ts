/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMobileStatus } from '../../common/paradisMobileRelay.js';
import { PARADIS_MOBILE_THROTTLING_RELEASE_GRACE_MS, PARADIS_MOBILE_THROTTLING_RESEND_MS, ParadisMobileBackgroundThrottlingKeeper, paradisShouldKeepWindowUnthrottledForMobile } from '../../electron-browser/paradisMobileBackgroundThrottling.js';

function status(overrides: Partial<IParadisMobileStatus> = {}): IParadisMobileStatus {
	return { state: 'online', deviceId: 'pc', pairedDevices: ['iPhone'], onlineMobiles: 1, ...overrides };
}

suite('ParadisMobileBackgroundThrottlingKeeper', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create() {
		const sent: boolean[] = [];
		const timers: { readonly callback: () => void; readonly ms: number }[] = [];
		const chatRunning = observableValue('chatRunning', false);
		const keeper = store.add(new ParadisMobileBackgroundThrottlingKeeper(allowed => sent.push(allowed), chatRunning, (callback, ms): IDisposable => {
			const timer = { callback, ms };
			timers.push(timer);
			return toDisposable(() => {
				const index = timers.indexOf(timer);
				if (index >= 0) {
					timers.splice(index, 1);
				}
			});
		}));
		/** `ms` 以下のタイマーを登録順に動かす。 */
		const run = (ms: number) => {
			for (const timer of timers.filter(candidate => candidate.ms <= ms)) {
				timers.splice(timers.indexOf(timer), 1);
				timer.callback();
			}
		};
		return { sent, timers, chatRunning, keeper, run };
	}

	test('keeps a window unthrottled only while a paired phone is online with the relay enabled', () => {
		assert.deepStrictEqual([
			paradisShouldKeepWindowUnthrottledForMobile(true, status()),
			paradisShouldKeepWindowUnthrottledForMobile(true, status({ onlineMobiles: 0 })),
			paradisShouldKeepWindowUnthrottledForMobile(false, status()),
			paradisShouldKeepWindowUnthrottledForMobile(true, status({ pairedDevices: [] })),
			paradisShouldKeepWindowUnthrottledForMobile(true, status({ state: 'disabled' })),
			paradisShouldKeepWindowUnthrottledForMobile(true, undefined),
		], [true, false, false, false, false, false]);
	});

	test('sends nothing while no phone is online, holds against chat with a resend, and hands back to chat when the relay is disabled', () => {
		const { sent, chatRunning, keeper, run } = create();
		keeper.update(true, status({ onlineMobiles: 0 }));
		chatRunning.set(true, undefined);
		chatRunning.set(false, undefined);
		run(PARADIS_MOBILE_THROTTLING_RESEND_MS);
		const neverOnline = [...sent];

		keeper.update(true, status());
		run(0);
		// チャットが終わると upstream は間引きを戻すので、その後にもう一度止める値を送り、少し後にも送り直す
		chatRunning.set(true, undefined);
		chatRunning.set(false, undefined);
		run(PARADIS_MOBILE_THROTTLING_RESEND_MS);
		const holding = [...sent];

		chatRunning.set(true, undefined);
		keeper.update(false, status());
		run(PARADIS_MOBILE_THROTTLING_RESEND_MS);

		assert.deepStrictEqual({ neverOnline, holding, releasedWhileChatRuns: sent }, {
			neverOnline: [],
			holding: [false, false, false],
			releasedWhileChatRuns: [false, false, false, false, false],
		});
	});

	test('releases only after the grace period once the phone goes offline, and keeps holding if it comes back', () => {
		const { sent, keeper, run } = create();
		keeper.update(true, status());
		run(PARADIS_MOBILE_THROTTLING_RESEND_MS);
		keeper.update(true, status({ onlineMobiles: 0 }));
		run(PARADIS_MOBILE_THROTTLING_RESEND_MS);
		const duringGrace = [...sent];
		keeper.update(true, status());
		run(PARADIS_MOBILE_THROTTLING_RELEASE_GRACE_MS);
		const cameBack = [...sent];
		keeper.update(true, status({ onlineMobiles: 0 }));
		run(PARADIS_MOBILE_THROTTLING_RELEASE_GRACE_MS);
		run(PARADIS_MOBILE_THROTTLING_RESEND_MS);

		assert.deepStrictEqual({ duringGrace, cameBack, released: sent }, {
			duringGrace: [false, false],
			cameBack: [false, false],
			released: [false, false, true, true],
		});
	});
});
