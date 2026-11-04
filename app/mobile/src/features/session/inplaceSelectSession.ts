// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { GestureResponderEvent } from 'react-native';

/**
 * その場で範囲を選んでいる発言（Q551 案 4）の受け付け。画面に 1 つだけ（別の発言で始めたら前のものを戻す）。
 *
 * 「外を触ったら元の表示に戻す」ために、アプリの一番外の View（`app/_layout.tsx`）が触れた始めと終わりを
 * ここへ知らせる。触れた点が差し替えた WebView の外で、指がほとんど動かずに離れた（＝押した）ときだけ戻す。
 * 一覧をなぞってスクロールしたとき（指が動く・スクロールに取られて終わりが届かない）は戻さない。
 */

/** 差し替えている発言。 */
export interface InplaceSelectSession {
	/** 元の表示に戻す。 */
	close(): void;
	/** 画面の座標の点が、差し替えた WebView の中か（測るのに一呼吸かかるので結果は `done` で返す）。 */
	contains(pageX: number, pageY: number, done: (inside: boolean) => void): void;
}

let active: InplaceSelectSession | undefined;
let touchStart: { readonly pageX: number; readonly pageY: number; readonly at: number } | undefined;

/** 始める。前に差し替えていた発言は元に戻す。返す関数で受け付けから外す（戻し終えたとき・部品が消えたとき）。 */
export function beginInplaceSelect(session: InplaceSelectSession): () => void {
	const previous = active;
	active = session;
	if (previous !== undefined && previous !== session) {
		previous.close();
	}
	return () => {
		if (active === session) {
			active = undefined;
		}
	};
}

/** 押した（＝スクロールではない）とみなす、指の動きの上限（pt）と、押していた時間の上限（ms）。 */
const TAP_SLOP = 10;
const TAP_MAX_MS = 600;

/** 触れた始めと終わりから、押したとみなせるか。 */
export function isOutsideTap(start: { readonly pageX: number; readonly pageY: number; readonly at: number } | undefined, end: { readonly pageX: number; readonly pageY: number; readonly at: number }): boolean {
	if (start === undefined) {
		return false;
	}
	return Math.hypot(end.pageX - start.pageX, end.pageY - start.pageY) <= TAP_SLOP && end.at - start.at >= 0 && end.at - start.at <= TAP_MAX_MS;
}

function pointOf(event: GestureResponderEvent): { pageX: number; pageY: number; at: number } | undefined {
	const { pageX, pageY, timestamp, touches } = event.nativeEvent;
	// 2 本目以降の指は見ない（つまむ操作などで戻さない）
	if (touches !== undefined && touches.length > 1) {
		return undefined;
	}
	return Number.isFinite(pageX) && Number.isFinite(pageY) ? { pageX, pageY, at: Number.isFinite(timestamp) ? timestamp : Date.now() } : undefined;
}

/** アプリの一番外の View の `onTouchStart`（触れを取らない。差し替えていないときは何もしない）。 */
export function observeInplaceSelectTouchStart(event: GestureResponderEvent): void {
	touchStart = active !== undefined ? pointOf(event) : undefined;
}

/** アプリの一番外の View の `onTouchEnd`。 */
export function observeInplaceSelectTouchEnd(event: GestureResponderEvent): void {
	const start = touchStart;
	touchStart = undefined;
	const session = active;
	if (session === undefined) {
		return;
	}
	const end = pointOf(event);
	if (end === undefined || !isOutsideTap(start, end)) {
		return;
	}
	session.contains(end.pageX, end.pageY, inside => {
		if (!inside && active === session) {
			session.close();
		}
	});
}
