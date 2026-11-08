/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 窓を閉じると、その窓の IPC の購読は shared process 側で外れる。最後の購読が外れたら映像の流れを閉じること。

import assert from 'assert';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisServeSimBackend } from '../../node/paradisServeSimBackend.js';
import { ParadisSimulatorService } from '../../node/paradisSimulatorChannel.js';
import { IParadisSimulatorHostConnection } from '../../node/paradisSimulatorHostProcess.js';

const UDID = 'A1B2C3D4-0000-1111-2222-333344445555';

suite('Paradis simulator: video relay in the shared process', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('opens the stream for the first subscriber and closes it when the last one goes away', () => {
		let open = 0;
		let emit: ((jpeg: Uint8Array) => void) | undefined;
		const backend = {
			subscribeFrames(_udid: string, onFrame: (jpeg: Uint8Array) => void): IDisposable {
				open++;
				emit = onFrame;
				return toDisposable(() => open--);
			},
		} as unknown as ParadisServeSimBackend;
		const host = { ensure: async (): Promise<IParadisSimulatorHostConnection> => ({ socketPath: '', token: '' }), isRunning: false, lastError: undefined, stop: async () => { } };
		const service = store.add(new ParadisSimulatorService(host, backend, () => true, true, new NullLogService()));
		const received: number[] = [];
		const first = service.onFrames(UDID)(frame => received.push(frame.jpeg.byteLength));
		const second = service.onFrames(UDID)(() => { });
		emit?.(new Uint8Array(3));
		const whileOpen = open;
		first.dispose();
		const afterFirst = open;
		second.dispose();
		const disabledService = store.add(new ParadisSimulatorService(host, backend, () => false, true, new NullLogService()));
		const disabled = disabledService.onFrames(UDID)(() => { });
		disabled.dispose();
		assert.deepStrictEqual({ whileOpen, afterFirst, afterLast: open, received, openedWhileDisabled: open }, { whileOpen: 1, afterFirst: 1, afterLast: 0, received: [3], openedWhileDisabled: 0 });
	});
});
