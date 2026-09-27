/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの描画ずれ（バッファには文字があるのに画面に描かれていない＝文字の欠け・古いグリフ）の
// 判定部分（Q58 B / TM12）。DOM や xterm には触らない純粋な計算だけを置き、テストから直接確かめる。
//
// 判定の考え方は Orca（stablyai/orca、MIT）の `terminal-render-desync-frame.ts` /
// `terminal-render-desync-sentinel.ts` を移植したもの: バッファが「文字あり」と言うセルの中央部を
// 抜き取り、背景色から離れた画素（インク）が1つも無いセルを「欠けている」と数える。
// 誤検知で頻発させないため、Orca よりさらに保守的にしてある（下の定数と ParadisRenderDesyncGate）。

/** 欠けを数える対象の最小セル数。文字の少ない画面では割合が暴れるので判定しない。 */
export const PARADIS_RENDER_DESYNC_MIN_TEXT_CELLS = 200;
/** 欠けているセルの割合（%）の下限。 */
export const PARADIS_RENDER_DESYNC_MISSING_PCT = 8;
/** 背景からの色の距離（RGB の差の和）がこれを超えた画素をインクとみなす。 */
const INK_BACKGROUND_DISTANCE = 36;
/** 2回の抜き取りで、欠けたセルの集合がこの割合以上重なっていれば同じ欠けとみなす。 */
const MISSING_SET_MIN_OVERLAP = 0.5;
/** 同じターミナルで修復してから次に検査するまでの最短間隔（ミリ秒）。 */
export const PARADIS_RENDER_REPAIR_COOLDOWN = 60_000;
/** 記録を残す上限（古いものから消す）。画面の画像には秘密情報が写りうるので少なく保つ。 */
export const PARADIS_RENDER_EVIDENCE_MAX_RECORDS = 4;

/** 抜き取りに使う画像（CanvasRenderingContext2D.getImageData の結果と同じ形）。 */
export interface IParadisRenderImage {
	readonly data: Uint8ClampedArray;
	readonly width: number;
	readonly height: number;
}

/** 画面の升目の形。 */
export interface IParadisRenderGrid {
	readonly rows: number;
	readonly cols: number;
	/** デバイス画素でのセルの幅・高さ。 */
	readonly cellWidth: number;
	readonly cellHeight: number;
	/** カーソルのある行（ビューポート内の行番号）。カーソルの描画が重なるので数えない。 */
	readonly cursorRow: number;
	/** テーマの背景色。 */
	readonly backgroundRgb: readonly [number, number, number];
}

export interface IParadisRenderDivergence {
	readonly textCells: number;
	readonly missing: number;
	readonly missPct: number;
	readonly missingCells: ReadonlySet<number>;
}

/**
 * バッファと画面のずれを測る。
 * @param isTextCell ビューポート内の (row, col) に、描かれるはずの文字があるか。
 */
export function paradisMeasureRenderDivergence(image: IParadisRenderImage, grid: IParadisRenderGrid, isTextCell: (row: number, col: number) => boolean): IParadisRenderDivergence {
	const { data, width, height } = image;
	const missingCells = new Set<number>();
	let textCells = 0;
	let missing = 0;
	for (let row = 0; row < grid.rows; row++) {
		if (row === grid.cursorRow) {
			continue;
		}
		for (let col = 0; col < grid.cols; col++) {
			if (!isTextCell(row, col)) {
				continue;
			}
			const x0 = Math.round(col * grid.cellWidth + grid.cellWidth * 0.25);
			const x1 = Math.round(col * grid.cellWidth + grid.cellWidth * 0.75);
			const y0 = Math.round(row * grid.cellHeight + grid.cellHeight * 0.25);
			const y1 = Math.round(row * grid.cellHeight + grid.cellHeight * 0.75);
			let ink = 0;
			let sampled = 0;
			for (let y = y0; y < y1 && y < height; y += 2) {
				for (let x = x0; x < x1 && x < width; x += 2) {
					const index = (y * width + x) * 4;
					sampled++;
					// 透明な画素は背景（ウィンドウ透過のときは背景の alpha を 0 にして描いている）
					if (data[index + 3] < 16) {
						continue;
					}
					const distance = Math.abs(data[index] - grid.backgroundRgb[0])
						+ Math.abs(data[index + 1] - grid.backgroundRgb[1])
						+ Math.abs(data[index + 2] - grid.backgroundRgb[2]);
					if (distance > INK_BACKGROUND_DISTANCE) {
						ink++;
					}
				}
			}
			if (sampled === 0) {
				continue;
			}
			textCells++;
			if (ink === 0) {
				missing++;
				missingCells.add(row * grid.cols + col);
			}
		}
	}
	return { textCells, missing, missingCells, missPct: textCells ? (100 * missing) / textCells : 0 };
}

/** 1回の抜き取りが「欠けの疑い」に当たるか。 */
export function paradisIsSuspectDivergence(divergence: IParadisRenderDivergence): boolean {
	return divergence.textCells >= PARADIS_RENDER_DESYNC_MIN_TEXT_CELLS && divergence.missPct >= PARADIS_RENDER_DESYNC_MISSING_PCT;
}

/** 2回の抜き取りで欠けた場所がほぼ同じか（本物の欠けは同じセルに居座る。描画の遅れは動く）。 */
export function paradisMissingSetsOverlap(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
	let intersection = 0;
	for (const cell of b) {
		if (a.has(cell)) {
			intersection++;
		}
	}
	const union = a.size + b.size - intersection;
	return union > 0 && intersection / union >= MISSING_SET_MIN_OVERLAP;
}

/**
 * 1本のターミナルの検査・修復の可否。
 *
 * - 修復してから {@link PARADIS_RENDER_REPAIR_COOLDOWN} の間は検査しない
 * - 修復しても同じ判定が出続けたら、それは描画ずれではなく判定の方が外れている（背景と同じ色で
 *   書かれた文字など）ので、そのターミナルでは以後検査しない。誤検知のたびに描き直すのを防ぐ
 */
export class ParadisRenderDesyncGate {
	private lastRepairAt: number | undefined;
	private disabled = false;

	constructor(private readonly now: () => number = Date.now) { }

	canInspect(): boolean {
		return !this.disabled && (this.lastRepairAt === undefined || this.now() - this.lastRepairAt >= PARADIS_RENDER_REPAIR_COOLDOWN);
	}

	noteRepaired(): void {
		this.lastRepairAt = this.now();
	}

	/** 修復の直後にもう一度測った結果。まだ疑わしければ以後の検査を止める。 */
	noteAfterRepair(stillSuspect: boolean): void {
		if (stillSuspect) {
			this.disabled = true;
		}
	}

	get isDisabled(): boolean {
		return this.disabled;
	}
}

/**
 * 記録のフォルダ名一覧から、消すものを選ぶ。名前は時刻で始まるので、名前の昇順＝古い順。
 * @param keep 残す件数（これから1件足すなら上限 - 1 を渡す）。
 */
export function paradisRenderRecordsToPrune(names: readonly string[], keep: number): string[] {
	const sorted = [...names].sort();
	return sorted.slice(0, Math.max(0, sorted.length - keep));
}

/** 記録のフォルダ名（時刻 + 乱数）。時刻を先頭に置き、名前の並びが古い順になるようにする。 */
export function paradisRenderRecordName(time: number, nonce: string): string {
	const stamp = new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
	return `${stamp}-${nonce.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`;
}
