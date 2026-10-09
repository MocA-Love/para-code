/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Office に貼られた EMF・WMF の画像を、記録を読んで SVG にする（Q321 f「ブラウザで変換する」）。外部の
// ツールは使わない。入力は信じない: 記録の数・大きさ・座標・オブジェクトの数・状態の保存の深さ・経路の点・
// ビットマップの画素・文字の数・出力の大きさに上限を付け、記録の大きさが中身の読み出しに足りなければ
// 止める。外部の参照や書体の読み込みはしない（書体は名前を書くだけで、無ければ閲覧側の既定の書体になる）。
//
// 描ける記録は、線・多角形・ベジェ曲線・矩形・楕円・経路の塗りと線・経路と矩形での切り抜き・文字・
// ビットマップ（SRCCOPY）・ブラシでの矩形の塗り（PATCOPY）と、座標系と状態の記録。それ以外の記録
// （円弧、ラスター演算、模様のブラシ、グリフ番号の文字、縦書きの書体など）を 1 つでも含む画像は描かず、
// 理由を返す（呼び出し側は代替表示の箱のままにする）。
//
// EMF+（GDI+ の記録）は解釈しない。EMF+ の見出しが「二重（dual）」なら、同じ絵が GDI の記録でも入って
// いるので、GDI の記録で描く。二重でない EMF+ に描く記録があれば、GDI の記録だけでは絵にならないので
// 描かない。EMF+ の中の入れ子（オブジェクトの続き・コメントの中の EMF）はたどらない。

import {
	formatMetafileNumber,
	ParadisMetafilePathBuilder,
	ParadisMetafileSvgCanvas,
	ParadisOfficeMetafileStop,
	PARADIS_METAFILE_CLIP_DEPTH,
	type ParadisMetafileBitmap,
	type ParadisMetafileClip,
	type ParadisMetafileColor,
	type ParadisMetafileMatrix,
	type ParadisMetafilePen,
	type ParadisOfficeMetafileOutputLimits,
} from './paradisOfficeMetafileSvg.js';

export type ParadisOfficeMetafileFormat = 'emf' | 'wmf';

export interface ParadisOfficeMetafileLimits extends ParadisOfficeMetafileOutputLimits {
	/** 入力のバイト数。 */
	readonly bytes: number;
	/** 記録の数。 */
	readonly records: number;
	/** オブジェクト（ペン・ブラシ・書体など）の表の大きさ。 */
	readonly objects: number;
	/** 状態の保存（SaveDC）の深さ。 */
	readonly saveDepth: number;
	/** 座標の絶対値（論理の座標と出力の座標の両方）。 */
	readonly coordinate: number;
}

export const PARADIS_OFFICE_METAFILE_LIMITS: ParadisOfficeMetafileLimits = Object.freeze({
	bytes: 16 * 1024 * 1024,
	records: 250_000,
	objects: 16_384,
	saveDepth: 64,
	coordinate: 1 << 27,
	points: 2_000_000,
	bitmapPixels: 64 * 64,
	patternRects: 65_536,
	textCharacters: 100_000,
	// 1 枚の出力の上限（4 MiB）。呼び出し側は 1 文書の合計にも上限を付ける。
	outputCharacters: 4 * 1024 * 1024,
});

export type ParadisOfficeMetafileResult =
	| {
		readonly ok: true;
		readonly format: ParadisOfficeMetafileFormat;
		/** 描いた SVG（`<svg` で始まる 1 つの要素）。 */
		readonly svg: string;
		/** 表示の大きさ（CSS の px）。 */
		readonly width: number;
		readonly height: number;
		readonly records: number;
	}
	| {
		readonly ok: false;
		readonly format?: ParadisOfficeMetafileFormat;
		/** `unsupported` は描けない記録を含む、`malformed` は壊れている、`limitExceeded` は上限を超えた。 */
		readonly reason: 'notMetafile' | 'unsupported' | 'malformed' | 'limitExceeded';
		/** 記録の名前などの決まった語。文書の中身は入れない。 */
		readonly detail: string;
		/** 止まるまでに読んだ記録の数（文書ごとの仕事の上限に数える）。 */
		readonly records: number;
	};

export interface ParadisOfficeMetafileOptions {
	readonly limits?: Partial<ParadisOfficeMetafileLimits>;
	/** 記録 1,024 件ごとに呼ぶ。描いている間に他の処理へ譲る・取り消しを確かめるために使う（投げれば止まる）。 */
	readonly checkpoint?: () => void | Promise<void>;
}

/** 先頭の署名で EMF か WMF かを見分ける。どちらでもなければ undefined。 */
export function sniffParadisOfficeMetafile(bytes: Uint8Array): ParadisOfficeMetafileFormat | undefined {
	if (bytes.byteLength >= 88 && readU32(bytes, 0) === 1 && readU32(bytes, 40) === 0x464d4520) {
		return 'emf';
	}
	if (bytes.byteLength >= 22 && readU32(bytes, 0) === 0x9ac6cdd7) {
		return 'wmf';
	}
	if (bytes.byteLength >= 18 && (readU16(bytes, 0) === 1 || readU16(bytes, 0) === 2) && readU16(bytes, 2) === 9 && (readU16(bytes, 4) === 0x0100 || readU16(bytes, 4) === 0x0300)) {
		return 'wmf';
	}
	return undefined;
}

/** EMF・WMF を SVG にする。描けないときは理由を返す（投げるのは checkpoint が投げたときだけ）。 */
export async function convertParadisOfficeMetafile(bytes: Uint8Array, options: ParadisOfficeMetafileOptions = {}): Promise<ParadisOfficeMetafileResult> {
	const limits: ParadisOfficeMetafileLimits = { ...PARADIS_OFFICE_METAFILE_LIMITS, ...options.limits };
	const format = sniffParadisOfficeMetafile(bytes);
	if (!format) {
		return { ok: false, reason: 'notMetafile', detail: 'signature', records: 0 };
	}
	if (bytes.byteLength > limits.bytes) {
		return { ok: false, format, reason: 'limitExceeded', detail: 'bytes', records: 0 };
	}
	const progress = { records: 0 };
	try {
		const converted = format === 'emf' ? await convertEmf(bytes, limits, options.checkpoint, progress) : await convertWmf(bytes, limits, options.checkpoint, progress);
		return { ok: true, format, ...converted };
	} catch (error) {
		if (error instanceof ParadisOfficeMetafileStop) {
			return { ok: false, format, reason: error.reason, detail: error.detail, records: progress.records };
		}
		if (error instanceof RangeError) {
			return { ok: false, format, reason: 'malformed', detail: 'range', records: progress.records };
		}
		throw error;
	}
}

// ── 共通の描画の状態（GDI の DC に当たる） ──────────────────────────────────

type Point = readonly [number, number];

interface PenObject { readonly kind: 'pen'; readonly style: ParadisMetafilePen['kind']; readonly width: number; readonly cosmetic: boolean; readonly color: ParadisMetafileColor; readonly cap: ParadisMetafilePen['cap']; readonly join: ParadisMetafilePen['join'] }
interface BrushObject { readonly kind: 'brush'; readonly style: 'solid' | 'null' | 'unsupported'; readonly color: ParadisMetafileColor }
interface FontObject { readonly kind: 'font'; readonly height: number; readonly weight: number; readonly italic: boolean; readonly underline: boolean; readonly strikeOut: boolean; readonly escapement: number; readonly charset: number; readonly pitchAndFamily: number; readonly face: string }
interface OtherObject { readonly kind: 'palette' | 'region' }
type GdiObject = PenObject | BrushObject | FontObject | OtherObject;

interface DcState {
	mapMode: number;
	windowOrg: Point;
	windowExt: Point;
	viewportOrg: Point;
	viewportExt: Point;
	world: ParadisMetafileMatrix;
	pen: PenObject;
	brush: BrushObject;
	font: FontObject;
	textColor: ParadisMetafileColor;
	bkColor: ParadisMetafileColor;
	bkMode: number;
	textAlign: number;
	polyFillMode: number;
	miterLimit: number;
	clip: readonly ParadisMetafileClip[];
	position: Point;
}

const IDENTITY: ParadisMetafileMatrix = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
const BLACK_PEN: PenObject = Object.freeze({ kind: 'pen', style: 'solid', width: 0, cosmetic: true, color: 0x000000, cap: 'round', join: 'round' });
const WHITE_PEN: PenObject = Object.freeze({ ...BLACK_PEN, color: 0xffffff });
const NULL_PEN: PenObject = Object.freeze({ ...BLACK_PEN, style: 'null' });
const WHITE_BRUSH: BrushObject = Object.freeze({ kind: 'brush', style: 'solid', color: 0xffffff });
const NULL_BRUSH: BrushObject = Object.freeze({ kind: 'brush', style: 'null', color: 0 });
const DEFAULT_FONT: FontObject = Object.freeze({ kind: 'font', height: 12, weight: 400, italic: false, underline: false, strikeOut: false, escapement: 0, charset: 1, pitchAndFamily: 0, face: '' });
const KAPPA = 0.5522847498;

/** 文字の上端・下端の目安（em に対する割合）。書体を読み込まないので、和文の書体に近い値で置く。 */
const ASCENT = 0.86;
const DESCENT = 0.14;

function multiply(left: ParadisMetafileMatrix, right: ParadisMetafileMatrix): ParadisMetafileMatrix {
	// left ∘ right（right を先に当てる）。
	return {
		a: left.a * right.a + left.c * right.b,
		b: left.b * right.a + left.d * right.b,
		c: left.a * right.c + left.c * right.d,
		d: left.b * right.c + left.d * right.d,
		e: left.a * right.e + left.c * right.f + left.e,
		f: left.b * right.e + left.d * right.f + left.f,
	};
}

function colorRef(value: number): ParadisMetafileColor {
	// COLORREF は 0x00BBGGRR。
	return ((value & 0xff) << 16) | (value & 0xff00) | ((value >>> 16) & 0xff);
}

/** EMF と WMF の両方で使う、記録を描き先へ写す部分。座標は論理の座標で受け取る。 */
class GdiInterpreter {
	readonly canvas: ParadisMetafileSvgCanvas;
	state: DcState;
	private readonly saved: DcState[] = [];
	private path: ParadisMetafilePathBuilder | undefined;
	private inPath = false;
	private completedPath: ParadisMetafilePathBuilder | undefined;
	private nextClipId = 0;

	constructor(private readonly limits: ParadisOfficeMetafileLimits, private readonly mapping: (state: DcState) => ParadisMetafileMatrix) {
		this.canvas = new ParadisMetafileSvgCanvas(limits);
		this.state = {
			mapMode: 1, windowOrg: [0, 0], windowExt: [1, 1], viewportOrg: [0, 0], viewportExt: [1, 1], world: IDENTITY,
			pen: BLACK_PEN, brush: WHITE_BRUSH, font: DEFAULT_FONT, textColor: 0, bkColor: 0xffffff, bkMode: 2, textAlign: 0,
			polyFillMode: 1, miterLimit: 10, clip: [], position: [0, 0],
		};
	}

	get matrix(): ParadisMetafileMatrix {
		return this.mapping(this.state);
	}

	device(point: Point, matrix = this.matrix): Point {
		this.checkCoordinate(point[0]);
		this.checkCoordinate(point[1]);
		const x = matrix.a * point[0] + matrix.c * point[1] + matrix.e;
		const y = matrix.b * point[0] + matrix.d * point[1] + matrix.f;
		this.checkCoordinate(x);
		this.checkCoordinate(y);
		return [x, y];
	}

	checkCoordinate(value: number): void {
		if (!Number.isFinite(value) || Math.abs(value) > this.limits.coordinate) {
			throw new ParadisOfficeMetafileStop('limitExceeded', 'coordinate');
		}
	}

	save(): void {
		if (this.saved.length >= this.limits.saveDepth) {
			throw new ParadisOfficeMetafileStop('limitExceeded', 'saveDepth');
		}
		this.saved.push({ ...this.state });
	}

	restore(relative: number): void {
		// 負の値は直前から数え、正の値は保存した順の番号（1 から）。
		const target = relative < 0 ? this.saved.length + relative : relative - 1;
		if (target < 0 || target >= this.saved.length) {
			return;
		}
		this.state = { ...this.saved[target] };
		this.saved.length = target;
	}

	// ── 経路 ──

	beginPath(): void {
		this.path = new ParadisMetafilePathBuilder(this.canvas);
		this.inPath = true;
		this.completedPath = undefined;
	}

	endPath(): void {
		if (this.inPath) {
			this.completedPath = this.path;
		}
		this.inPath = false;
		this.path = undefined;
	}

	abortPath(): void {
		this.inPath = false;
		this.path = undefined;
		this.completedPath = undefined;
	}

	closeFigure(): void {
		this.path?.close();
	}

	private takePath(): string {
		const path = this.completedPath ?? (this.inPath ? this.path : undefined);
		this.completedPath = undefined;
		if (this.inPath) {
			this.inPath = false;
			this.path = undefined;
		}
		return path?.toString() ?? '';
	}

	fillPath(): void {
		this.fillD(this.takePath());
	}

	strokePath(): void {
		this.strokeD(this.takePath());
	}

	strokeAndFillPath(): void {
		const d = this.takePath();
		this.fillD(d);
		this.strokeD(d);
	}

	selectClipPath(mode: number): void {
		const d = this.takePath();
		this.combineClip({ d, rule: this.fillRule }, mode);
	}

	/** 切り抜きを組み合わせる。`clip` が無い RGN_COPY は切り抜きを外す。 */
	combineClip(clip: Omit<ParadisMetafileClip, 'id'> | undefined, mode: number): void {
		if (mode === 5) { // RGN_COPY
			this.state.clip = clip ? [this.makeClip(clip)] : [];
		} else if (mode === 1) { // RGN_AND
			if (clip) {
				this.state.clip = this.intersect(this.state.clip, clip);
			}
		} else {
			throw new ParadisOfficeMetafileStop('unsupported', 'clipMode');
		}
	}

	intersectClipRect(left: number, top: number, right: number, bottom: number): void {
		this.combineClip(this.rectClip(left, top, right, bottom), 1);
	}

	/** 論理の座標の矩形の切り抜き。写した先が軸に沿っていれば、矩形として持つ。 */
	private rectClip(left: number, top: number, right: number, bottom: number): Omit<ParadisMetafileClip, 'id'> {
		const matrix = this.matrix;
		const [x0, y0] = this.device([left, top], matrix);
		const [x1, y1] = this.device([right, bottom], matrix);
		if (Math.abs(matrix.b) < 1e-9 && Math.abs(matrix.c) < 1e-9) {
			return rectangleClip([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]);
		}
		const builder = new ParadisMetafilePathBuilder(this.canvas);
		this.addPolygon(builder, [[left, top], [right, top], [right, bottom], [left, bottom]]);
		return { d: builder.toString(), rule: 'nonzero' };
	}

	/** 鎖に交わりを足す。矩形どうしは 1 つの矩形に畳む。鎖の長さには上限がある。 */
	private intersect(chain: readonly ParadisMetafileClip[], clip: Omit<ParadisMetafileClip, 'id'>): readonly ParadisMetafileClip[] {
		const last = chain[chain.length - 1];
		if (last?.rect && clip.rect) {
			const [a, b] = [last.rect, clip.rect];
			const left = Math.max(a[0], b[0]);
			const top = Math.max(a[1], b[1]);
			const folded = rectangleClip([left, top, Math.max(left, Math.min(a[2], b[2])), Math.max(top, Math.min(a[3], b[3]))]);
			return [...chain.slice(0, -1), this.makeClip(folded)];
		}
		if (chain.length >= PARADIS_METAFILE_CLIP_DEPTH) {
			throw new ParadisOfficeMetafileStop('limitExceeded', 'clipDepth');
		}
		return [...chain, this.makeClip(clip)];
	}

	private makeClip(clip: Omit<ParadisMetafileClip, 'id'>): ParadisMetafileClip {
		return { ...clip, id: this.nextClipId++ };
	}

	// ── 図形（経路の記録中は経路へ、それ以外は描く） ──

	moveTo(point: Point): void {
		this.state.position = point;
		if (this.inPath) {
			this.ensurePath();
			const [x, y] = this.device(point);
			this.path!.moveTo(x, y);
		}
	}

	lineTo(point: Point): void {
		this.polylineTo([point]);
	}

	polylineTo(points: readonly Point[]): void {
		if (points.length === 0) {
			return;
		}
		if (this.inPath) {
			this.ensurePath();
			if (this.path!.empty) {
				const [x, y] = this.device(this.state.position);
				this.path!.moveTo(x, y);
			}
			for (const point of points) {
				const [x, y] = this.device(point);
				this.path!.lineTo(x, y);
			}
		} else {
			const builder = new ParadisMetafilePathBuilder(this.canvas);
			this.addPolyline(builder, [this.state.position, ...points]);
			this.strokeD(builder.toString());
		}
		this.state.position = points[points.length - 1];
	}

	polyBezierTo(points: readonly Point[]): void {
		if (points.length % 3 !== 0) {
			throw new ParadisOfficeMetafileStop('malformed', 'bezier');
		}
		if (points.length === 0) {
			return;
		}
		const builder = this.inPath ? this.ensurePath() : new ParadisMetafilePathBuilder(this.canvas);
		if (builder.empty || !this.inPath) {
			const [x, y] = this.device(this.state.position);
			builder.moveTo(x, y);
		}
		this.addBeziers(builder, points);
		if (!this.inPath) {
			this.strokeD(builder.toString());
		}
		this.state.position = points[points.length - 1];
	}

	polyBezier(points: readonly Point[]): void {
		if (points.length === 0) {
			return;
		}
		if ((points.length - 1) % 3 !== 0) {
			throw new ParadisOfficeMetafileStop('malformed', 'bezier');
		}
		const builder = this.inPath ? this.ensurePath() : new ParadisMetafilePathBuilder(this.canvas);
		const [x, y] = this.device(points[0]);
		builder.moveTo(x, y);
		this.addBeziers(builder, points.slice(1));
		if (!this.inPath) {
			this.strokeD(builder.toString());
		}
	}

	polyline(points: readonly Point[]): void {
		if (points.length === 0) {
			return;
		}
		const builder = this.inPath ? this.ensurePath() : new ParadisMetafilePathBuilder(this.canvas);
		this.addPolyline(builder, points);
		if (!this.inPath) {
			this.strokeD(builder.toString());
		}
	}

	polyPolygon(polygons: readonly (readonly Point[])[]): void {
		const builder = this.inPath ? this.ensurePath() : new ParadisMetafilePathBuilder(this.canvas);
		for (const polygon of polygons) {
			this.addPolygon(builder, polygon);
		}
		if (!this.inPath) {
			const d = builder.toString();
			this.fillD(d);
			this.strokeD(d);
		}
	}

	polyPolyline(polylines: readonly (readonly Point[])[]): void {
		const builder = this.inPath ? this.ensurePath() : new ParadisMetafilePathBuilder(this.canvas);
		for (const polyline of polylines) {
			this.addPolyline(builder, polyline);
		}
		if (!this.inPath) {
			this.strokeD(builder.toString());
		}
	}

	rectangle(left: number, top: number, right: number, bottom: number): void {
		this.polyPolygon([[[left, top], [right, top], [right, bottom], [left, bottom]]]);
	}

	ellipse(left: number, top: number, right: number, bottom: number): void {
		const builder = this.inPath ? this.ensurePath() : new ParadisMetafilePathBuilder(this.canvas);
		const cx = (left + right) / 2;
		const cy = (top + bottom) / 2;
		const rx = (right - left) / 2;
		const ry = (bottom - top) / 2;
		const [sx, sy] = this.device([cx + rx, cy]);
		builder.moveTo(sx, sy);
		this.addBeziers(builder, [
			[cx + rx, cy + ry * KAPPA], [cx + rx * KAPPA, cy + ry], [cx, cy + ry],
			[cx - rx * KAPPA, cy + ry], [cx - rx, cy + ry * KAPPA], [cx - rx, cy],
			[cx - rx, cy - ry * KAPPA], [cx - rx * KAPPA, cy - ry], [cx, cy - ry],
			[cx + rx * KAPPA, cy - ry], [cx + rx, cy - ry * KAPPA], [cx + rx, cy],
		]);
		builder.close();
		if (!this.inPath) {
			const d = builder.toString();
			this.fillD(d);
			this.strokeD(d);
		}
	}

	roundRect(left: number, top: number, right: number, bottom: number, width: number, height: number): void {
		const rx = Math.min(Math.abs(width) / 2, Math.abs(right - left) / 2);
		const ry = Math.min(Math.abs(height) / 2, Math.abs(bottom - top) / 2);
		if (rx <= 0 || ry <= 0) {
			this.rectangle(left, top, right, bottom);
			return;
		}
		const x0 = Math.min(left, right);
		const x1 = Math.max(left, right);
		const y0 = Math.min(top, bottom);
		const y1 = Math.max(top, bottom);
		const builder = this.inPath ? this.ensurePath() : new ParadisMetafilePathBuilder(this.canvas);
		const [sx, sy] = this.device([x0 + rx, y0]);
		builder.moveTo(sx, sy);
		const line = (point: Point) => { const [x, y] = this.device(point); builder.lineTo(x, y); };
		line([x1 - rx, y0]);
		this.addBeziers(builder, [[x1 - rx + rx * KAPPA, y0], [x1, y0 + ry - ry * KAPPA], [x1, y0 + ry]]);
		line([x1, y1 - ry]);
		this.addBeziers(builder, [[x1, y1 - ry + ry * KAPPA], [x1 - rx + rx * KAPPA, y1], [x1 - rx, y1]]);
		line([x0 + rx, y1]);
		this.addBeziers(builder, [[x0 + rx - rx * KAPPA, y1], [x0, y1 - ry + ry * KAPPA], [x0, y1 - ry]]);
		line([x0, y0 + ry]);
		this.addBeziers(builder, [[x0, y0 + ry - ry * KAPPA], [x0 + rx - rx * KAPPA, y0], [x0 + rx, y0]]);
		builder.close();
		if (!this.inPath) {
			const d = builder.toString();
			this.fillD(d);
			this.strokeD(d);
		}
	}

	/** 論理の座標の矩形を、指定の色（無ければ今のブラシ）で塗る。 */
	fillRect(left: number, top: number, right: number, bottom: number, fill?: ParadisMetafileColor): void {
		const builder = new ParadisMetafilePathBuilder(this.canvas);
		this.addPolygon(builder, [[left, top], [right, top], [right, bottom], [left, bottom]]);
		const d = builder.toString();
		if (fill === undefined) {
			this.fillD(d);
		} else {
			this.canvas.setClip(this.state.clip);
			this.canvas.fill(d, fill, 'nonzero');
		}
	}

	/**
	 * ビットマップを、論理の座標の `dest` へ写す。`source` はビットマップの上の行を 0 とした画素の座標。
	 */
	drawBitmap(bitmap: ParadisMetafileBitmap, source: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, dest: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): void {
		if (source.width <= 0 || source.height <= 0 || dest.width === 0 || dest.height === 0) {
			return;
		}
		this.checkCoordinate(dest.x);
		this.checkCoordinate(dest.y);
		this.checkCoordinate(dest.width);
		this.checkCoordinate(dest.height);
		const sx = dest.width / source.width;
		const sy = dest.height / source.height;
		const local: ParadisMetafileMatrix = { a: sx, b: 0, c: 0, d: sy, e: dest.x - source.x * sx, f: dest.y - source.y * sy };
		const matrix = multiply(this.matrix, local);
		this.device([dest.x, dest.y]);
		this.device([dest.x + dest.width, dest.y + dest.height]);
		this.canvas.setClip(this.state.clip);
		this.canvas.bitmap(bitmap, source, matrix);
	}

	/** 文字を描く。`advances` は文字ごとの送り幅（論理の座標）。 */
	text(reference: Point, value: string, advances: readonly number[] | undefined, options: { readonly opaqueRect?: readonly [number, number, number, number]; readonly clipRect?: readonly [number, number, number, number] }): void {
		const font = this.state.font;
		if (font.face.startsWith('@')) {
			throw new ParadisOfficeMetafileStop('unsupported', 'verticalFont');
		}
		const matrix = this.matrix;
		const align = this.state.textAlign;
		const updateCp = (align & 1) !== 0;
		const origin: Point = updateCp ? this.state.position : reference;
		const total = advances ? advances.reduce((sum, value) => sum + value, 0) : undefined;
		if (updateCp && total === undefined) {
			throw new ParadisOfficeMetafileStop('unsupported', 'textUpdateCp');
		}
		const horizontal = align & 6;
		const vertical = align & 24;
		const linearScale = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || 1;
		// 高さが負なら文字の高さ（em）、正ならセルの高さ（行間を含む）なので em に直す。0 は既定の大きさ。
		const em = (font.height < 0 ? -font.height : font.height > 0 ? font.height * 0.85 : DEFAULT_FONT.height) * linearScale;
		if (em <= 0) {
			return;
		}
		const axisAligned = Math.abs(matrix.b) < 1e-9 && Math.abs(matrix.c) < 1e-9;
		const rotation = -font.escapement / 10;
		// 基準点を出力の座標へ写し、縦の揃え（上・下・基準線）を基準線の位置に直す。
		const [ox, oy] = this.device(origin, matrix);
		const baselineShift = vertical === 0 ? em * ASCENT : vertical === 8 ? -em * DESCENT : 0;
		const radians = rotation * Math.PI / 180;
		const baselineX = ox - Math.sin(radians) * baselineShift;
		const baselineY = oy + Math.cos(radians) * baselineShift;
		const xDirection = axisAligned && matrix.a < 0 ? -1 : 1;
		let positions: number[] | undefined;
		let startX = baselineX;
		let anchor: 'start' | 'middle' | 'end' = horizontal === 2 ? 'end' : horizontal === 6 ? 'middle' : 'start';
		if (advances && total !== undefined && axisAligned && rotation === 0) {
			const totalDevice = total * Math.abs(matrix.a) * xDirection;
			startX = horizontal === 2 ? baselineX - totalDevice : horizontal === 6 ? baselineX - totalDevice / 2 : baselineX;
			positions = [];
			let offset = 0;
			for (let index = 0; index < advances.length && index < value.length; index++) {
				positions.push(startX + offset * Math.abs(matrix.a) * xDirection);
				offset += advances[index];
			}
			anchor = 'start';
		}
		if (options.opaqueRect) {
			const [left, top, right, bottom] = options.opaqueRect;
			this.fillRect(left, top, right, bottom, this.state.bkColor);
		} else if (this.state.bkMode === 2 && positions && total !== undefined) {
			// 背景を塗る（OPAQUE）。文字の幅が分かるときだけ、上端から下端までを塗る。
			const width = total * Math.abs(matrix.a);
			const builder = new ParadisMetafilePathBuilder(this.canvas);
			const left = Math.min(startX, startX + width * xDirection);
			builder.moveTo(left, baselineY - em * ASCENT);
			builder.lineTo(left + width, baselineY - em * ASCENT);
			builder.lineTo(left + width, baselineY + em * DESCENT);
			builder.lineTo(left, baselineY + em * DESCENT);
			builder.close();
			this.canvas.setClip(this.state.clip);
			this.canvas.fill(builder.toString(), this.state.bkColor, 'nonzero');
		}
		let clip = this.state.clip;
		if (options.clipRect) {
			const [left, top, right, bottom] = options.clipRect;
			clip = this.intersect(clip, this.rectClip(left, top, right, bottom));
		}
		this.canvas.setClip(clip);
		this.canvas.text({
			x: positions ? startX : baselineX, y: baselineY, positions, text: value,
			fontFamily: font.face, generic: genericFamily(font.pitchAndFamily), size: em, weight: font.weight || 400,
			italic: font.italic, underline: font.underline, strikeOut: font.strikeOut, color: this.state.textColor, rotation, anchor,
		});
		if (updateCp && total !== undefined) {
			this.state.position = [origin[0] + total, origin[1]];
		}
	}

	// ── 中で使う ──

	get fillRule(): 'nonzero' | 'evenodd' {
		return this.state.polyFillMode === 2 ? 'nonzero' : 'evenodd';
	}

	private ensurePath(): ParadisMetafilePathBuilder {
		if (!this.path) {
			this.path = new ParadisMetafilePathBuilder(this.canvas);
		}
		return this.path;
	}

	private addPolyline(builder: ParadisMetafilePathBuilder, points: readonly Point[]): void {
		points.forEach((point, index) => {
			const [x, y] = this.device(point);
			if (index === 0) {
				builder.moveTo(x, y);
			} else {
				builder.lineTo(x, y);
			}
		});
	}

	private addPolygon(builder: ParadisMetafilePathBuilder, points: readonly Point[]): void {
		if (points.length === 0) {
			return;
		}
		this.addPolyline(builder, points);
		builder.close();
	}

	private addBeziers(builder: ParadisMetafilePathBuilder, points: readonly Point[]): void {
		const matrix = this.matrix;
		for (let index = 0; index + 2 < points.length; index += 3) {
			const [x1, y1] = this.device(points[index], matrix);
			const [x2, y2] = this.device(points[index + 1], matrix);
			const [x, y] = this.device(points[index + 2], matrix);
			builder.bezierTo(x1, y1, x2, y2, x, y);
		}
	}

	private fillD(d: string): void {
		const brush = this.state.brush;
		if (!d || brush.style === 'null') {
			return;
		}
		if (brush.style === 'unsupported') {
			throw new ParadisOfficeMetafileStop('unsupported', 'brush');
		}
		this.canvas.setClip(this.state.clip);
		this.canvas.fill(d, brush.color, this.fillRule);
	}

	private strokeD(d: string): void {
		const pen = this.state.pen;
		if (!d || pen.style === 'null') {
			return;
		}
		const matrix = this.matrix;
		const scale = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || 1;
		const width = pen.cosmetic || pen.width <= 0 ? 1 : pen.width * scale;
		this.canvas.setClip(this.state.clip);
		this.canvas.stroke(d, { kind: pen.style, width, color: pen.color, cap: pen.cap, join: pen.join, miterLimit: this.state.miterLimit });
	}
}

function rectangleClip(rect: readonly [number, number, number, number]): Omit<ParadisMetafileClip, 'id'> {
	const [left, top, right, bottom] = rect.map(formatMetafileNumber);
	return { d: `M${left} ${top}H${right}V${bottom}H${left}Z`, rule: 'nonzero', rect };
}

function genericFamily(pitchAndFamily: number): 'serif' | 'sans-serif' | 'monospace' {
	const family = pitchAndFamily & 0xf0;
	if ((pitchAndFamily & 3) === 1 || family === 0x30) {
		return 'monospace';
	}
	return family === 0x10 ? 'serif' : 'sans-serif';
}

function penObject(style: number, width: number, colorValue: number, geometric: boolean): PenObject {
	const kinds: Record<number, ParadisMetafilePen['kind'] | undefined> = { 0: 'solid', 1: 'dash', 2: 'dot', 3: 'dashDot', 4: 'dashDotDot', 5: 'null', 6: 'solid', 8: 'dot' };
	const kind = kinds[style & 0xf];
	if (!kind) {
		throw new ParadisOfficeMetafileStop('unsupported', 'penStyle');
	}
	const cap = ({ 0x000: 'round', 0x100: 'square', 0x200: 'butt' } as const)[style & 0xf00];
	const join = ({ 0x0000: 'round', 0x1000: 'bevel', 0x2000: 'miter' } as const)[style & 0xf000];
	if (!cap || !join) {
		throw new ParadisOfficeMetafileStop('unsupported', 'penStyle');
	}
	return { kind: 'pen', style: kind, width: Math.abs(width), cosmetic: !geometric, color: colorRef(colorValue), cap, join };
}

function brushObject(style: number, colorValue: number): BrushObject {
	if (style === 0) {
		return { kind: 'brush', style: 'solid', color: colorRef(colorValue) };
	}
	if (style === 1) {
		return NULL_BRUSH;
	}
	// 模様（ハッチ・パターン）のブラシは、それで塗るときに描けない画像になる。
	return { kind: 'brush', style: 'unsupported', color: 0 };
}

const TEXT_DECODERS = new Map<string, TextDecoder | null>();

/** 書体の文字セット（LOGFONT の lfCharSet）から、文字コードの名前へ。無いものは windows-1252。 */
const CHARSET_LABELS = new Map<number, string>([
	[128, 'shift_jis'], [129, 'euc-kr'], [134, 'gbk'], [136, 'big5'], [161, 'windows-1253'], [162, 'windows-1254'], [177, 'windows-1255'],
	[178, 'windows-1256'], [186, 'windows-1257'], [204, 'windows-1251'], [222, 'windows-874'], [238, 'windows-1250'],
]);

/** 書体の文字セットに合わせて、1 バイト系の文字列を読む。 */
function decodeCharset(bytes: Uint8Array, charset: number): string {
	const label = CHARSET_LABELS.get(charset) ?? 'windows-1252';
	let decoder = TEXT_DECODERS.get(label);
	if (decoder === undefined) {
		try {
			decoder = new TextDecoder(label);
		} catch {
			decoder = null;
		}
		TEXT_DECODERS.set(label, decoder);
	}
	if (!decoder) {
		throw new ParadisOfficeMetafileStop('unsupported', 'charset');
	}
	return decoder.decode(bytes);
}

// ── バイト列の読み出し ──

function readU16(bytes: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 2 > bytes.byteLength) {
		throw new ParadisOfficeMetafileStop('malformed', 'read');
	}
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function readI16(bytes: Uint8Array, offset: number): number {
	const value = readU16(bytes, offset);
	return value >= 0x8000 ? value - 0x10000 : value;
}

function readU32(bytes: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 4 > bytes.byteLength) {
		throw new ParadisOfficeMetafileStop('malformed', 'read');
	}
	return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readI32(bytes: Uint8Array, offset: number): number {
	return readU32(bytes, offset) | 0;
}

function readF32(bytes: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 4 > bytes.byteLength) {
		throw new ParadisOfficeMetafileStop('malformed', 'read');
	}
	return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, true);
}

/**
 * DIB（BITMAPINFOHEADER とその後の画素）を読む。`bmi` と `bits` は記録の中の範囲。上の行から並べて返す。
 * 対応は 1・4・8 ビット（色の表つき）、16 ビット（5-5-5）、24・32 ビット、圧縮なしだけ。
 */
function readDib(bytes: Uint8Array, bmi: number, bmiSize: number, bits: number, bitsSize: number, limits: ParadisOfficeMetafileLimits, usage: number): ParadisMetafileBitmap {
	if (usage !== 0) {
		throw new ParadisOfficeMetafileStop('unsupported', 'dibPaletteUsage');
	}
	const headerSize = readU32(bytes, bmi);
	if (headerSize < 40 || headerSize > bmiSize) {
		throw new ParadisOfficeMetafileStop('unsupported', 'dibHeader');
	}
	const width = readI32(bytes, bmi + 4);
	const rawHeight = readI32(bytes, bmi + 8);
	const planes = readU16(bytes, bmi + 12);
	const bitCount = readU16(bytes, bmi + 14);
	const compression = readU32(bytes, bmi + 16);
	const colorsUsed = readU32(bytes, bmi + 32);
	const height = Math.abs(rawHeight);
	if (planes !== 1 || width <= 0 || height <= 0 || compression !== 0 || ![1, 4, 8, 16, 24, 32].includes(bitCount)) {
		throw new ParadisOfficeMetafileStop('unsupported', 'dibFormat');
	}
	if (width * height > limits.bitmapPixels) {
		throw new ParadisOfficeMetafileStop('limitExceeded', 'bitmapPixels');
	}
	const palette: number[] = [];
	if (bitCount <= 8) {
		const count = colorsUsed || (1 << bitCount);
		if (count > 256 || headerSize + count * 4 > bmiSize) {
			throw new ParadisOfficeMetafileStop('malformed', 'dibPalette');
		}
		for (let index = 0; index < count; index++) {
			const at = bmi + headerSize + index * 4;
			palette.push((bytes[at + 2] << 16) | (bytes[at + 1] << 8) | bytes[at]);
		}
	}
	const stride = Math.ceil(width * bitCount / 32) * 4;
	if (stride * height > bitsSize || bits + stride * height > bytes.byteLength) {
		throw new ParadisOfficeMetafileStop('malformed', 'dibBits');
	}
	const pixels = new Uint32Array(width * height);
	for (let row = 0; row < height; row++) {
		const sourceRow = rawHeight > 0 ? height - 1 - row : row;
		const base = bits + sourceRow * stride;
		for (let x = 0; x < width; x++) {
			let value: number;
			switch (bitCount) {
				case 1: value = palette[(bytes[base + (x >> 3)] >> (7 - (x & 7))) & 1] ?? 0; break;
				case 4: value = palette[(bytes[base + (x >> 1)] >> ((x & 1) ? 0 : 4)) & 0xf] ?? 0; break;
				case 8: value = palette[bytes[base + x]] ?? 0; break;
				case 16: {
					const word = bytes[base + x * 2] | (bytes[base + x * 2 + 1] << 8);
					const expand = (part: number) => (part << 3) | (part >> 2);
					value = (expand((word >> 10) & 31) << 16) | (expand((word >> 5) & 31) << 8) | expand(word & 31);
					break;
				}
				case 24: value = (bytes[base + x * 3 + 2] << 16) | (bytes[base + x * 3 + 1] << 8) | bytes[base + x * 3]; break;
				default: value = (bytes[base + x * 4 + 2] << 16) | (bytes[base + x * 4 + 1] << 8) | bytes[base + x * 4]; break;
			}
			pixels[row * width + x] = value;
		}
	}
	return { width, height, pixels };
}

const SRCCOPY = 0x00cc0020;
const PATCOPY = 0x00f00021;
const BLACKNESS = 0x00000042;
const WHITENESS = 0x00ff0062;

// ── EMF ──

const EMR_NAMES: Record<number, string> = {
	2: 'POLYBEZIER', 3: 'POLYGON', 4: 'POLYLINE', 5: 'POLYBEZIERTO', 6: 'POLYLINETO', 7: 'POLYPOLYLINE', 8: 'POLYPOLYGON',
	15: 'SETPIXELV', 26: 'OFFSETCLIPRGN', 29: 'EXCLUDECLIPRECT', 41: 'ANGLEARC', 45: 'ARC', 46: 'CHORD', 47: 'PIE', 53: 'EXTFLOODFILL',
	55: 'ARCTO', 56: 'POLYDRAW', 66: 'WIDENPATH', 71: 'FILLRGN', 72: 'FRAMERGN', 73: 'INVERTRGN', 74: 'PAINTRGN', 77: 'STRETCHBLT',
	78: 'MASKBLT', 79: 'PLGBLT', 80: 'SETDIBITSTODEVICE', 83: 'EXTTEXTOUTA', 92: 'POLYDRAW16', 93: 'CREATEMONOBRUSH',
	94: 'CREATEDIBPATTERNBRUSHPT', 96: 'POLYTEXTOUTA', 97: 'POLYTEXTOUTW', 108: 'SMALLTEXTOUT', 114: 'ALPHABLEND', 116: 'TRANSPARENTBLT',
	118: 'GRADIENTFILL',
};

/** 何もしなくてよい記録（描画に効かない設定・色管理・パレット）。 */
const EMR_IGNORED = new Set([
	13, // SETBRUSHORGEX
	16, // SETMAPPERFLAGS
	21, // SETSTRETCHBLTMODE
	23, // SETCOLORADJUSTMENT
	28, // SETMETARGN
	48, // SELECTPALETTE
	50, // SETPALETTEENTRIES
	51, // RESIZEPALETTE
	52, // REALIZEPALETTE
	57, // SETARCDIRECTION（円弧は描かない）
	65, // FLATTENPATH（曲線のまま描く）
	98, // SETICMMODE
	99, // CREATECOLORSPACE
	100, // SETCOLORSPACE
	101, // DELETECOLORSPACE
	111, // COLORCORRECTPALETTE
	112, // SETICMPROFILEA
	113, // SETICMPROFILEW
	119, // SETLINKEDUFIS
	121, // COLORMATCHTOTARGETW
	122, // CREATECOLORSPACEW
]);

/** EMF+ の、絵を描く記録の種類（FillRects から DrawString、DrawDriverString・StrokeFillPath）。 */
function isEmfPlusDrawing(type: number): boolean {
	return type >= 0x4009 && type <= 0x401c || type === 0x4036 || type === 0x4037;
}

async function convertEmf(bytes: Uint8Array, limits: ParadisOfficeMetafileLimits, checkpoint: (() => void | Promise<void>) | undefined, progress: { records: number }): Promise<{ readonly svg: string; readonly width: number; readonly height: number; readonly records: number }> {
	const headerSize = readU32(bytes, 4);
	if (headerSize < 88 || headerSize > bytes.byteLength) {
		throw new ParadisOfficeMetafileStop('malformed', 'header');
	}
	const bounds = [readI32(bytes, 8), readI32(bytes, 12), readI32(bytes, 16), readI32(bytes, 20)];
	const frame = [readI32(bytes, 24), readI32(bytes, 28), readI32(bytes, 32), readI32(bytes, 36)];
	const declaredBytes = readU32(bytes, 48);
	const declaredRecords = readU32(bytes, 52);
	const handles = readU16(bytes, 56);
	const device = [readI32(bytes, 72), readI32(bytes, 76)];
	const millimeters = [readI32(bytes, 80), readI32(bytes, 84)];
	if (declaredRecords > limits.records) {
		throw new ParadisOfficeMetafileStop('limitExceeded', 'records');
	}
	if (handles > limits.objects) {
		throw new ParadisOfficeMetafileStop('limitExceeded', 'objects');
	}
	const end = Math.min(bytes.byteLength, declaredBytes >= headerSize ? declaredBytes : bytes.byteLength);
	const pixelsPerMillimeter: Point = device[0] > 0 && device[1] > 0 && millimeters[0] > 0 && millimeters[1] > 0
		? [device[0] / millimeters[0], device[1] / millimeters[1]]
		: [96 / 25.4, 96 / 25.4];
	const objects: (GdiObject | undefined)[] = new Array(Math.max(handles, 1));
	const gdi = new GdiInterpreter(limits, state => emfMatrix(state, pixelsPerMillimeter));
	let emfPlus = false;
	let emfPlusDual = false;
	let emfPlusDrawing = false;
	let offset = 0;
	let finished = false;
	while (offset + 8 <= end) {
		const type = readU32(bytes, offset);
		const size = readU32(bytes, offset + 4);
		if (size < 8 || size % 4 !== 0 || offset + size > end) {
			throw new ParadisOfficeMetafileStop('malformed', 'recordSize');
		}
		if (++progress.records > limits.records) {
			throw new ParadisOfficeMetafileStop('limitExceeded', 'records');
		}
		if (progress.records % 1024 === 0 && checkpoint) {
			await checkpoint();
		}
		const at = (relative: number, length: number) => {
			if (relative + length > size) {
				throw new ParadisOfficeMetafileStop('malformed', 'recordSize');
			}
			return offset + relative;
		};
		const i32 = (relative: number) => readI32(bytes, at(relative, 4));
		const u32 = (relative: number) => readU32(bytes, at(relative, 4));
		const point = (relative: number): Point => [i32(relative), i32(relative + 4)];
		const object = (index: number): GdiObject | undefined => {
			if (index & 0x80000000) {
				return stockObject(index & 0x7fffffff);
			}
			if (index >= objects.length) {
				throw new ParadisOfficeMetafileStop('malformed', 'objectIndex');
			}
			return objects[index];
		};
		const store = (index: number, value: GdiObject) => {
			if (index === 0 || index >= objects.length) {
				throw new ParadisOfficeMetafileStop('malformed', 'objectIndex');
			}
			objects[index] = value;
		};
		const points16 = (relative: number, count: number): Point[] => {
			at(relative, count * 4);
			const result: Point[] = [];
			for (let index = 0; index < count; index++) {
				result.push([readI16(bytes, offset + relative + index * 4), readI16(bytes, offset + relative + index * 4 + 2)]);
			}
			return result;
		};
		const points32 = (relative: number, count: number): Point[] => {
			at(relative, count * 8);
			const result: Point[] = [];
			for (let index = 0; index < count; index++) {
				result.push([readI32(bytes, offset + relative + index * 8), readI32(bytes, offset + relative + index * 8 + 4)]);
			}
			return result;
		};
		const counted = (count: number) => {
			if (count > limits.points) {
				throw new ParadisOfficeMetafileStop('limitExceeded', 'points');
			}
			return count;
		};
		const polyPoints = (wide: boolean) => {
			const count = counted(u32(24));
			return wide ? points32(28, count) : points16(28, count);
		};
		const polyPolyPoints = (wide: boolean): Point[][] => {
			const polygons = u32(24);
			const total = counted(u32(28));
			if (polygons > total + 1 || polygons > limits.points) {
				throw new ParadisOfficeMetafileStop('malformed', 'polyCounts');
			}
			const counts: number[] = [];
			let sum = 0;
			for (let index = 0; index < polygons; index++) {
				const count = u32(32 + index * 4);
				counts.push(count);
				sum += count;
			}
			if (sum !== total) {
				throw new ParadisOfficeMetafileStop('malformed', 'polyCounts');
			}
			const all = wide ? points32(32 + polygons * 4, total) : points16(32 + polygons * 4, total);
			const result: Point[][] = [];
			let start = 0;
			for (const count of counts) {
				result.push(all.slice(start, start + count));
				start += count;
			}
			return result;
		};
		const state = gdi.state;
		switch (type) {
			case 1: break; // HEADER（2 つ目以降は読み飛ばす）
			case 14: finished = true; break; // EOF
			case 9: state.windowExt = point(8); break; // SETWINDOWEXTEX
			case 10: state.windowOrg = point(8); break; // SETWINDOWORGEX
			case 11: state.viewportExt = point(8); break; // SETVIEWPORTEXTEX
			case 12: state.viewportOrg = point(8); break; // SETVIEWPORTORGEX
			case 31: state.viewportExt = scaleExtent(state.viewportExt, i32(8), i32(12), i32(16), i32(20)); break; // SCALEVIEWPORTEXTEX
			case 32: state.windowExt = scaleExtent(state.windowExt, i32(8), i32(12), i32(16), i32(20)); break; // SCALEWINDOWEXTEX
			case 17: state.mapMode = u32(8); break; // SETMAPMODE
			case 18: state.bkMode = u32(8); break; // SETBKMODE
			case 19: state.polyFillMode = u32(8); break; // SETPOLYFILLMODE
			case 20: if (u32(8) !== 13) { throw new ParadisOfficeMetafileStop('unsupported', 'rop2'); } break; // SETROP2（R2_COPYPEN だけ）
			case 22: state.textAlign = u32(8); break; // SETTEXTALIGN
			case 24: state.textColor = colorRef(u32(8)); break; // SETTEXTCOLOR
			case 25: state.bkColor = colorRef(u32(8)); break; // SETBKCOLOR
			case 58: state.miterLimit = u32(8); break; // SETMITERLIMIT
			case 115: if (u32(8) !== 0) { throw new ParadisOfficeMetafileStop('unsupported', 'layout'); } break; // SETLAYOUT
			case 120: if (i32(8) !== 0) { throw new ParadisOfficeMetafileStop('unsupported', 'textJustification'); } break; // SETTEXTJUSTIFICATION
			case 27: gdi.moveTo(point(8)); break; // MOVETOEX
			case 54: gdi.lineTo(point(8)); break; // LINETO
			case 33: gdi.save(); break; // SAVEDC
			case 34: gdi.restore(i32(8)); break; // RESTOREDC
			case 35: state.world = xform(bytes, at(8, 24)); break; // SETWORLDTRANSFORM
			case 36: { // MODIFYWORLDTRANSFORM
				const matrix = xform(bytes, at(8, 24));
				const mode = u32(32);
				state.world = mode === 1 ? IDENTITY : mode === 2 ? multiply(state.world, matrix) : mode === 3 ? multiply(matrix, state.world) : mode === 4 ? matrix : (() => { throw new ParadisOfficeMetafileStop('malformed', 'worldTransform'); })();
				break;
			}
			case 37: { // SELECTOBJECT
				const selected = object(u32(8));
				if (selected?.kind === 'pen') { state.pen = selected; }
				if (selected?.kind === 'brush') { state.brush = selected; }
				if (selected?.kind === 'font') { state.font = selected; }
				if (selected?.kind === 'region') { throw new ParadisOfficeMetafileStop('unsupported', 'selectRegion'); }
				break;
			}
			case 40: { // DELETEOBJECT
				const index = u32(8);
				if (!(index & 0x80000000) && index < objects.length) { objects[index] = undefined; }
				break;
			}
			case 38: { // CREATEPEN
				const created = penObject(u32(12), i32(16), u32(24), i32(16) > 1);
				store(u32(8), created);
				break;
			}
			case 95: { // EXTCREATEPEN
				const style = u32(28);
				const brushStyle = u32(36);
				if (brushStyle !== 0 && brushStyle !== 1 || (style & 0xf) === 7) {
					throw new ParadisOfficeMetafileStop('unsupported', 'penBrush');
				}
				const created = brushStyle === 1 ? NULL_PEN : penObject(style & 0xffff, u32(32), u32(40), (style & 0x10000) !== 0);
				store(u32(8), created);
				break;
			}
			case 39: store(u32(8), brushObject(u32(12), u32(16))); break; // CREATEBRUSHINDIRECT
			case 82: store(u32(8), emfFont(bytes, at(12, 92))); break; // EXTCREATEFONTINDIRECTW
			case 49: store(u32(8), { kind: 'palette' }); break; // CREATEPALETTE
			case 59: gdi.beginPath(); break; // BEGINPATH
			case 60: gdi.endPath(); break; // ENDPATH
			case 61: gdi.closeFigure(); break; // CLOSEFIGURE
			case 62: gdi.fillPath(); break; // FILLPATH
			case 63: gdi.strokeAndFillPath(); break; // STROKEANDFILLPATH
			case 64: gdi.strokePath(); break; // STROKEPATH
			case 68: gdi.abortPath(); break; // ABORTPATH
			case 67: gdi.selectClipPath(u32(8)); break; // SELECTCLIPPATH
			case 30: gdi.intersectClipRect(i32(8), i32(12), i32(16), i32(20)); break; // INTERSECTCLIPRECT
			case 75: gdi.combineClip(regionClip(bytes, offset, size, u32(8)), u32(12)); break; // EXTSELECTCLIPRGN
			case 2: gdi.polyBezier(polyPoints(true)); break; // POLYBEZIER
			case 3: gdi.polyPolygon([polyPoints(true)]); break; // POLYGON
			case 4: gdi.polyline(polyPoints(true)); break; // POLYLINE
			case 5: gdi.polyBezierTo(polyPoints(true)); break; // POLYBEZIERTO
			case 6: gdi.polylineTo(polyPoints(true)); break; // POLYLINETO
			case 7: gdi.polyPolyline(polyPolyPoints(true)); break; // POLYPOLYLINE
			case 8: gdi.polyPolygon(polyPolyPoints(true)); break; // POLYPOLYGON
			case 85: gdi.polyBezier(polyPoints(false)); break; // POLYBEZIER16
			case 86: gdi.polyPolygon([polyPoints(false)]); break; // POLYGON16
			case 87: gdi.polyline(polyPoints(false)); break; // POLYLINE16
			case 88: gdi.polyBezierTo(polyPoints(false)); break; // POLYBEZIERTO16
			case 89: gdi.polylineTo(polyPoints(false)); break; // POLYLINETO16
			case 90: gdi.polyPolyline(polyPolyPoints(false)); break; // POLYPOLYLINE16
			case 91: gdi.polyPolygon(polyPolyPoints(false)); break; // POLYPOLYGON16
			case 42: gdi.ellipse(i32(8), i32(12), i32(16), i32(20)); break; // ELLIPSE
			case 43: gdi.rectangle(i32(8), i32(12), i32(16), i32(20)); break; // RECTANGLE
			case 44: gdi.roundRect(i32(8), i32(12), i32(16), i32(20), i32(24), i32(28)); break; // ROUNDRECT
			case 76: emfBitBlt(bytes, offset, size, gdi, limits, false); break; // BITBLT
			case 77: emfBitBlt(bytes, offset, size, gdi, limits, true); break; // STRETCHBLT
			case 81: { // STRETCHDIBITS
				if (u32(68) !== SRCCOPY) {
					throw new ParadisOfficeMetafileStop('unsupported', 'rop');
				}
				const offBmi = u32(48);
				const cbBmi = u32(52);
				const offBits = u32(56);
				const cbBits = u32(60);
				if (cbBmi === 0) {
					break;
				}
				at(offBmi, cbBmi);
				at(offBits, cbBits);
				const bitmap = readDib(bytes, offset + offBmi, cbBmi, offset + offBits, cbBits, limits, u32(64));
				const sourceY = i32(36);
				const sourceHeight = i32(44);
				// 下から上へ並んだ DIB では、元の範囲の y は下の端から数える。
				const bottomUp = readI32(bytes, offset + offBmi + 8) > 0;
				const top = bottomUp ? bitmap.height - sourceY - sourceHeight : sourceY;
				gdi.drawBitmap(bitmap, { x: i32(32), y: top, width: i32(40), height: sourceHeight }, { x: i32(24), y: i32(28), width: i32(72), height: i32(76) });
				break;
			}
			case 84: emfText(bytes, offset, size, gdi, limits, true); break; // EXTTEXTOUTW
			case 83: emfText(bytes, offset, size, gdi, limits, false); break; // EXTTEXTOUTA
			case 70: { // COMMENT
				const dataSize = u32(8);
				at(12, dataSize);
				if (dataSize >= 4 && readU32(bytes, offset + 12) === 0x2b464d45) { // 'EMF+'
					emfPlus = true;
					let plus = offset + 16;
					const plusEnd = offset + 12 + dataSize;
					while (plus + 12 <= plusEnd) {
						const plusType = readU16(bytes, plus);
						const plusFlags = readU16(bytes, plus + 2);
						const plusSize = readU32(bytes, plus + 4);
						if (plusSize < 12 || plus + plusSize > plusEnd) {
							break;
						}
						if (plusType === 0x4001 && (plusFlags & 1)) {
							emfPlusDual = true;
						}
						if (isEmfPlusDrawing(plusType)) {
							emfPlusDrawing = true;
						}
						plus += plusSize;
					}
				}
				break;
			}
			default:
				if (!EMR_IGNORED.has(type)) {
					throw new ParadisOfficeMetafileStop('unsupported', `EMR_${EMR_NAMES[type] ?? type}`);
				}
		}
		if (finished) {
			break;
		}
		offset += size;
	}
	if (!finished) {
		throw new ParadisOfficeMetafileStop('malformed', 'eof');
	}
	if (emfPlus && !emfPlusDual && emfPlusDrawing) {
		throw new ParadisOfficeMetafileStop('unsupported', 'emfPlusOnly');
	}
	// 表示の範囲は、見出しの frame（0.01 mm）を装置の座標へ写したもの。frame が無効なら bounds（装置の座標）。
	let viewBox: { x: number; y: number; width: number; height: number };
	let cssWidth: number;
	let cssHeight: number;
	if (frame[2] > frame[0] && frame[3] > frame[1]) {
		viewBox = {
			x: frame[0] / 100 * pixelsPerMillimeter[0], y: frame[1] / 100 * pixelsPerMillimeter[1],
			width: (frame[2] - frame[0]) / 100 * pixelsPerMillimeter[0], height: (frame[3] - frame[1]) / 100 * pixelsPerMillimeter[1],
		};
		cssWidth = (frame[2] - frame[0]) / 100 * 96 / 25.4;
		cssHeight = (frame[3] - frame[1]) / 100 * 96 / 25.4;
	} else if (bounds[2] >= bounds[0] && bounds[3] >= bounds[1]) {
		viewBox = { x: bounds[0], y: bounds[1], width: bounds[2] - bounds[0] + 1, height: bounds[3] - bounds[1] + 1 };
		cssWidth = viewBox.width;
		cssHeight = viewBox.height;
	} else {
		throw new ParadisOfficeMetafileStop('malformed', 'frame');
	}
	gdi.checkCoordinate(viewBox.x);
	gdi.checkCoordinate(viewBox.y);
	gdi.checkCoordinate(viewBox.width);
	gdi.checkCoordinate(viewBox.height);
	return { svg: gdi.canvas.finish(viewBox, cssWidth, cssHeight), width: cssWidth, height: cssHeight, records: progress.records };
}

function stockObject(index: number): GdiObject | undefined {
	switch (index) {
		case 0: return WHITE_BRUSH;
		case 1: return { kind: 'brush', style: 'solid', color: 0xc0c0c0 };
		case 2: return { kind: 'brush', style: 'solid', color: 0x808080 };
		case 3: return { kind: 'brush', style: 'solid', color: 0x404040 };
		case 4: return { kind: 'brush', style: 'solid', color: 0x000000 };
		case 5: return NULL_BRUSH;
		case 6: return WHITE_PEN;
		case 7: return BLACK_PEN;
		case 8: return NULL_PEN;
		case 10: case 11: case 12: case 13: case 14: case 16: case 17: return DEFAULT_FONT;
		case 15: return { kind: 'palette' };
		case 18: return WHITE_BRUSH; // DC_BRUSH
		case 19: return BLACK_PEN; // DC_PEN
		default: throw new ParadisOfficeMetafileStop('malformed', 'stockObject');
	}
}

function scaleExtent(extent: Point, xNum: number, xDenom: number, yNum: number, yDenom: number): Point {
	if (xDenom === 0 || yDenom === 0) {
		throw new ParadisOfficeMetafileStop('malformed', 'scale');
	}
	return [extent[0] * xNum / xDenom, extent[1] * yNum / yDenom];
}

function xform(bytes: Uint8Array, offset: number): ParadisMetafileMatrix {
	const values = [0, 4, 8, 12, 16, 20].map(relative => readF32(bytes, offset + relative));
	if (values.some(value => !Number.isFinite(value))) {
		throw new ParadisOfficeMetafileStop('malformed', 'worldTransform');
	}
	return { a: values[0], b: values[1], c: values[2], d: values[3], e: values[4], f: values[5] };
}

/** 論理の座標（世界の変換の後のページの座標）から装置の座標へ。 */
function emfMatrix(state: DcState, pixelsPerMillimeter: Point): ParadisMetafileMatrix {
	let sx: number;
	let sy: number;
	const [wox, woy] = state.windowOrg;
	const [vox, voy] = state.viewportOrg;
	switch (state.mapMode) {
		case 1: sx = 1; sy = 1; break; // MM_TEXT
		case 2: sx = 0.1 * pixelsPerMillimeter[0]; sy = -0.1 * pixelsPerMillimeter[1]; break; // MM_LOMETRIC
		case 3: sx = 0.01 * pixelsPerMillimeter[0]; sy = -0.01 * pixelsPerMillimeter[1]; break; // MM_HIMETRIC
		case 4: sx = 0.254 * pixelsPerMillimeter[0]; sy = -0.254 * pixelsPerMillimeter[1]; break; // MM_LOENGLISH
		case 5: sx = 0.0254 * pixelsPerMillimeter[0]; sy = -0.0254 * pixelsPerMillimeter[1]; break; // MM_HIENGLISH
		case 6: sx = 25.4 / 1440 * pixelsPerMillimeter[0]; sy = -25.4 / 1440 * pixelsPerMillimeter[1]; break; // MM_TWIPS
		case 7: case 8: { // MM_ISOTROPIC・MM_ANISOTROPIC
			const [wex, wey] = state.windowExt;
			const [vex, vey] = state.viewportExt;
			if (wex === 0 || wey === 0) {
				throw new ParadisOfficeMetafileStop('malformed', 'windowExtent');
			}
			sx = vex / wex;
			sy = vey / wey;
			if (state.mapMode === 7) {
				const scale = Math.min(Math.abs(sx), Math.abs(sy));
				sx = Math.sign(sx || 1) * scale;
				sy = Math.sign(sy || 1) * scale;
			}
			break;
		}
		default: throw new ParadisOfficeMetafileStop('unsupported', 'mapMode');
	}
	const page: ParadisMetafileMatrix = { a: sx, b: 0, c: 0, d: sy, e: vox - wox * sx, f: voy - woy * sy };
	return multiply(page, state.world);
}

function emfFont(bytes: Uint8Array, offset: number): FontObject {
	const faceStart = offset + 28;
	let face = '';
	for (let index = 0; index < 32; index++) {
		const code = readU16(bytes, faceStart + index * 2);
		if (code === 0) {
			break;
		}
		face += String.fromCharCode(code);
	}
	return {
		kind: 'font', height: readI32(bytes, offset), weight: readI32(bytes, offset + 16), italic: bytes[offset + 20] !== 0,
		underline: bytes[offset + 21] !== 0, strikeOut: bytes[offset + 22] !== 0, escapement: readI32(bytes, offset + 8),
		charset: bytes[offset + 23], pitchAndFamily: bytes[offset + 27], face,
	};
}

/** EXTSELECTCLIPRGN の領域（装置の座標の矩形の集まり）。データが無ければ undefined（切り抜きを外す）。 */
function regionClip(bytes: Uint8Array, offset: number, size: number, dataSize: number): Omit<ParadisMetafileClip, 'id'> | undefined {
	if (dataSize === 0) {
		return undefined;
	}
	if (16 + dataSize > size || dataSize < 32) {
		throw new ParadisOfficeMetafileStop('malformed', 'region');
	}
	const header = offset + 16;
	const count = readU32(bytes, header + 8);
	if (32 + count * 16 > dataSize) {
		throw new ParadisOfficeMetafileStop('malformed', 'region');
	}
	if (count === 1) {
		const rect = header + 32;
		return rectangleClip([readI32(bytes, rect), readI32(bytes, rect + 4), readI32(bytes, rect + 8), readI32(bytes, rect + 12)]);
	}
	let d = '';
	for (let index = 0; index < count; index++) {
		const rect = header + 32 + index * 16;
		const [left, top, right, bottom] = [readI32(bytes, rect), readI32(bytes, rect + 4), readI32(bytes, rect + 8), readI32(bytes, rect + 12)];
		d += `M${formatMetafileNumber(left)} ${formatMetafileNumber(top)}H${formatMetafileNumber(right)}V${formatMetafileNumber(bottom)}H${formatMetafileNumber(left)}Z`;
	}
	return { d, rule: 'nonzero' };
}

function emfBitBlt(bytes: Uint8Array, offset: number, size: number, gdi: GdiInterpreter, limits: ParadisOfficeMetafileLimits, stretch: boolean): void {
	if (size < (stretch ? 108 : 100)) {
		throw new ParadisOfficeMetafileStop('malformed', 'recordSize');
	}
	const x = readI32(bytes, offset + 24);
	const y = readI32(bytes, offset + 28);
	const width = readI32(bytes, offset + 32);
	const height = readI32(bytes, offset + 36);
	const rop = readU32(bytes, offset + 40);
	const offBmi = readU32(bytes, offset + 84);
	const cbBmi = readU32(bytes, offset + 88);
	const offBits = readU32(bytes, offset + 92);
	const cbBits = readU32(bytes, offset + 96);
	if (cbBmi === 0) {
		// 元の画像の無い転送は、ブラシ・黒・白での矩形の塗り。
		if (rop === PATCOPY) {
			gdi.fillRect(x, y, x + width, y + height);
		} else if (rop === BLACKNESS || rop === WHITENESS) {
			gdi.fillRect(x, y, x + width, y + height, rop === BLACKNESS ? 0x000000 : 0xffffff);
		} else {
			throw new ParadisOfficeMetafileStop('unsupported', 'rop');
		}
		return;
	}
	if (rop !== SRCCOPY) {
		throw new ParadisOfficeMetafileStop('unsupported', 'rop');
	}
	if (offBmi + cbBmi > size || offBits + cbBits > size) {
		throw new ParadisOfficeMetafileStop('malformed', 'recordSize');
	}
	// 元の画像の座標の変換（xformSrc）は、平行移動と拡大だけのときに使う。
	const source = xform(bytes, offset + 52);
	if (Math.abs(source.b) > 1e-9 || Math.abs(source.c) > 1e-9 || source.a === 0 || source.d === 0) {
		throw new ParadisOfficeMetafileStop('unsupported', 'sourceTransform');
	}
	const bitmap = readDib(bytes, offset + offBmi, cbBmi, offset + offBits, cbBits, limits, readU32(bytes, offset + 80));
	const sourceWidth = stretch ? readI32(bytes, offset + 100) : width;
	const sourceHeight = stretch ? readI32(bytes, offset + 104) : height;
	// 元の範囲は元の DC の論理の座標なので、xformSrc（拡大と平行移動）でビットマップの画素の座標に直す。
	const sourceRect = {
		x: source.a * readI32(bytes, offset + 44) + source.e,
		y: source.d * readI32(bytes, offset + 48) + source.f,
		width: source.a * sourceWidth,
		height: source.d * sourceHeight,
	};
	if (sourceRect.width <= 0 || sourceRect.height <= 0) {
		throw new ParadisOfficeMetafileStop('unsupported', 'sourceTransform');
	}
	gdi.drawBitmap(bitmap, sourceRect, { x, y, width, height });
}

function emfText(bytes: Uint8Array, offset: number, size: number, gdi: GdiInterpreter, limits: ParadisOfficeMetafileLimits, wide: boolean): void {
	if (size < 76) {
		throw new ParadisOfficeMetafileStop('malformed', 'recordSize');
	}
	const reference: Point = [readI32(bytes, offset + 36), readI32(bytes, offset + 40)];
	const characters = readU32(bytes, offset + 44);
	const offString = readU32(bytes, offset + 48);
	const options = readU32(bytes, offset + 52);
	const rect: [number, number, number, number] = [readI32(bytes, offset + 56), readI32(bytes, offset + 60), readI32(bytes, offset + 64), readI32(bytes, offset + 68)];
	const offDx = readU32(bytes, offset + 72);
	if (characters === 0) {
		return;
	}
	if (characters > limits.textCharacters) {
		throw new ParadisOfficeMetafileStop('limitExceeded', 'text');
	}
	if (options & 0x10) { // ETO_GLYPH_INDEX
		throw new ParadisOfficeMetafileStop('unsupported', 'glyphIndex');
	}
	if (options & 0x80) { // ETO_RTLREADING
		throw new ParadisOfficeMetafileStop('unsupported', 'rtlText');
	}
	const stringBytes = characters * (wide ? 2 : 1);
	if (offString + stringBytes > size) {
		throw new ParadisOfficeMetafileStop('malformed', 'textString');
	}
	let value = '';
	if (wide) {
		for (let index = 0; index < characters; index++) {
			value += String.fromCharCode(readU16(bytes, offset + offString + index * 2));
		}
	} else {
		value = decodeCharset(bytes.subarray(offset + offString, offset + offString + stringBytes), gdi.state.font.charset);
	}
	let advances: number[] | undefined;
	const step = options & 0x2000 ? 2 : 1; // ETO_PDY は x と y の組
	if (offDx !== 0 && offDx + characters * 4 * step <= size) {
		advances = [];
		for (let index = 0; index < characters; index++) {
			advances.push(readI32(bytes, offset + offDx + index * 4 * step));
		}
		if (!wide && value.length !== characters) {
			// 2 バイト文字は送り幅が 2 つに分かれて入っているので、文字ごとに足し合わせる。
			advances = mergeAnsiAdvances(bytes.subarray(offset + offString, offset + offString + stringBytes), advances, gdi.state.font.charset);
		}
	}
	gdi.text(reference, value, advances, {
		...(options & 0x2 ? { opaqueRect: rect } : {}), // ETO_OPAQUE
		...(options & 0x4 ? { clipRect: rect } : {}), // ETO_CLIPPED
	});
}

/** 1 バイト系の文字列で、2 バイトで 1 文字になる所の送り幅を足し合わせる（Shift_JIS などの先行バイトを見る）。 */
function mergeAnsiAdvances(raw: Uint8Array, advances: readonly number[], charset: number): number[] | undefined {
	const lead = (byte: number) => charset === 128 ? (byte >= 0x81 && byte <= 0x9f || byte >= 0xe0 && byte <= 0xfc) : charset === 129 || charset === 134 || charset === 136 ? byte >= 0x81 && byte <= 0xfe : false;
	const merged: number[] = [];
	for (let index = 0; index < raw.length; index++) {
		if (lead(raw[index]) && index + 1 < raw.length) {
			merged.push(advances[index] + advances[index + 1]);
			index++;
		} else {
			merged.push(advances[index]);
		}
	}
	return merged;
}

// ── WMF ──

const WMF_NAMES: Record<number, string> = {
	0x0817: 'ARC', 0x081a: 'PIE', 0x0830: 'CHORD', 0x0419: 'FLOODFILL', 0x0548: 'EXTFLOODFILL', 0x041f: 'SETPIXEL', 0x0228: 'FILLREGION',
	0x0429: 'FRAMEREGION', 0x012a: 'INVERTREGION', 0x012b: 'PAINTREGION', 0x012c: 'SELECTCLIPREGION', 0x0220: 'OFFSETCLIPRGN',
	0x0415: 'EXCLUDECLIPRECT', 0x0922: 'BITBLT', 0x0b23: 'STRETCHBLT', 0x0d33: 'SETDIBTODEV', 0x0108: 'SETTEXTCHAREXTRA',
	0x01f9: 'CREATEPATTERNBRUSH', 0x0436: 'ANIMATEPALETTE', 0x020f: 'OFFSETWINDOWORG', 0x0211: 'OFFSETVIEWPORTORG',
	0x0410: 'SCALEWINDOWEXT', 0x0412: 'SCALEVIEWPORTEXT',
};

const WMF_IGNORED = new Set([
	0x0035, // REALIZEPALETTE
	0x0037, // SETPALENTRIES
	0x0105, // SETRELABS
	0x0107, // SETSTRETCHBLTMODE
	0x0139, // RESIZEPALETTE
	0x0149, // SETLAYOUT は 0 のときだけ下で確かめる
	0x0231, // SETMAPPERFLAGS
	0x0234, // SELECTPALETTE
	0x0626, // ESCAPE
	0x020d, // SETVIEWPORTORG（装置を持たないので使わない）
	0x020e, // SETVIEWPORTEXT
]);

async function convertWmf(bytes: Uint8Array, limits: ParadisOfficeMetafileLimits, checkpoint: (() => void | Promise<void>) | undefined, progress: { records: number }): Promise<{ readonly svg: string; readonly width: number; readonly height: number; readonly records: number }> {
	let offset = 0;
	let placeable: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; readonly inch: number } | undefined;
	if (readU32(bytes, 0) === 0x9ac6cdd7) {
		placeable = { left: readI16(bytes, 6), top: readI16(bytes, 8), right: readI16(bytes, 10), bottom: readI16(bytes, 12), inch: readU16(bytes, 14) };
		offset = 22;
	}
	const headerWords = readU16(bytes, offset + 2);
	if (headerWords !== 9) {
		throw new ParadisOfficeMetafileStop('malformed', 'header');
	}
	const objectCount = readU16(bytes, offset + 10);
	if (objectCount > limits.objects) {
		throw new ParadisOfficeMetafileStop('limitExceeded', 'objects');
	}
	offset += 18;
	const objects: (GdiObject | undefined)[] = new Array(objectCount);
	const slots = new FreeObjectSlots(objectCount);
	let windowBox: { origin: Point; extent: Point } | undefined = placeable && placeable.right !== placeable.left && placeable.bottom !== placeable.top
		? { origin: [placeable.left, placeable.top], extent: [placeable.right - placeable.left, placeable.bottom - placeable.top] }
		: undefined;
	let frame: { readonly matrix: ParadisMetafileMatrix; readonly mapMode: number; readonly window: { origin: Point; extent: Point } } | undefined;
	const gdi = new GdiInterpreter(limits, wmfMatrix);
	if (windowBox) {
		gdi.state.windowOrg = windowBox.origin;
		gdi.state.windowExt = windowBox.extent;
	}
	let finished = false;
	while (offset + 6 <= bytes.byteLength) {
		const words = readU32(bytes, offset);
		const fn = readU16(bytes, offset + 4);
		const size = words * 2;
		if (words < 3 || offset + size > bytes.byteLength) {
			throw new ParadisOfficeMetafileStop('malformed', 'recordSize');
		}
		if (++progress.records > limits.records) {
			throw new ParadisOfficeMetafileStop('limitExceeded', 'records');
		}
		if (progress.records % 1024 === 0 && checkpoint) {
			await checkpoint();
		}
		const param = (index: number) => {
			if (6 + index * 2 + 2 > size) {
				throw new ParadisOfficeMetafileStop('malformed', 'recordSize');
			}
			return readI16(bytes, offset + 6 + index * 2);
		};
		const paramU = (index: number) => param(index) & 0xffff;
		const paramU32 = (index: number) => (paramU(index) | (paramU(index + 1) << 16)) >>> 0;
		const create = (value: GdiObject) => {
			// WMF のオブジェクトは、空いている中で最も小さい番号に入る。
			const index = slots.take();
			if (index === undefined) {
				throw new ParadisOfficeMetafileStop('malformed', 'objectTable');
			}
			objects[index] = value;
		};
		const drawStarted = () => {
			// 最初に描く時点の写像と窓で、表示の範囲を決める。
			if (!frame) {
				frame = { matrix: gdi.matrix, mapMode: gdi.state.mapMode, window: { origin: gdi.state.windowOrg, extent: gdi.state.windowExt } };
			}
		};
		const points = (start: number, count: number): Point[] => {
			if (count > limits.points) {
				throw new ParadisOfficeMetafileStop('limitExceeded', 'points');
			}
			const result: Point[] = [];
			for (let index = 0; index < count; index++) {
				result.push([param(start + index * 2), param(start + index * 2 + 1)]);
			}
			return result;
		};
		const state = gdi.state;
		switch (fn) {
			case 0x0000: finished = true; break; // EOF
			case 0x0201: state.bkColor = colorRef(paramU32(0)); break; // SETBKCOLOR
			case 0x0102: state.bkMode = paramU(0); break; // SETBKMODE
			case 0x0103: state.mapMode = paramU(0); break; // SETMAPMODE（窓だけで写す）
			case 0x0104: if (paramU(0) !== 13) { throw new ParadisOfficeMetafileStop('unsupported', 'rop2'); } break; // SETROP2
			case 0x0106: state.polyFillMode = paramU(0); break; // SETPOLYFILLMODE
			case 0x0209: state.textColor = colorRef(paramU32(0)); break; // SETTEXTCOLOR
			case 0x012e: state.textAlign = paramU(0); break; // SETTEXTALIGN
			case 0x020b: state.windowOrg = [param(1), param(0)]; break; // SETWINDOWORG
			case 0x020c: state.windowExt = [param(1), param(0)]; break; // SETWINDOWEXT
			case 0x001e: gdi.save(); break; // SAVEDC
			case 0x0127: gdi.restore(param(0)); break; // RESTOREDC
			case 0x012d: { // SELECTOBJECT
				const index = paramU(0);
				const selected = index < objects.length ? objects[index] : undefined;
				if (!selected) {
					throw new ParadisOfficeMetafileStop('malformed', 'objectIndex');
				}
				if (selected.kind === 'pen') { state.pen = selected; }
				if (selected.kind === 'brush') { state.brush = selected; }
				if (selected.kind === 'font') { state.font = selected; }
				if (selected.kind === 'region') { throw new ParadisOfficeMetafileStop('unsupported', 'selectRegion'); }
				break;
			}
			case 0x01f0: { // DELETEOBJECT
				const index = paramU(0);
				if (index < objects.length && objects[index] !== undefined) {
					objects[index] = undefined;
					slots.release(index);
				}
				break;
			}
			case 0x02fa: create(penObject(paramU(0), param(1), paramU32(3), param(1) > 1)); break; // CREATEPENINDIRECT
			case 0x02fc: create(brushObject(paramU(0), paramU32(1))); break; // CREATEBRUSHINDIRECT
			case 0x02fb: create(wmfFont(bytes, offset + 6, size - 6)); break; // CREATEFONTINDIRECT
			case 0x00f7: create({ kind: 'palette' }); break; // CREATEPALETTE
			case 0x06ff: create({ kind: 'region' }); break; // CREATEREGION
			case 0x0142: create({ kind: 'brush', style: 'unsupported', color: 0 }); break; // DIBCREATEPATTERNBRUSH
			case 0x0214: gdi.moveTo([param(1), param(0)]); break; // MOVETO
			case 0x0213: drawStarted(); gdi.lineTo([param(1), param(0)]); break; // LINETO
			case 0x0325: drawStarted(); gdi.polyline(points(1, paramU(0))); break; // POLYLINE
			case 0x0324: drawStarted(); gdi.polyPolygon([points(1, paramU(0))]); break; // POLYGON
			case 0x0538: { // POLYPOLYGON
				drawStarted();
				const polygons = paramU(0);
				const counts = Array.from({ length: polygons }, (_value, index) => paramU(1 + index));
				const total = counts.reduce((sum, count) => sum + count, 0);
				const all = points(1 + polygons, total);
				const result: Point[][] = [];
				let start = 0;
				for (const count of counts) {
					result.push(all.slice(start, start + count));
					start += count;
				}
				gdi.polyPolygon(result);
				break;
			}
			case 0x041b: drawStarted(); gdi.rectangle(param(3), param(2), param(1), param(0)); break; // RECTANGLE
			case 0x0418: drawStarted(); gdi.ellipse(param(3), param(2), param(1), param(0)); break; // ELLIPSE
			case 0x061c: drawStarted(); gdi.roundRect(param(5), param(4), param(3), param(2), param(1), param(0)); break; // ROUNDRECT
			case 0x0416: gdi.intersectClipRect(param(3), param(2), param(1), param(0)); break; // INTERSECTCLIPRECT
			case 0x061d: { // PATBLT
				drawStarted();
				const rop = paramU32(0);
				const [height, width, y, x] = [param(2), param(3), param(4), param(5)];
				if (rop === PATCOPY) {
					gdi.fillRect(x, y, x + width, y + height);
				} else if (rop === BLACKNESS || rop === WHITENESS) {
					gdi.fillRect(x, y, x + width, y + height, rop === BLACKNESS ? 0 : 0xffffff);
				} else {
					throw new ParadisOfficeMetafileStop('unsupported', 'rop');
				}
				break;
			}
			case 0x0521: { // TEXTOUT
				drawStarted();
				const length = paramU(0);
				const stringStart = offset + 8;
				const padded = length + (length & 1);
				if (8 + padded + 4 > size) {
					throw new ParadisOfficeMetafileStop('malformed', 'textString');
				}
				const y = readI16(bytes, stringStart + padded);
				const x = readI16(bytes, stringStart + padded + 2);
				gdi.text([x, y], decodeCharset(bytes.subarray(stringStart, stringStart + length), state.font.charset), undefined, {});
				break;
			}
			case 0x0a32: { // EXTTEXTOUT
				drawStarted();
				const y = param(0);
				const x = param(1);
				const length = paramU(2);
				const opts = paramU(3);
				let cursor = offset + 14;
				let rect: [number, number, number, number] | undefined;
				if (opts & 0x6) {
					rect = [param(4), param(5), param(6), param(7)];
					cursor += 8;
				}
				if (opts & 0x10) {
					throw new ParadisOfficeMetafileStop('unsupported', 'glyphIndex');
				}
				const padded = length + (length & 1);
				if (cursor - offset + padded > size) {
					throw new ParadisOfficeMetafileStop('malformed', 'textString');
				}
				const raw = bytes.subarray(cursor, cursor + length);
				const value = decodeCharset(raw, state.font.charset);
				let advances: number[] | undefined;
				const dxStart = cursor + padded;
				if (dxStart - offset + length * 2 <= size && length > 0) {
					advances = [];
					for (let index = 0; index < length; index++) {
						advances.push(readI16(bytes, dxStart + index * 2));
					}
					if (value.length !== length) {
						advances = mergeAnsiAdvances(raw, advances, state.font.charset);
					}
				}
				gdi.text([x, y], value, advances, { ...(rect && opts & 0x2 ? { opaqueRect: rect } : {}), ...(rect && opts & 0x4 ? { clipRect: rect } : {}) });
				break;
			}
			case 0x0b41: case 0x0f43: case 0x0940: { // DIBSTRETCHBLT・STRETCHDIB・DIBBITBLT
				drawStarted();
				wmfBitmap(bytes, offset, size, fn, param, paramU32, gdi, limits);
				break;
			}
			default:
				if (fn === 0x0149 && paramU32(0) !== 0) {
					throw new ParadisOfficeMetafileStop('unsupported', 'layout');
				}
				if (!WMF_IGNORED.has(fn)) {
					throw new ParadisOfficeMetafileStop('unsupported', `META_${WMF_NAMES[fn] ?? fn.toString(16)}`);
				}
		}
		if (finished) {
			break;
		}
		offset += size;
	}
	if (!finished) {
		throw new ParadisOfficeMetafileStop('malformed', 'eof');
	}
	// 表示の範囲は、MM_ISOTROPIC・MM_ANISOTROPIC なら最初に描いた時点の窓、それ以外は placeable の範囲を、その時点の
	// 写像で写したもの。どちらも無い（placeable でない MM_TEXT など）と、絵の大きさが決まらないので描かない。
	const used = frame ?? { matrix: gdi.matrix, mapMode: gdi.state.mapMode, window: { origin: gdi.state.windowOrg, extent: gdi.state.windowExt } };
	windowBox = used.mapMode === 7 || used.mapMode === 8 ? used.window : placeable ? windowBox : undefined;
	if (!windowBox) {
		throw new ParadisOfficeMetafileStop('unsupported', 'wmfExtent');
	}
	const [x0, y0] = gdi.device(windowBox.origin, used.matrix);
	const [x1, y1] = gdi.device([windowBox.origin[0] + windowBox.extent[0], windowBox.origin[1] + windowBox.extent[1]], used.matrix);
	const width = Math.abs(x1 - x0);
	const height = Math.abs(y1 - y0);
	if (width === 0 || height === 0) {
		throw new ParadisOfficeMetafileStop('malformed', 'windowExtent');
	}
	const viewBox = { x: Math.min(x0, x1), y: Math.min(y0, y1), width, height };
	let cssWidth = width;
	let cssHeight = height;
	if (placeable && placeable.inch > 0) {
		cssWidth = Math.abs(placeable.right - placeable.left) / placeable.inch * 96;
		cssHeight = Math.abs(placeable.bottom - placeable.top) / placeable.inch * 96;
	}
	return { svg: gdi.canvas.finish(viewBox, cssWidth, cssHeight), width: cssWidth, height: cssHeight, records: progress.records };
}

/** WMF のオブジェクトの表の空き。最も小さい空きの番号を、表の大きさの対数の手間で出し入れする（最小ヒープ）。 */
class FreeObjectSlots {
	private readonly heap: number[] = [];

	constructor(count: number) {
		// 0 から順に並べた配列は、そのまま最小ヒープになっている。
		for (let index = 0; index < count; index++) {
			this.heap.push(index);
		}
	}

	take(): number | undefined {
		const heap = this.heap;
		if (heap.length === 0) {
			return undefined;
		}
		const top = heap[0];
		const last = heap.pop()!;
		if (heap.length > 0) {
			heap[0] = last;
			let index = 0;
			for (; ;) {
				const left = index * 2 + 1;
				const right = left + 1;
				let smallest = index;
				if (left < heap.length && heap[left] < heap[smallest]) { smallest = left; }
				if (right < heap.length && heap[right] < heap[smallest]) { smallest = right; }
				if (smallest === index) { break; }
				[heap[index], heap[smallest]] = [heap[smallest], heap[index]];
				index = smallest;
			}
		}
		return top;
	}

	release(slot: number): void {
		const heap = this.heap;
		heap.push(slot);
		let index = heap.length - 1;
		while (index > 0) {
			const parent = (index - 1) >> 1;
			if (heap[parent] <= heap[index]) { break; }
			[heap[index], heap[parent]] = [heap[parent], heap[index]];
			index = parent;
		}
	}
}

/** WMF の論理の座標から出力の座標へ。装置を持たないので、窓の写像では窓の大きさ、固定の単位では 96 dpi の px にする。 */
function wmfMatrix(state: DcState): ParadisMetafileMatrix {
	const [ox, oy] = state.windowOrg;
	const fixed = (perUnit: number): ParadisMetafileMatrix => ({ a: perUnit, b: 0, c: 0, d: -perUnit, e: -ox * perUnit, f: oy * perUnit });
	switch (state.mapMode) {
		case 1: return { a: 1, b: 0, c: 0, d: 1, e: -ox, f: -oy }; // MM_TEXT
		case 2: return fixed(96 / 254); // MM_LOMETRIC（0.1 mm）
		case 3: return fixed(96 / 2540); // MM_HIMETRIC（0.01 mm）
		case 4: return fixed(0.96); // MM_LOENGLISH（0.01 in）
		case 5: return fixed(0.096); // MM_HIENGLISH（0.001 in）
		case 6: return fixed(96 / 1440); // MM_TWIPS
		case 7: case 8: { // MM_ISOTROPIC・MM_ANISOTROPIC: 窓の向きだけを使い、大きさは窓のまま
			const [ex, ey] = state.windowExt;
			if (ex === 0 || ey === 0) {
				throw new ParadisOfficeMetafileStop('malformed', 'windowExtent');
			}
			return { a: Math.sign(ex), b: 0, c: 0, d: Math.sign(ey), e: -ox * Math.sign(ex), f: -oy * Math.sign(ey) };
		}
		default: throw new ParadisOfficeMetafileStop('unsupported', 'mapMode');
	}
}

function wmfFont(bytes: Uint8Array, offset: number, length: number): FontObject {
	if (length < 18) {
		throw new ParadisOfficeMetafileStop('malformed', 'font');
	}
	const charset = bytes[offset + 13];
	let end = offset + 18;
	const limit = offset + Math.min(length, 18 + 32);
	while (end < limit && bytes[end] !== 0) {
		end++;
	}
	return {
		kind: 'font', height: readI16(bytes, offset), weight: readI16(bytes, offset + 8), italic: bytes[offset + 10] !== 0,
		underline: bytes[offset + 11] !== 0, strikeOut: bytes[offset + 12] !== 0, escapement: readI16(bytes, offset + 4), charset,
		pitchAndFamily: bytes[offset + 17], face: decodeCharset(bytes.subarray(offset + 18, end), charset),
	};
}

function wmfBitmap(bytes: Uint8Array, offset: number, size: number, fn: number, param: (index: number) => number, paramU32: (index: number) => number, gdi: GdiInterpreter, limits: ParadisOfficeMetafileLimits): void {
	const rop = paramU32(0);
	if (rop !== SRCCOPY) {
		throw new ParadisOfficeMetafileStop('unsupported', 'rop');
	}
	let dibStart: number;
	let source: { x: number; y: number; width: number; height: number };
	let dest: { x: number; y: number; width: number; height: number };
	let usage = 0;
	if (fn === 0x0f43) { // STRETCHDIB: rop, usage, srcH, srcW, ySrc, xSrc, destH, destW, yDst, xDst, DIB
		usage = param(2) & 0xffff;
		source = { height: param(3), width: param(4), y: param(5), x: param(6) };
		dest = { height: param(7), width: param(8), y: param(9), x: param(10) };
		dibStart = offset + 6 + 11 * 2;
	} else if (fn === 0x0b41) { // DIBSTRETCHBLT: rop, srcH, srcW, ySrc, xSrc, destH, destW, yDst, xDst, DIB
		source = { height: param(2), width: param(3), y: param(4), x: param(5) };
		dest = { height: param(6), width: param(7), y: param(8), x: param(9) };
		dibStart = offset + 6 + 10 * 2;
	} else { // DIBBITBLT: rop, ySrc, xSrc, height, width, yDst, xDst, DIB
		source = { y: param(2), x: param(3), height: param(4), width: param(5) };
		dest = { y: param(6), x: param(7), height: source.height, width: source.width };
		dibStart = offset + 6 + 8 * 2;
	}
	const available = offset + size - dibStart;
	if (available < 40) {
		throw new ParadisOfficeMetafileStop('unsupported', 'bitbltWithoutBitmap');
	}
	const headerSize = readU32(bytes, dibStart);
	const bitCount = readU16(bytes, dibStart + 14);
	const colorsUsed = readU32(bytes, dibStart + 32);
	const paletteBytes = bitCount <= 8 ? (colorsUsed || (1 << bitCount)) * 4 : 0;
	const bmiSize = headerSize + paletteBytes;
	if (bmiSize > available) {
		throw new ParadisOfficeMetafileStop('malformed', 'dibHeader');
	}
	const bitmap = readDib(bytes, dibStart, bmiSize, dibStart + bmiSize, available - bmiSize, limits, usage);
	const bottomUp = readI32(bytes, dibStart + 8) > 0;
	const top = fn === 0x0f43 && bottomUp ? bitmap.height - source.y - source.height : source.y;
	gdi.drawBitmap(bitmap, { ...source, y: top }, dest);
}
