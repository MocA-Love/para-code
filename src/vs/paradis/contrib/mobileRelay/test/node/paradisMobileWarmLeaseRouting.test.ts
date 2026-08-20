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
import { IParadisMobileInboundFrame, ParadisMobileInboundFrameWire } from '../../common/paradisMobileRelay.js';
import { ParadisMobileRelayService } from '../../node/paradisMobileRelayService.js';
import { ParadisMobileTerminalRegistry } from '../../node/paradisMobileTerminalRegistry.js';

suite('ParadisMobileRelay warm lease routing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const encode = (value: object) => VSBuffer.fromString(JSON.stringify(value));

	function createHarness() {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		registry.syncWindow(7, 'old-session', 1, {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'Repo' }],
			terminals: [],
		});
		const delivered: ParadisMobileInboundFrameWire[] = [];
		const service = Object.assign(Object.create(ParadisMobileRelayService.prototype) as object, {
			rendererAuthorityChain: Promise.resolve(),
			terminalRegistry: registry,
			windowLeaseClient: {
				validate: async () => ({ valid: true, manifestRevision: 1, windowRevision: 1 }),
			},
			_onInboundFrame: { fire: (frame: ParadisMobileInboundFrameWire) => delivered.push(frame) },
			sessions: new Map(),
			logService: new NullLogService(),
		}) as unknown as { handleWindowFrame(frame: IParadisMobileInboundFrame): Promise<void> };
		const send = (ch: typeof Channels.Fs | typeof Channels.Scm, value: object) => service.handleWindowFrame({
			ch,
			ws: undefined,
			seq: 1,
			payload: encode(value),
			mobileId: 'mobile-a',
		});
		return { registry, delivered, send };
	}

	test('forwards only warm requests matching the current desktop, window and renderer generation', async () => {
		const { registry, delivered, send } = createHarness();
		registry.syncWindow(7, 'new-session', 2, {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'Repo' }],
			terminals: [],
		});
		const base = { leaseId: 'lease-1', desktopEpoch: 'desktop-epoch', windowId: 7 };
		await send(Channels.Fs, { t: 'usageWarmLease', ...base, desktopEpoch: 'stale-epoch', active: true, rendererGeneration: 2 });
		await send(Channels.Fs, { t: 'usageWarmLease', ...base, windowId: 8, active: true, rendererGeneration: 2 });
		await send(Channels.Fs, { t: 'usageWarmLease', ...base, active: true, rendererGeneration: 1 });
		await send(Channels.Fs, { t: 'usageWarmLease', ...base, active: false, rendererGeneration: 1 });
		await send(Channels.Scm, { t: 'usageWarmLease', ...base, active: true, rendererGeneration: 2 });
		await send(Channels.Fs, { t: 'spaceDiskWarmLease', ...base, active: true, rendererGeneration: 2 });

		assert.deepStrictEqual(delivered.map(frame => ({ ch: frame[0], ws: frame[1], body: JSON.parse(frame[3].toString()) })), [{
			ch: Channels.Fs,
			ws: 'window:7:2:new-session',
			body: { t: 'spaceDiskWarmLease', ...base, active: true, rendererGeneration: 2 },
		}]);
	});

	test('keeps protocol v3 FS and SCM workspace requests compatible without rendererGeneration', async () => {
		const { registry, delivered, send } = createHarness();
		registry.syncWindow(7, 'new-session', 2, {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'Repo' }],
			terminals: [],
		});
		const target = { protocolVersion: 3, desktopEpoch: 'desktop-epoch', windowId: 7, ws: 'repo' };
		await send(Channels.Fs, { t: 'read', id: 'fs-1', path: 'README.md', ...target });
		await send(Channels.Scm, { t: 'status', id: 'scm-1', ...target });

		assert.deepStrictEqual(delivered.map(frame => [frame[0], frame[1]]), [
			[Channels.Fs, 'window:7:2:new-session'],
			[Channels.Scm, 'window:7:2:new-session'],
		]);
	});

	// 「接続先セグメント」(usage/rtk/limits/github) は ws を持たず、windowId + rendererGeneration
	// だけで対象ウィンドウを指定する。ws解決とは別の検証経路なので個別に確認する。
	test('routes workspace-less requests (usage/rtk/limits) by windowId + rendererGeneration alone', async () => {
		const { registry, delivered, send } = createHarness();
		registry.syncWindow(7, 'new-session', 2, {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'Repo' }],
			terminals: [],
		});
		const target = { protocolVersion: 3, desktopEpoch: 'desktop-epoch', windowId: 7, rendererGeneration: 2 };
		await send(Channels.Fs, { t: 'usage', id: 'usage-1', ...target });

		assert.deepStrictEqual(delivered.map(frame => [frame[0], frame[1]]), [
			[Channels.Fs, 'window:7:2:new-session'],
		]);
	});

	test('does not route workspace-less requests when rendererGeneration is stale (reload boundary)', async () => {
		const { registry, delivered, send } = createHarness();
		registry.syncWindow(7, 'new-session', 2, {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'Repo' }],
			terminals: [],
		});
		const target = { protocolVersion: 3, desktopEpoch: 'desktop-epoch', windowId: 7, rendererGeneration: 1 };
		await send(Channels.Fs, { t: 'usage', id: 'usage-1', ...target });

		assert.deepStrictEqual(delivered, []);
	});

	// ws無し+rendererGeneration一致の経路は「接続先セグメント」向けの型だけに絞る。
	// 許可リストに無い型（uploadのように本来 ws による所有権検証を必要とする操作）が
	// ws を省略するだけでこの経路を通れてしまうと、ws解決の検証を素通りすることになる。
	test('does not route a request whose type is outside the workspace-less allowlist even with a valid windowId + rendererGeneration', async () => {
		const { registry, delivered, send } = createHarness();
		registry.syncWindow(7, 'new-session', 2, {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'Repo' }],
			terminals: [],
		});
		const target = { protocolVersion: 3, desktopEpoch: 'desktop-epoch', windowId: 7, rendererGeneration: 2 };
		await send(Channels.Fs, { t: 'upload', id: 'upload-1', name: 'a.png', data: 'AA==', ...target });

		assert.deepStrictEqual(delivered, []);
	});

	test('does not route a request with neither ws nor rendererGeneration', async () => {
		const { registry, delivered, send } = createHarness();
		registry.syncWindow(7, 'new-session', 2, {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'Repo' }],
			terminals: [],
		});
		await send(Channels.Fs, { t: 'usage', id: 'usage-1', protocolVersion: 3, desktopEpoch: 'desktop-epoch', windowId: 7 });

		assert.deepStrictEqual(delivered, []);
	});
});
