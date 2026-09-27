/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 作業実績の共有カード（白地、1200 × 630）を canvas に描く。
//
// 載せるのは期間・4つの数字・日別のターン数の棒だけ。リポジトリ名、ブランチ名、PR のタイトルと番号、
// 金額は載せない（SNS に貼っても公開したくない情報が写らないようにするため）。
// アプリのテーマに関わらず常に同じ白地で描く（共有した画像の見た目を揃える）。

import { localize } from '../../../../nls.js';

export const PARADIS_SHARE_CARD_WIDTH = 1200;
export const PARADIS_SHARE_CARD_HEIGHT = 630;

export interface IParadisShareCardData {
	/** 例: 2026/09/20 – 09/26 */
	readonly periodLabel: string;
	/** 例: Claude Code と Codex の合計 */
	readonly scopeLabel: string;
	readonly sessions: number;
	readonly turns: number;
	readonly activeMs: number;
	readonly prs: number;
	/** 古い順の日別ターン数。 */
	readonly dailyTurns: readonly number[];
}

const COLORS = {
	background: '#ffffff',
	text: '#1f2328',
	muted: '#656d76',
	border: '#d0d7de',
	accent: '#0969da',
	grid: '#eaeef2',
};

const FONT_FAMILY = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Noto Sans JP", sans-serif`;

/** 稼働時間の短い表記（31h 20m）。カードは言語に依らず同じ見た目にする。 */
export function paradisShareCardDuration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	const hours = Math.floor(minutes / 60);
	return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** カードに載せる4つの数字（値とラベル）。テストで中身を確かめられるよう描画と分けてある。 */
export function paradisShareCardStats(data: IParadisShareCardData): readonly { readonly value: string; readonly label: string }[] {
	return [
		{ value: data.sessions.toLocaleString('en-US'), label: localize('paradis.shareCard.agents', "起動したエージェント") },
		{ value: data.turns.toLocaleString('en-US'), label: localize('paradis.shareCard.turns', "ターン") },
		{ value: paradisShareCardDuration(data.activeMs), label: localize('paradis.shareCard.activeTime', "稼働時間") },
		{ value: data.prs.toLocaleString('en-US'), label: localize('paradis.shareCard.prs', "作成した PR") },
	];
}

/** カードを描いた canvas を返す。 */
export function paradisDrawShareCard(document: Document, data: IParadisShareCardData): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = PARADIS_SHARE_CARD_WIDTH;
	canvas.height = PARADIS_SHARE_CARD_HEIGHT;
	const context = canvas.getContext('2d');
	if (!context) {
		return canvas;
	}
	const padding = 64;
	context.fillStyle = COLORS.background;
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.strokeStyle = COLORS.border;
	context.lineWidth = 2;
	context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

	// 見出し
	context.textBaseline = 'alphabetic';
	context.fillStyle = COLORS.text;
	context.font = `600 40px ${FONT_FAMILY}`;
	context.fillText('Para Code', padding, padding + 36);
	context.fillStyle = COLORS.muted;
	context.font = `400 26px ${FONT_FAMILY}`;
	context.textAlign = 'right';
	context.fillText(data.periodLabel, canvas.width - padding, padding + 34);
	context.textAlign = 'left';

	// 4つの数字
	const stats = paradisShareCardStats(data);
	const columnWidth = (canvas.width - padding * 2) / stats.length;
	const valueY = 240;
	stats.forEach((stat, index) => {
		const x = padding + columnWidth * index;
		context.fillStyle = COLORS.text;
		context.font = `600 64px ${FONT_FAMILY}`;
		context.fillText(stat.value, x, valueY, columnWidth - 24);
		context.fillStyle = COLORS.muted;
		context.font = `400 24px ${FONT_FAMILY}`;
		context.fillText(stat.label, x, valueY + 40, columnWidth - 24);
	});

	// 日別のターン数
	const chartTop = 350;
	const chartBottom = canvas.height - padding - 34;
	const chartLeft = padding;
	const chartRight = canvas.width - padding;
	context.fillStyle = COLORS.muted;
	context.font = `400 22px ${FONT_FAMILY}`;
	context.fillText(localize('paradis.shareCard.chartTitle', "日別のターン数 · {0}", data.scopeLabel), chartLeft, chartTop);
	const barsTop = chartTop + 20;
	context.strokeStyle = COLORS.grid;
	context.lineWidth = 2;
	context.beginPath();
	context.moveTo(chartLeft, chartBottom);
	context.lineTo(chartRight, chartBottom);
	context.stroke();
	const values = data.dailyTurns;
	const max = Math.max(1, ...values);
	const slot = (chartRight - chartLeft) / Math.max(1, values.length);
	const barWidth = Math.max(2, Math.min(48, slot * 0.7));
	context.fillStyle = COLORS.accent;
	values.forEach((value, index) => {
		const height = (chartBottom - barsTop) * value / max;
		if (height <= 0) {
			return;
		}
		const x = chartLeft + slot * index + (slot - barWidth) / 2;
		context.fillRect(x, chartBottom - height, barWidth, height);
	});
	return canvas;
}

/** canvas を PNG のバイト列にする。 */
export async function paradisShareCardPng(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Unable to encode the share card.')), 'image/png'));
}
