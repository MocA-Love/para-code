/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントが内蔵ブラウザを操作しているあいだ、ページ上に「合成マウスカーソル」を描いて
// 見せるためのページ側スクリプト生成（純粋関数のみ。Electron/DOMには一切触らない）。
//
// 実行はelectron-mainの `ParadisCursorOverlayController` が
// `webContents.executeJavaScriptInIsolatedWorld(browserViewIsolatedWorldId, ...)` で行う。
// 対象ページのJSコンテキストとは分離されたisolated worldで動くため、ページのCSPや
// Trusted Types、prototype改変の影響を受けない。加えてスクリプト側でも
// `innerHTML` と `<style>` を一切使わず、DOM生成はCSSOM（`element.style`）と
// Web Animations API（`element.animate()`）だけで組み立てている。
//
// 移動アニメーションの長さはmain側が決めて `durationMs` として渡す。ページに計算させて
// 戻り値を待つと、入力配送1コマンドあたりにIPC往復ぶんの遅延が乗る。入力キューは
// 1コマンド5秒を超えるとそのキューを恒久的にpoisonするため（`paradisCdpInputQueue.ts`）、
// 演出のために往復を挟まないことが重要。
//
// move・press・focus はページの事情（動きを減らす設定・カーソルを正しい位置に描けない <html>）を
// `IParadisCursorOverlayPageTraits` として返す。main は投げっぱなしの実行の結果からそれを覚え、
// 次の入力から待ち時間を 0 にする（入力の配送の途中では待たない）。
//
// 状態はisolated worldの `window[STATE_KEY]` に保持する。ナビゲーションで自動的に消えるため
// 「再訪時は作り直し」が自然に成立する。加えてコマンドが長く途切れたら自分でフェードアウトして
// 消える（`idleMs`）。共有解除・ユーザーの手動操作開始・設定OFFのときは待たせる意味がないので、
// electron-main側から明示的に `remove` を送る。

import type { IParadisCursorKeyframe } from './paradisCursorMotion.js';

/** カーソル演出の見た目・時間まわりの調整値。 */
export interface IParadisCursorOverlayTuning {
	/** 移動アニメーションの最短時間（ms）。 */
	readonly minMs: number;
	/** 通常移動の最長時間（ms）。 */
	readonly maxMs: number;
	/** ドラッグ中（ボタン押下したままの移動）の最長時間（ms）。追従が遅いと不自然なので短くする。 */
	readonly dragMaxMs: number;
	/** 移動速度（px/ms）。距離をこれで割って所要時間を出す。 */
	readonly pxPerMs: number;
	/** この距離（px）未満の移動はアニメーションせず瞬間移動する。 */
	readonly snapPx: number;
	/** 初回出現時のフェードイン待ち時間（ms）。 */
	readonly appearMs: number;
	/**
	 * 最後のコマンドからこの時間（ms）操作が無ければ、自分でフェードアウトして消える。
	 *
	 * エージェントは考えている間や別の作業をしている間もページを掴んだままなので、
	 * 短く切ると操作のたびにカーソルが消えては現れて落ち着かない。ここはあくまで保険で、
	 * 共有解除・手動操作の開始・設定OFFでは待たずに消している。
	 */
	readonly idleMs: number;
	/** クリック波紋の再生時間（ms）。 */
	readonly rippleMs: number;
	/** スクリーンショット撮影フラッシュの再生時間（ms）。 */
	readonly flashMs: number;
	/** 撮影完了の知らせを出しておく時間（ms）。 */
	readonly toastMs: number;
	/**
	 * フォーカス移動に合わせてカーソルを寄せるときの移動時間（ms）。
	 *
	 * 寄せるのは main がキー入力を送るとき（`focus` コマンド）だけ。ページのフォーカスを定期的に
	 * 見に行くことはしない。ページのスクリプトが動かしたフォーカスに付いていくと、エージェントが
	 * 触っていない場所へカーソルが動き、そこを操作したように見えるため。
	 */
	readonly focusMs: number;
	/** 非表示化してから撮影して良いと判断するまでの最大待ち時間（ms）。 */
	readonly settleMs: number;
	/** 一度きりの状態（押せなかった・選んだ など）と印を出しておく時間（ms）。 */
	readonly markMs: number;
	/** キーの札を出しておく時間（ms）。 */
	readonly keyMs: number;
	/** 最後のキー入力から入力欄の枠と「入力中」を消すまでの時間（ms）。 */
	readonly typingMs: number;
	/** ボタンを離してからドラッグの軌跡を消し終えるまでの時間（ms）。 */
	readonly trailFadeMs: number;
	/** 押したときの縮みの時間（ms）。 */
	readonly squishMs: number;
	/** 読み取り系の道具が見ている要素の枠を出しておく時間（ms）。 */
	readonly lookMs: number;
	/** 枠へカーソルを寄せる時間（ms）。 */
	readonly lookGlideMs: number;
	/** evaluate_script の中のクリックへ続けて寄せるときの間隔（ms）。 */
	readonly scriptClickGapMs: number;
	/**
	 * スクリプトの実行中としてクリックを拾い続ける上限（ms）。終わりの知らせが届かなくても、これを過ぎたら
	 * ページ自身のクリックへ寄せない。
	 */
	readonly watchMs: number;
}

export const PARADIS_CURSOR_OVERLAY_TUNING: IParadisCursorOverlayTuning = Object.freeze({
	minMs: 90,
	maxMs: 380,
	dragMaxMs: 90,
	pxPerMs: 2.2,
	snapPx: 6,
	appearMs: 140,
	idleMs: 60_000,
	rippleMs: 460,
	flashMs: 340,
	toastMs: 1600,
	focusMs: 140,
	settleMs: 250,
	markMs: 1600,
	keyMs: 1000,
	typingMs: 1200,
	trailFadeMs: 600,
	squishMs: 220,
	lookMs: 1000,
	lookGlideMs: 260,
	scriptClickGapMs: 450,
	watchMs: 30_000,
});

/**
 * カーソル移動のために入力配送を待たせる絶対上限（ms）。
 *
 * 入力は1コマンド5秒でキューがpoisonされ、そのページの入力が以後ずっと通らなくなる。
 * 演出でその予算を大きく削らないよう、計算結果は必ずこの値で頭打ちにする。
 */
export const PARADIS_CURSOR_OVERLAY_MAX_WAIT_MS = 400;

/**
 * カーソルの名札に出す状態（q.html Q275 A「標準」）。`idle` は状態を消して名前だけに戻す。
 *
 * - 長く続くもの（`script`・`waiting`・`loading`・`reading`）は次の状態か `idle` まで残す
 * - 一度きりのもの（`failed`・`missing`・`select`・`value`・`upload`・`scroll`）は少し出して消える
 */
export type ParadisCursorStatus = 'idle' | 'script' | 'waiting' | 'loading' | 'reading' | 'failed' | 'missing' | 'select' | 'value' | 'upload' | 'scroll';

/** 道具が終わるか次の状態が来るまで名札に残す状態か。 */
export function paradisIsStickyCursorStatus(status: ParadisCursorStatus): boolean {
	return status === 'script' || status === 'waiting' || status === 'loading' || status === 'reading';
}

/**
 * 写し（モバイル）へ流す状態。モバイルのアプリが知っている状態だけを流す（知らない状態は捨てられる）。
 * `loading` は待機中として流し、`reading` は流さない。
 */
export function paradisCursorStatusForMirror(status: ParadisCursorStatus): ParadisCursorStatus | undefined {
	switch (status) {
		case 'loading': return 'waiting';
		case 'reading': return undefined;
		default: return status;
	}
}

/** ビューポートの CSS ピクセルの矩形。 */
export interface IParadisCursorRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** 撮った範囲。`doc` はドキュメント座標（ページがスクロール量を引いてビューポートへ直す）。 */
export interface IParadisCursorCaptureRange extends IParadisCursorRect {
	readonly doc?: boolean;
}

/** 撮影の指定（`IParadisCdpScreenshotOptions` の一部）から、光らせる範囲を決める。全体なら undefined。 */
export function paradisCursorCaptureRange(options: { readonly pageRect?: IParadisCursorRect; readonly captureBeyondViewport?: boolean; readonly fullPage?: boolean } | undefined): IParadisCursorCaptureRange | undefined {
	const rect = options?.pageRect;
	if (!rect || options?.fullPage === true) {
		return undefined;
	}
	return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, ...(options?.captureBeyondViewport === true ? { doc: true } : {}) };
}

/** 枠を出した要素の目印（同じ要素へ続けて出さないため）。 */
export function paradisCursorLookKey(rect: IParadisCursorRect): string {
	return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
}

/** 読み取り系の道具の枠の間引き。前に出した枠より {@link PARADIS_CURSOR_LOOK_MIN_INTERVAL_MS} 以内、または同じ要素なら出さない。 */
export const PARADIS_CURSOR_LOOK_MIN_INTERVAL_MS = 1_000;

/** この要素へ枠を出すか（同じ要素へ続けて出さない・1 秒以内の連続は間引く）。 */
export function paradisShouldShowCursorLook(previous: { readonly key: string; readonly at: number } | undefined, rect: IParadisCursorRect, at: number): boolean {
	if (!(rect.width > 0) || !(rect.height > 0)) {
		return false;
	}
	if (!previous) {
		return true;
	}
	return previous.key !== paradisCursorLookKey(rect) && at - previous.at >= PARADIS_CURSOR_LOOK_MIN_INTERVAL_MS;
}

/** キー入力の名札の文言（ページ側で行き先を見て選ぶ）。 */
export interface IParadisCursorTypingTexts {
	/** 文字の入力。 */
	readonly typing: string;
	/** パスワード欄への入力（文字そのものはどの場合も出さない）。 */
	readonly secret: string;
	/** 行き先がページの本体（フォーカスされた入力欄が無い）。 */
	readonly page: string;
}

/** ページ側スクリプトへ渡すコマンド。 */
export type ParadisCursorOverlayCommand =
	/**
	 * 目標座標へカーソルを動かす（必要なら生成する）。軌跡は main が cursor-motion で計算した
	 * keyframes（`paradisCursorMotion.ts`）で、ページはそれを `element.animate()` で再生するだけ。
	 * `drag` はボタンを押したままの移動で、押した点からの軌跡を残す。
	 */
	| { readonly kind: 'move'; readonly x: number; readonly y: number; readonly label: string; readonly durationMs: number; readonly frames: readonly IParadisCursorKeyframe[]; readonly drag?: boolean }
	/**
	 * 押した座標へカーソルを合わせて波紋と縮みを出す（未生成ならその場に作る）。
	 *
	 * `delayMs` は、直前の move がまだ滑っている途中のときの残り時間。押す前の move は待たずに
	 * 配送するので、ページは先に押され、カーソルは後から着く。そのときは滑りを途中で切らず、
	 * 着いた時に波紋を出す。
	 */
	| { readonly kind: 'press'; readonly x: number; readonly y: number; readonly label: string; readonly delayMs?: number }
	/** ボタンを離した。ドラッグの軌跡を消し始める。 */
	| { readonly kind: 'release' }
	/**
	 * キー入力。いまフォーカスされている要素へカーソルを寄せ、名札に入力中と出して入力欄に枠を描く。
	 * `key` は Enter・⌘K のような特別なキーの札（文字の入力では付けない）。
	 */
	| { readonly kind: 'focus'; readonly label: string; readonly texts: IParadisCursorTypingTexts; readonly key?: string }
	/** ホイール。カーソルの横に向きの矢印を出す。 */
	| { readonly kind: 'wheel'; readonly label: string; readonly dx: number; readonly dy: number; readonly text: string }
	/**
	 * 道具の状態（スクリプト実行中・待機中・押せなかった など）。`frames` があれば対象の要素へ寄せる
	 * （入力を伴わない道具の対象。待たない）。
	 *
	 * - `park`: カーソルがまだ無いページでも、右下の端に出す（名札を常に出す。q.html Q297 の 1）
	 * - `box`: 読み取り系の道具が見ている要素。薄い枠を少し出し、カーソルをそこへ寄せる（Q297 の 3）
	 * - `transient`: 長く続く状態でも少し出して消す（ページ移動の後に出し直したときの「読み込み中」）
	 * - `clickText`: evaluate_script の中のクリックへ寄せたときの名札（`script` のときだけ。Q297 の 4）
	 * - `since`: スクリプトを始めた時刻（ms、`Date.now()`）。これより前のクリックへは寄せない
	 * - `settle`: 片付けだけ（見えていないタブへの終わりの idle）。既にあるカーソルの状態・見張り・待機の輪を
	 *   落とすだけで、カーソルを付け直したり見せたりせず、無ければ何も作らない
	 */
	| { readonly kind: 'status'; readonly label: string; readonly status: ParadisCursorStatus; readonly text: string; readonly frames?: readonly IParadisCursorKeyframe[]; readonly durationMs?: number; readonly park?: boolean; readonly box?: IParadisCursorRect; readonly transient?: boolean; readonly clickText?: string; readonly since?: number; readonly settle?: boolean }
	/** 読み取り系の道具が見ている要素に枠を出し、カーソルを寄せるだけ（名札の状態とスクリプトの見張りは変えない）。 */
	| { readonly kind: 'look'; readonly label: string; readonly box: IParadisCursorRect }
	/** 撮影のため即座に隠す（進行中のフラッシュも消す）。描画が反映されるまで待ってから解決する。 */
	| { readonly kind: 'hide' }
	/** 隠していたカーソルを元に戻すだけ（フラッシュは出さない）。 */
	| { readonly kind: 'show' }
	/** 撮影完了。隠していたカーソルを戻し、フラッシュと知らせを出す。`rect` は撮った範囲（無ければ全体）。 */
	| { readonly kind: 'captured'; readonly toast: string; readonly rect?: IParadisCursorCaptureRange }
	/** 撮影を伴わない読み取り（take_snapshot）の範囲を光らせる。撮影のために隠している間は何もしない。 */
	| { readonly kind: 'flash'; readonly toast: string; readonly rect?: IParadisCursorCaptureRange }
	/** オーバーレイもフラッシュも完全に取り除く。 */
	| { readonly kind: 'remove' };

/** ページのコマンドに付ける持ち主（`owner` はカーソルを分ける鍵、`color`・`mark` は見た目）。 */
export interface IParadisCursorOwnerTag {
	readonly owner?: string;
	readonly color?: string;
	readonly mark?: string;
}

/** 持ち主の付いたコマンド。撮影と後始末（hide・show・captured・remove）はページの全部のカーソルに効く。 */
export type ParadisCursorOverlayOwnedCommand = ParadisCursorOverlayCommand & IParadisCursorOwnerTag;

/**
 * move・press・focus の実行結果としてページが返す事情。
 *
 * - `calm`: `prefers-reduced-motion: reduce`。ページ側は瞬間移動するので、main も待たない
 * - `blocked`: `<html>` に transform・filter・zoom などがあり、`position:fixed` の基準がずれる。
 *   ずれた位置にカーソルを描くよりは描かない（補正はしない）。待つ意味も無い
 */
export interface IParadisCursorOverlayPageTraits {
	readonly calm: boolean;
	readonly blocked: boolean;
}

/** 実行結果からページの事情を取り出す。形が違えば undefined（古いページの戻り値・例外）。 */
export function paradisParseCursorOverlayPageTraits(value: unknown): IParadisCursorOverlayPageTraits | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const { calm, blocked } = value as { calm?: unknown; blocked?: unknown };
	return typeof calm === 'boolean' && typeof blocked === 'boolean' ? { calm, blocked } : undefined;
}

/**
 * 1 回の入力の配送で、カーソルの演出のために待ってよいかの指示（shared process から main へ）。
 *
 * - `pressFollows`: この move の直後に press が続く（click・click_at・click_by など）。位置を測ってから
 *   押すまでの間に待つと、その間にページが動いたとき古い座標を押すので、待たずに配送する
 * - `maxWaitMs`: この配送で待ってよい上限。1 回のツール呼び出しで待つ合計を抑えるために使う
 */
export interface IParadisCursorPacing {
	readonly pressFollows?: boolean;
	readonly maxWaitMs?: number;
	/** 入力の持ち主（ペイン × タブ）。カーソルを持ち主ごとに分ける（q.html Q272 A）。 */
	readonly owner?: IParadisCursorOwner;
}

/**
 * カーソルの持ち主。shared process がペインのトークンとタブから決め、名前を整えて渡す
 * （`paradisCursorOwners.ts`）。`id` はトークンを含まない鍵。
 */
export interface IParadisCursorOwner {
	readonly id: string;
	/** 名札の名前（LLM が `set_cursor_label` で決めたもの、無ければ「Claude」「Codex 2」など）。 */
	readonly name: string;
	/** 名前の左に Para Code が描く CLI の印（C・X）。分からなければ空。 */
	readonly mark: string;
	/** カーソルと名札の色（#rrggbb）。 */
	readonly color: string;
}

/** IPC で受けた持ち主を確かめる。 */
export function paradisParseCursorOwner(value: unknown): IParadisCursorOwner | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const { id } = value as { id?: unknown };
	if (typeof id !== 'string' || !/^[0-9a-f]{8,32}$/.test(id)) {
		return undefined;
	}
	const label = paradisParseOwnerLabel(value);
	return label ? { id, ...label } : undefined;
}

/** IPC で受けた名札（名前・印・色）を確かめる。`id` は見ない（スクリプトの持ち主のように `id` を持たないものにも使う）。 */
export function paradisParseOwnerLabel(value: unknown): Pick<IParadisCursorOwner, 'name' | 'mark' | 'color'> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const { name, mark, color } = value as { name?: unknown; mark?: unknown; color?: unknown };
	if (typeof name !== 'string' || typeof mark !== 'string' || !/^[A-Z]{0,2}$/.test(mark) || typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
		return undefined;
	}
	// 名前は shared process で整えてあるが、ここでも制御文字・書式文字を落として長さを抑える
	const cleaned = name.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 24);
	return cleaned.length > 0 ? { name: cleaned, mark, color } : undefined;
}

/**
 * shared process から main へ送る道具の状態。`point` は対象の要素の中心（ビューポートの CSS ピクセル）。
 *
 * - `status`: 名札の状態。省くと状態は変えず、`rect`・`flash` だけを出す（並んで走る別の道具の名札を消さない）
 * - `rect`: 読み取り系の道具が見ている要素（ビューポートの CSS ピクセル）。枠を出してカーソルを寄せる
 * - `flash`: 撮影を伴わない読み取り（take_snapshot）が済んだ。`rect`（無ければ全体）を光らせる
 * - `since`: 道具を始めた時刻（ms）。evaluate_script の中のクリックを、これより後のものに限る
 */
export interface IParadisCursorStatusNote {
	readonly owner?: IParadisCursorOwner;
	readonly status?: ParadisCursorStatus;
	readonly since?: number;
	readonly detail?: string;
	readonly point?: { readonly x: number; readonly y: number };
	readonly rect?: IParadisCursorRect;
	readonly flash?: boolean;
}

const PARADIS_CURSOR_STATUSES: ReadonlySet<string> = new Set<ParadisCursorStatus>(['idle', 'script', 'waiting', 'loading', 'reading', 'failed', 'missing', 'select', 'value', 'upload', 'scroll']);

/** IPC で受けた矩形を確かめる。 */
function paradisParseCursorRect(value: unknown): IParadisCursorRect | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const { x, y, width, height } = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
	const ok = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= 100_000;
	return ok(x, -100_000) && ok(y, -100_000) && ok(width, 0) && ok(height, 0) ? { x, y, width, height } : undefined;
}

/** IPC で受けた道具の状態を確かめる。知らない形は捨てる。 */
export function paradisParseCursorStatusNote(value: unknown): IParadisCursorStatusNote | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const { status, detail, point, owner, rect, flash, since } = value as { status?: unknown; detail?: unknown; point?: unknown; owner?: unknown; rect?: unknown; flash?: unknown; since?: unknown };
	const parsedRect = paradisParseCursorRect(rect);
	if (status === undefined ? !parsedRect && flash !== true : typeof status !== 'string' || !PARADIS_CURSOR_STATUSES.has(status)) {
		return undefined;
	}
	const result: { owner?: IParadisCursorOwner; status?: ParadisCursorStatus; since?: number; detail?: string; point?: { x: number; y: number }; rect?: IParadisCursorRect; flash?: boolean } = status === undefined ? {} : { status: status as ParadisCursorStatus };
	if (parsedRect) {
		result.rect = parsedRect;
	}
	if (flash === true) {
		result.flash = true;
	}
	if (typeof since === 'number' && Number.isFinite(since) && since > 0) {
		result.since = since;
	}
	const parsedOwner = paradisParseCursorOwner(owner);
	if (parsedOwner) {
		result.owner = parsedOwner;
	}
	if (typeof detail === 'string' && detail.length > 0) {
		result.detail = detail.slice(0, 200);
	}
	if (typeof point === 'object' && point !== null) {
		const { x, y } = point as { x?: unknown; y?: unknown };
		if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 100_000 && Math.abs(y) <= 100_000) {
			result.point = { x, y };
		}
	}
	return result;
}

/** IPC で受けた指示を確かめる。知らない形は「指示なし」（今までどおり待つ）として扱う。 */
export function paradisParseCursorPacing(value: unknown): IParadisCursorPacing | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const { pressFollows, maxWaitMs, owner } = value as { pressFollows?: unknown; maxWaitMs?: unknown; owner?: unknown };
	const result: { pressFollows?: boolean; maxWaitMs?: number; owner?: IParadisCursorOwner } = {};
	const parsedOwner = paradisParseCursorOwner(owner);
	if (parsedOwner) {
		result.owner = parsedOwner;
	}
	if (pressFollows === true) {
		result.pressFollows = true;
	}
	if (typeof maxWaitMs === 'number' && Number.isFinite(maxWaitMs)) {
		result.maxWaitMs = Math.max(0, Math.round(maxWaitMs));
	}
	return result;
}

/**
 * `window` へ状態を置くときのキー。isolated worldごとに独立しているため、
 * ページ側スクリプトから見えることはない。
 */
const STATE_KEY = '__paraCodeAgentCursorOverlay';

/** evaluate_script の中のクリックの受け口を置いたかの印（isolated world の `window` に置く）。 */
const CLICKS_KEY = '__paraCodeAgentCursorClicks';

/** カーソルとラベルのアクセントカラー（ワークベンチのアクセントに合わせた固定値）。 */
const ACCENT_COLOR = '#5b8cff';

/** 押せなかった印の色。 */
const DANGER_COLOR = '#cf222e';

/**
 * cursor-motion の矢印（Cua Driver のカーソル、./cursorMotion/README.md と同じ取得元の `render.ts` の
 * `CURSOR_PATH`）。128 の正方形の上で、先端（クリックの点）が (55, 30)。
 */
const CURSOR_PATH = 'M55 30 C48 28 42 33 43 41 C43 41 64 98 64 98 C67 106 73 106 77 99 C77 99 86 79 86 79 C88 75 91 72 95 70 C95 70 108 63 108 63 C115 59 114 53 107 50 C107 50 55 30 55 30 Z';
/** 画面での大きさ（px、Cua Driver の表示の大きさ）。 */
const CURSOR_SIZE = 42;

/**
 * JSONをスクリプトへ埋め込むためにシリアライズする。
 *
 * U+2028 / U+2029 はJSONでは生のまま出力されるが、古い実行環境では行終端子として
 * 解釈されうるためエスケープしておく（渡すのは自前の値だけだが、埋め込みの安全性は
 * 入力に依存させない）。
 */
export function paradisEncodeCursorOverlayPayload(command: ParadisCursorOverlayOwnedCommand, tuning: IParadisCursorOverlayTuning): string {
	return JSON.stringify({ ...tuning, ...command })
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

/** 札を出すキー（文字の入力でないもの）。CDP の `key` の値 → 札の文字。 */
const PARADIS_CURSOR_NAMED_KEYS: Readonly<Record<string, string>> = {
	Enter: 'Enter', Tab: 'Tab', Escape: 'Esc', Backspace: '\u232b', Delete: 'Del',
	ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192',
	PageUp: 'PgUp', PageDown: 'PgDn', Home: 'Home', End: 'End',
};

/**
 * キーの札の文字（Enter・⌘K など）。文字の入力（修飾キーなしの 1 文字）・キーを離した・修飾キーそのものは
 * undefined（札を出さない。パスワード欄があるので打った文字は出さない）。
 */
export function paradisCursorKeyLabel(params: Readonly<Record<string, unknown>>, mac: boolean): string | undefined {
	if (params.type !== 'keyDown' && params.type !== 'rawKeyDown') {
		return undefined;
	}
	const key = typeof params.key === 'string' ? params.key : '';
	if (key === '' || key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') {
		return undefined;
	}
	const modifiers = typeof params.modifiers === 'number' ? params.modifiers : 0;
	// CDP の modifiers: Alt=1, Ctrl=2, Meta=4, Shift=8
	const alt = (modifiers & 1) !== 0, ctrl = (modifiers & 2) !== 0, meta = (modifiers & 4) !== 0, shift = (modifiers & 8) !== 0;
	const named = PARADIS_CURSOR_NAMED_KEYS[key] ?? (/^F\d{1,2}$/.test(key) ? key : undefined);
	// 名前の無いキーは Ctrl・⌘ のショートカットだけ札にする。Option・AltGr（Ctrl+Alt）で打つ文字（@・€・é）は
	// 文字の入力なので出さない
	if (named === undefined && (!(ctrl || meta) || alt)) {
		return undefined;
	}
	const base = named ?? ([...key].length === 1 ? key.toUpperCase() : key.slice(0, 8));
	const parts = mac
		? [ctrl ? '\u2303' : '', alt ? '\u2325' : '', shift ? '\u21e7' : '', meta ? '\u2318' : ''].join('') + base
		: [ctrl ? 'Ctrl+' : '', alt ? 'Alt+' : '', shift ? 'Shift+' : '', meta ? 'Win+' : ''].join('') + base;
	return parts;
}

/** 入力配送を待たせる時間を、安全な範囲へ丸める。 */
export function paradisClampCursorWaitMs(raw: unknown, maxWaitMs: number = PARADIS_CURSOR_OVERLAY_MAX_WAIT_MS): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
		return 0;
	}
	return Math.min(Math.round(raw), Math.max(0, Math.round(maxWaitMs)));
}

/**
 * このマウスイベントで使う移動アニメーションの最長時間を決める。
 *
 * ドラッグ中（`buttons` が立っている移動）はカーソルが実際の掴んでいる点から
 * 離れて見えると不自然なので、通常より大幅に短くする。
 */
export function paradisCursorMoveMaxMs(params: Readonly<Record<string, unknown>>, tuning: IParadisCursorOverlayTuning = PARADIS_CURSOR_OVERLAY_TUNING): number {
	const buttons = params.buttons;
	const dragging = typeof buttons === 'number' && Number.isFinite(buttons) && buttons !== 0;
	return dragging ? tuning.dragMaxMs : tuning.maxMs;
}

/**
 * 直前の位置から目標座標までの移動にかける時間（ms）を決める。
 *
 * ページへ問い合わせず main 側だけで決めるのは、入力配送の途中にIPC往復を挟まないため。
 * 直前の位置が無い／古すぎる（ページ側は `idleMs` で自ら消えている）ときは、
 * 距離ではなくフェードインぶんだけ待つ。
 */
export function paradisCursorGlideMs(
	previous: { readonly x: number; readonly y: number; readonly at: number } | undefined,
	next: { readonly x: number; readonly y: number; readonly at: number },
	maxMs: number,
	tuning: IParadisCursorOverlayTuning = PARADIS_CURSOR_OVERLAY_TUNING,
): number {
	if (!previous || next.at - previous.at > tuning.idleMs) {
		return tuning.appearMs;
	}
	const distance = Math.sqrt((next.x - previous.x) ** 2 + (next.y - previous.y) ** 2);
	if (distance < tuning.snapPx) {
		return 0;
	}
	return Math.round(Math.max(tuning.minMs, Math.min(maxMs, distance / tuning.pxPerMs)));
}

/**
 * isolated worldで実行する自己完結スクリプトを組み立てる。
 *
 * 毎回まるごと送る（差分注入や `Page.addScriptToEvaluateOnNewDocument` による常駐はしない）。
 * ナビゲーション後もそのまま作り直せるうえ、送り先はelectron-main→レンダラのIPCなので
 * CDPゲートウェイの帯域予算とは無関係だからである。
 */
export function paradisBuildCursorOverlayScript(command: ParadisCursorOverlayOwnedCommand, tuning: IParadisCursorOverlayTuning = PARADIS_CURSOR_OVERLAY_TUNING): string {
	return `(function (c) {
	'use strict';
	try {
		var K = ${JSON.stringify(STATE_KEY)};
		var K2 = ${JSON.stringify(CLICKS_KEY)};
		/** 道具が終わるか次の状態が来るまで名札に残す状態。 */
		var STICKY = { script: 1, waiting: 1, loading: 1, reading: 1 };
		// 色は持ち主ごと（main が決める）。形の違う値は使わずアクセントに戻す
		var A = typeof c.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : ${JSON.stringify(ACCENT_COLOR)};
		var SVGNS = 'http://www.w3.org/2000/svg';
		var doc = document;
		if (!doc) { return 0; }
		var calm = false;
		try { calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { }
		function sx(el, o) { for (var k in o) { try { el.style[k] = o[k]; } catch (e) { } } }
		function sv(n, a) { var e = doc.createElementNS(SVGNS, n); for (var k in a) { e.setAttribute(k, a[k]); } return e; }
		// documentElement を優先する。body に transform / filter / will-change があると
		// position:fixed の基準が body になり、カーソルが実際のクリック位置からずれるため。
		function root() { return doc.documentElement || doc.body; }
		/** 状態だけを取り出す（cursorのDOMは作らない）。撮影の退避や後始末が、無かったはずの
		 *  カーソルを作ってしまわないようにするための分離。 */
		/** ページに 1 つの状態（撮影の隠し・フラッシュ・知らせ）と、持ち主ごとのカーソル（'cs'）。 */
		function G(create) {
			var g = window[K];
			if (!g && create) { g = window[K] = { cs: {}, f: null, ts: null, tst: 0, hid: false, fh: null, fs: null }; watchClicks(); }
			return g || null;
		}
		/** 全部のカーソルに。 */
		function each(fn) {
			var g = G(false);
			if (!g) { return; }
			var ids = Object.keys(g.cs);
			for (var i = 0; i < ids.length; i++) { if (g.cs[ids[i]]) { fn(g.cs[ids[i]]); } }
		}
		/** このコマンドの持ち主のカーソル（ペイン × タブ。持ち主の無いコマンドは '_'）。 */
		function state(create) {
			var g = G(create);
			if (!g) { return null; }
			var id = typeof c.owner === 'string' && c.owner.length > 0 ? c.owner : '_';
			var s = g.cs[id];
			if (!s && create) {
				s = g.cs[id] = { g: g, id: id, color: A, h: null, lf: null, lft: 0, alf: null, watch: false, wat: 0, since: 0, ct: '', cq: null, cqt: 0, mv: null, gl: null, sq: null, rp: null, rg: null, mk: null, lb: null, lm: null, lt: null, kb: null, fr: null, tr: null, tl2: null, t: '', name: '', mark: '', st: '', sticky: '', x: null, y: null, r: 0, tm: 0, stt: 0, kbt: 0, frt: 0, mkt: 0, trt: 0, am: null, ag: null, ao: null, aw: null, awo: null, atr: null, shown: false, fading: false, typing: false, wt: false, pp: null, tl: null, tp: null };
			}
			return s || null;
		}
		/** カーソルが無く、フラッシュも知らせも無ければ、ページの状態ごと畳む。 */
		function collapse(g) {
			if (window[K] === g && Object.keys(g.cs).length === 0 && !g.f && !g.ts) {
				if (g.fh && g.fh.parentNode) { g.fh.parentNode.removeChild(g.fh); }
				try { delete window[K]; } catch (e) { window[K] = void 0; }
			}
		}
		/**
		 * フラッシュと知らせを入れる closed shadow root（カーソルと同じく、ページのスクリプトから読めず、
		 * アクセシビリティのツリー・スナップショットにも出さない）。
		 */
		function effects(g) {
			if (!g.fh || !g.fh.isConnected) {
				var p = root();
				if (!p) { return null; }
				var h = doc.createElement('div');
				h.setAttribute('aria-hidden', 'true');
				sx(h, { position: 'fixed', left: '0px', top: '0px', width: '0px', height: '0px', margin: '0px', padding: '0px', border: '0px', overflow: 'visible', zIndex: '2147483647', pointerEvents: 'none' });
				g.fs = h.attachShadow ? h.attachShadow({ mode: 'closed' }) : h;
				g.fh = h;
				p.appendChild(h);
			}
			return g.fs;
		}
		/** スクリプトの実行中としてクリックを拾ってよいカーソルか（終わりの知らせが届かなくても上限で止める）。 */
		function watching(s) {
			return !!(s && s.watch && s.h && Date.now() - s.wat < c.watchMs);
		}

		/**
		 * evaluate_script の中の '.click()'・'dispatchEvent' のクリック（isTrusted でないもの）を受ける口を、
		 * この文書に 1 度だけ置く（q.html Q297 の 4）。isolated world の受け口なので、ページのスクリプトからは
		 * 見えず外せない。受けた要素は WeakRef で少しだけ覚え、スクリプトの実行中のカーソル（'watch'）を
		 * そこへ寄せる。止めたり書き換えたりはしない（ページの挙動を変えない）。
		 */
		function watchClicks() {
			if (window[K2] || typeof WeakRef !== 'function') { return; }
			var rec = window[K2] = { q: [] };
			try {
				window.addEventListener('click', function (e) {
					try {
						if (e.isTrusted) { return; }
						var el = e.target;
						if (!el || el.nodeType !== 1) { return; }
						var item = { r: new WeakRef(el), at: Date.now(), done: false };
						rec.q.push(item);
						if (rec.q.length > 8) { rec.q.shift(); }
						var g = window[K];
						if (!g) { return; }
						// 誰のスクリプトのクリックかはイベントから分からない。見張っているカーソルが 1 つのときだけ寄せる
						var ids = Object.keys(g.cs), only = null, count = 0;
						for (var i = 0; i < ids.length; i++) {
							if (watching(g.cs[ids[i]])) { only = g.cs[ids[i]]; count++; }
						}
						if (count === 1 && item.at >= only.since) { item.done = true; follow(only, el); }
					} catch (err) { }
				}, true);
			} catch (e) { }
		}
		/**
		 * スクリプトを始めた後、状態の知らせより先に来たクリックへも寄せる（'s.since' はスクリプトを始めた時刻。
		 * それより前のページ自身のクリックは拾わない）。
		 */
		function replay(s) {
			var rec = window[K2];
			if (!rec || !(s.since > 0)) { return; }
			for (var i = 0; i < rec.q.length; i++) {
				var it = rec.q[i];
				if (it.done || it.at < s.since) { continue; }
				it.done = true;
				var el = it.r.deref();
				if (el && el.isConnected) { follow(s, el); }
			}
		}
		/** 押された要素へ順に寄せる（多すぎるときは捨てる）。 */
		function follow(s, el) {
			if (!s.cq) { s.cq = []; }
			if (s.cq.length >= 4) { return; }
			s.cq.push(el);
			if (!s.cqt) { followNext(s); }
		}
		function followNext(s) {
			s.cqt = 0;
			while (s.cq && s.cq.length) {
				var el = s.cq.shift();
				var p = pointOf(el);
				if (!p || !s.h || !s.h.isConnected || s.g.cs[s.id] !== s) { continue; }
				var d = calm ? 0 : c.lookGlideMs;
				slide(s, p.x, p.y, d);
				reveal(s);
				arm(s, c.idleMs);
				if (s.ct) { setStatus(s, s.ct, c.markMs); }
				if (!calm) {
					anim(s.rp, [{ transform: 'scale(0.35)', opacity: 0.75 }, { transform: 'scale(1.6)', opacity: 0 }], { duration: c.rippleMs, delay: d, easing: 'cubic-bezier(0.2,0.7,0.3,1)' });
					anim(s.sq, [{ transform: 'scale(1)' }, { transform: 'scale(0.82)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: c.squishMs, delay: d, easing: 'ease-out' });
				}
				s.cqt = setTimeout(function () { followNext(s); }, c.scriptClickGapMs);
				return;
			}
		}
		/**
		 * 今いる点から真っすぐ寄せる（色に触らない）。受け口は最初に置いたコマンドの持ち主の色を覚えて
		 * いるので、ほかの持ち主のカーソルを作り直す 'play' は使わない。
		 */
		function slide(s, x, y, dur) {
			var fx = s.x === null ? x : s.x, fy = s.x === null ? y : s.y;
			if (s.am) {
				try { var m = new DOMMatrixReadOnly(getComputedStyle(s.mv).transform); fx = m.m41; fy = m.m42; } catch (e) { }
			}
			var d = s.x === null || !(dur > 0) ? 1 : dur;
			stop(s.am); stop(s.ag);
			s.am = anim(s.mv, [{ transform: 'translate3d(' + fx + 'px,' + fy + 'px,0)' }, { transform: 'translate3d(' + x + 'px,' + y + 'px,0)' }], { duration: d, fill: 'forwards', easing: 'ease-out' });
			s.ag = anim(s.gl, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(0deg)' }], { duration: 1, fill: 'forwards' });
			s.x = x; s.y = y; s.r = 0;
		}
		/** カーソルがまだ無いページで、名札を出しておく場所（右下の端。名札が画面に収まる位置）。 */
		function parkPoint() {
			var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
			return { x: Math.max(12, Math.round(vw - 200)), y: Math.max(12, Math.round(vh - 64)) };
		}
		/**
		 * 読み取り系の道具が見ている要素に薄い枠を少し出す。画面に見えている部分だけを囲み、カーソルを
		 * 寄せる点を返す。画面の外なら何もしない。
		 */
		function look(s, b) {
			if (!s.lf) { return null; }
			var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
			var l = Math.max(0, b.x), t = Math.max(0, b.y), r = Math.min(vw, b.x + b.width), bt = Math.min(vh, b.y + b.height);
			if (!(r - l > 0 && bt - t > 0)) { return null; }
			if (s.lft) { clearTimeout(s.lft); s.lft = 0; }
			stop(s.alf); s.alf = null;
			sx(s.lf, { left: Math.round(l - 3) + 'px', top: Math.round(t - 3) + 'px', width: Math.round(r - l + 6) + 'px', height: Math.round(bt - t + 6) + 'px', opacity: '1' });
			if (!calm) { s.alf = anim(s.lf, [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: c.lookMs, fill: 'forwards', easing: 'ease' }); }
			s.lft = setTimeout(function () { s.lft = 0; stop(s.alf); s.alf = null; sx(s.lf, { opacity: '0' }); }, c.lookMs);
			return { x: Math.round(l + Math.min(14, Math.max(2, (r - l) / 2))), y: Math.round(t + (bt - t) / 2) };
		}

		/** いまフォーカスされている要素（shadow root の中まで辿る）。 */
		function deepActive() {
			var el = doc.activeElement, guard = 0;
			while (el && el.shadowRoot && el.shadowRoot.activeElement && guard++ < 20) { el = el.shadowRoot.activeElement; }
			return el;
		}
		/**
		 * '<html>' に 'position:fixed' の基準を変える指定があるか。あるとカーソルがクリックの位置から
		 * ずれるので描かない（補正はしない）。body は避けて html に置いているが、html 自身は避けられない。
		 */
		function blockedRoot() {
			try {
				var de = doc.documentElement;
				if (!de || !window.getComputedStyle) { return false; }
				var cs = window.getComputedStyle(de);
				if (cs.transform && cs.transform !== 'none') { return true; }
				if (cs.filter && cs.filter !== 'none') { return true; }
				if (cs.backdropFilter && cs.backdropFilter !== 'none') { return true; }
				if (cs.perspective && cs.perspective !== 'none') { return true; }
				if ((cs.translate && cs.translate !== 'none') || (cs.rotate && cs.rotate !== 'none') || (cs.scale && cs.scale !== 'none')) { return true; }
				if (cs.containerType && cs.containerType !== 'normal') { return true; }
				var z = cs.zoom;
				if (z && z !== '1' && z !== 'normal') { return true; }
				if (/transform|filter|perspective/.test(cs.willChange || '')) { return true; }
				if (/paint|layout|strict|content/.test(cs.contain || '')) { return true; }
			} catch (e) { }
			return false;
		}
		/** ページの事情を main へ返す（'IParadisCursorOverlayPageTraits'）。 */
		function traits(blocked) { return { calm: calm, blocked: !!blocked }; }
		/**
		 * いま top layer にあるもの（全画面・モーダルのダイアログ・開いている popover）の目印。
		 * top layer は z-index に関係なく上に描かれるので、そこにカーソルを出すには自分も top layer の
		 * 最後に積む必要がある。
		 */
		function topLayerKey(s) {
			var n = 0, last = null;
			try {
				var fs = doc.fullscreenElement;
				if (fs) { n++; last = fs; }
				var list = doc.querySelectorAll(':modal, :popover-open');
				for (var i = 0; i < list.length; i++) { if (list[i] !== s.h) { n++; last = list[i]; } }
			} catch (e) { }
			return n === 0 ? null : { n: n, last: last };
		}
		/** top layer に何かあれば、カーソルを popover にして top layer の最後へ積み直す。 */
		function lift(s) {
			var k = topLayerKey(s);
			var h = s.h;
			if (!k) {
				s.tl = null;
				// popover のまま閉じられていると（付け直した・ページが popover を一括で閉じた）、UA の
				// '[popover]:not(:popover-open)' で消えたままになる。top layer が空なら普通の要素に戻す。
				try { if (h.hasAttribute('popover') && !h.matches(':popover-open')) { h.removeAttribute('popover'); } } catch (e) { }
				return;
			}
			var open = false;
			try { open = h.matches(':popover-open'); } catch (e) { }
			// 積み直すと表示が一度切れて滑りが止まるので、top layer の中身が変わったときだけ行う。
			if (open && s.tl && s.tl.n === k.n && s.tl.last === k.last) { return; }
			s.tl = k;
			try {
				if (!h.hasAttribute('popover')) { h.setAttribute('popover', 'manual'); }
				if (open) { h.hidePopover(); }
				h.showPopover();
			} catch (e) {
				// popover を使えない。UA の '[popover]:not(:popover-open)' で消えないよう属性を外す。
				try { h.removeAttribute('popover'); } catch (e2) { }
				s.tl = null;
			}
		}
		/** 要素のどこにカーソルを置くか。画面外・大きさ0なら置かない。 */
		function pointOf(el) {
			if (!el || !el.getBoundingClientRect || el === doc.body || el === doc.documentElement) { return null; }
			var r;
			try { r = el.getBoundingClientRect(); } catch (e) { return null; }
			if (!r || (r.width <= 0 && r.height <= 0)) { return null; }
			var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
			if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) { return null; }
			return { x: Math.round(r.left + Math.min(14, Math.max(2, r.width / 2))), y: Math.round(r.top + r.height / 2) };
		}

		/** 押した点の上下左右の枠（入力欄の枠を描く）。iframe の中の要素は iframe の位置を足す。 */
		function rectOf(el) {
			try {
				var r = el.getBoundingClientRect();
				return r && (r.width > 0 || r.height > 0) ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
			} catch (e) { return null; }
		}
		/**
		 * キー入力の行き先。iframe にフォーカスがあれば、読める（同じ origin の）ときは中の要素まで辿る。
		 * 戻り値の 'kind' は 'field'（入力欄）・'secret'（パスワード欄）・'page'（本体）。
		 */
		function typingTarget() {
			var el = deepActive(), ox = 0, oy = 0, guard = 0;
			while (el && el.tagName === 'IFRAME' && guard++ < 5) {
				var fr = rectOf(el);
				var inner = null;
				try { inner = el.contentDocument && el.contentDocument.activeElement; } catch (e) { inner = null; }
				if (!fr || !inner || inner === el.contentDocument.body) { break; }
				ox += fr.left; oy += fr.top; el = inner;
			}
			if (!el || el === doc.body || el === doc.documentElement || (el.ownerDocument && el === el.ownerDocument.body)) { return { kind: 'page', el: null, rect: null }; }
			var r = rectOf(el);
			if (r) { r.left += ox; r.top += oy; }
			var type = '';
			try { type = String(el.type || '').toLowerCase(); } catch (e) { }
			return { kind: type === 'password' ? 'secret' : 'field', el: el, rect: r };
		}

		function buildCursor(s) {
			// ホストは画面の左上に止めたまま、中の 'mv' だけを keyframes で動かす。入力欄の枠と
			// ドラッグの軌跡は画面の座標で描くので、動く要素の外（ホストの直下）に置く。
			var h = doc.createElement('div');
			h.setAttribute('aria-hidden', 'true');
			sx(h, {
				position: 'fixed', left: '0px', top: '0px', right: 'auto', bottom: 'auto', width: '0px', height: '0px',
				margin: '0px', padding: '0px', border: '0px', background: 'none', overflow: 'visible',
				zIndex: '2147483647', pointerEvents: 'none'
			});
			var sr = h.attachShadow ? h.attachShadow({ mode: 'closed' }) : h;
			var fr = doc.createElement('div');
			sx(fr, { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px', boxSizing: 'border-box', border: '2px solid ' + A, borderRadius: '5px', opacity: '0', pointerEvents: 'none' });
			// 読み取り系の道具が見ている要素の枠（入力欄の枠より薄く）
			var lf = doc.createElement('div');
			sx(lf, { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px', boxSizing: 'border-box', border: '1.5px solid ' + A, borderRadius: '6px', background: A + '14', boxShadow: '0 0 0 3px ' + A + '26', opacity: '0', pointerEvents: 'none' });
			var tr = sv('svg', { width: '1', height: '1' });
			sx(tr, { position: 'absolute', left: '0px', top: '0px', overflow: 'visible', opacity: '0', pointerEvents: 'none' });
			var tl = sv('polyline', { fill: 'none', stroke: A, 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': '0.65', points: '' });
			tr.appendChild(tl);
			var mv = doc.createElement('div');
			sx(mv, { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px', pointerEvents: 'none', opacity: '0', transform: 'translate3d(-99999px,-99999px,0)' });
			var rp = doc.createElement('div');
			sx(rp, {
				position: 'absolute', left: '-18px', top: '-18px', width: '36px', height: '36px',
				boxSizing: 'border-box', borderRadius: '50%', border: '2px solid ' + A, opacity: '0'
			});
			// 待機中の輪（回る）
			var rg = doc.createElement('div');
			sx(rg, {
				position: 'absolute', left: '-15px', top: '-15px', width: '30px', height: '30px',
				boxSizing: 'border-box', borderRadius: '50%', border: '2px solid ' + A, borderTopColor: 'transparent', opacity: '0'
			});
			// 矢印。先端（クリックの点）が 'gl' の原点に来るよう、cursor-motion の 128 の正方形をずらして置く。
			var gl = doc.createElement('div');
			sx(gl, { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px' });
			var sq = doc.createElement('div');
			sx(sq, { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px' });
			var scale = ${CURSOR_SIZE} / 128;
			var g = sv('svg', { viewBox: '0 0 128 128', width: String(${CURSOR_SIZE}), height: String(${CURSOR_SIZE}) });
			sx(g, { position: 'absolute', left: (-55 * scale) + 'px', top: (-30 * scale) + 'px', overflow: 'visible', filter: 'drop-shadow(0 0 3px ' + A + ') drop-shadow(0 2px 3px rgba(0,0,0,0.3))' });
			g.appendChild(sv('path', { d: ${JSON.stringify(CURSOR_PATH)}, fill: A, stroke: '#ffffff', 'stroke-width': '5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
			sq.appendChild(g); gl.appendChild(sq);
			// 印（押せなかった ✕・スクロールの矢印）
			var mk = doc.createElement('div');
			sx(mk, {
				position: 'absolute', left: '-11px', top: '-11px', width: '22px', height: '22px', borderRadius: '50%',
				display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ffffff', background: A,
				font: '700 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif', opacity: '0',
				boxShadow: '0 1px 4px rgba(0,0,0,0.3)'
			});
			var lb = doc.createElement('div');
			sx(lb, {
				position: 'absolute', left: '18px', top: '22px', display: 'flex', alignItems: 'center', gap: '5px',
				background: A, color: '#ffffff',
				font: '500 10.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
				padding: '2px 7px', borderRadius: '5px', whiteSpace: 'nowrap',
				boxShadow: '0 2px 6px rgba(0,0,0,0.25)'
			});
			// CLI の印（C・X）。Para Code が描き、名前を決める LLM は変えられない
			var lm = doc.createElement('span');
			sx(lm, { display: 'none', minWidth: '13px', height: '13px', borderRadius: '50%', background: 'rgba(255,255,255,0.28)', font: '700 9px/13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif', textAlign: 'center' });
			var lt = doc.createElement('span');
			var kb = doc.createElement('span');
			sx(kb, {
				display: 'none', padding: '0px 5px', borderRadius: '3px', background: 'rgba(255,255,255,0.22)',
				border: '1px solid rgba(255,255,255,0.45)', font: '600 10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace'
			});
			lb.appendChild(lm); lb.appendChild(lt); lb.appendChild(kb);
			mv.appendChild(rp); mv.appendChild(rg); mv.appendChild(gl); mv.appendChild(mk); mv.appendChild(lb);
			sr.appendChild(lf); sr.appendChild(fr); sr.appendChild(tr); sr.appendChild(mv);
			// 撮影のために隠している最中に作ったなら、作った時から隠す
			if (s.g.hid) { sx(h, { display: 'none' }); }
			s.color = A; s.mark = ''; s.t = '';
			s.h = h; s.lm = lm; s.mv = mv; s.gl = gl; s.sq = sq; s.rp = rp; s.rg = rg; s.mk = mk; s.lb = lb; s.lt = lt; s.kb = kb; s.fr = fr; s.tr = tr; s.tl2 = tl; s.lf = lf;
		}
		function anim(el, frames, opts) { try { return el.animate(frames, opts); } catch (e) { return null; } }
		function stop(a) { if (a) { try { a.cancel(); } catch (e) { } } }
		function dropFlash(g) {
			if (g.f) { if (g.f.parentNode) { g.f.parentNode.removeChild(g.f); } g.f = null; }
		}
		function dropToast(g) {
			if (g.tst) { clearTimeout(g.tst); g.tst = 0; }
			if (g.ts) { if (g.ts.parentNode) { g.ts.parentNode.removeChild(g.ts); } g.ts = null; }
		}
		function clearTimers(s) {
			var names = ['tm', 'stt', 'kbt', 'frt', 'mkt', 'trt', 'lft', 'cqt'];
			for (var i = 0; i < names.length; i++) { if (s[names[i]]) { clearTimeout(s[names[i]]); s[names[i]] = 0; } }
		}
		/** 1 つのカーソルを取り除く（ほかの持ち主のカーソルは残す）。 */
		function kill(s) {
			clearTimers(s);
			s.cq = null; s.watch = false;
			if (s.h && s.h.parentNode) { s.h.parentNode.removeChild(s.h); }
			if (s.g.cs[s.id] === s) { delete s.g.cs[s.id]; }
			collapse(s.g);
		}
		function arm(s, ms) {
			if (s.tm) { clearTimeout(s.tm); }
			s.tm = setTimeout(function () {
				stop(s.ao);
				s.fading = true;
				s.ao = anim(s.mv, [{ opacity: 1 }, { opacity: 0 }], { duration: 380, fill: 'forwards', easing: 'ease' });
				s.tm = setTimeout(function () { kill(s); }, 440);
			}, ms);
		}
		function attachCursor(s) {
			// 持ち主の色が変わった（同じページの持ち主の並びが変わった）。作り直す
			if (s.h && s.color !== A) {
				if (s.h.parentNode) { s.h.parentNode.removeChild(s.h); }
				s.h = null; s.shown = false; s.fading = false;
			}
			if (!s.h) { buildCursor(s); }
			if (!s.h) { return false; }
			if (!s.h.isConnected) {
				var p = root();
				if (!p) { return false; }
				p.appendChild(s.h);
				s.tl = null;
			}
			lift(s);
			return true;
		}
		/** 見えるようにする（撮影のために隠している間は出さない）。 */
		function reveal(s) {
			if (s.g.hid) { return; }
			sx(s.h, { display: '' });
			if (s.fading) { s.fading = false; stop(s.ao); s.ao = null; }
			if (s.shown) { return; }
			// 不透明にするのは出すときの 1 回だけ（移動のたびに style を書かない）。
			s.shown = true;
			sx(s.mv, { opacity: '1' });
			if (!calm) { anim(s.mv, [{ opacity: 0 }, { opacity: 1 }], { duration: 170, easing: 'ease' }); }
		}
		/**
		 * keyframes を再生する。前の再生は止めるが、新しい再生は main が計算した「今いる点」から始まる
		 * ので位置は跳ばない。style の属性は書き換えない（ページのセッション録画に残りにくくするため）。
		 */
		function play(s, frames, dur) {
			if (!attachCursor(s)) { return; }
			var last = frames[frames.length - 1];
			var fs = (calm || !(dur > 0) || frames.length < 2 || s.x === null) ? [{ x: last.x, y: last.y, r: last.r, o: 0 }, { x: last.x, y: last.y, r: last.r, o: 1 }] : frames;
			var d = fs === frames ? dur : 1;
			if (fs === frames && s.am) {
				// main は寄せ（入力欄へ）や押した点の行き過ぎを知らないので、再生の頭を今いる点へ合わせる
				try {
					var m = new DOMMatrixReadOnly(getComputedStyle(s.mv).transform);
					if (Math.abs(m.m41 - frames[0].x) > 2 || Math.abs(m.m42 - frames[0].y) > 2) {
						fs = frames.slice();
						fs[0] = { x: Math.round(m.m41 * 10) / 10, y: Math.round(m.m42 * 10) / 10, r: frames[0].r, o: 0 };
					}
				} catch (e) { }
			}
			s.x = last.x; s.y = last.y; s.r = last.r;
			stop(s.am); stop(s.ag);
			s.am = anim(s.mv, fs.map(function (f) { return { transform: 'translate3d(' + f.x + 'px,' + f.y + 'px,0)', offset: f.o }; }), { duration: d, fill: 'forwards', easing: 'linear' });
			s.ag = anim(s.gl, fs.map(function (f) { return { transform: 'rotate(' + f.r + 'deg)', offset: f.o }; }), { duration: d, fill: 'forwards', easing: 'linear' });
			reveal(s);
			arm(s, c.idleMs + d);
		}
		/** 今の向きのまま、点へ真っすぐ動かす（press・focus・ホイール）。 */
		function glideTo(s, x, y, dur) {
			var r = s.r || 0;
			var from = s.x === null ? { x: x, y: y } : { x: s.x, y: s.y };
			play(s, [{ x: from.x, y: from.y, r: r, o: 0 }, { x: x, y: y, r: 0, o: 1 }], dur);
		}
		/** 名札。名前の後ろに状態を出す。 */
		function render(s) {
			if (!s.lt) { return; }
			var text = s.st ? s.name + ' \\u00b7 ' + s.st : s.name;
			if (s.t !== text) { s.t = text; s.lt.textContent = text; }
		}
		function setLabel(s, label) {
			var mk = typeof c.mark === 'string' ? c.mark.slice(0, 2) : '';
			if (s.lm && s.mark !== mk) { s.mark = mk; s.lm.textContent = mk; sx(s.lm, { display: mk ? 'inline-block' : 'none' }); }
			s.name = label; if (!s.st && s.sticky) { s.st = s.sticky; } render(s); }
		/** 状態を出す。'ms' があればその後に消す（長く続く状態は次の状態まで残す）。 */
		function setStatus(s, text, ms) {
			if (s.stt) { clearTimeout(s.stt); s.stt = 0; }
			s.st = text || '';
			render(s);
			if (ms > 0) { s.stt = setTimeout(function () { s.stt = 0; s.st = s.sticky || ''; render(s); }, ms); }
		}
		/** 待機中: カーソルを薄くして輪を回す。 */
		function setWaiting(s, on) {
			if (!!s.wt === !!on) { return; }
			s.wt = !!on;
			stop(s.aw); stop(s.awo); s.aw = null; s.awo = null;
			if (on) {
				sx(s.rg, { opacity: '1' });
				if (!calm) { s.aw = anim(s.rg, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 900, iterations: Infinity }); }
				s.awo = anim(s.gl, [{ opacity: 0.5 }, { opacity: 0.5 }], { duration: 1, fill: 'forwards' });
			} else {
				sx(s.rg, { opacity: '0' });
			}
		}
		/** 印（✕・矢印）を少し出す。 */
		function mark(s, glyph, color) {
			if (s.mkt) { clearTimeout(s.mkt); s.mkt = 0; }
			s.mk.textContent = glyph;
			sx(s.mk, { background: color, opacity: '1' });
			s.mkt = setTimeout(function () { s.mkt = 0; sx(s.mk, { opacity: '0' }); }, c.markMs);
		}
		/** キーの札を少し出す。 */
		function keyBadge(s, key) {
			if (s.kbt) { clearTimeout(s.kbt); s.kbt = 0; }
			s.kb.textContent = key;
			sx(s.kb, { display: '' });
			s.kbt = setTimeout(function () { s.kbt = 0; sx(s.kb, { display: 'none' }); }, c.keyMs);
		}
		/** 入力欄の枠。打つのが止まったら消す。 */
		function fieldFrame(s, r) {
			if (s.frt) { clearTimeout(s.frt); s.frt = 0; }
			var done = function () { s.frt = 0; sx(s.fr, { opacity: '0' }); if (s.typing) { s.typing = false; setStatus(s, s.sticky || '', 0); } };
			if (!r) { sx(s.fr, { opacity: '0' }); s.frt = setTimeout(done, c.typingMs); return; }
			sx(s.fr, { left: Math.round(r.left - 3) + 'px', top: Math.round(r.top - 3) + 'px', width: Math.round(r.width + 6) + 'px', height: Math.round(r.height + 6) + 'px', opacity: '1' });
			s.frt = setTimeout(done, c.typingMs);
		}
		/** ドラッグの軌跡（押した点から）。 */
		function trail(s, x, y) {
			if (s.trt) { clearTimeout(s.trt); s.trt = 0; stop(s.atr); s.atr = null; }
			if (!s.tp) { s.tp = s.pp ? [s.pp.x + ',' + s.pp.y] : []; }
			s.tp.push(x + ',' + y);
			if (s.tp.length > 400) { s.tp.splice(1, s.tp.length - 400); }
			s.tl2.setAttribute('points', s.tp.join(' '));
			sx(s.tr, { opacity: '1' });
		}
		function endTrail(s) {
			if (!s.tp) { return; }
			s.tp = null;
			stop(s.atr);
			s.atr = calm ? null : anim(s.tr, [{ opacity: 1 }, { opacity: 0 }], { duration: c.trailFadeMs, fill: 'forwards' });
			s.trt = setTimeout(function () { s.trt = 0; stop(s.atr); s.atr = null; sx(s.tr, { opacity: '0' }); s.tl2.setAttribute('points', ''); }, c.trailFadeMs);
		}

		/** 枠が画面に見えるか（見えない枠のためにカーソルを作らない）。 */
		function boxVisible(b) {
			var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
			return !!b && Math.min(vw, b.x + b.width) - Math.max(0, b.x) > 0 && Math.min(vh, b.y + b.height) - Math.max(0, b.y) > 0;
		}

		if (c.kind === 'status' && c.settle) {
			var gs = G(false);
			var ss = gs ? gs.cs[typeof c.owner === 'string' && c.owner.length > 0 ? c.owner : '_'] : null;
			if (!ss) { return 0; }
			ss.sticky = ''; ss.watch = false;
			if (ss.h) { setWaiting(ss, false); setStatus(ss, '', 0); }
			return 0;
		}

		if (c.kind === 'move' || c.kind === 'press' || c.kind === 'focus' || c.kind === 'wheel' || c.kind === 'status' || c.kind === 'look') {
			if (c.kind === 'look' && !boxVisible(c.box)) { return traits(false); }
			if (blockedRoot()) {
				// ずれた位置に出すより出さない。前に描いていたものも片付ける。
				each(kill);
				return traits(true);
			}
			var sm = state(true);
			if (!sm) { return 0; }
			// まだカーソルを出していないページで、置き場所の無い状態・ホイールのために DOM を作らない
			// （見えないホストがページに残り、消すタイマーも張られない）。'park' の状態は右下の端に出す。
			var noSpot = sm.x === null || !sm.h;
			if (noSpot && (c.kind === 'wheel' || (c.kind === 'status' && !(c.frames && c.frames.length) && !(c.park && (c.status !== 'idle' || c.box))))) {
				if (c.kind === 'status') { sm.sticky = STICKY[c.status] && !c.transient ? c.text : ''; if (c.status !== 'script') { sm.watch = false; } }
				return traits(false);
			}
			if (!attachCursor(sm)) { return 0; }
			setLabel(sm, c.label);
			if (c.kind === 'look') {
				// 名札の状態とスクリプトの見張りには触らない（並んで走る別の道具のもの）
				var ll = look(sm, c.box);
				if (ll) { sm.pp = null; glideTo(sm, ll.x, ll.y, calm ? 0 : c.lookGlideMs); } else if (sm.x !== null) { reveal(sm); arm(sm, c.idleMs); }
				return traits(false);
			}
			if (c.kind === 'focus') {
				var tt = typingTarget();
				// パスワード欄では、特別なキーの札も出さない（何を打ったかの手がかりになる）
				if (c.key && tt.kind !== 'secret') { keyBadge(sm, c.key); }
				if (!c.key || tt.kind !== 'page') {
					sm.typing = true;
					setStatus(sm, tt.kind === 'secret' ? c.texts.secret : tt.kind === 'page' ? c.texts.page : c.texts.typing, 0);
				}
				fieldFrame(sm, tt.rect);
				var r0 = tt.rect;
				// 直前に押した点がその要素の中なら、押した点に留める（クリックした入力欄へ打つとき、
				// カーソルが要素の左端へ滑ると、端を押したように見える）。
				if (sm.pp && r0 && sm.pp.x >= r0.left && sm.pp.x <= r0.left + r0.width && sm.pp.y >= r0.top && sm.pp.y <= r0.top + r0.height) {
					if (sm.x === null) { glideTo(sm, sm.pp.x, sm.pp.y, 0); } else { reveal(sm); arm(sm, c.idleMs); }
					return traits(false);
				}
				var fp = tt.el ? pointOf(tt.el) : null;
				if (fp && r0) { fp = { x: Math.round(r0.left + Math.min(14, Math.max(2, r0.width / 2))), y: Math.round(r0.top + r0.height / 2) }; }
				if (!fp) {
					if (sm.x !== null) { reveal(sm); arm(sm, c.idleMs); }
					return traits(false);
				}
				sm.pp = null;
				glideTo(sm, fp.x, fp.y, calm ? 0 : c.focusMs);
				return traits(false);
			}
			if (c.kind === 'wheel') {
				var ax = Math.abs(c.dx), ay = Math.abs(c.dy);
				mark(sm, ay >= ax ? (c.dy > 0 ? '\\u2193' : '\\u2191') : (c.dx > 0 ? '\\u2192' : '\\u2190'), A);
				setStatus(sm, c.text, c.markMs);
				reveal(sm); arm(sm, c.idleMs);
				return traits(false);
			}
			if (c.kind === 'status') {
				var lp = c.box ? look(sm, c.box) : null;
				if (c.frames && c.frames.length) { sm.pp = null; play(sm, c.frames, c.durationMs || 0); }
				else if (lp) { sm.pp = null; glideTo(sm, lp.x, lp.y, calm ? 0 : c.lookGlideMs); }
				else if (noSpot) { var pk = parkPoint(); glideTo(sm, pk.x, pk.y, 0); }
				else { reveal(sm); arm(sm, c.idleMs); }
				setWaiting(sm, !c.transient && (c.status === 'waiting' || c.status === 'loading'));
				// スクリプトの実行中だけ、その中のクリックへ寄せる
				if (c.status === 'script') {
					sm.ct = typeof c.clickText === 'string' ? c.clickText : '';
					sm.wat = Date.now();
					var was = sm.watch;
					sm.watch = true;
					if (!was) { sm.since = c.since > 0 ? c.since : sm.wat; replay(sm); }
				} else { sm.watch = false; }
				if (c.status === 'idle') { sm.sticky = ''; setStatus(sm, '', 0); return traits(false); }
				if (STICKY[c.status] && !c.transient) { sm.sticky = c.text; setStatus(sm, c.text, 0); return traits(false); }
				if (c.status === 'failed') { mark(sm, '\\u2715', ${JSON.stringify(DANGER_COLOR)}); }
				if (c.status === 'scroll') { mark(sm, '\\u2195', A); }
				setStatus(sm, c.text, c.markMs);
				return traits(false);
			}
			// move・press は道具が入力を始めた合図なので、待機中は解く。
			setWaiting(sm, false);
			if (c.kind === 'move') {
				if (!c.drag) { sm.pp = null; endTrail(sm); }
				play(sm, c.frames, c.durationMs);
				if (c.drag) { trail(sm, c.x, c.y); }
				return traits(false);
			}
			// press: 押した点そのものへ合わせてから波紋と縮みを出す。移動のコマンドが届いて
			// いなくてもクリックが無音にならないよう、ここでも作る。
			// 直前の move がまだその点へ滑っている途中なら、滑りを切らずに着いた時に波紋を出す。
			var delay = !calm && c.delayMs > 0 && sm.x !== null && Math.abs(sm.x - c.x) < 1 && Math.abs(sm.y - c.y) < 1 ? c.delayMs : 0;
			if (delay > 0) {
				reveal(sm);
				arm(sm, c.idleMs + delay);
			} else {
				glideTo(sm, c.x, c.y, 0);
			}
			sm.pp = { x: c.x, y: c.y };
			endTrail(sm);
			if (calm) { return traits(false); }
			anim(sm.rp, [{ transform: 'scale(0.35)', opacity: 0.75 }, { transform: 'scale(1.6)', opacity: 0 }], { duration: c.rippleMs, delay: delay, easing: 'cubic-bezier(0.2,0.7,0.3,1)' });
			anim(sm.sq, [{ transform: 'scale(1)' }, { transform: 'scale(0.82)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: c.squishMs, delay: delay, easing: 'ease-out' });
			return traits(false);
		}

		if (c.kind === 'release') {
			var sr2 = state(false);
			if (sr2 && sr2.h) { endTrail(sr2); }
			return 0;
		}

		/**
		 * 撮った範囲を光らせ、知らせを出す。知らせは撮影が終わってから出すので画像には写らない。動きを
		 * 抑える設定でも「撮れた」ことは伝えたいので、知らせは出したうえで動きだけ止める（光は出さない）。
		 * 'rect' は撮った範囲（'doc' ならドキュメント座標）。画面の外なら光らせない。
		 */
		function flashRange(gc, toast, rect) {
			var p2 = effects(gc);
			if (!p2) { return; }
			dropToast(gc);
			var ts = doc.createElement('div');
			ts.setAttribute('aria-hidden', 'true');
			sx(ts, {
				position: 'fixed', top: '12px', right: '12px', margin: '0px',
				display: 'flex', alignItems: 'center', gap: '8px',
				background: '#16181c', color: '#ffffff',
				font: '400 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
				padding: '8px 12px', borderRadius: '8px', whiteSpace: 'nowrap',
				boxShadow: '0 4px 14px rgba(0,0,0,0.35)', pointerEvents: 'none',
				zIndex: '2147483647', opacity: calm ? '1' : '0'
			});
			var thumb = doc.createElement('div');
			sx(thumb, { width: '26px', height: '18px', flex: 'none', background: '#3a3d44', border: '1px solid #565961', borderRadius: '3px' });
			var text = doc.createElement('span');
			text.textContent = toast;
			ts.appendChild(thumb); ts.appendChild(text);
			p2.appendChild(ts);
			gc.ts = ts;
			gc.tst = setTimeout(function () { if (gc.ts === ts) { dropToast(gc); collapse(gc); } else if (ts.parentNode) { ts.parentNode.removeChild(ts); } }, c.toastMs + 120);
			if (calm) { return; }
			try {
				ts.animate([
					{ opacity: 0, transform: 'translateY(-8px) scale(0.92)' },
					{ opacity: 1, transform: 'translateY(0px) scale(1)', offset: 0.12 },
					{ opacity: 1, transform: 'translateY(0px) scale(1)', offset: 0.82 },
					{ opacity: 0, transform: 'translateY(-6px) scale(0.98)' }
				], { duration: c.toastMs, easing: 'ease-out' });
			} catch (e) { }
			dropFlash(gc);
			var box = { left: '0px', top: '0px', width: '100%', height: '100%', borderRadius: '0px' };
			if (rect && typeof rect.x === 'number') {
				var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
				var ox = rect.doc ? (window.scrollX || 0) : 0, oy = rect.doc ? (window.scrollY || 0) : 0;
				var l = Math.max(0, rect.x - ox), t = Math.max(0, rect.y - oy);
				var r = Math.min(vw, rect.x - ox + rect.width), b = Math.min(vh, rect.y - oy + rect.height);
				if (!(r - l > 0 && b - t > 0)) { return; }
				box = { left: Math.round(l) + 'px', top: Math.round(t) + 'px', width: Math.round(r - l) + 'px', height: Math.round(b - t) + 'px', borderRadius: '4px' };
			}
			var f = doc.createElement('div');
			f.setAttribute('aria-hidden', 'true');
			sx(f, {
				position: 'fixed', left: box.left, top: box.top, width: box.width, height: box.height, borderRadius: box.borderRadius,
				margin: '0px', padding: '0px', border: '0px', background: '#ffffff',
				opacity: '0', pointerEvents: 'none', zIndex: '2147483647'
			});
			p2.appendChild(f);
			gc.f = f;
			var gone = function () { if (gc.f === f) { dropFlash(gc); collapse(gc); } else if (f.parentNode) { f.parentNode.removeChild(f); } };
			try {
				var fa = f.animate([{ opacity: 0 }, { opacity: 0.92, offset: 0.16 }, { opacity: 0 }], { duration: c.flashMs, easing: 'ease-out' });
				fa.onfinish = gone; fa.oncancel = gone;
			} catch (e) { }
			setTimeout(gone, c.flashMs + 500);
		}

		if (c.kind === 'captured') {
			var gc = G(true);
			if (!gc) { return 0; }
			gc.hid = false;
			each(function (sc) { if (sc.h) { sx(sc.h, { display: '' }); if (!sc.shown && sc.x !== null) { reveal(sc); } } });
			flashRange(gc, c.toast, c.rect);
			return 0;
		}

		if (c.kind === 'flash') {
			// 撮影のために隠している間は光らせない（その 1 枚に写る）
			var gf = G(true);
			if (!gf || gf.hid) { return 0; }
			flashRange(gf, c.toast, c.rect);
			return 0;
		}

		// ここから先は既にあるものにしか作用しない。撮影と後始末はページの全部のカーソルに効かせる。
		var g = G(false);
		if (!g) { return 0; }
		if (c.kind === 'remove') { dropFlash(g); dropToast(g); each(kill); collapse(g); return 0; }
		if (c.kind === 'show') {
			g.hid = false;
			each(function (s) { if (s.h) { sx(s.h, { display: '' }); if (!s.shown && s.x !== null) { reveal(s); } } });
			return 0;
		}
		if (c.kind === 'hide') {
			// 撮影に入るので、進行中の演出も必ず消す（残っていると次の1枚に写る）。
			dropFlash(g); dropToast(g);
			g.hid = true;
			each(function (s) { if (s.h) { sx(s.h, { transition: 'none', display: 'none' }); } });
			return new Promise(function (res) {
				var settled = false;
				var done = function () { if (!settled) { settled = true; res(0); } };
				setTimeout(done, c.settleMs);
				if (typeof requestAnimationFrame === 'function') {
					requestAnimationFrame(function () { requestAnimationFrame(done); });
				} else { done(); }
			});
		}
		return 0;
	} catch (e) { return 0; }
})(${paradisEncodeCursorOverlayPayload(command, tuning)})`;
}
