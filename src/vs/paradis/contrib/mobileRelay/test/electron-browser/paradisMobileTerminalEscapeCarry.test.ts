/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileWorkspaceProvider } from '../../electron-browser/paradisMobileWorkspaceProvider.js';

interface ISentTermFrame {
	readonly mobileId: string;
	readonly data?: string;
	readonly snapshot?: boolean;
	readonly seq?: number;
}

interface ITermCarryFixture {
	sendTermData(id: number, data: string): void;
	flushTermData(id: number, mobileId: string): void;
	sendTerminalSnapshot(instance: unknown, id: number, mobileId: string, reason: 'attach' | 'flow' | 'resize'): void;
}

/** snapshot の後の最初のチャンクに、直前で切れていた制御シーケンスの断片が付くか（W2-18）。 */
suite('ParadisMobileWorkspaceProvider terminal escape carry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createFixture() {
		const sent: ISentTermFrame[] = [];
		const syncState = () => ({
			epoch: 1, seq: 0, inflight: [], unackedChars: 0, suspended: false, droppedWhileSuspended: false,
			pending: [], pendingChars: 0, coalesceTimer: undefined, resizeTimer: undefined,
		});
		const provider = Object.assign(Object.create(ParadisMobileWorkspaceProvider.prototype) as object, {
			terminalSubscribers: new Map([[1, new Set(['phone', 'tablet'])]]),
			termSyncStates: new Map([['phone\u00001', syncState()], ['tablet\u00001', syncState()]]),
			termEscapeTails: new Map<number, string>(),
			snapshotMetrics: new Map(),
			logService: { warn: () => { } },
			serializeTerminalSnapshot: async () => 'SNAPSHOT',
			sendTerm: (_id: number, mobileId: string, msg: { data?: string; snapshot?: boolean; seq?: number }) => {
				sent.push({ mobileId, data: msg.data, ...(msg.snapshot ? { snapshot: true } : {}), seq: msg.seq });
			},
		}) as unknown as ITermCarryFixture;
		const instance = { cols: 80, rows: 24, xterm: { raw: { unicode: { activeVersion: '11' } } } };
		const flushAll = () => {
			provider.flushTermData(1, 'phone');
			provider.flushTermData(1, 'tablet');
		};
		return { provider, instance, sent, flushAll };
	}

	test('prepends the cut sequence to the first chunk after the snapshot only for the subscriber that took it', async () => {
		const { provider, instance, sent, flushAll } = createFixture();
		provider.sendTermData(1, 'output \x1b[3');
		flushAll();
		provider.sendTerminalSnapshot(instance, 1, 'phone', 'attach');
		await new Promise(resolve => setTimeout(resolve, 0));
		provider.sendTermData(1, '1mRED');
		flushAll();
		provider.sendTermData(1, ' more');
		flushAll();
		assert.deepStrictEqual(sent, [
			{ mobileId: 'phone', data: 'output \x1b[3', seq: 1 },
			{ mobileId: 'tablet', data: 'output \x1b[3', seq: 1 },
			{ mobileId: 'phone', data: 'SNAPSHOT', snapshot: true, seq: 2 },
			{ mobileId: 'phone', data: '\x1b[31mRED', seq: 3 },
			{ mobileId: 'tablet', data: '1mRED', seq: 2 },
			{ mobileId: 'phone', data: ' more', seq: 4 },
			{ mobileId: 'tablet', data: ' more', seq: 3 },
		]);
	});

	test('adds nothing when the stream ended on a complete sequence', async () => {
		const { provider, instance, sent, flushAll } = createFixture();
		provider.sendTermData(1, '\x1b[31mRED\x1b[0m');
		flushAll();
		provider.sendTerminalSnapshot(instance, 1, 'phone', 'resize');
		await new Promise(resolve => setTimeout(resolve, 0));
		provider.sendTermData(1, 'next');
		flushAll();
		assert.deepStrictEqual(sent.filter(frame => frame.mobileId === 'phone').map(frame => frame.data), ['\x1b[31mRED\x1b[0m', 'SNAPSHOT', 'next']);
	});
});
