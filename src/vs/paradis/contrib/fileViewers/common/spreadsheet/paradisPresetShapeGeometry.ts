/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// DrawingML の形（既定の形 prstGeom と自由形状 custGeom）を、式（guide）を計算して SVG の道筋にする。
// 式と組み込みの変数は ECMA-376 Part 1 §20.1.9（DrawingML の形）と §20.1.10.25（ST_GeomGuideName の式）に沿う。
// 角度は 1/60000 度で、y は下向き（時計回りが正）。

import { PARADIS_PRESET_SHAPES, type ParadisPresetCommand, type ParadisPresetGuide, type ParadisPresetShape } from './paradisPresetShapeData.js';

/** 原文に無い形を、ほかの形の向きを変えて描く（upArrow は原文の誤りで抜けている）。 */
export const PARADIS_PRESET_SHAPE_ALIASES: Readonly<Record<string, { readonly shape: string; readonly flipV?: boolean; readonly flipH?: boolean }>> = {
	upArrow: { shape: 'downArrow', flipV: true },
};

export interface ParadisGeometryBox {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface ParadisGeometryPoint {
	readonly x: number;
	readonly y: number;
}

export interface ParadisGeometryPath {
	readonly d: string;
	readonly fill: 'none' | 'norm' | 'lighten' | 'lightenLess' | 'darken' | 'darkenLess';
	readonly stroke: boolean;
	/** 最初の点と、そこから出ていく向きの点（線の端の矢印に使う）。 */
	readonly start?: readonly [ParadisGeometryPoint, ParadisGeometryPoint];
	/** 最後の点と、そこへ入ってくる向きの元の点。 */
	readonly end?: readonly [ParadisGeometryPoint, ParadisGeometryPoint];
}

export interface ParadisGeometryResult {
	readonly paths: readonly ParadisGeometryPath[];
	/** 文字を置く枠。形が持たなければ undefined（図形の枠いっぱい）。 */
	readonly textRect?: ParadisGeometryBox;
}

/** 計算の上限。壊れた・大きすぎる形で止まらないように。 */
export const PARADIS_GEOMETRY_LIMITS = Object.freeze({ guides: 1_000, commands: 10_000 });

const ANGLE_UNIT = Math.PI / 180 / 60000;

function builtInGuides(width: number, height: number): Map<string, number> {
	const ss = Math.min(width, height);
	const ls = Math.max(width, height);
	const values: [string, number][] = [
		['3cd4', 16200000], ['3cd8', 8100000], ['5cd8', 13500000], ['7cd8', 18900000],
		['cd2', 10800000], ['cd4', 5400000], ['cd8', 2700000],
		['l', 0], ['t', 0], ['r', width], ['b', height], ['w', width], ['h', height],
		['hc', width / 2], ['vc', height / 2], ['ls', ls], ['ss', ss],
	];
	for (const divisor of [2, 3, 4, 5, 6, 8, 10, 12, 32]) {
		values.push([`wd${divisor}`, width / divisor], [`hd${divisor}`, height / divisor]);
	}
	for (const divisor of [2, 4, 6, 8, 16, 32]) {
		values.push([`ssd${divisor}`, ss / divisor]);
	}
	return new Map(values);
}

function operand(guides: ReadonlyMap<string, number>, token: string): number {
	const value = guides.get(token);
	if (value !== undefined) {
		return value;
	}
	const number = Number(token);
	if (Number.isFinite(number) && /^-?\d+(?:\.\d+)?$/.test(token)) {
		return number;
	}
	throw new Error(`unknown guide ${token.slice(0, 32)}`);
}

/** 1 つの式を計算する（§20.1.10.25 の 17 種）。 */
export function evaluateParadisGuideFormula(formula: string, guides: ReadonlyMap<string, number>): number {
	const [op, ...tokens] = formula.trim().split(/\s+/);
	const [x, y, z] = tokens.map(token => operand(guides, token));
	switch (op) {
		case 'val': return x;
		case '*/': return z === 0 ? 0 : x * y / z;
		case '+-': return x + y - z;
		case '+/': return z === 0 ? 0 : (x + y) / z;
		case '?:': return x > 0 ? y : z;
		case 'abs': return Math.abs(x);
		case 'at2': return Math.atan2(y, x) / ANGLE_UNIT;
		case 'cat2': return x * Math.cos(Math.atan2(z, y));
		case 'cos': return x * Math.cos(y * ANGLE_UNIT);
		case 'max': return Math.max(x, y);
		case 'min': return Math.min(x, y);
		case 'mod': return Math.sqrt(x * x + y * y + z * z);
		case 'pin': return y < x ? x : y > z ? z : y;
		case 'sat2': return x * Math.sin(Math.atan2(z, y));
		case 'sin': return x * Math.sin(y * ANGLE_UNIT);
		case 'sqrt': return Math.sqrt(Math.max(0, x));
		case 'tan': return x * Math.tan(y * ANGLE_UNIT);
		default: throw new Error(`unknown formula ${String(op).slice(0, 8)}`);
	}
}

function evaluateGuides(shape: ParadisPresetShape, width: number, height: number, adjust: Readonly<Record<string, number>> | undefined): Map<string, number> {
	const guides = builtInGuides(width, height);
	const list: readonly ParadisPresetGuide[] = [...(shape.av ?? []), ...(shape.gd ?? [])];
	if (list.length > PARADIS_GEOMETRY_LIMITS.guides) {
		throw new Error('too many guides');
	}
	for (const [name, formula] of shape.av ?? []) {
		const given = adjust && Object.hasOwn(adjust, name) ? adjust[name] : undefined;
		guides.set(name, given !== undefined && Number.isFinite(given) ? given : evaluateParadisGuideFormula(formula, guides));
	}
	for (const [name, formula] of shape.gd ?? []) {
		const value = evaluateParadisGuideFormula(formula, guides);
		guides.set(name, Number.isFinite(value) ? value : 0);
	}
	return guides;
}

function round(value: number): string {
	return String(Math.round(value * 100) / 100);
}

/** 楕円の上で、中心から見た角度 angle の点（中心からの位置）。DrawingML の角度は見た目の角度。 */
function ellipsePoint(wR: number, hR: number, angle: number): ParadisGeometryPoint {
	const t = Math.atan2(wR * Math.sin(angle), hR * Math.cos(angle));
	return { x: wR * Math.cos(t), y: hR * Math.sin(t) };
}

function pathToSvg(path: ParadisPresetShape['paths'][number], guides: ReadonlyMap<string, number>, box: ParadisGeometryBox, budget: { commands: number }): ParadisGeometryPath {
	const scaleX = path.w ? box.width / path.w : 1;
	const scaleY = path.h ? box.height / path.h : 1;
	const px = (token: string) => box.x + operand(guides, token) * scaleX;
	const py = (token: string) => box.y + operand(guides, token) * scaleY;
	const parts: string[] = [];
	let current: ParadisGeometryPoint | undefined;
	let subpathStart: ParadisGeometryPoint | undefined;
	let first: ParadisGeometryPoint | undefined;
	let second: ParadisGeometryPoint | undefined;
	let previous: ParadisGeometryPoint | undefined;
	const visit = (point: ParadisGeometryPoint, toward?: ParadisGeometryPoint) => {
		if (!first) {
			first = point;
		} else if (!second) {
			second = toward ?? point;
		}
		previous = toward ?? current;
		current = point;
	};
	for (const command of path.c as readonly ParadisPresetCommand[]) {
		if (++budget.commands > PARADIS_GEOMETRY_LIMITS.commands) {
			throw new Error('too many commands');
		}
		switch (command[0]) {
			case 'M': {
				const point = { x: px(command[1]), y: py(command[2]) };
				parts.push(`M ${round(point.x)} ${round(point.y)}`);
				subpathStart = point;
				if (!first) {
					first = point;
				}
				previous = current;
				current = point;
				break;
			}
			case 'L': {
				const point = { x: px(command[1]), y: py(command[2]) };
				parts.push(`L ${round(point.x)} ${round(point.y)}`);
				visit(point);
				break;
			}
			case 'Q': {
				const control = { x: px(command[1]), y: py(command[2]) };
				const point = { x: px(command[3]), y: py(command[4]) };
				parts.push(`Q ${round(control.x)} ${round(control.y)} ${round(point.x)} ${round(point.y)}`);
				visit(point, control);
				break;
			}
			case 'C': {
				const control1 = { x: px(command[1]), y: py(command[2]) };
				const control2 = { x: px(command[3]), y: py(command[4]) };
				const point = { x: px(command[5]), y: py(command[6]) };
				parts.push(`C ${round(control1.x)} ${round(control1.y)} ${round(control2.x)} ${round(control2.y)} ${round(point.x)} ${round(point.y)}`);
				if (first && !second) {
					second = control1;
				}
				visit(point, control2);
				break;
			}
			case 'A': {
				// 今の点から、半径 wR・hR の楕円の角度 stAng の点として中心を逆算し、swAng だけ回る（§20.1.9.3）。
				const from = current ?? { x: box.x, y: box.y };
				const wR = Math.abs(operand(guides, command[1]) * scaleX);
				const hR = Math.abs(operand(guides, command[2]) * scaleY);
				const start = operand(guides, command[3]) * ANGLE_UNIT;
				const sweep = operand(guides, command[4]) * ANGLE_UNIT;
				if (wR === 0 || hR === 0 || sweep === 0) {
					break;
				}
				const startOffset = ellipsePoint(wR, hR, start);
				const center = { x: from.x - startOffset.x, y: from.y - startOffset.y };
				// 一周に近いと SVG の円弧は描けないので、半分ずつに分ける。
				const steps = Math.abs(sweep) > Math.PI ? 2 : 1;
				let point = from;
				for (let step = 1; step <= steps; step++) {
					const angle = start + sweep * step / steps;
					const offset = ellipsePoint(wR, hR, angle);
					point = { x: center.x + offset.x, y: center.y + offset.y };
					parts.push(`A ${round(wR)} ${round(hR)} 0 0 ${sweep > 0 ? 1 : 0} ${round(point.x)} ${round(point.y)}`);
				}
				// 円弧の向き（接線）は、始まりの少し先と、終わりの少し手前の点で近似する。
				if (first && !second) {
					const after = ellipsePoint(wR, hR, start + sweep * 0.02);
					second = { x: center.x + after.x, y: center.y + after.y };
				}
				const near = ellipsePoint(wR, hR, start + sweep * 0.98);
				visit(point, { x: center.x + near.x, y: center.y + near.y });
				break;
			}
			case 'Z':
				parts.push('Z');
				if (subpathStart) {
					previous = current;
					current = subpathStart;
				}
				break;
		}
	}
	return {
		d: parts.join(' '),
		fill: path.fill ?? 'norm',
		stroke: path.stroke !== false,
		...(first && second ? { start: [first, second] as const } : {}),
		...(current && previous ? { end: [current, previous] as const } : {}),
	};
}

/**
 * 形の定義を、枠と調整値で計算して SVG の道筋にする。名前の無い形・計算できない形は undefined。
 * `definition` を渡すと（自由形状）、それを使う。
 */
export function paradisShapeGeometry(nameOrDefinition: string | ParadisPresetShape, box: ParadisGeometryBox, adjust?: Readonly<Record<string, number>>): ParadisGeometryResult | undefined {
	let shape: ParadisPresetShape | undefined;
	let alias: (typeof PARADIS_PRESET_SHAPE_ALIASES)[string] | undefined;
	if (typeof nameOrDefinition === 'string') {
		alias = Object.hasOwn(PARADIS_PRESET_SHAPE_ALIASES, nameOrDefinition) ? PARADIS_PRESET_SHAPE_ALIASES[nameOrDefinition] : undefined;
		const name = alias?.shape ?? nameOrDefinition;
		shape = Object.hasOwn(PARADIS_PRESET_SHAPES, name) ? PARADIS_PRESET_SHAPES[name] : undefined;
	} else {
		shape = nameOrDefinition;
	}
	if (!shape || !(box.width >= 0) || !(box.height >= 0)) {
		return undefined;
	}
	try {
		const guides = evaluateGuides(shape, box.width, box.height, adjust);
		const budget = { commands: 0 };
		// 計算は枠の左上を原点にして行い、最後に反転（別名の形）を掛ける。
		const local = { x: 0, y: 0, width: box.width, height: box.height };
		let paths = shape.paths.map(path => pathToSvg(path, guides, local, budget));
		let textRect: ParadisGeometryBox | undefined;
		if (shape.rect) {
			const [l, t, r, b] = shape.rect.map(token => operand(guides, token));
			textRect = { x: Math.min(l, r), y: Math.min(t, b), width: Math.abs(r - l), height: Math.abs(b - t) };
		}
		const flipX = (value: number) => alias?.flipH ? box.width - value : value;
		const flipY = (value: number) => alias?.flipV ? box.height - value : value;
		const place = (point: ParadisGeometryPoint): ParadisGeometryPoint => ({ x: box.x + flipX(point.x), y: box.y + flipY(point.y) });
		paths = paths.map(path => ({
			...path,
			d: transformPathData(path.d, point => place(point), !!alias?.flipH !== !!alias?.flipV),
			...(path.start ? { start: [place(path.start[0]), place(path.start[1])] as const } : {}),
			...(path.end ? { end: [place(path.end[0]), place(path.end[1])] as const } : {}),
		}));
		if (textRect) {
			const corner = place({ x: alias?.flipH ? textRect.x + textRect.width : textRect.x, y: alias?.flipV ? textRect.y + textRect.height : textRect.y });
			textRect = { x: corner.x, y: corner.y, width: textRect.width, height: textRect.height };
		}
		return { paths, ...(textRect ? { textRect } : {}) };
	} catch {
		return undefined;
	}
}

/** 道筋の座標を写す。反転が 1 回なら円弧の回る向きも逆にする。 */
function transformPathData(d: string, map: (point: ParadisGeometryPoint) => ParadisGeometryPoint, mirrored: boolean): string {
	const tokens = d.split(' ');
	const out: string[] = [];
	for (let index = 0; index < tokens.length;) {
		const command = tokens[index++];
		out.push(command);
		const take = (count: number) => tokens.slice(index, index += count).map(Number);
		const point = (x: number, y: number) => {
			const mapped = map({ x, y });
			out.push(round(mapped.x), round(mapped.y));
		};
		switch (command) {
			case 'M': case 'L': { const [x, y] = take(2); point(x, y); break; }
			case 'Q': { const [x1, y1, x, y] = take(4); point(x1, y1); point(x, y); break; }
			case 'C': { const [x1, y1, x2, y2, x, y] = take(6); point(x1, y1); point(x2, y2); point(x, y); break; }
			case 'A': {
				const [rx, ry, rotation, large, sweep, x, y] = take(7);
				out.push(round(rx), round(ry), String(rotation), String(large), String(mirrored ? 1 - sweep : sweep));
				point(x, y);
				break;
			}
		}
	}
	return out.join(' ');
}

/** 既定の形の名前を知っているか（別名を含む）。 */
export function isParadisPresetShape(name: string): boolean {
	return Object.hasOwn(PARADIS_PRESET_SHAPES, name) || Object.hasOwn(PARADIS_PRESET_SHAPE_ALIASES, name);
}

/** 既定の形の数（別名を含む）。 */
export function paradisPresetShapeCount(): number {
	return Object.keys(PARADIS_PRESET_SHAPES).length + Object.keys(PARADIS_PRESET_SHAPE_ALIASES).length;
}

/**
 * 既定の形の調整値の既定値（`gd` の名前 → 値）。`val` で書かれたものだけを返す。知らない形は空。比較で、
 * 既定値を明示したときと省いたときを同じに扱うために使う。
 */
export function paradisPresetShapeAdjustDefaults(name: string): Readonly<Record<string, number>> {
	const target = Object.hasOwn(PARADIS_PRESET_SHAPE_ALIASES, name) ? PARADIS_PRESET_SHAPE_ALIASES[name].shape : name;
	const shape = Object.hasOwn(PARADIS_PRESET_SHAPES, target) ? PARADIS_PRESET_SHAPES[target] : undefined;
	const defaults: Record<string, number> = {};
	for (const [guide, formula] of shape?.av ?? []) {
		const value = /^val (?<value>-?\d+(?:\.\d+)?)$/.exec(formula)?.groups?.value;
		if (value !== undefined) {
			defaults[guide] = Number(value);
		}
	}
	return defaults;
}
