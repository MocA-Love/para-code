// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 画面共有の上に描くエージェントのカーソル（browser.cursor.v1、q.html Q276 A）の台帳と、置き場所の計算。
// PC から届く `t: 'cursor'` を持ち主ごとに覚え、映像の上の位置（contain の余白を除いた点）に直す。
// 画面は `components/browserCursorOverlay.tsx`。

import type { IParadisMobileBrowserCursor } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileBrowserProtocol.js';

/** 1 つの持ち主のカーソル。 */
export interface BrowserCursor {
	readonly ownerId: string;
	readonly targetId: string;
	readonly nx: number;
	readonly ny: number;
	/** 前の点からここまで滑らせる時間（ms）。 */
	readonly durationMs: number;
	readonly name: string;
	readonly mark: string;
	readonly color: string;
	/** 名札の状態（無ければ名前だけ）。 */
	readonly status: string | undefined;
	/** 押した回数（増えたら波紋を出す）。 */
	readonly presses: number;
	/** 最後に届いた時刻（端末の時計）。 */
	readonly at: number;
}

export type BrowserCursors = ReadonlyMap<string, BrowserCursor>;

export const EMPTY_BROWSER_CURSORS: BrowserCursors = new Map();

/** これだけ届かなければ消す（PC のページ側のカーソルと同じ考え方）。 */
export const BROWSER_CURSOR_IDLE_MS = 60_000;

const DEFAULT_COLOR = '#5b8cff';

/** 届いた通知を台帳へ反映する。変わらなければ同じ台帳を返す。 */
export function applyBrowserCursor(cursors: BrowserCursors, message: IParadisMobileBrowserCursor, now: number): BrowserCursors {
	if (message.kind === 'gone') {
		const kept = [...cursors].filter(([, cursor]) => cursor.targetId !== message.targetId);
		return kept.length === cursors.size ? cursors : new Map(kept);
	}
	const ownerId = message.ownerId ?? '_';
	const previous = cursors.get(ownerId);
	const base = previous && previous.targetId === message.targetId ? previous : undefined;
	if (message.kind === 'state') {
		if (!base) {
			return cursors;
		}
		const next = new Map(cursors);
		next.set(ownerId, { ...base, status: message.status === 'idle' ? undefined : message.status, at: now });
		return next;
	}
	const next = new Map(cursors);
	next.set(ownerId, {
		ownerId,
		targetId: message.targetId,
		nx: message.nx ?? base?.nx ?? 0,
		ny: message.ny ?? base?.ny ?? 0,
		durationMs: base ? (message.durationMs ?? 0) : 0,
		name: message.name ?? base?.name ?? 'エージェント',
		mark: message.mark ?? base?.mark ?? '',
		color: message.color ?? base?.color ?? DEFAULT_COLOR,
		status: base?.status,
		presses: (base?.presses ?? 0) + (message.kind === 'press' ? 1 : 0),
		at: now,
	});
	return next;
}

/** 古いカーソルを捨てる。 */
export function pruneBrowserCursors(cursors: BrowserCursors, now: number): BrowserCursors {
	const kept = [...cursors].filter(([, cursor]) => now - cursor.at < BROWSER_CURSOR_IDLE_MS);
	return kept.length === cursors.size ? cursors : new Map(kept);
}

/** 名札の状態の文言。iPhone の狭い画面では出さない（呼び出し側が決める）。 */
export function browserCursorStatusText(status: string | undefined): string | undefined {
	switch (status) {
		case 'script': return 'スクリプト実行中';
		case 'waiting': return '待機中';
		case 'failed': return '押せませんでした';
		case 'missing': return '見つかりません';
		case 'select': return '選択';
		case 'value': return '値を入力';
		case 'upload': return 'ファイルを渡す';
		case 'scroll': return 'スクロール';
		default: return undefined;
	}
}

/**
 * ページの割合の座標を、枠の中の点に直す（映像は contain で描かれ、上下か左右に余白がある）。
 * 映像の外なら undefined。
 */
export function browserCursorPoint(nx: number, ny: number, view: { readonly w: number; readonly h: number }, content: { readonly w: number; readonly h: number } | undefined): { readonly x: number; readonly y: number } | undefined {
	if (!content || content.w <= 0 || content.h <= 0 || view.w <= 0 || view.h <= 0) {
		return undefined;
	}
	if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
		return undefined;
	}
	const scale = Math.min(view.w / content.w, view.h / content.h);
	const drawnW = content.w * scale;
	const drawnH = content.h * scale;
	return { x: (view.w - drawnW) / 2 + nx * drawnW, y: (view.h - drawnH) / 2 + ny * drawnH };
}
