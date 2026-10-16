/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// メニューバーのアイコンとメニューの行の頭の小さな画像を、画像ファイルを使わずに計算で描く。
//
// マークはアプリアイコンの 3 枚の面（奥の立った面・手前の立った面・床の面）を、面の境目の細い
// すき間で区切った単色の形にする。アプリアイコンは面の色の濃さで立体を描いているので、そのまま
// 縮めると灰色のむらになる。単色の形ならテンプレート画像（macOS がメニューバーの明暗に合わせて
// 塗る）にでき、18pt でも 3 枚の面が読める。
//
// 点（要対応の印）を出すときだけテンプレートをやめる（テンプレート画像は単色なので色の点を描けない）。
// そのとき絵の色は呼び出し側がメニューバーの明暗に合わせて渡す。
//
// 返す画像はどれも BGRA（アルファ乗算済み）で、Electron の `nativeImage.createFromBitmap` にそのまま渡せる。

export interface IParadisRgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

export interface IParadisMenuBarBitmap {
	/** ピクセル数。 */
	readonly width: number;
	readonly height: number;
	readonly data: Uint8Array;
}

type Point = readonly [number, number];

/** 18pt の正方形の中の面（アプリアイコンの 1024px の画像から写した座標）。 */
const BACK: readonly Point[] = [[5.42, 5.36], [13.16, 1.07], [13.24, 7.57], [5.42, 12.35]];
const LEFT: readonly Point[] = [[3.77, 5.7], [8.44, 9.04], [8.52, 16.85], [3.77, 13.37]];
const FLOOR: readonly Point[] = [[3.77, 13.37], [10.05, 9.72], [14.21, 12.56], [8.52, 16.9]];
/** 手前の面の周りに空けるすき間（pt）。 */
const GAP = 0.7;
const MARK_SIZE = 18;
/** 点の中心・半径と、点の周りの抜き。 */
const DOT_CENTER: Point = [14.6, 3.3];
const DOT_RADIUS = 2.9;
const DOT_CUT = 4.3;
const SUPERSAMPLE = 4;
/** バーの下地の濃さ（テンプレート画像では透明度だけが効く）。 */
const TRACK_ALPHA = 0.3;

function insidePolygon(polygon: readonly Point[], x: number, y: number): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const [xi, yi] = polygon[i];
		const [xj, yj] = polygon[j];
		if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

function distanceToSegment(x: number, y: number, [ax, ay]: Point, [bx, by]: Point): number {
	const dx = bx - ax;
	const dy = by - ay;
	const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
	return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** 多角形の外にあって、縁から `gap` より離れているか。 */
function clearOf(polygon: readonly Point[], x: number, y: number, gap: number): boolean {
	if (insidePolygon(polygon, x, y)) {
		return false;
	}
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		if (distanceToSegment(x, y, polygon[j], polygon[i]) <= gap) {
			return false;
		}
	}
	return true;
}

/** マークの形の内側か（18pt の座標）。奥の面から順に、手前の面の周りだけ削る。 */
function insideMark(x: number, y: number): boolean {
	if (insidePolygon(LEFT, x, y)) {
		return true;
	}
	if (insidePolygon(FLOOR, x, y)) {
		return clearOf(LEFT, x, y, GAP);
	}
	return insidePolygon(BACK, x, y) && clearOf(LEFT, x, y, GAP) && clearOf(FLOOR, x, y, GAP);
}

/** 1 点の塗り。glyph は絵の濃さ（0〜1）、dot は点の色で塗るか。 */
interface IShade {
	readonly glyph: number;
	readonly dot: boolean;
}

const EMPTY: IShade = { glyph: 0, dot: false };
const SOLID: IShade = { glyph: 1, dot: false };
const TRACK: IShade = { glyph: TRACK_ALPHA, dot: false };
const DOT: IShade = { glyph: 0, dot: true };

/**
 * pt で書いた形を、`scale` 倍のピクセルで描く。
 * @param shade pt の座標を受け取り、その点の塗りを返す
 */
function rasterize(widthPt: number, heightPt: number, scale: number, glyph: IParadisRgb, dot: IParadisRgb | undefined, shade: (x: number, y: number) => IShade): IParadisMenuBarBitmap {
	const width = Math.round(widthPt * scale);
	const height = Math.round(heightPt * scale);
	const data = new Uint8Array(width * height * 4);
	const samples = SUPERSAMPLE * SUPERSAMPLE;
	for (let py = 0; py < height; py++) {
		for (let px = 0; px < width; px++) {
			let glyphCoverage = 0;
			let dotCoverage = 0;
			for (let sy = 0; sy < SUPERSAMPLE; sy++) {
				for (let sx = 0; sx < SUPERSAMPLE; sx++) {
					const result = shade((px + (sx + 0.5) / SUPERSAMPLE) / scale, (py + (sy + 0.5) / SUPERSAMPLE) / scale);
					glyphCoverage += result.glyph;
					if (result.dot) {
						dotCoverage++;
					}
				}
			}
			const glyphAlpha = glyphCoverage / samples;
			const dotAlpha = dot ? dotCoverage / samples : 0;
			const offset = (py * width + px) * 4;
			// 乗算済みなので、色 × 被覆率を足し合わせる
			data[offset] = Math.round(glyph.b * glyphAlpha + (dot?.b ?? 0) * dotAlpha);
			data[offset + 1] = Math.round(glyph.g * glyphAlpha + (dot?.g ?? 0) * dotAlpha);
			data[offset + 2] = Math.round(glyph.r * glyphAlpha + (dot?.r ?? 0) * dotAlpha);
			data[offset + 3] = Math.round(Math.min(1, glyphAlpha + dotAlpha) * 255);
		}
	}
	return { width, height, data };
}

/** マーク（`size` pt の正方形を左上 `(left, top)` に置く）と、その右上の点。 */
function markShade(x: number, y: number, left: number, top: number, size: number, withDot: boolean): IShade | undefined {
	const k = MARK_SIZE / size;
	const mx = (x - left) * k;
	const my = (y - top) * k;
	if (withDot) {
		const distance = Math.hypot(mx - DOT_CENTER[0], my - DOT_CENTER[1]);
		if (distance <= DOT_RADIUS) {
			return DOT;
		}
		if (distance <= DOT_CUT) {
			return EMPTY;
		}
	}
	if (mx < 0 || my < 0 || mx > MARK_SIZE || my > MARK_SIZE) {
		return undefined;
	}
	return insideMark(mx, my) ? SOLID : undefined;
}

/** 0〜100 の値を、左から伸びる横棒で描く（下地は薄く）。 */
function barShade(x: number, y: number, left: number, top: number, width: number, height: number, percent: number | undefined): IShade | undefined {
	if (x < left || x > left + width || y < top || y > top + height) {
		return undefined;
	}
	// 角を丸める
	const radius = height / 2;
	const cx = Math.max(left + radius, Math.min(left + width - radius, x));
	if (Math.hypot(x - cx, y - (top + radius)) > radius) {
		return undefined;
	}
	const filled = percent === undefined ? 0 : Math.max(radius * 2, width * Math.max(0, Math.min(100, percent)) / 100);
	return x <= left + filled && percent !== undefined ? SOLID : TRACK;
}

/**
 * メニューバーのマーク（18pt の正方形）。
 * @param dot 点の色。undefined なら点を描かない（テンプレート画像にできる）
 */
export function paradisRenderMenuBarMark(scale: number, glyph: IParadisRgb, dot: IParadisRgb | undefined): IParadisMenuBarBitmap {
	return rasterize(MARK_SIZE, MARK_SIZE, scale, glyph, dot, (x, y) => markShade(x, y, 0, 0, MARK_SIZE, dot !== undefined) ?? EMPTY);
}

const BAR_WIDTH = 22;
const BAR_HEIGHT = 4;
const BARS_GAP = 4;

/** マークの右に、上が Claude Code・下が Codex の 2 本のバーを並べた画像。 */
export function paradisRenderMenuBarBars(scale: number, glyph: IParadisRgb, dot: IParadisRgb | undefined, upper: number | undefined, lower: number | undefined): IParadisMenuBarBitmap {
	const barsLeft = MARK_SIZE + BARS_GAP;
	return rasterize(barsLeft + BAR_WIDTH, MARK_SIZE, scale, glyph, dot, (x, y) =>
		markShade(x, y, 0, 0, MARK_SIZE, dot !== undefined)
		?? barShade(x, y, barsLeft, 3.5, BAR_WIDTH, BAR_HEIGHT, upper)
		?? barShade(x, y, barsLeft, 10.5, BAR_WIDTH, BAR_HEIGHT, lower)
		?? EMPTY);
}

const RING_SIZE = 20;
const RING_RADIUS = 8;
const RING_WIDTH = 1.6;
const RING_MARK = 11;

/** マークを小さくして、使用率の長さの輪で囲んだ画像（輪は上から時計回り）。 */
export function paradisRenderMenuBarRing(scale: number, glyph: IParadisRgb, dot: IParadisRgb | undefined, percent: number | undefined): IParadisMenuBarBitmap {
	const center = RING_SIZE / 2;
	const offset = (RING_SIZE - RING_MARK) / 2;
	const sweep = percent === undefined ? 0 : Math.max(0, Math.min(100, percent)) / 100 * Math.PI * 2;
	return rasterize(RING_SIZE, RING_SIZE, scale, glyph, dot, (x, y) => {
		if (dot !== undefined) {
			const distance = Math.hypot(x - 16.5, y - 3.5);
			if (distance <= 2.6) {
				return DOT;
			}
			if (distance <= 3.8) {
				return EMPTY;
			}
		}
		const radius = Math.hypot(x - center, y - center);
		if (Math.abs(radius - RING_RADIUS) <= RING_WIDTH / 2) {
			// 上（12 時）から時計回りの角度
			let angle = Math.atan2(x - center, center - y);
			if (angle < 0) {
				angle += Math.PI * 2;
			}
			return angle <= sweep ? SOLID : { glyph: 0.25, dot: false };
		}
		return markShade(x, y, offset, offset, RING_MARK, false) ?? EMPTY;
	});
}

const ROW_WIDTH = 30;
const ROW_HEIGHT = 12;
const ROW_BAR = 3.2;

/** メニューの行の頭に置く 2 本のバー（上が 5 時間、下が週）。 */
export function paradisRenderMenuBarRowBars(scale: number, glyph: IParadisRgb, fiveHour: number | undefined, sevenDay: number | undefined): IParadisMenuBarBitmap {
	return rasterize(ROW_WIDTH, ROW_HEIGHT, scale, glyph, undefined, (x, y) =>
		barShade(x, y, 0, 1.5, ROW_WIDTH, ROW_BAR, fiveHour)
		?? barShade(x, y, 0, 7.3, ROW_WIDTH, ROW_BAR, sevenDay)
		?? EMPTY);
}
