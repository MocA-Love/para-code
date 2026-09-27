/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントの右クリックで、Para Code の OS の右クリックメニューを出さない。
//
// CDP で右ボタンを押すと、ページに `contextmenu` イベントが届き、ページが取り消さなければ
// webContents の `context-menu` になって upstream の browserViewMainService.ts が OS のメニューを出す。
// これは背景のタブでも利用者の画面に出て、「外部ブラウザで開く」などを誤って押せてしまう。
//
// エージェントの入力の通り道（paradisCdpTargetService.ts）が、メニューを開きうる入力を送るたびに
// 「この入力の印」（どの座標の右クリックか・キーか）を付け、browserViewMainService.ts の PARA-PATCH 1 行が
// `context-menu` の引数（座標と、マウスかキーか）を印と突き合わせる。一致した1つだけを消費して
// メニューを出さない。時間の窓で一律に止めないので、利用者の右クリック（別の座標）は止めない。
// ページ自身の右クリックメニュー（`contextmenu` を取り消して自前で描くもの）はそのまま動く。
//
// Electron に依存しない（テストから素のオブジェクトで使える）。

/** 印が残る上限（入力から `context-menu` までは通常数十 ms。取り消されたときの残りを長く置かない）。 */
const MARK_LIFETIME_MS = 1_000;
/** 座標の突き合わせの誤差（丸めと拡大率の分）。 */
const COORDINATE_TOLERANCE = 3;
/** 1枚のタブに置く印の上限。 */
const MAX_MARKS = 8;

interface IContextMenuMark {
	readonly source: 'mouse' | 'keyboard';
	/** ページの CSS ピクセルと、それに拡大率を掛けたもの（`context-menu` の座標はどちらかで届く）。 */
	readonly points: readonly { readonly x: number; readonly y: number }[];
	readonly at: number;
}

const marks = new WeakMap<object, IContextMenuMark[]>();

const MODIFIER_CONTROL = 2;
const MODIFIER_SHIFT = 8;
const VK_APPS = 93;
const VK_F10 = 121;

function modifiersOf(params: Readonly<Record<string, unknown>>): number {
	return typeof params.modifiers === 'number' ? params.modifiers : 0;
}

/**
 * CDP の入力が OS の右クリックメニューを開きうるか。右ボタンの押下・離し、Control を押した左ボタンの
 * 押下・離し（macOS では右クリック扱い）、ContextMenu キー（仮想キー 93）、Shift+F10。
 */
export function paradisContextMenuInputSource(method: string, params: Readonly<Record<string, unknown>>): 'mouse' | 'keyboard' | undefined {
	if (method === 'Input.dispatchMouseEvent') {
		if (params.type !== 'mousePressed' && params.type !== 'mouseReleased') {
			return undefined;
		}
		if (params.button === 'right' || (params.button === 'left' && (modifiersOf(params) & MODIFIER_CONTROL) !== 0)) {
			return 'mouse';
		}
		return undefined;
	}
	if (method === 'Input.dispatchKeyEvent') {
		const keyCode = typeof params.windowsVirtualKeyCode === 'number' ? params.windowsVirtualKeyCode : undefined;
		if (params.key === 'ContextMenu' || params.code === 'ContextMenu' || keyCode === VK_APPS) {
			return 'keyboard';
		}
		if ((params.key === 'F10' || params.code === 'F10' || keyCode === VK_F10) && (modifiersOf(params) & MODIFIER_SHIFT) !== 0) {
			return 'keyboard';
		}
	}
	return undefined;
}

/**
 * エージェントが送る入力に印を付ける。メニューを開きうる入力でなければ何もしない。
 * `zoomFactor` はタブの拡大率（`context-menu` の座標が拡大後で届いても突き合わせられるように）。
 */
export function paradisMarkAgentContextMenuInput(webContents: object, method: string, params: Readonly<Record<string, unknown>>, zoomFactor: number, now: number = Date.now()): void {
	const source = paradisContextMenuInputSource(method, params);
	if (source === undefined) {
		return;
	}
	const points: { x: number; y: number }[] = [];
	if (source === 'mouse' && typeof params.x === 'number' && typeof params.y === 'number') {
		points.push({ x: params.x, y: params.y });
		if (Number.isFinite(zoomFactor) && zoomFactor > 0 && zoomFactor !== 1) {
			points.push({ x: params.x * zoomFactor, y: params.y * zoomFactor });
		}
	}
	const list = (marks.get(webContents) ?? []).filter(mark => now - mark.at <= MARK_LIFETIME_MS);
	list.push({ source, points, at: now });
	marks.set(webContents, list.slice(-MAX_MARKS));
}

/** `context-menu` の引数のうち使うもの（Electron の ContextMenuParams）。 */
export interface IParadisContextMenuRequest {
	readonly x?: number;
	readonly y?: number;
	readonly menuSourceType?: string;
}

/**
 * この `context-menu` がエージェントの入力で開いたものか。一致する印があれば消費して true を返す
 * （印は1回のメニューにだけ効く）。マウスは座標、キーは種類で突き合わせる。
 */
export function paradisConsumeAgentContextMenuSuppression(webContents: object, request: IParadisContextMenuRequest | undefined, now: number = Date.now()): boolean {
	const list = (marks.get(webContents) ?? []).filter(mark => now - mark.at <= MARK_LIFETIME_MS);
	const source = request?.menuSourceType === 'keyboard' ? 'keyboard' : 'mouse';
	const index = list.findIndex(mark => {
		if (mark.source !== source) {
			return false;
		}
		if (source === 'keyboard') {
			return true;
		}
		const x = request?.x;
		const y = request?.y;
		return typeof x === 'number' && typeof y === 'number'
			&& mark.points.some(point => Math.abs(point.x - x) <= COORDINATE_TOLERANCE && Math.abs(point.y - y) <= COORDINATE_TOLERANCE);
	});
	if (index < 0) {
		if (list.length === 0) {
			marks.delete(webContents);
		} else {
			marks.set(webContents, list);
		}
		return false;
	}
	list.splice(index, 1);
	if (list.length === 0) {
		marks.delete(webContents);
	} else {
		marks.set(webContents, list);
	}
	return true;
}
