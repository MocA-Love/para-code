/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントのクリックやキーを、ページの上に出ているブラウザ拡張の画面（パスワード管理のページ内メニューなど）に
// 届けない。CDP ゲートウェイは拡張の iframe のターゲットと world を隠すが、ページの上に描かれた iframe そのものは、
// 座標で押すクリックやフォーカスの移ったキー入力で操作できてしまう。押せばパスワードの自動入力が起き、入った値は
// ページのスクリプトから読める。
//
// Electron 43.7.7 で実測した見分け方（2026-10-29）:
//  - 入力の座標（`Input.*` の x・y）は、見えている範囲の左上からの CSS ピクセル。`DOM.getNodeForLocation` は文書の
//    座標なので、`Page.getLayoutMetrics` の `cssVisualViewport.pageX`・`pageY` を足す。ピンチで 2 倍に拡大した
//    ページでも、足すだけで実際にクリックの届いた要素と一致した（倍率で割ると外れる）
//  - `DOM.getNodeForLocation`（DOM.enable は要らない）は閉じた shadow root の中や、同じプロセスの iframe の中まで入る。
//    別プロセスの iframe では iframe の要素を返す。その中の URL は、要素の `frameId` を、iframe のターゲット
//    （upstream が auto-attach したもの。ターゲットの id は frameId と同じ）の URL で引く。src 属性は見ない
//    （src はウェブのまま、中で拡張のページへ移れる）
//  - 別プロセスの iframe の中は、その iframe のセッションで当たり判定をやり直す。座標は `DOM.getBoxModel` の
//    content の左上（見えている範囲の座標）を引いたもの
//  - `webContents.focusedFrame` は、拡張の iframe の中の入力欄にフォーカスがあると、その iframe（URL が
//    chrome-extension://）を返す
//
// 拡張の iframe がタブに 1 つも無ければ（ほとんどの場合）、何も問い合わせずに通す。

import type { WebContents, WebFrameMain } from 'electron';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { paradisIsBrowserExtensionUrl } from '../common/paradisCdpExtensionScope.js';

/** 断るときにエージェントへ返す文。 */
export const PARADIS_EXTENSION_INPUT_DENIED_MESSAGE = 'This input would reach a browser extension\'s own UI drawn over the page (for example a password manager\'s menu). Para Code does not let agents click, tap or type into browser extension UI. Click somewhere else, or ask the user to use the extension.';

/** 拡張のページの iframe のセッションへの命令を断るときの文。 */
export const PARADIS_EXTENSION_FRAME_DENIED_MESSAGE = 'This frame shows a browser extension page. Para Code does not let agents read or operate browser extension pages.';

/** 中に別の文書を持つ要素（クリックがその文書へ届く）。 */
const FRAME_OWNER_NODE_NAMES: ReadonlySet<string> = new Set(['IFRAME', 'FRAME', 'EMBED', 'OBJECT', 'FENCEDFRAME', 'PORTAL']);

/** フォーカスのある文書へ届く入力。 */
const KEY_METHODS: ReadonlySet<string> = new Set(['Input.dispatchKeyEvent', 'Input.insertText', 'Input.imeSetComposition']);

/** 別プロセスの iframe の中へ潜る深さの上限（超えたら、タブに拡張の iframe があれば断る）。 */
const MAX_FRAME_DEPTH = 4;

/** 見張りが使う webContents の一部（テストでは偽物を渡す）。 */
export type ParadisInputGuardWebContents = Pick<WebContents, 'focusedFrame' | 'mainFrame'>;

/** 別プロセスの iframe（ターゲット）の、今の URL と CDP のセッション。 */
export interface IParadisGuardFrameTarget {
	readonly url?: string;
	readonly sessionId?: string;
}

/** 入力を判定する相手（タブ）。 */
export interface IParadisInputGuardTab {
	readonly webContents: ParadisInputGuardWebContents;
	/** タブの CDP へ命令を送る（`sessionId` が無ければページ）。 */
	send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown>;
	/** 別プロセスの iframe の frameId（= ターゲットの id）から、その URL とセッションを引く。分からなければ undefined。 */
	frameTarget(frameId: string): IParadisGuardFrameTarget | undefined;
}

/** 押す・離す・置くなど、その点の要素へ届く入力の座標。届かない入力（移動・ホイール）は空。 */
function pointsOf(method: string, params: unknown): readonly { readonly x: number; readonly y: number }[] {
	if (typeof params !== 'object' || params === null) {
		return [];
	}
	const record = params as Record<string, unknown>;
	const point = (x: unknown, y: unknown) => typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
	switch (method) {
		case 'Input.dispatchMouseEvent':
		case 'Input.emulateTouchFromMouseEvent':
			return record.type === 'mousePressed' || record.type === 'mouseReleased' ? point(record.x, record.y) : [];
		case 'Input.dispatchDragEvent':
			return record.type === 'drop' || record.type === 'dragEnter' ? point(record.x, record.y) : [];
		case 'Input.synthesizeTapGesture':
			return point(record.x, record.y);
		case 'Input.dispatchTouchEvent': {
			if (record.type !== 'touchStart' && record.type !== 'touchEnd') {
				return [];
			}
			const touches = Array.isArray(record.touchPoints) ? record.touchPoints : [];
			return touches.flatMap(touch => typeof touch === 'object' && touch !== null ? point((touch as Record<string, unknown>).x, (touch as Record<string, unknown>).y) : []);
		}
		default:
			return [];
	}
}

/** タブの中に、拡張のページを表示している iframe があるか。 */
function hasExtensionFrame(webContents: ParadisInputGuardWebContents): boolean {
	try {
		return webContents.mainFrame.framesInSubtree.some((frame: WebFrameMain) => frame !== webContents.mainFrame && paradisIsBrowserExtensionUrl(frame.url));
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 見えている範囲の (x, y) が、拡張の画面に当たるか。`sessionId` はその文書のセッション（ページなら undefined）。
 * 別プロセスのウェブの iframe に当たったら、その中で判定をやり直す。
 */
async function hitsExtensionFrame(tab: IParadisInputGuardTab, x: number, y: number, sessionId: string | undefined, depth: number): Promise<boolean> {
	let offsetX = 0;
	let offsetY = 0;
	try {
		const metrics = await tab.send('Page.getLayoutMetrics', {}, sessionId);
		const visual = isRecord(metrics) && isRecord(metrics.cssVisualViewport) ? metrics.cssVisualViewport : undefined;
		offsetX = typeof visual?.pageX === 'number' ? visual.pageX : 0;
		offsetY = typeof visual?.pageY === 'number' ? visual.pageY : 0;
	} catch {
		// 読めなければスクロールしていないとみなす
	}
	let hit: unknown;
	try {
		hit = await tab.send('DOM.getNodeForLocation', { x: Math.round(x + offsetX), y: Math.round(y + offsetY), includeUserAgentShadowDOM: true, ignorePointerEventsNone: true }, sessionId);
	} catch {
		// その点に要素が無い（画面の外など）。押しても拡張には届かない
		return false;
	}
	const backendNodeId = isRecord(hit) ? hit.backendNodeId : undefined;
	if (typeof backendNodeId !== 'number') {
		return false;
	}
	let described: unknown;
	try {
		described = await tab.send('DOM.describeNode', { backendNodeId }, sessionId);
	} catch {
		return false;
	}
	const node = isRecord(described) && isRecord(described.node) ? described.node : undefined;
	if (typeof node?.nodeName !== 'string' || !FRAME_OWNER_NODE_NAMES.has(node.nodeName.toUpperCase())) {
		// 同じプロセスの iframe の中は getNodeForLocation が潜って中の要素を返すので、ここへは来ない
		return false;
	}
	const frameId = typeof node.frameId === 'string' ? node.frameId : undefined;
	const target = frameId !== undefined ? tab.frameTarget(frameId) : undefined;
	if (paradisIsBrowserExtensionUrl(target?.url)) {
		return true;
	}
	if (target?.url === undefined || target.sessionId === undefined || depth >= MAX_FRAME_DEPTH) {
		// 中の URL かセッションが分からない別プロセスの iframe（upstream が attach していない入れ子など）。タブに拡張の
		// iframe があるときだけ、そこへ届くかもしれないとして断る
		return hasExtensionFrame(tab.webContents);
	}
	let box: unknown;
	try {
		box = await tab.send('DOM.getBoxModel', { backendNodeId }, sessionId);
	} catch {
		return hasExtensionFrame(tab.webContents);
	}
	const content = isRecord(box) && isRecord(box.model) && Array.isArray(box.model.content) ? box.model.content : undefined;
	if (typeof content?.[0] !== 'number' || typeof content[1] !== 'number') {
		return hasExtensionFrame(tab.webContents);
	}
	return hitsExtensionFrame(tab, x - content[0], y - content[1], target.sessionId, depth + 1);
}

/** 押したボタンが通ったか（離すのを断ってボタンが押されたままにならないように覚える）。 */
const pressedThrough = new WeakMap<object, boolean>();

/**
 * エージェントの入力が拡張の画面に届くなら、断る理由を返す。届かなければ undefined。
 * 座標は入力と同じ（見えている範囲の CSS ピクセル。縮小して描いているタブでは倍率を合わせた後）。
 */
export async function paradisExtensionInputRefusal(tab: IParadisInputGuardTab, method: string, params: unknown): Promise<string | undefined> {
	if (KEY_METHODS.has(method)) {
		let focused: string | undefined;
		try {
			focused = tab.webContents.focusedFrame?.url;
		} catch {
			focused = undefined;
		}
		return paradisIsBrowserExtensionUrl(focused) ? PARADIS_EXTENSION_INPUT_DENIED_MESSAGE : undefined;
	}
	const type = isRecord(params) ? params.type : undefined;
	if (method === 'Input.dispatchMouseEvent' && type === 'mouseReleased' && pressedThrough.get(tab.webContents) === true) {
		// 押したのを通したなら、離すのも通す（断るとページの中でボタンが押されたままになる）。押した点が拡張の画面なら
		// 押す時点で断っている
		pressedThrough.delete(tab.webContents);
		return undefined;
	}
	const points = pointsOf(method, params);
	let refusal: string | undefined;
	if (points.length > 0 && hasExtensionFrame(tab.webContents)) {
		for (const point of points) {
			if (await hitsExtensionFrame(tab, point.x, point.y, undefined, 0)) {
				refusal = PARADIS_EXTENSION_INPUT_DENIED_MESSAGE;
				break;
			}
		}
	}
	if (method === 'Input.dispatchMouseEvent' && type === 'mousePressed') {
		pressedThrough.set(tab.webContents, refusal === undefined);
	}
	return refusal;
}

/** CDP のターゲットの情報の一部。 */
interface ICdpTargetInfoLike {
	readonly targetId?: unknown;
	readonly url?: unknown;
}

/**
 * タブの CDP の上の、別プロセスの iframe のターゲット（id は frameId と同じ）の URL とセッションを、attach・URL の
 * 変化・切り離しのイベントで追う。upstream の BrowserViewDebugger はページで auto-attach しており、その iframe の
 * セッションの id は外から引けないので、ここで覚える。
 */
export class ParadisFrameTargetTracker {

	private readonly _targets = new Map<string, { url?: string; sessionId?: string }>();
	private readonly _sessionTargets = new Map<string, string>();

	/** CDP のイベントを 1 つ受け取る（Electron の debugger の 'message'）。 */
	onMessage(method: string, params: unknown): void {
		const record = isRecord(params) ? params : undefined;
		const info = isRecord(record?.targetInfo) ? record.targetInfo as ICdpTargetInfoLike : undefined;
		const targetId = typeof info?.targetId === 'string' ? info.targetId : undefined;
		switch (method) {
			case 'Target.attachedToTarget': {
				const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : undefined;
				if (targetId !== undefined && sessionId !== undefined && this._targets.size < 4_096) {
					this._targets.set(targetId, { url: typeof info?.url === 'string' ? info.url : undefined, sessionId });
					this._sessionTargets.set(sessionId, targetId);
				}
				return;
			}
			case 'Target.targetInfoChanged': {
				const known = targetId !== undefined ? this._targets.get(targetId) : undefined;
				if (known && typeof info?.url === 'string') {
					known.url = info.url;
				}
				return;
			}
			case 'Target.detachedFromTarget': {
				const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : undefined;
				const detached = sessionId !== undefined ? this._sessionTargets.get(sessionId) : undefined;
				if (sessionId !== undefined && detached !== undefined) {
					this._sessionTargets.delete(sessionId);
					if (this._targets.get(detached)?.sessionId === sessionId) {
						this._targets.delete(detached);
					}
				}
				return;
			}
			case 'Target.targetDestroyed': {
				const destroyed = typeof record?.targetId === 'string' ? record.targetId : undefined;
				const known = destroyed !== undefined ? this._targets.get(destroyed) : undefined;
				if (destroyed !== undefined && known) {
					this._targets.delete(destroyed);
					if (known.sessionId !== undefined) {
						this._sessionTargets.delete(known.sessionId);
					}
				}
				return;
			}
		}
	}

	frameTarget(frameId: string): IParadisGuardFrameTarget | undefined {
		const known = this._targets.get(frameId);
		return known ? { url: known.url, sessionId: known.sessionId } : undefined;
	}

	/** セッションの id から、そのターゲットの URL を引く（知らなければ undefined）。 */
	urlOfSession(sessionId: string): string | undefined {
		const targetId = this._sessionTargets.get(sessionId);
		return targetId !== undefined ? this._targets.get(targetId)?.url : undefined;
	}
}

/** upstream の CDP の送り口の一部（BrowserViewDebugger）。 */
interface IParadisUpstreamDebugger {
	/** タブのページのターゲット。 */
	readonly targetId: string;
	/** upstream が auto-attach で知ったターゲット（id は frameId と同じ）。 */
	readonly knownTargets?: ReadonlyMap<string, { readonly url?: string }>;
	registerCommandInterceptor(interceptor: (method: string, params: unknown, session: unknown) => Promise<unknown> | undefined): IDisposable;
	sendCommandRaw(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
}

/** Electron の debugger の 'message' の受け口の一部。 */
interface IElectronDebuggerEvents {
	on(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void): unknown;
	removeListener(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void): unknown;
}

/** 見張りの対象のビューの一部（BrowserView）。 */
export interface IParadisInputGuardView {
	readonly webContents: ParadisInputGuardWebContents & { readonly debugger: IElectronDebuggerEvents; once(event: 'destroyed', listener: () => void): unknown };
	readonly debugger: IParadisUpstreamDebugger;
}

/** ビューごとの見張り（ビューと同じだけ生きる）。 */
const guards = new WeakMap<object, IParadisInputGuardTab>();

/** 共有中のタブの拡張の画面への入力を断る見張りを返す（無ければ作る）。 */
export function paradisInputGuardTab(view: IParadisInputGuardView): IParadisInputGuardTab {
	const existing = guards.get(view.debugger);
	if (existing) {
		return existing;
	}
	const tracker = new ParadisFrameTargetTracker();
	const listener = (_event: unknown, method: string, params: unknown) => tracker.onMessage(method, params);
	const electronDebugger = (view.webContents as Partial<IParadisInputGuardView['webContents']>).debugger;
	electronDebugger?.on('message', listener);
	const upstreamDebugger = view.debugger;
	const tab: IParadisInputGuardTab = {
		webContents: view.webContents,
		send: (method, params, sessionId) => upstreamDebugger.sendCommandRaw(method, params, sessionId),
		frameTarget: frameId => {
			const tracked = tracker.frameTarget(frameId);
			const knownUrl = upstreamDebugger.knownTargets?.get(frameId)?.url;
			return tracked || knownUrl !== undefined ? { url: tracked?.url ?? knownUrl, sessionId: tracked?.sessionId } : undefined;
		},
	};
	guards.set(view.debugger, tab);
	// upstream の Agent ツール（BrowserViewDebugger.sendCommand で Input.* を送る）の入力も判定する。
	// 割り込みは登録した順に呼ばれる。upstream のデバイスのエミュレーション（BrowserViewEmulator）はビューを作るときに
	// 登録して座標を倍率に合わせ、undefined を返して次へ渡す。この割り込みはビューが作られた後
	// （onDidCreateBrowserView）に登録するので、合わせた後の座標で判定できる
	const interceptor = typeof upstreamDebugger.registerCommandInterceptor === 'function'
		? upstreamDebugger.registerCommandInterceptor((method, params, session) => paradisInterceptUpstreamCommand(tab, tracker, upstreamDebugger, method, params, session))
		: undefined;
	(view.webContents as Partial<IParadisInputGuardView['webContents']>).once?.('destroyed', () => {
		interceptor?.dispose();
		electronDebugger?.removeListener('message', listener);
	});
	return tab;
}

/**
 * upstream の CDP の送り口（BrowserViewDebugger.sendCommand。upstream の Agent ツールや Playwright が使う）への命令を
 * 判定する。Para Code 自身の入力（dispatchExactViewInput）は sendCommandRaw で送るので、ここを通らない（そちらは送る前に
 * 同じ判定をする）。
 *  - ページへの入力（upstream はページへ flatten で attach したセッション越しに送る）は、拡張の画面に届くなら断る
 *  - 拡張のページを表示している別プロセスの iframe のセッションへの命令は、離れるための命令のほかは断る
 *    （page.frames() から拡張の frame を取って evaluate させない）
 * セッションの無い命令は、upstream の通常の経路のまま通す（upstream の Agent ツールは使わない）。
 */
export function paradisInterceptUpstreamCommand(tab: IParadisInputGuardTab, tracker: ParadisFrameTargetTracker, upstreamDebugger: IParadisUpstreamDebugger, method: string, params: unknown, session: unknown): Promise<unknown> | undefined {
	const connection = session as { readonly sessionId?: unknown; readonly targetId?: unknown } | undefined;
	if (connection === undefined) {
		return undefined;
	}
	const sessionId = typeof connection.sessionId === 'string' ? connection.sessionId : undefined;
	if (connection.targetId !== upstreamDebugger.targetId) {
		const frameUrl = sessionId !== undefined ? tracker.urlOfSession(sessionId) : undefined;
		const knownUrl = typeof connection.targetId === 'string' ? upstreamDebugger.knownTargets?.get(connection.targetId)?.url : undefined;
		if (paradisIsBrowserExtensionUrl(frameUrl ?? knownUrl) && method !== 'Runtime.runIfWaitingForDebugger' && !/\.(?:enable|disable)$/.test(method)) {
			return Promise.reject(new Error(PARADIS_EXTENSION_FRAME_DENIED_MESSAGE));
		}
		return undefined;
	}
	if (!method.startsWith('Input.')) {
		return undefined;
	}
	return (async () => {
		const refusal = await paradisExtensionInputRefusal(tab, method, params);
		if (refusal !== undefined) {
			throw new Error(refusal);
		}
		return upstreamDebugger.sendCommandRaw(method, params, sessionId);
	})();
}
