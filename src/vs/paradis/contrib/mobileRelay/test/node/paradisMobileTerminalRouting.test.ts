/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { Channels } from '../../common/paradisMobileProtocol.js';
import { IParadisMobileInboundFrame, ParadisMobileInboundFrameWire, PARADIS_MOBILE_PROTOCOL_VERSION } from '../../common/paradisMobileRelay.js';
import { ParadisMobileOperationLedger } from '../../node/paradisMobileOperationLedger.js';
import { ParadisMobileRelayService } from '../../node/paradisMobileRelayService.js';
import { ParadisMobileTerminalRegistry } from '../../node/paradisMobileTerminalRegistry.js';

suite('ParadisMobileRelay terminal routing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createHarness() {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		registry.syncWindow(7, 'window-session', 2, {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'Repo' }],
			terminals: [{ terminalKey: 'terminal', id: 1, title: 'Terminal' }],
		});
		const delivered: ParadisMobileInboundFrameWire[] = [];
		const terminalOperationTimers = new Map<string, ReturnType<typeof setTimeout>>();
		const service = Object.assign(Object.create(ParadisMobileRelayService.prototype) as object, {
			terminalRegistry: registry,
			terminalOperations: new ParadisMobileOperationLedger(),
			terminalOperationTimers,
			sessions: new Map(),
			logService: new NullLogService(),
			withCurrentRegisteredLease: async (_owner: unknown, task: () => Promise<boolean>) => task(),
			_onInboundFrame: { fire: (frame: ParadisMobileInboundFrameWire) => delivered.push(frame) },
		}) as unknown as { handleTerminalFrame(frame: IParadisMobileInboundFrame): Promise<void> };
		let operationSeq = 0;
		const send = async (message: object) => {
			operationSeq++;
			await service.handleTerminalFrame({
				ch: Channels.Terminal,
				ws: undefined,
				seq: operationSeq,
				payload: VSBuffer.fromString(JSON.stringify({
					protocolVersion: PARADIS_MOBILE_PROTOCOL_VERSION,
					desktopEpoch: registry.desktopEpoch,
					operationId: `operation-${operationSeq}`,
					operationRun: 1,
					operationSeq,
					terminalKey: 'terminal',
					...message,
				})),
				mobileId: 'mobile-a',
			});
		};
		const dispose = () => {
			for (const timer of terminalOperationTimers.values()) {
				clearTimeout(timer);
			}
			terminalOperationTimers.clear();
		};
		return { delivered, dispose, send };
	}

	test('routes viewport updates to the terminal owner renderer', async () => {
		const { delivered, dispose, send } = createHarness();
		try {
			await send({ t: 'viewport', viewCols: 54, viewRows: 28 });

			assert.deepStrictEqual(delivered.map(frame => ({
				channel: frame[0],
				route: frame[1],
				type: JSON.parse(frame[3].toString()).t,
			})), [{ channel: Channels.Terminal, route: 'window:7:2:window-session', type: 'viewport' }]);
		} finally {
			dispose();
		}
	});

	test('routes scroll intents to the terminal owner renderer', async () => {
		const { delivered, dispose, send } = createHarness();
		try {
			await send({ t: 'scroll', dir: 'up', lines: 3 });

			assert.deepStrictEqual(delivered.map(frame => ({
				channel: frame[0],
				route: frame[1],
				type: JSON.parse(frame[3].toString()).t,
			})), [{ channel: Channels.Terminal, route: 'window:7:2:window-session', type: 'scroll' }]);
		} finally {
			dispose();
		}
	});
});
