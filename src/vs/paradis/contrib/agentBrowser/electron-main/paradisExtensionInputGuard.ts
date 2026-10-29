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

/** 判定が送る CDP の命令の答えを待つ上限（ミリ秒）。 */
export const PARADIS_INPUT_GUARD_COMMAND_TIMEOUT_MS = 1_500;

/**
 * 判定の命令が答えなかった（時間切れ）、または送り先のセッションが切り離された。その iframe の中は見られないものとして
 * 扱う（タブに拡張の iframe があれば断る）。
 */
export class ParadisGuardFrameUnavailableError extends Error {
	constructor(reason: string) {
		super(`Para Code input guard could not look into a frame: ${reason}`);
	}
}

/** 見られない iframe の知らせなら投げ直す（ほかの失敗は呼び出し側で扱う）。 */
function rethrowUnavailable(error: unknown): void {
	if (error instanceof ParadisGuardFrameUnavailableError) {
		throw error;
	}
}

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
	/**
	 * 別プロセスの iframe のセッションに auto-attach を掛け、その中の別プロセスの iframe も引けるようにする
	 * （upstream はページにしか掛けない）。1 つのセッションに 1 回だけ。
	 */
	attachChildren?(sessionId: string): Promise<void>;
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

/** 同じプロセスの iframe の URL を、その文書のフレームの木から引く（無ければ undefined）。 */
async function localFrameUrl(tab: IParadisInputGuardTab, frameId: string, sessionId: string | undefined): Promise<string | undefined> {
	let tree: unknown;
	try {
		tree = await tab.send('Page.getFrameTree', {}, sessionId);
	} catch (error) {
		rethrowUnavailable(error);
		return undefined;
	}
	const visit = (node: unknown, depth: number): string | undefined => {
		if (!isRecord(node) || depth > 64) {
			return undefined;
		}
		const frame = isRecord(node.frame) ? node.frame : undefined;
		if (frame?.id === frameId && typeof frame.url === 'string') {
			return frame.url;
		}
		for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) {
			const found = visit(child, depth + 1);
			if (found !== undefined) {
				return found;
			}
		}
		return undefined;
	};
	return visit(isRecord(tree) ? tree.frameTree : undefined, 0);
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
	} catch (error) {
		rethrowUnavailable(error);
		// 読めなければスクロールしていないとみなす
	}
	let hit: unknown;
	try {
		hit = await tab.send('DOM.getNodeForLocation', { x: Math.round(x + offsetX), y: Math.round(y + offsetY), includeUserAgentShadowDOM: true, ignorePointerEventsNone: true }, sessionId);
	} catch (error) {
		rethrowUnavailable(error);
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
	} catch (error) {
		rethrowUnavailable(error);
		return false;
	}
	const node = isRecord(described) && isRecord(described.node) ? described.node : undefined;
	if (typeof node?.nodeName !== 'string' || !FRAME_OWNER_NODE_NAMES.has(node.nodeName.toUpperCase())) {
		// 同じプロセスの iframe の中は getNodeForLocation が潜って中の要素を返すので、ここへは来ない
		return false;
	}
	const frameId = typeof node.frameId === 'string' ? node.frameId : undefined;
	let target = frameId !== undefined ? tab.frameTarget(frameId) : undefined;
	if (frameId !== undefined && target?.url === undefined && sessionId !== undefined && tab.attachChildren) {
		// 2 段目より奥の別プロセスの iframe。この文書のセッションに auto-attach を掛けて、その iframe を引けるようにする
		await tab.attachChildren(sessionId);
		target = tab.frameTarget(frameId);
	}
	if (paradisIsBrowserExtensionUrl(target?.url)) {
		return true;
	}
	if (target === undefined && frameId !== undefined) {
		// 同じプロセスの iframe（ターゲットを持たない）の枠に当たった。その文書のフレームの木から URL を引く
		const local = await localFrameUrl(tab, frameId, sessionId);
		if (local !== undefined) {
			return paradisIsBrowserExtensionUrl(local);
		}
	}
	if (target?.url === undefined || target.sessionId === undefined || depth >= MAX_FRAME_DEPTH) {
		// 中の URL かセッションが分からない別プロセスの iframe（auto-attach を掛けても見つからないもの、深すぎるもの）。
		// タブに拡張の iframe があるときだけ、そこへ届くかもしれないとして断る
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
	try {
		return await hitsExtensionFrame(tab, x - content[0], y - content[1], target.sessionId, depth + 1);
	} catch (error) {
		if (error instanceof ParadisGuardFrameUnavailableError) {
			// 中の iframe が答えない・切り離された（拡張のページへ移る途中など）
			return hasExtensionFrame(tab.webContents);
		}
		throw error;
	}
}

/** 通した「押す」の座標（タブ × ボタン）。離す位置を拡張の画面から外すのに使う。 */
const pressedThrough = new WeakMap<object, Map<string, { readonly x: number; readonly y: number }>>();

/** 入力の判定の結果。 */
export interface IParadisExtensionInputVerdict {
	/** 断る理由（通すなら undefined）。 */
	readonly refusal?: string;
	/** 送る前に置き換える params（置き換えないなら undefined）。 */
	readonly params?: Record<string, unknown>;
}

/**
 * エージェントの入力が拡張の画面に届くなら断る。座標は入力と同じ（見えている範囲の CSS ピクセル。縮小して描いている
 * タブでは倍率を合わせた後）。
 *  - 押して離すまでの間に場所を変え、離す位置が拡張の画面に当たるときは、離す位置を押した位置に置き換えて通す
 *    （断るとページの中でボタンが押されたままになる。押した位置が拡張の画面なら、押す時点で断っている）
 *  - 押していないボタンの離す（単独の離す）は、その位置で判定する
 */
export async function paradisGuardExtensionInput(tab: IParadisInputGuardTab, method: string, params: unknown): Promise<IParadisExtensionInputVerdict> {
	if (KEY_METHODS.has(method)) {
		let focused: string | undefined;
		try {
			focused = tab.webContents.focusedFrame?.url;
		} catch {
			focused = undefined;
		}
		return paradisIsBrowserExtensionUrl(focused) ? { refusal: PARADIS_EXTENSION_INPUT_DENIED_MESSAGE } : {};
	}
	const record = isRecord(params) ? params : undefined;
	const isMouse = method === 'Input.dispatchMouseEvent';
	const button = typeof record?.button === 'string' ? record.button : 'none';
	let pressed = pressedThrough.get(tab.webContents);
	const pressedAt = isMouse && record?.type === 'mouseReleased' ? pressed?.get(button) : undefined;
	if (pressedAt !== undefined) {
		pressed?.delete(button);
	}
	const points = pointsOf(method, params);
	let hitsExtension = false;
	if (points.length > 0 && hasExtensionFrame(tab.webContents)) {
		for (const point of points) {
			let hit: boolean;
			try {
				hit = await hitsExtensionFrame(tab, point.x, point.y, undefined, 0);
			} catch (error) {
				if (!(error instanceof ParadisGuardFrameUnavailableError)) {
					throw error;
				}
				// ページそのものが答えない。タブに拡張の iframe があるので断る
				hit = true;
			}
			if (hit) {
				hitsExtension = true;
				break;
			}
		}
	}
	if (pressedAt !== undefined) {
		return hitsExtension ? { params: { ...record, x: pressedAt.x, y: pressedAt.y } } : {};
	}
	if (hitsExtension) {
		return { refusal: PARADIS_EXTENSION_INPUT_DENIED_MESSAGE };
	}
	if (isMouse && record?.type === 'mousePressed' && typeof record.x === 'number' && typeof record.y === 'number') {
		if (!pressed) {
			pressed = new Map();
			pressedThrough.set(tab.webContents, pressed);
		}
		pressed.set(button, { x: record.x, y: record.y });
	}
	return {};
}

/** {@link paradisGuardExtensionInput} の断る理由だけを返す。 */
export async function paradisExtensionInputRefusal(tab: IParadisInputGuardTab, method: string, params: unknown): Promise<string | undefined> {
	return (await paradisGuardExtensionInput(tab, method, params)).refusal;
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

	private readonly _targets = new Map<string, { url?: string; sessionId?: string; parentSessionId?: string }>();
	private readonly _sessionTargets = new Map<string, string>();

	/**
	 * CDP のイベントを 1 つ受け取る（Electron の debugger の 'message'）。`eventSessionId` はイベントが届いた
	 * セッション（attach なら親のセッション）。
	 */
	onMessage(method: string, params: unknown, eventSessionId?: string): void {
		const record = isRecord(params) ? params : undefined;
		const info = isRecord(record?.targetInfo) ? record.targetInfo as ICdpTargetInfoLike : undefined;
		const targetId = typeof info?.targetId === 'string' ? info.targetId : undefined;
		switch (method) {
			case 'Target.attachedToTarget': {
				const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : undefined;
				if (targetId !== undefined && sessionId !== undefined && this._targets.size < 4_096) {
					// Electron はページ（ルート）のイベントのセッションを空文字で渡す
					this._targets.set(targetId, { url: typeof info?.url === 'string' ? info.url : undefined, sessionId, parentSessionId: eventSessionId ? eventSessionId : undefined });
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
					const known = this._targets.get(detached);
					if (known?.sessionId === sessionId) {
						if (paradisIsBrowserExtensionUrl(known.url)) {
							// 拡張のページの iframe は、こちらで切り離す（下の paradisInputGuardTab）。当たり判定のために URL は覚えておく
							known.sessionId = undefined;
						} else {
							this._targets.delete(detached);
						}
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

	/** 拡張のページを表示している、attach 中のターゲットのセッションと親のセッション（切り離すため）。 */
	extensionSessions(): { readonly sessionId: string; readonly parentSessionId?: string }[] {
		const sessions: { sessionId: string; parentSessionId?: string }[] = [];
		for (const known of this._targets.values()) {
			if (known.sessionId !== undefined && paradisIsBrowserExtensionUrl(known.url)) {
				sessions.push({ sessionId: known.sessionId, parentSessionId: known.parentSessionId });
			}
		}
		return sessions;
	}

	/** セッションの id から、そのターゲットの URL を引く（知らなければ undefined）。 */
	urlOfSession(sessionId: string): string | undefined {
		const targetId = this._sessionTargets.get(sessionId);
		return targetId !== undefined ? this._targets.get(targetId)?.url : undefined;
	}
}

/**
 * 答えを待っている CDP の命令（セッションごと）。切り離したセッションへの命令は Electron から答えが来ないので、
 * 切り離すとき・タブを閉じたときに、こちらで失敗として終わらせる。
 */
export class ParadisPendingCommands {

	private readonly _bySession = new Map<string, Set<(error: Error) => void>>();

	/**
	 * 命令の答えを待つ。`withTimeout` なら {@link PARADIS_INPUT_GUARD_COMMAND_TIMEOUT_MS} で打ち切る（判定の命令）。
	 * 打ち切り・切り離しは {@link ParadisGuardFrameUnavailableError} で終わる。
	 */
	track<T>(sessionId: string | undefined, command: Promise<T>, withTimeout = true): Promise<T> {
		const key = sessionId ?? '';
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = () => {
				settled = true;
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				const rejecters = this._bySession.get(key);
				rejecters?.delete(abandon);
				if (rejecters?.size === 0) {
					this._bySession.delete(key);
				}
			};
			const abandon = (error: Error) => {
				if (!settled) {
					finish();
					reject(error);
				}
			};
			let rejecters = this._bySession.get(key);
			if (!rejecters) {
				rejecters = new Set();
				this._bySession.set(key, rejecters);
			}
			rejecters.add(abandon);
			if (withTimeout) {
				timer = setTimeout(() => abandon(new ParadisGuardFrameUnavailableError('the frame did not answer in time')), PARADIS_INPUT_GUARD_COMMAND_TIMEOUT_MS);
			}
			command.then(value => {
				if (!settled) {
					finish();
					resolve(value);
				}
			}, error => {
				if (!settled) {
					finish();
					reject(error);
				}
			});
		});
	}

	/** そのセッションへ送りかけの命令を終わらせる。 */
	abandon(sessionId: string, reason: string): void {
		const rejecters = this._bySession.get(sessionId);
		this._bySession.delete(sessionId);
		for (const reject of rejecters ?? []) {
			reject(new ParadisGuardFrameUnavailableError(reason));
		}
	}

	/** すべて終わらせる（タブを閉じたとき）。 */
	abandonAll(reason: string): void {
		for (const sessionId of [...this._bySession.keys()]) {
			this.abandon(sessionId, reason);
		}
	}

	/** 答えを待っている命令の数（テスト用）。 */
	get size(): number {
		let count = 0;
		for (const rejecters of this._bySession.values()) {
			count += rejecters.size;
		}
		return count;
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

/**
 * upstream の Agent ツールの入力に、Para Code 自身の入力（paradisCdpTargetService.dispatchExactViewInput）と同じ
 * 自動入力の印を付けるもの（送る直前に呼ぶ）。キーは preload と main がその印で workbench へ送らなくなるので、Para Code と
 * 拡張機能のショートカットを発火させない。右クリックは Para Code の OS のメニューを出さない。印を付けられなければ投げる
 * （印の無いキーは送らない）。返り値の done は送った後（失敗しても）に 1 回呼ぶ。
 */
export interface IParadisUpstreamInputMarker {
	beforeSend(method: string, params: Readonly<Record<string, unknown>>): Promise<{ done(): void } | undefined>;
}

/**
 * 印を閉じる done を作る。送った命令が答えを返さなくても印が残り続けないよう、期限が来たら閉じる（閉じると、印は短い猶予の後に
 * 消える。期限より後に届いたキーは利用者のものと見分けられないが、印を持ち続けて同じ形の利用者のキーを飲み込むよりよい）。
 * done と期限のどちらが先でも、閉じるのは 1 回だけ。
 */
export function paradisMarkDoneWithDeadline(complete: () => void, deadlineMs: number): { done(): void } {
	let closed = false;
	const close = () => {
		if (!closed) {
			closed = true;
			clearTimeout(timer);
			complete();
		}
	};
	const timer = setTimeout(close, deadlineMs);
	return { done: close };
}

/** ビューごとの見張り（ビューと同じだけ生きる）。 */
const guards = new WeakMap<object, IParadisInputGuardTab>();

/** 共有中のタブの拡張の画面への入力を断る見張りを返す（無ければ作る）。 */
export function paradisInputGuardTab(view: IParadisInputGuardView, marker?: IParadisUpstreamInputMarker): IParadisInputGuardTab {
	const existing = guards.get(view.debugger);
	if (existing) {
		return existing;
	}
	const tracker = new ParadisFrameTargetTracker();
	const upstreamDebuggerForDetach = view.debugger;
	const detaching = new Set<string>();
	const pending = new ParadisPendingCommands();
	const listener = (_event: unknown, method: string, params: unknown, eventSessionId?: string) => {
		tracker.onMessage(method, params, eventSessionId);
		if (method === 'Target.detachedFromTarget' && isRecord(params) && typeof params.sessionId === 'string') {
			// 切り離されたセッションへ送りかけの命令は、もう答えが来ない
			pending.abandon(params.sessionId, 'its session was detached');
		}
		if (method !== 'Target.attachedToTarget' && method !== 'Target.targetInfoChanged') {
			return;
		}
		// 拡張のページの iframe のセッションは切り離す。upstream の Agent ツールへ、そのページのイベント
		// （Runtime.consoleAPICalled・executionContextCreated・Network.* など）を届けないため。命令は割り込みで断る
		for (const extension of tracker.extensionSessions()) {
			if (detaching.has(extension.sessionId) || detaching.size >= 4_096) {
				continue;
			}
			detaching.add(extension.sessionId);
			// 送りかけの命令（判定や upstream の利用者のもの）は、切り離すと答えが来なくなるので、ここで終わらせる
			pending.abandon(extension.sessionId, 'it shows a browser extension page');
			// debugger のイベントの中から命令を送ると Electron が落ちることがある（実測）ので、次の周回で送る
			setImmediate(() => void upstreamDebuggerForDetach.sendCommandRaw('Target.detachFromTarget', { sessionId: extension.sessionId }, extension.parentSessionId)
				.catch(() => { /* already gone */ })
				.finally(() => detaching.delete(extension.sessionId)));
		}
	};
	const electronDebugger = (view.webContents as Partial<IParadisInputGuardView['webContents']>).debugger;
	electronDebugger?.on('message', listener);
	const upstreamDebugger = view.debugger;
	const autoAttached = new Set<string>();
	const tab: IParadisInputGuardTab = {
		webContents: view.webContents,
		send: (method, params, sessionId) => pending.track(sessionId, upstreamDebugger.sendCommandRaw(method, params, sessionId)),
		attachChildren: async sessionId => {
			if (autoAttached.has(sessionId) || autoAttached.size >= 4_096) {
				return;
			}
			autoAttached.add(sessionId);
			try {
				// 既にある子の attach のイベントは、この命令の応答より前に届く
				await pending.track(sessionId, upstreamDebugger.sendCommandRaw('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }, sessionId));
			} catch (error) {
				rethrowUnavailable(error);
				// セッションが既に無い
			}
		},
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
		? upstreamDebugger.registerCommandInterceptor((method, params, session) => paradisInterceptUpstreamCommand(tab, tracker, upstreamDebugger, method, params, session, pending, marker))
		: undefined;
	(view.webContents as Partial<IParadisInputGuardView['webContents']>).once?.('destroyed', () => {
		interceptor?.dispose();
		electronDebugger?.removeListener('message', listener);
		pending.abandonAll('the tab was closed');
	});
	return tab;
}

/**
 * upstream の CDP の送り口（BrowserViewDebugger.sendCommand。upstream の Agent ツールや Playwright が使う）への命令を
 * 判定する。Para Code 自身の入力（dispatchExactViewInput）は sendCommandRaw で送るので、ここを通らない（そちらは送る前に
 * 同じ判定をする）。
 *  - ページへの入力（upstream はページへ flatten で attach したセッション越しに送る）は、拡張の画面に届くなら断る
 *  - 拡張のページを表示している別プロセスの iframe のセッションへの命令は、`Runtime.runIfWaitingForDebugger` と
 *    `*.disable` のほかは断る（page.frames() から拡張の frame を取って evaluate させない。`*.enable` も断り、そのページの
 *    イベントを生まない）。そのセッションは見つけ次第切り離す（paradisInputGuardTab）
 * セッションの無い命令は、upstream の通常の経路のまま通す（upstream の Agent ツールは使わない）。
 */
export function paradisInterceptUpstreamCommand(tab: IParadisInputGuardTab, tracker: ParadisFrameTargetTracker, upstreamDebugger: IParadisUpstreamDebugger, method: string, params: unknown, session: unknown, pending?: ParadisPendingCommands, marker?: IParadisUpstreamInputMarker): Promise<unknown> | undefined {
	const connection = session as { readonly sessionId?: unknown; readonly targetId?: unknown } | undefined;
	// セッションの無い命令は、upstream の通常の経路のまま通す（判定も印も付けない）。upstream の Agent ツール（Playwright）は
	// ページへ flatten で attach したセッション越しにしか送らず、セッションの無い送り口は upstream の中の命令（エミュレーション
	// など）と、Para Code 自身の入力（sendCommandRaw。こちらは送る前に同じ判定と印を付ける）だけが使う
	if (connection === undefined) {
		return undefined;
	}
	const sessionId = typeof connection.sessionId === 'string' ? connection.sessionId : undefined;
	// iframe（別プロセスのフレーム）のセッションへの命令には、自動入力の印を付けない。Playwright はキーとマウスをページの
	// セッションへ送り、Chromium がフォーカスのあるフレームへ配る（iframe のセッションへ Input.* を送らない）。拡張機能のページの
	// iframe のセッションへの命令は、この下で断る
	if (connection.targetId !== upstreamDebugger.targetId) {
		const frameUrl = sessionId !== undefined ? tracker.urlOfSession(sessionId) : undefined;
		const knownUrl = typeof connection.targetId === 'string' ? upstreamDebugger.knownTargets?.get(connection.targetId)?.url : undefined;
		if (paradisIsBrowserExtensionUrl(frameUrl ?? knownUrl)) {
			// 拡張のページの iframe のセッションは切り離すので、送らずにここで答える（送ると答えが来ないまま残る）。
			// 再開と購読の停止は、切り離しで済むので成功として答える
			return method === 'Runtime.runIfWaitingForDebugger' || /\.disable$/.test(method) ? Promise.resolve({}) : Promise.reject(new Error(PARADIS_EXTENSION_FRAME_DENIED_MESSAGE));
		}
		// 後で拡張のページへ移って切り離すことがあるので、答えを待っている命令を覚えておく（切り離すときに終わらせる）。
		// upstream が自分で答える命令（Electron が落ちる Emulation.setDeviceMetricsOverride）は upstream に任せる
		if (!pending || sessionId === undefined || method === 'Emulation.setDeviceMetricsOverride') {
			return undefined;
		}
		const tracked = pending.track(sessionId, upstreamDebugger.sendCommandRaw(method, params, sessionId), false);
		// 再開の命令は、切り離しでも再開されるので、切り離しで終わったら成功として答える
		return method === 'Runtime.runIfWaitingForDebugger' ? tracked.catch(error => {
			if (error instanceof ParadisGuardFrameUnavailableError) {
				return {};
			}
			throw error;
		}) : tracked;
	}
	if (!method.startsWith('Input.')) {
		return undefined;
	}
	return (async () => {
		const verdict = await paradisGuardExtensionInput(tab, method, params);
		if (verdict.refusal !== undefined) {
			throw new Error(verdict.refusal);
		}
		const sent = verdict.params ?? params;
		// 自動入力の印（キーは workbench へ送らない、右クリックは OS のメニューを出さない）。付けられなければ送らない
		const mark = marker && isRecord(sent) ? await marker.beforeSend(method, sent) : undefined;
		try {
			return await upstreamDebugger.sendCommandRaw(method, sent, sessionId);
		} finally {
			// 送りかけで失敗したキーも届いたかもしれないので、印は送った扱いで閉じる（Para Code 自身の入力と同じ）
			mark?.done();
		}
	})();
}
