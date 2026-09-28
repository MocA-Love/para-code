/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/runWithFakedTimers.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { paradisMobileTerminalViewportStatus } from '../../common/paradisMobileTerminalViewportStatus.js';
import { createParadisMobileViewportBanner } from '../../browser/paradisMobileViewportBannerView.js';
import { ParadisMobileWorkspaceProvider } from '../../electron-browser/paradisMobileWorkspaceProvider.js';

interface ITakebackFixture {
	handleTerminalInbound(payload: VSBuffer, mobileId: string | undefined): Promise<void>;
	takeBackTerminalViewport(id: number): void;
	clearAllTerminalViewports(): void;
}

/** PC の［PC の幅に戻す］と、スマホが離れたときの猶予（W2-19）。 */
suite('ParadisMobileWorkspaceProvider viewport take-back', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createFixture() {
		const resized: string[] = [];
		const sent: string[] = [];
		const subscribers = new Map([[1, new Set(['phone'])]]);
		const instance = {
			instanceId: 1,
			shellLaunchConfig: {},
			maxCols: 120,
			maxRows: 40,
			setOverrideDimensions: (dimensions: { cols: number; rows: number; forceExactSize?: boolean } | undefined) => {
				resized.push(dimensions === undefined ? 'restore' : `${dimensions.cols}x${dimensions.rows}${dimensions.forceExactSize ? ' exact' : ''}`);
			},
		};
		const provider = Object.assign(Object.create(ParadisMobileWorkspaceProvider.prototype) as object, {
			_store: { isDisposed: false },
			terminalSubscribers: subscribers,
			termSyncStates: new Map(),
			termViewports: new Map(),
			termAppliedDimensions: new Map(),
			termOverriddenInstanceIds: new Set(),
			termViewportRevoked: new Set(),
			termViewportReleaseTimers: new Map(),
			viewportLeaseSweeper: { cancelAndSet: () => { }, cancel: () => { } },
			viewportLeaseSweeperRunning: false,
			attachedTerminals: { deleteAndDispose: () => { }, has: () => true },
			terminalIdentityService: { getInstanceId: (key: string) => key === 'terminal-1' ? 1 : undefined, getTerminalKey: () => 'terminal-1' },
			allInstances: () => [instance],
			completeTerminalOperation: async () => { },
			logService: { info: () => { }, warn: () => { } },
			sendTerm: (_id: number, mobileId: string, msg: { t: string }) => { sent.push(`${mobileId} ${msg.t}`); },
		}) as unknown as ITakebackFixture;
		let operation = 0;
		const inbound = (message: Record<string, unknown>) => provider.handleTerminalInbound(
			VSBuffer.fromString(JSON.stringify({ protocolVersion: 3, desktopEpoch: 'epoch', operationId: `op-${++operation}`, terminalKey: 'terminal-1', ...message })),
			'phone',
		);
		// PC の restore は「無害な override を挟んでから外す」の 2 段なので、1 回の戻しは 2 行になる。
		const restoredAs = (lines: string[]) => lines.join(' | ').replace(/120x40 \| restore/g, 'PC');
		return { provider, inbound, resized, sent, subscribers, restoredAs };
	}

	test('takes the terminal back, ignores the phone until it reopens or reclaims, and tells the phone', async () => {
		const { provider, inbound, resized, sent, subscribers, restoredAs } = createFixture();
		await inbound({ t: 'viewport', viewCols: 50, viewRows: 20 });
		const shrunk = paradisMobileTerminalViewportStatus.get(1);
		provider.takeBackTerminalViewport(1);
		const afterTakeBack = paradisMobileTerminalViewportStatus.get(1);
		// 旧アプリは戻されたことを知らずに申告を送り続ける。
		await inbound({ t: 'viewport', viewCols: 50, viewRows: 20 });
		await inbound({ t: 'attach', epoch: 2, viewCols: 50, viewRows: 20 }).catch(() => { /* attach の snapshot は fixture に無い */ });
		const ignored = [...resized];
		// ［再び合わせる］。
		await inbound({ t: 'viewport', viewCols: 50, viewRows: 20, reclaim: true });
		provider.takeBackTerminalViewport(1);
		// 開き直す（detach → attach）と、また縮めてよい。
		await inbound({ t: 'detach' });
		subscribers.set(1, new Set(['phone']));
		await inbound({ t: 'viewport', viewCols: 44, viewRows: 18 });
		provider.clearAllTerminalViewports();
		assert.deepStrictEqual({
			shrunk,
			afterTakeBack,
			ignored: restoredAs(ignored),
			resized: restoredAs(resized),
			sent,
			final: paradisMobileTerminalViewportStatus.get(1),
		}, {
			shrunk: { cols: 50, rows: 20 },
			afterTakeBack: undefined,
			ignored: '50x20 exact | PC',
			resized: '50x20 exact | PC | 50x20 exact | PC | 44x18 exact | PC',
			sent: ['phone viewport-revoked', 'phone viewport-revoked'],
			final: undefined,
		});
	});

	test('keeps the phone size for a few seconds after the phone leaves, and does not resize when it comes back', () => runWithFakedTimers({}, async () => {
		const { provider, inbound, resized, subscribers, restoredAs } = createFixture();
		await inbound({ t: 'viewport', viewCols: 50, viewRows: 20 });
		// タブを離れる（申告の取り下げと detach）。
		await inbound({ t: 'viewport' });
		await inbound({ t: 'detach' });
		await new Promise(resolve => setTimeout(resolve, 1000));
		const whileAway = { resized: restoredAs(resized), status: paradisMobileTerminalViewportStatus.get(1) };
		// すぐ戻ってきた。
		subscribers.set(1, new Set(['phone']));
		await inbound({ t: 'viewport', viewCols: 50, viewRows: 20 });
		await new Promise(resolve => setTimeout(resolve, 10_000));
		const cameBack = restoredAs(resized);
		// 今度は離れたまま。
		await inbound({ t: 'detach' });
		await new Promise(resolve => setTimeout(resolve, 10_000));
		assert.deepStrictEqual({ whileAway, cameBack, left: restoredAs(resized), status: paradisMobileTerminalViewportStatus.get(1) }, {
			whileAway: { resized: '50x20 exact', status: { cols: 50, rows: 20 } },
			cameBack: '50x20 exact',
			left: '50x20 exact | PC',
			status: undefined,
		});
		provider.clearAllTerminalViewports();
	}));

	test('the banner shows the phone size and takes the terminal back', () => {
		const container = mainWindow.document.createElement('div');
		const takenBack: number[] = [];
		const controller = paradisMobileTerminalViewportStatus.setController({ takeBack: id => takenBack.push(id) });
		const banner = createParadisMobileViewportBanner(container, paradisMobileTerminalViewportStatus);
		store.add({ dispose: () => { banner.dispose(); controller.dispose(); } });
		banner.setInstance(7);
		const hiddenAtFirst = container.textContent;
		paradisMobileTerminalViewportStatus.set(7, { cols: 45, rows: 30 });
		const shown = container.querySelector('.paradis-mobile-viewport-banner')?.textContent;
		(container.querySelector('.monaco-text-button') as HTMLElement | null)?.click();
		paradisMobileTerminalViewportStatus.set(7, undefined);
		assert.deepStrictEqual({ hiddenAtFirst, shown, takenBack, hiddenAfter: container.textContent }, {
			hiddenAtFirst: '',
			shown: 'スマホ表示に合わせて縮小中45×30PC の幅に戻す',
			takenBack: [7],
			hiddenAfter: '',
		});
	});
});
