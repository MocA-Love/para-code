/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スクリーンショットへの書き込み（Markup、B2）の図形と取り消し履歴。DOM に触らない純粋なモデル。
//
// Orca（stablyai/orca、MIT License、Copyright (c) 2026 Lovecast Inc.）の
// src/renderer/src/components/browser-pane/annotate/markup-drawing-model.ts と
// markup-shape-render.ts を移植した。座標は書き込み面の CSS px。画面の描画と、保存する PNG への
// 合成は同じ描画処理（paradisDrawMarkupShapes）を通すので、見たままの絵が保存される。

export type ParadisMarkupTool = 'pen' | 'highlight' | 'arrow' | 'rect' | 'ellipse' | 'text';

export interface IParadisMarkupPoint {
	readonly x: number;
	readonly y: number;
}

interface IParadisMarkupShapeBase {
	readonly id: string;
	readonly color: string;
}

export interface IParadisMarkupStroke extends IParadisMarkupShapeBase {
	readonly kind: 'pen' | 'highlight';
	readonly points: readonly IParadisMarkupPoint[];
	readonly width: number;
}

export interface IParadisMarkupSegment extends IParadisMarkupShapeBase {
	readonly kind: 'arrow' | 'rect' | 'ellipse';
	readonly from: IParadisMarkupPoint;
	readonly to: IParadisMarkupPoint;
	readonly width: number;
}

export interface IParadisMarkupText extends IParadisMarkupShapeBase {
	readonly kind: 'text';
	readonly at: IParadisMarkupPoint;
	readonly text: string;
	readonly fontSize: number;
}

export type ParadisMarkupShape = IParadisMarkupStroke | IParadisMarkupSegment | IParadisMarkupText;

/** 絵の具の色（保存する画像に焼き込むので、テーマの色ではなく固定の色）。 */
export const PARADIS_MARKUP_COLORS: readonly string[] = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#111827', '#ffffff'];
/** 線の太さ3段。 */
export const PARADIS_MARKUP_WIDTHS: readonly number[] = [2, 4, 8];
export const PARADIS_MARKUP_DEFAULT_WIDTH = 4;
/** 文字の大きさは線の太さから決める（細・中・太）。 */
export function paradisMarkupFontSize(width: number): number {
	return width <= 2 ? 14 : width <= 4 ? 18 : 28;
}
/** 蛍光ペンは太く、半透明にする。 */
export const PARADIS_MARKUP_HIGHLIGHT_MULTIPLIER = 4;
export const PARADIS_MARKUP_HIGHLIGHT_ALPHA = 0.35;
/** 取り消し履歴の上限（長く描き続けても記憶が増え続けないように）。 */
const HISTORY_LIMIT = 200;

/** 図形の一覧と、取り消し・やり直しの履歴。 */
export interface IParadisMarkupDocument {
	readonly shapes: readonly ParadisMarkupShape[];
	readonly past: readonly (readonly ParadisMarkupShape[])[];
	readonly future: readonly (readonly ParadisMarkupShape[])[];
}

export function paradisCreateMarkupDocument(): IParadisMarkupDocument {
	return { shapes: [], past: [], future: [] };
}

export function paradisCommitMarkupShape(doc: IParadisMarkupDocument, shape: ParadisMarkupShape): IParadisMarkupDocument {
	return { shapes: [...doc.shapes, shape], past: [...doc.past, doc.shapes].slice(-HISTORY_LIMIT), future: [] };
}

export function paradisUndoMarkup(doc: IParadisMarkupDocument): IParadisMarkupDocument {
	const previous = doc.past.at(-1);
	if (!previous) {
		return doc;
	}
	return { shapes: previous, past: doc.past.slice(0, -1), future: [doc.shapes, ...doc.future] };
}

export function paradisRedoMarkup(doc: IParadisMarkupDocument): IParadisMarkupDocument {
	const next = doc.future.at(0);
	if (!next) {
		return doc;
	}
	return { shapes: next, past: [...doc.past, doc.shapes], future: doc.future.slice(1) };
}

export function paradisClearMarkup(doc: IParadisMarkupDocument): IParadisMarkupDocument {
	return doc.shapes.length === 0 ? doc : { shapes: [], past: [...doc.past, doc.shapes].slice(-HISTORY_LIMIT), future: [] };
}

export interface IParadisMarkupRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export function paradisNormalizeMarkupRect(from: IParadisMarkupPoint, to: IParadisMarkupPoint): IParadisMarkupRect {
	return {
		x: Math.min(from.x, to.x),
		y: Math.min(from.y, to.y),
		width: Math.abs(to.x - from.x),
		height: Math.abs(to.y - from.y),
	};
}

function scalePoint(point: IParadisMarkupPoint, scale: number): IParadisMarkupPoint {
	return { x: point.x * scale, y: point.y * scale };
}

/**
 * 図形を拡大縮小する。書き込みは CSS px で行い、保存する PNG はスクリーンショットの実ピクセル
 * なので、その比で掛けて位置と太さを合わせる。
 */
export function paradisScaleMarkupShape(shape: ParadisMarkupShape, scale: number): ParadisMarkupShape {
	switch (shape.kind) {
		case 'pen':
		case 'highlight':
			return { ...shape, width: shape.width * scale, points: shape.points.map(point => scalePoint(point, scale)) };
		case 'arrow':
		case 'rect':
		case 'ellipse':
			return { ...shape, width: shape.width * scale, from: scalePoint(shape.from, scale), to: scalePoint(shape.to, scale) };
		case 'text':
			return { ...shape, fontSize: shape.fontSize * scale, at: scalePoint(shape.at, scale) };
	}
}

export interface IParadisArrowHead {
	readonly tip: IParadisMarkupPoint;
	readonly left: IParadisMarkupPoint;
	readonly right: IParadisMarkupPoint;
}

const ARROW_HEAD_ANGLE = 0.45;

/** 矢じりの2点。向きが無い（始点と終点が同じ）ときは undefined。 */
export function paradisArrowHead(from: IParadisMarkupPoint, to: IParadisMarkupPoint, width: number): IParadisArrowHead | undefined {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (dx === 0 && dy === 0) {
		return undefined;
	}
	const angle = Math.atan2(dy, dx);
	const size = Math.max(10, width * 3.5);
	const left = angle + Math.PI - ARROW_HEAD_ANGLE;
	const right = angle + Math.PI + ARROW_HEAD_ANGLE;
	return {
		tip: to,
		left: { x: to.x + size * Math.cos(left), y: to.y + size * Math.sin(left) },
		right: { x: to.x + size * Math.cos(right), y: to.y + size * Math.sin(right) },
	};
}

/**
 * 図形の描画に使う最小限の 2D コンテキスト。common 層なので DOM の型は使わず、構造で受ける
 * （本物の CanvasRenderingContext2D をそのまま渡せ、テストからは偽物を渡せる）。
 */
export interface IParadisMarkupCanvasContext {
	lineCap: string;
	lineJoin: string;
	lineWidth: number;
	strokeStyle: unknown;
	fillStyle: unknown;
	globalAlpha: number;
	font: string;
	textBaseline: string;
	save(): void;
	restore(): void;
	beginPath(): void;
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
	ellipse(x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number): void;
	stroke(): void;
	fill(): void;
	strokeRect(x: number, y: number, width: number, height: number): void;
	strokeText(text: string, x: number, y: number): void;
	fillText(text: string, x: number, y: number): void;
}

const TEXT_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif';

function strokePolyline(ctx: IParadisMarkupCanvasContext, points: readonly IParadisMarkupPoint[], width: number): void {
	if (points.length === 0) {
		return;
	}
	if (points.length === 1) {
		// 1回押しただけでも点が残るようにする
		ctx.beginPath();
		ctx.arc(points[0].x, points[0].y, Math.max(width / 2, 1), 0, Math.PI * 2);
		ctx.fill();
		return;
	}
	ctx.beginPath();
	ctx.moveTo(points[0].x, points[0].y);
	for (let index = 1; index < points.length; index++) {
		ctx.lineTo(points[index].x, points[index].y);
	}
	ctx.stroke();
}

/** 図形を1つ描く。 */
export function paradisDrawMarkupShape(ctx: IParadisMarkupCanvasContext, shape: ParadisMarkupShape): void {
	ctx.save();
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	ctx.strokeStyle = shape.color;
	ctx.fillStyle = shape.color;
	switch (shape.kind) {
		case 'pen':
			ctx.lineWidth = shape.width;
			strokePolyline(ctx, shape.points, shape.width);
			break;
		case 'highlight': {
			ctx.globalAlpha = PARADIS_MARKUP_HIGHLIGHT_ALPHA;
			const width = shape.width * PARADIS_MARKUP_HIGHLIGHT_MULTIPLIER;
			ctx.lineWidth = width;
			strokePolyline(ctx, shape.points, width);
			break;
		}
		case 'arrow': {
			ctx.lineWidth = shape.width;
			ctx.beginPath();
			ctx.moveTo(shape.from.x, shape.from.y);
			ctx.lineTo(shape.to.x, shape.to.y);
			ctx.stroke();
			const head = paradisArrowHead(shape.from, shape.to, shape.width);
			if (head) {
				ctx.beginPath();
				ctx.moveTo(head.left.x, head.left.y);
				ctx.lineTo(head.tip.x, head.tip.y);
				ctx.lineTo(head.right.x, head.right.y);
				ctx.stroke();
			}
			break;
		}
		case 'rect': {
			ctx.lineWidth = shape.width;
			const rect = paradisNormalizeMarkupRect(shape.from, shape.to);
			ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
			break;
		}
		case 'ellipse': {
			ctx.lineWidth = shape.width;
			const rect = paradisNormalizeMarkupRect(shape.from, shape.to);
			ctx.beginPath();
			ctx.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2);
			ctx.stroke();
			break;
		}
		case 'text':
			ctx.font = `600 ${shape.fontSize}px ${TEXT_FONT_FAMILY}`;
			ctx.textBaseline = 'top';
			// どんな背景の上でも読めるよう、反対色の縁取りを付ける
			ctx.lineWidth = Math.max(shape.fontSize / 6, 2);
			ctx.strokeStyle = shape.color.toLowerCase() === '#ffffff' ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.85)';
			ctx.strokeText(shape.text, shape.at.x, shape.at.y);
			ctx.fillText(shape.text, shape.at.x, shape.at.y);
			break;
	}
	ctx.restore();
}

export function paradisDrawMarkupShapes(ctx: IParadisMarkupCanvasContext, shapes: readonly ParadisMarkupShape[]): void {
	for (const shape of shapes) {
		paradisDrawMarkupShape(ctx, shape);
	}
}

/** ドラッグで作る図形が「描いた」と言える大きさか（押しただけの誤操作を捨てる）。 */
export function paradisIsMeaningfulMarkupShape(shape: ParadisMarkupShape): boolean {
	switch (shape.kind) {
		case 'pen':
		case 'highlight':
			return shape.points.length > 0;
		case 'arrow':
		case 'rect':
		case 'ellipse':
			return Math.abs(shape.to.x - shape.from.x) + Math.abs(shape.to.y - shape.from.y) >= 4;
		case 'text':
			return shape.text.trim().length > 0;
	}
}
