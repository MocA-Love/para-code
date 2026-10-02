/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { Event } from '../../../../../base/common/event.js';
import { ParadisCdpUpstream } from '../../../agentBrowser/node/paradisCdpUpstream.js';
import { paradisMobileBookmarksPayload } from '../../common/paradisMobileBookmarks.js';
import { paradisMobileBrowserPageMessage, paradisNormalizeMobileBrowserFocusReport } from '../../common/paradisMobileBrowserPageState.js';
import { paradisParseMobileBookmarks, paradisParseMobileBrowserFocus, paradisParseMobileBrowserInputRejected, paradisParseMobileBrowserPage } from '../../common/paradisMobileBrowserProtocol.js';
import { paradisMobileBrowserTargetsScope } from '../../common/paradisMobileBrowserScope.js';
import { paradisHasMobileCapability } from '../../common/paradisMobileCompat.js';
import { ParadisMobileBrowserMirror } from '../../node/paradisMobileBrowserMirror.js';
import type { MobileIdentity } from '../../common/paradisMobileCrypto.js';
import { Channels } from '../../common/paradisMobileProtocol.js';
import { IParadisMobileInboundFrame, ParadisMobileInboundFrameWire } from '../../common/paradisMobileRelay.js';
import { paradisIsValidAgentInboundForTest } from '../../node/paradisMobileAgentChat.js';
import { ParadisMobileOperationLedger } from '../../node/paradisMobileOperationLedger.js';
import { MobileSession, ParadisMobileRelayService } from '../../node/paradisMobileRelayService.js';
import { ParadisMobileTerminalRegistry } from '../../node/paradisMobileTerminalRegistry.js';

/**
 * PC ⇔ モバイルの公開ワイヤの固定形（ゴールデン、`app/protocol/test/golden/`）を PC 側から確かめる。
 *
 * - PC が組み立てる State が、ゴールデンと同じ形（項目名と値の型）であること
 * - アプリが送る形（State の要求・term の操作・agent の要求）を、PC が受け付けること
 *
 * アプリ側は `app/mobile/src/wireGolden.test.ts` が同じファイルを読み、逆向き（アプリが送る形と、
 * PC が送る形を受け付けること）を確かめる。形を変えたらゴールデンと両方のテストを同じ変更で直す。
 * app/ の vitest はこのリポジトリの CI で走らないので、PC 側のここが CI の歯止めになる。
 */

/** このテストのレイヤーでは `path` を import できないため、区切りは '/' に正規化して扱う。 */
function findRepositoryDirectory(relativePath: string): string | undefined {
	let directory = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/');
	if (!directory.endsWith('/')) {
		directory += '/';
	}
	for (let depth = 0; depth < 12; depth++) {
		const candidate = `${directory}${relativePath}`;
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = directory.slice(0, directory.lastIndexOf('/', directory.length - 2) + 1);
		if (parent.length === 0 || parent === directory) {
			return undefined;
		}
		directory = parent;
	}
	return undefined;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 値を「項目名と値の型」だけの形にする。配列は先頭の要素の形で代表させる（ゴールデンは先頭に全項目を持たせてある）。 */
function shapeOf(value: unknown): Json {
	if (Array.isArray(value)) {
		return value.length === 0 ? [] : [shapeOf(value[0])];
	}
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => [key, shapeOf(record[key])]));
	}
	return typeof value;
}

suite('ParadisMobileWireGolden', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let goldenRoot: string | undefined;
	suiteSetup(() => {
		goldenRoot = findRepositoryDirectory('app/protocol/test/golden');
	});

	function readGolden<T>(context: Mocha.Context, name: string): T {
		if (goldenRoot === undefined) {
			// リポジトリ外（配布物など）から実行された場合は照合対象が無い。
			context.skip();
		}
		return JSON.parse(readFileSync(`${goldenRoot}/${name}`, 'utf8')) as T;
	}

	test('PC が組み立てる State はゴールデンの current と同じ形', function () {
		const golden = readGolden<{ current: Record<string, unknown> }>(this, 'state.json');
		const registry = new ParadisMobileTerminalRegistry('golden-desktop-epoch');
		registry.syncWindow(1, 'window-session', 2, {
			activeWs: 'repo',
			workspaces: [{
				id: 'repo', name: 'para-code', color: '#0969da', branch: 'main', parent: 'parent',
				pr: { number: 135, state: 'open', url: 'https://github.com/example/para-code/pull/135' },
				note: { open: 2, done: 1 }, pinned: true,
			}],
			terminals: [{ terminalKey: 'terminal-key-1', id: 7, title: 'claude', ws: 'repo', agent: true, agentToken: 'agent-token-1', agentStatus: 'working', cols: 120, rows: 40 }],
			battery: { level: 80, charging: true },
			host: { kind: 'remote', id: 'ssh-remote+devbox', label: 'devbox', machineIdHash: 'a'.repeat(64) },
		});
		registry.setHostResources({ cpu: 25, memUsed: 8589934592, memTotal: 17179869184, diskFree: 107374182400, diskTotal: 494384795648 });
		registry.setPcName('MacBook-Pro');
		registry.setMachineIdHash('b'.repeat(64));
		const built = JSON.parse(JSON.stringify(registry.desktopState()));
		// 版・互換の窓・機能の広告・既存の能力の印は、形だけでなく値まで一致させる
		// （PC がこれらを変えたら、アプリの判定が変わるのでゴールデンも同じ変更で直す）。
		const pick = (state: Record<string, unknown>) => Object.fromEntries(['protocolVersion', 'minCompatibleMobile', 'capabilities', 'fsUploadEncoding', 'voiceClips'].map(key => [key, state[key]]));
		assert.deepStrictEqual({ shape: shapeOf(built), values: pick(built) }, { shape: shapeOf(golden.current), values: pick(golden.current) });
	});

	test('State の要求: 今のアプリも W2-17 より前のアプリも通り、今のアプリの capability を覚える', function () {
		const golden = readGolden<{ current: object; preW217: object }>(this, 'state-request.json');
		const session = new MobileSession('mobile-a', new Uint8Array(16), new Uint8Array(32), {} as MobileIdentity, () => true, () => { }, undefined, new NullLogService());
		const negotiate = (request: object) => {
			const ok = session.negotiateProtocol(VSBuffer.fromString(JSON.stringify(request)).buffer);
			return { ok, termSync: paradisHasMobileCapability(session.capabilities, 'term.sync.v1'), advertised: session.capabilities !== undefined };
		};
		assert.deepStrictEqual({
			current: negotiate(golden.current),
			preW217: negotiate(golden.preW217),
			newerAppWithinWindow: negotiate({ ...golden.current, protocolVersion: 4, minCompatiblePc: 3 }),
			newerAppWithoutWindow: negotiate({ ...golden.preW217, protocolVersion: 4 }),
		}, {
			current: { ok: true, termSync: true, advertised: true },
			preW217: { ok: true, termSync: false, advertised: false },
			newerAppWithinWindow: { ok: true, termSync: true, advertised: true },
			newerAppWithoutWindow: { ok: false, termSync: false, advertised: false },
		});
	});

	test('term: アプリが送る操作はすべて持ち主の PC 画面へ届く', async function () {
		const golden = readGolden<{ toPc: Array<Record<string, unknown>> }>(this, 'term.json');
		const registry = new ParadisMobileTerminalRegistry('golden-desktop-epoch');
		registry.syncWindow(1, 'window-session', 2, {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'para-code' }],
			terminals: [{ terminalKey: 'terminal-key-1', id: 7, title: 'claude', ws: 'repo' }],
		});
		const delivered: ParadisMobileInboundFrameWire[] = [];
		const results: string[] = [];
		const terminalOperationTimers = new Map<string, ReturnType<typeof setTimeout>>();
		const service = Object.assign(Object.create(ParadisMobileRelayService.prototype) as object, {
			terminalRegistry: registry,
			terminalOperations: new ParadisMobileOperationLedger(),
			terminalOperationTimers,
			sessions: new Map([['mobile-a', { hasCurrentProtocol: true, sendFrame: async (_ch: string, _ws: undefined, payload: Uint8Array) => { results.push(new TextDecoder().decode(payload)); } }]]),
			logService: new NullLogService(),
			withCurrentRegisteredLease: async (_owner: unknown, task: () => Promise<boolean>) => task(),
			_onInboundFrame: { fire: (frame: ParadisMobileInboundFrameWire) => delivered.push(frame) },
		}) as unknown as { handleTerminalFrame(frame: IParadisMobileInboundFrame): Promise<void> };
		try {
			for (const [index, message] of golden.toPc.entries()) {
				await service.handleTerminalFrame({ ch: Channels.Terminal, ws: undefined, seq: index + 1, payload: VSBuffer.fromString(JSON.stringify(message)), mobileId: 'mobile-a' });
			}
		} finally {
			for (const timer of terminalOperationTimers.values()) {
				clearTimeout(timer);
			}
		}
		assert.deepStrictEqual({
			delivered: delivered.map(frame => `${frame[1]} ${JSON.parse(frame[3].toString()).t}`),
			rejected: results,
		}, {
			delivered: golden.toPc.map(message => `window:1:2:window-session ${message.t}`),
			rejected: [],
		});
	});

	test('agent: アプリが送る要求はすべて PC の検査を通る', function () {
		const golden = readGolden<{ toPc: Array<{ t: string }> }>(this, 'agent.json');
		assert.deepStrictEqual(golden.toPc.map(message => [message.t, paradisIsValidAgentInboundForTest(message)]), golden.toPc.map(message => [message.t, true]));
	});

	test('browser: アプリが送る形を PC が受け、PC が組み立てる形はゴールデンと同じ形', async function () {
		type Message = Record<string, unknown>;
		const golden = readGolden<{ toPc: Message[]; toMobile: Message[]; bookmarks: { toPc: Message; toMobile: Message; push: Message } }>(this, 'browser.json');
		const state = readGolden<{ current: { renderers: { windowId: number }[]; workspaces: { sourceId: string }[] } }>(this, 'state.json');
		const logService = new NullLogService();
		const upstream = new ParadisCdpUpstream('', logService);
		(upstream as unknown as { fetchJson: () => Promise<unknown> }).fetchJson = async () => [
			{ id: 'target-1', type: 'page', title: 'Docs', url: 'https://example.com/docs' },
			{ id: 'target-other', type: 'page', title: 'Other', url: 'https://example.com/other' },
		];
		const asked: unknown[] = [];
		const mirror = new ParadisMobileBrowserMirror(upstream, undefined, { listBoundCdpTargets: async () => [{ token: 'pane-token-1', targetId: 'target-1' }], onDidAcknowledgePane: Event.None }, logService, {
			resolveSpaceTargetIds: async (windowId, ws) => { asked.push([windowId, ws]); return new Set(['target-1']); },
		});
		try {
			const replies: Message[] = [];
			await mirror.handleRequest('m', new TextEncoder().encode(JSON.stringify(golden.toPc[0])), payload => replies.push(JSON.parse(new TextDecoder().decode(payload))));

			// 入力の各種類が CDP の呼び出しになる（新しい種類を PC が受け付ける）
			const sentCdp: string[] = [];
			const session = {
				socket: { close: () => undefined, readyState: 1, send: (data: string) => sentCdp.push(JSON.parse(data).method) } as unknown as WebSocket,
				targetId: 'target-1', nextId: 1, viewWidth: 800, viewHeight: 600, captureTimer: undefined, captureInFlight: false, lastFrameData: undefined,
				handlers: new Map(), pushMode: true, pushStarted: false, lastPushFrameAt: Date.now(), lastMetricsAt: 0, binaryFrames: false,
				send: () => undefined, focusContextId: 1,
			};
			const internals = mirror as unknown as { sessions: Map<string, typeof session>; cdpCall: (target: typeof session, method: string, params: object, handler: (result: unknown) => void) => void };
			internals.sessions.set('m', session);
			internals.cdpCall = (_session, method, _params, handler) => handler(method === 'Runtime.evaluate' ? { result: { value: true } } : undefined);
			const inputKinds: [unknown, number][] = [];
			for (const message of golden.toPc.filter(candidate => candidate.t === 'input')) {
				const before = sentCdp.length;
				await mirror.handleRequest('m', new TextEncoder().encode(JSON.stringify(message)), () => undefined);
				inputKinds.push([message.kind, sentCdp.length - before]);
			}
			internals.sessions.delete('m');

			const pageMessage = paradisMobileBrowserPageMessage('target-1', { url: 'https://example.com/docs', title: 'Docs', loading: true, progress: 0.6, canGoBack: true, canGoForward: false });
			const focusMessage = paradisNormalizeMobileBrowserFocusReport(JSON.stringify({ focused: true, fieldId: 7, field: 'text', inputType: 'search', value: 'x'.repeat(5000), reason: 'tap' }), { targetId: 'target-1', seq: 3, now: 0, lastTapAt: 0 });
			const blurMessage = paradisNormalizeMobileBrowserFocusReport(JSON.stringify({ focused: false, reason: 'focus' }), { targetId: 'target-1', seq: 4, now: 0, lastTapAt: 0 });
			const bookmarksReply = {
				...paradisMobileBookmarksPayload([
					{ id: 'folder-1', type: 'folder', title: '仕事', icon: 'briefcase', color: '#2563eb', createdAt: 0, children: [{ id: 'bookmark-2', type: 'bookmark', title: 'Issues', url: 'https://example.com/issues', createdAt: 0 }] },
					{ id: 'bookmark-1', type: 'bookmark', title: 'Docs', url: 'https://example.com/docs', faviconHash: 'hash-1', createdAt: 0 },
				], hash => hash === 'hash-1' ? 'data:image/png;base64,iVBORw0KGgo=' : undefined), id: 'm-r-2'
			};
			const withoutId = (message: Message) => Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'id'));

			assert.deepStrictEqual({
				scope: paradisMobileBrowserTargetsScope(golden.toPc[0]),
				asked,
				targets: replies.map(shapeOf),
				targetsValue: replies[0],
				inputKinds: inputKinds.map(([kind, calls]) => [kind, calls > 0]),
				page: shapeOf(pageMessage),
				focus: shapeOf(focusMessage),
				blur: shapeOf(blurMessage),
				bookmarks: bookmarksReply,
				parsed: [paradisParseMobileBrowserPage(golden.toMobile[1]), paradisParseMobileBrowserFocus(golden.toMobile[2]), paradisParseMobileBrowserFocus(golden.toMobile[3]), paradisParseMobileBookmarks(golden.bookmarks.toMobile), paradisParseMobileBrowserInputRejected(golden.toMobile[4])],
			}, {
				scope: { windowId: state.current.renderers[0].windowId, ws: state.current.workspaces[0].sourceId },
				asked: [[state.current.renderers[0].windowId, state.current.workspaces[0].sourceId]],
				targets: [shapeOf(golden.toMobile[0])],
				targetsValue: golden.toMobile[0],
				inputKinds: golden.toPc.filter(candidate => candidate.t === 'input').map(message => [message.kind, true]),
				page: shapeOf(golden.toMobile[1]),
				focus: shapeOf(golden.toMobile[2]),
				blur: shapeOf(golden.toMobile[3]),
				bookmarks: golden.bookmarks.toMobile,
				parsed: [golden.toMobile[1], golden.toMobile[2], golden.toMobile[3], withoutId(golden.bookmarks.toMobile), golden.toMobile[4]],
			});
		} finally {
			mirror.dispose();
		}
	});
});
