/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// メニューバー（Windows は通知領域）のアイコンの契約と、アイコンの絵（q.html Q36 案A）。
//
// アイコンは main プロセスが持つ（Electron の Tray は main でしか作れない）。中身（要対応の一覧）は
// 台帳を読んでいる renderer が main へ送り、メニューで押されたものは main から renderer へ返す。
// 移動そのものは台帳（shared process）経由で、ペインを持っているウィンドウが行う。
//
// 絵は Orca（stablyai/orca、MIT）の src/main/tray/tray-attention-icon.ts の考え方に倣う:
// ふだんはテンプレート画像（macOS がメニューバーの色に合わせて塗る）にし、要対応があるときだけ
// テンプレートをやめて色付きの点を足す（テンプレート画像は単色なので赤い点を描けないため）。
// 画像ファイルを同梱すると配布物への追加が要るので、ベルの形はここで計算して描く。

import { fromNow } from '../../../../base/common/date.js';
import { localize } from '../../../../nls.js';
import { IParadisInboxSnapshot, paradisInboxAttentionEntries, paradisInboxEntryLocation, paradisInboxKindLabel, ParadisInboxKind } from './paradisNotificationInbox.js';

export const PARADIS_NOTIFICATION_TRAY_CHANNEL = 'paradisNotificationTray';

/** メニューに出す要対応の件数の上限。 */
export const PARADIS_NOTIFICATION_TRAY_ITEM_LIMIT = 5;

export interface IParadisTrayItem {
	readonly entryId: string;
	readonly kind: ParadisInboxKind;
	readonly location: string;
	readonly at: number;
}

/** renderer が main へ送るアイコンの中身。 */
export interface IParadisTrayState {
	/** 要対応のペイン数（点の有無と見出しに使う）。 */
	readonly attentionCount: number;
	readonly items: readonly IParadisTrayItem[];
}

/**
 * メニューで押されたもの。`windowId` は main が選んだ「これを処理するウィンドウ」（最後に使っていた
 * ウィンドウ）。全ウィンドウに届くので、自分宛てのものだけを処理する。
 */
export type ParadisTrayRequest =
	| { readonly type: 'reveal'; readonly windowId: number; readonly entryId: string }
	| { readonly type: 'openInbox'; readonly windowId: number }
	| { readonly type: 'hideIcon'; readonly windowId: number };

export function paradisTrayStateFromSnapshot(snapshot: IParadisInboxSnapshot): IParadisTrayState {
	return {
		attentionCount: snapshot.attentionPaneCount,
		items: paradisInboxAttentionEntries(snapshot, PARADIS_NOTIFICATION_TRAY_ITEM_LIMIT).map(entry => ({
			entryId: entry.id,
			kind: entry.kind,
			location: paradisInboxEntryLocation(entry),
			at: entry.at,
		})),
	};
}

/** renderer から来た値を検める（形が崩れていてもメニューを壊さない）。 */
export function paradisSanitizeTrayState(value: unknown): IParadisTrayState {
	const input = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
	const items: IParadisTrayItem[] = [];
	if (Array.isArray(input.items)) {
		for (const raw of input.items.slice(0, PARADIS_NOTIFICATION_TRAY_ITEM_LIMIT)) {
			const item = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
			if (typeof item.entryId === 'string' && (item.kind === 'review' || item.kind === 'permission' || item.kind === 'question')
				&& typeof item.location === 'string' && typeof item.at === 'number') {
				items.push({ entryId: item.entryId, kind: item.kind, location: item.location.slice(0, 200), at: item.at });
			}
		}
	}
	const attentionCount = typeof input.attentionCount === 'number' && input.attentionCount > 0 ? Math.floor(input.attentionCount) : 0;
	return { attentionCount, items };
}

// ---- メニューの組み立て（Electron に依存しない形で作り、main で MenuItem に写す） --------------------

export type ParadisTrayMenuItem =
	| { readonly kind: 'header'; readonly label: string }
	| { readonly kind: 'entry'; readonly label: string; readonly entryId: string }
	| { readonly kind: 'openInbox'; readonly label: string }
	| { readonly kind: 'openApp'; readonly label: string }
	| { readonly kind: 'hideIcon'; readonly label: string }
	| { readonly kind: 'separator' };

export function paradisTrayMenuModel(state: IParadisTrayState, isMac: boolean): ParadisTrayMenuItem[] {
	const menu: ParadisTrayMenuItem[] = [{
		kind: 'header',
		label: state.attentionCount > 0
			? localize('paradis.tray.attention', "要対応 {0} 件", state.attentionCount)
			: localize('paradis.tray.noAttention', "要対応はありません"),
	}];
	for (const item of state.items) {
		menu.push({
			kind: 'entry',
			entryId: item.entryId,
			label: localize('paradis.tray.entry', "{0}  {1}（{2}）", paradisInboxKindLabel(item.kind), item.location, fromNow(item.at, true)),
		});
	}
	menu.push(
		{ kind: 'separator' },
		{ kind: 'openInbox', label: localize('paradis.tray.openInbox', "受信箱を開く") },
		{ kind: 'openApp', label: localize('paradis.tray.openApp', "Para Code を開く") },
		{ kind: 'separator' },
		{
			kind: 'hideIcon',
			label: isMac
				? localize('paradis.tray.hideMac', "メニューバーのアイコンを隠す")
				: localize('paradis.tray.hideWindows', "通知領域のアイコンを隠す"),
		},
	);
	return menu;
}

// ---- アイコンの絵 -------------------------------------------------------------------------------

/** 要対応の点の色（ワークベンチのエラー色に近い赤）。 */
const DOT_RGB = { r: 0xe5, g: 0x53, b: 0x4b };
const SUPERSAMPLE = 4;

/** 単位正方形 [0,1]² の中でベルの形の内側か。 */
function insideBell(x: number, y: number): boolean {
	const dx = x - 0.5;
	// 上のつまみ
	if (dx * dx + (y - 0.13) * (y - 0.13) <= 0.055 * 0.055) {
		return true;
	}
	// 丸い頭
	if (y <= 0.36 && dx * dx + (y - 0.36) * (y - 0.36) <= 0.2 * 0.2) {
		return true;
	}
	// 裾に向かって少し広がる胴
	if (y >= 0.36 && y <= 0.7) {
		const halfWidth = 0.2 + (y - 0.36) / (0.7 - 0.36) * 0.1;
		return Math.abs(dx) <= halfWidth;
	}
	// 縁
	if (y >= 0.7 && y <= 0.78) {
		return Math.abs(dx) <= 0.4;
	}
	// 舌
	return dx * dx + (y - 0.86) * (y - 0.86) <= 0.08 * 0.08;
}

const DOT_CENTER = { x: 0.8, y: 0.2 };
const DOT_RADIUS = 0.17;
/** 点の周りの抜き（ベルと点の間の隙間）。 */
const DOT_GAP = 0.07;

/**
 * ベルのアイコンを BGRA（アルファ乗算済み）で描く。Electron の `nativeImage.createFromBitmap` にそのまま渡せる。
 *
 * @param size 一辺のピクセル数（Retina 用は倍の大きさで描く）
 * @param glyph ベルの色。テンプレート画像にするときは黒（macOS が塗り直す）
 * @param dot 要対応の点を描くか
 */
export function paradisRenderTrayBell(size: number, glyph: { r: number; g: number; b: number }, dot: boolean): Uint8Array {
	const bitmap = new Uint8Array(size * size * 4);
	const samples = SUPERSAMPLE * SUPERSAMPLE;
	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let glyphCoverage = 0;
			let dotCoverage = 0;
			for (let sy = 0; sy < SUPERSAMPLE; sy++) {
				for (let sx = 0; sx < SUPERSAMPLE; sx++) {
					const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
					const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
					if (dot) {
						const distance = Math.hypot(x - DOT_CENTER.x, y - DOT_CENTER.y);
						if (distance <= DOT_RADIUS) {
							dotCoverage++;
							continue;
						}
						if (distance <= DOT_RADIUS + DOT_GAP) {
							continue;
						}
					}
					if (insideBell(x, y)) {
						glyphCoverage++;
					}
				}
			}
			const glyphAlpha = glyphCoverage / samples;
			const dotAlpha = dotCoverage / samples;
			const alpha = Math.min(1, glyphAlpha + dotAlpha);
			const offset = (py * size + px) * 4;
			// 乗算済みなので、色 × 被覆率を足し合わせる
			bitmap[offset] = Math.round(glyph.b * glyphAlpha + DOT_RGB.b * dotAlpha);
			bitmap[offset + 1] = Math.round(glyph.g * glyphAlpha + DOT_RGB.g * dotAlpha);
			bitmap[offset + 2] = Math.round(glyph.r * glyphAlpha + DOT_RGB.r * dotAlpha);
			bitmap[offset + 3] = Math.round(alpha * 255);
		}
	}
	return bitmap;
}
