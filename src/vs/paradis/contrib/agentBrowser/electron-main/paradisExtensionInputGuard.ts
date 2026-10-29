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
//  - `DOM.getNodeForLocation`（DOM.enable は要らない）は閉じた shadow root の中まで入り、拡張の iframe の要素
//    （src が chrome-extension://）を返す。別プロセスの iframe の中の URL は、ページのセッションの CDP からは
//    引けない（Page.getFrameTree に出ず、Target.getTargetInfo も見つからない）ので、iframe の要素の src で見る
//  - `webContents.focusedFrame` は、拡張の iframe の中の入力欄にフォーカスがあると、その iframe（URL が
//    chrome-extension://）を返す
//
// 拡張の iframe がタブに 1 つも無ければ（ほとんどの場合）、何も問い合わせずに通す。

import type { WebContents, WebFrameMain } from 'electron';
import { paradisIsBrowserExtensionUrl } from '../common/paradisCdpExtensionScope.js';

/** 断るときにエージェントへ返す文。 */
export const PARADIS_EXTENSION_INPUT_DENIED_MESSAGE = 'This input would reach a browser extension\'s own UI drawn over the page (for example a password manager\'s menu). Para Code does not let agents click, tap or type into browser extension UI. Click somewhere else, or ask the user to use the extension.';

/** 中に別の文書を持つ要素（クリックがその文書へ届く）。 */
const FRAME_OWNER_NODE_NAMES: ReadonlySet<string> = new Set(['IFRAME', 'FRAME', 'EMBED', 'OBJECT', 'FENCEDFRAME', 'PORTAL']);

/** 要素の中の文書の URL を表す属性。 */
const FRAME_SOURCE_ATTRIBUTES: ReadonlySet<string> = new Set(['src', 'data']);

/** フォーカスのある文書へ届く入力。 */
const KEY_METHODS: ReadonlySet<string> = new Set(['Input.dispatchKeyEvent', 'Input.insertText', 'Input.imeSetComposition']);

/** 見張りが使う webContents の一部（テストでは偽物を渡す）。 */
export type ParadisInputGuardWebContents = Pick<WebContents, 'focusedFrame' | 'mainFrame'>;

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

/** CDP の `attributes`（名前と値が交互に並ぶ）から、中の文書の URL を表す値を取り出す。 */
function frameSources(attributes: unknown): string[] {
	const list = Array.isArray(attributes) ? attributes : [];
	const sources: string[] = [];
	for (let index = 0; index + 1 < list.length; index += 2) {
		const name = list[index];
		const value = list[index + 1];
		if (typeof name === 'string' && FRAME_SOURCE_ATTRIBUTES.has(name.toLowerCase()) && typeof value === 'string') {
			sources.push(value);
		}
	}
	return sources;
}

/**
 * その点の要素が拡張の画面か。iframe の要素の src が拡張の URL なら拡張の画面。src が無い・about:blank の iframe は、
 * 中身を後から拡張のページへ移せるので、タブに拡張の iframe があるときは拡張の画面とみなす（ウェブのページの
 * src を持つ iframe は通す）。
 */
async function hitsExtensionFrame(send: (method: string, params: Record<string, unknown>) => Promise<unknown>, x: number, y: number): Promise<boolean> {
	let hit: unknown;
	try {
		hit = await send('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true, ignorePointerEventsNone: true });
	} catch {
		// その点に要素が無い（画面の外など）。押しても拡張には届かない
		return false;
	}
	const backendNodeId = (hit as { backendNodeId?: unknown } | undefined)?.backendNodeId;
	if (typeof backendNodeId !== 'number') {
		return false;
	}
	let described: unknown;
	try {
		described = await send('DOM.describeNode', { backendNodeId });
	} catch {
		return false;
	}
	const node = (described as { node?: { nodeName?: unknown; attributes?: unknown } } | undefined)?.node;
	if (typeof node?.nodeName !== 'string' || !FRAME_OWNER_NODE_NAMES.has(node.nodeName.toUpperCase())) {
		return false;
	}
	const sources = frameSources(node.attributes);
	if (sources.some(source => paradisIsBrowserExtensionUrl(source))) {
		return true;
	}
	return sources.every(source => source.trim() === '' || source.trim().toLowerCase() === 'about:blank');
}

/**
 * エージェントの入力が拡張の画面に届くなら、断る理由を返す。届かなければ undefined。
 * `send` はそのタブのページのセッションへ CDP の命令を送る（座標は入力と同じ、ページの CSS ピクセル）。
 */
export async function paradisExtensionInputRefusal(
	webContents: ParadisInputGuardWebContents,
	send: (method: string, params: Record<string, unknown>) => Promise<unknown>,
	method: string,
	params: unknown,
): Promise<string | undefined> {
	if (KEY_METHODS.has(method)) {
		let focused: string | undefined;
		try {
			focused = webContents.focusedFrame?.url;
		} catch {
			focused = undefined;
		}
		return paradisIsBrowserExtensionUrl(focused) ? PARADIS_EXTENSION_INPUT_DENIED_MESSAGE : undefined;
	}
	const points = pointsOf(method, params);
	if (points.length === 0 || !hasExtensionFrame(webContents)) {
		return undefined;
	}
	for (const point of points) {
		if (await hitsExtensionFrame(send, point.x, point.y)) {
			return PARADIS_EXTENSION_INPUT_DENIED_MESSAGE;
		}
	}
	return undefined;
}

/** upstream の CDP の送り口の一部（BrowserViewDebugger）。 */
interface IParadisUpstreamDebugger {
	/** タブのページのターゲット。 */
	readonly targetId: string;
	registerCommandInterceptor(interceptor: (method: string, params: unknown, session: unknown) => Promise<unknown> | undefined): unknown;
	sendCommandRaw(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
}

/** 見張りを付けたビュー（付けるのは 1 回だけ）。 */
const guardedUpstreamDebuggers = new WeakSet<object>();

/**
 * upstream の CDP の送り口（BrowserViewDebugger.sendCommand。upstream の Agent ツールや Playwright が使う）で、ページの
 * セッションへの入力を、拡張の画面に届くなら断る。Para Code 自身の入力（dispatchExactViewInput）は sendCommandRaw で
 * 送るのでここを通らない（そちらは送る前に同じ判定をする）。upstream はページへ flatten で attach したセッション越しに
 * 入力を送るので、そのセッション（ターゲットがタブのページ）も対象にする。別プロセスの iframe のセッション宛ては対象外。
 * 登録は upstream の公開の口（registerCommandInterceptor）だけで行い、upstream のファイルは変えない。ビューと同じだけ
 * 生きるので、登録を外す必要は無い。
 */
export function paradisGuardUpstreamAutomationInput(view: { readonly webContents: ParadisInputGuardWebContents; readonly debugger: IParadisUpstreamDebugger }): void {
	const upstreamDebugger = view.debugger;
	if (guardedUpstreamDebuggers.has(upstreamDebugger)) {
		return;
	}
	guardedUpstreamDebuggers.add(upstreamDebugger);
	upstreamDebugger.registerCommandInterceptor((method, params, session) => {
		if (!method.startsWith('Input.')) {
			return undefined;
		}
		const connection = session as { readonly sessionId?: unknown; readonly targetId?: unknown } | undefined;
		if (connection !== undefined && connection.targetId !== upstreamDebugger.targetId) {
			return undefined;
		}
		const sessionId = typeof connection?.sessionId === 'string' ? connection.sessionId : undefined;
		return (async () => {
			const refusal = await paradisExtensionInputRefusal(view.webContents, (name, values) => upstreamDebugger.sendCommandRaw(name, values, undefined), method, params);
			if (refusal !== undefined) {
				throw new Error(refusal);
			}
			return upstreamDebugger.sendCommandRaw(method, params, sessionId);
		})();
	});
}
