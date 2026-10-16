/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IProcessDetails } from '../../../../../platform/terminal/common/terminalProcess.js';
import { registerParadisServerTerminalLifetime } from '../../node/paradisServerTerminalLifetime.js';

suite('ParadisServerTerminalLifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** 窓が去った後、拾い直し待ちの端末を理由にサーバーの終了を延ばした回数を数える。 */
	async function delaysWhileWaiting(waiting: Partial<IProcessDetails>[]): Promise<number> {
		let delays = 0;
		await runWithFakedTimers({ useFakeTimers: true }, async () => {
			// 見回りの間隔は偽の時計の中で止める（外で止めると、偽の時計が終わらない）。
			const disposables = new DisposableStore();
			const started = disposables.add(new Emitter<void>());
			disposables.add(registerParadisServerTerminalLifetime(
				{ listProcesses: async () => waiting as IProcessDetails[], onPtyHostStart: started.event, onPtyHostExit: Event.None },
				{ delay: () => { delays++; }, hasActiveConsumers: false },
				24 * 60 * 60 * 1000,
				new NullLogService(),
			));
			// pty ホストが起きている（起きていなければ守るものが無いので、そもそも見に行かない）。
			started.fire();
			await timeout(5 * 60 * 1000);
			disposables.dispose();
		});
		return delays;
	}

	test('常駐が持っている端末は、サーバーを生かしておく理由にしない', async () => {
		assert.deepStrictEqual(
			{ daemonHeld: await delaysWhileWaiting([{ id: 1, paradisHeldByDaemon: true }]), inServer: (await delaysWhileWaiting([{ id: 1 }])) > 0 },
			{ daemonHeld: 0, inServer: true },
		);
	});
});
