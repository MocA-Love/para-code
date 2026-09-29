/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { ILocalPtyService } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisPrepareTerminalShutdown } from '../../../../../workbench/contrib/terminal/browser/paradisTerminalShutdownPolicy.js';
import { ILifecycleService, ShutdownReason } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ParadisTerminalCloseCleanupQuit } from '../../electron-browser/paradisTerminalCloseCleanupQuit.contribution.js';

suite('ParadisTerminalCloseCleanupQuit', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(windowCount: number): { readonly sent: boolean[]; readonly veto: Emitter<void>; readonly connected: DeferredPromise<void> } {
		const sent: boolean[] = [];
		const veto = store.add(new Emitter<void>());
		const connected = new DeferredPromise<void>();
		const localPtyService = { paradisSetAppQuitting: async (quitting: boolean) => { sent.push(quitting); } } as Partial<ILocalPtyService> as ILocalPtyService;
		const lifecycleService = { onShutdownVeto: veto.event } as Partial<ILifecycleService> as ILifecycleService;
		const nativeHostService = { getWindowCount: async () => windowCount } as Partial<INativeHostService> as INativeHostService;
		const terminalService = { whenConnected: connected.p } as Partial<ITerminalService> as ITerminalService;
		store.add(new ParadisTerminalCloseCleanupQuit(localPtyService, lifecycleService, nativeHostService, terminalService, new NullLogService()));
		return { sent, veto, connected };
	}

	test('起動時に前の終了の印を下ろし、終了で立て、取り消しで下ろす（Q136）', async () => {
		const { sent, veto, connected } = create(2);
		await timeout(0);
		const atStartup = [...sent];
		// ターミナルの復元が終わった後にもう一度下ろす（起動直後は pty ホストへ届かないことがある）。
		connected.complete();
		await timeout(0);
		const afterRestore = [...sent];
		// 残りのウィンドウがあるうちに 1 枚を閉じるのはアプリの終了ではない。
		await paradisPrepareTerminalShutdown(ShutdownReason.CLOSE);
		const closingOneOfTwo = [...sent];
		await paradisPrepareTerminalShutdown(ShutdownReason.QUIT);
		const quitting = [...sent];
		veto.fire();
		await timeout(0);

		assert.deepStrictEqual({ atStartup, afterRestore, closingOneOfTwo, quitting, cancelled: sent }, {
			atStartup: [false],
			afterRestore: [false, false],
			closingOneOfTwo: [false, false],
			quitting: [false, false, true],
			cancelled: [false, false, true, false],
		});
	});

	test('復元が終わる前に終了が始まったら、立てたばかりの印を下ろさない（Q136）', async () => {
		const { sent, connected } = create(1);
		await timeout(0);
		await paradisPrepareTerminalShutdown(ShutdownReason.QUIT);
		connected.complete();
		await timeout(0);

		assert.deepStrictEqual(sent, [false, true]);
	});
});
