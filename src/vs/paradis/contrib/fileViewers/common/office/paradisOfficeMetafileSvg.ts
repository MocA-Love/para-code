/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// EMF・WMF を描くときの描き先（paradisOfficeMetafile.ts から使う）。座標はすべて出力の座標（EMF の装置の
// 座標）で受け取り、SVG の文字列にする。文書から来た値（文字・書体名・色・座標）は、ここで決めた形にしか
// 書き出さない。文字は要素の中身としてだけ書き、`&` `<` `>` `"` `'` を実体参照に置き換える（DOM の
// textContent に入れたのと同じ結果になる）。書体名は文字・数字・空白・`-` `_` `.` だけを残す。
// 外部の参照（href・url(...) の外部・@font-face）は書かない。`url(#id)` はここで付けた id だけを指す。

/** 描き始める前に決める上限。超えたら描くのをやめ、その画像は代替表示にする。 */
export interface ParadisOfficeMetafileOutputLimits {
	/** 経路の点の数の合計。 */
	readonly points: number;
	/** 1 枚のビットマップの画素数。これより大きいビットマップを含む画像は描かない。 */
	readonly bitmapPixels: number;
	/** ビットマップを模様にしたときの矩形の数の合計。 */
	readonly patternRects: number;
	/** 文字の数の合計。 */
	readonly textCharacters: number;
	/** 出力の SVG の文字数。 */
	readonly outputCharacters: number;
}

/** 描くのをやめる理由。`detail` は記録の名前などの決まった語だけ（文書の中身は入れない）。 */
export class ParadisOfficeMetafileStop extends Error {
	constructor(readonly reason: 'unsupported' | 'malformed' | 'limitExceeded', readonly detail: string) {
		super(`${reason}:${detail}`);
	}
}

/** 0xRRGGBB。 */
export type ParadisMetafileColor = number;

export interface ParadisMetafilePen {
	readonly kind: 'null' | 'solid' | 'dash' | 'dot' | 'dashDot' | 'dashDotDot';
	/** 出力の座標での太さ。 */
	readonly width: number;
	readonly color: ParadisMetafileColor;
	readonly cap: 'round' | 'square' | 'butt';
	readonly join: 'round' | 'bevel' | 'miter';
	readonly miterLimit: number;
}

export interface ParadisMetafileClip {
	/** 出力の座標の経路。 */
	readonly d: string;
	readonly rule: 'nonzero' | 'evenodd';
}

export interface ParadisMetafileText {
	/** 文字の基準線の始まり（出力の座標）。 */
	readonly x: number;
	readonly y: number;
	/** 文字ごとの x（出力の座標）。無ければ書体の送り幅に任せる。 */
	readonly positions?: readonly number[];
	readonly text: string;
	readonly fontFamily: string;
	readonly generic: 'serif' | 'sans-serif' | 'monospace';
	/** 出力の座標での文字の大きさ（em）。 */
	readonly size: number;
	readonly weight: number;
	readonly italic: boolean;
	readonly underline: boolean;
	readonly strikeOut: boolean;
	readonly color: ParadisMetafileColor;
	/** 時計回りの回転（度）。 */
	readonly rotation: number;
	readonly anchor: 'start' | 'middle' | 'end';
}

/** ビットマップ（上の行から順の 0xRRGGBB）。 */
export interface ParadisMetafileBitmap {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint32Array;
}

/** 出力の座標へ写すアフィン変換（a b c d e f は SVG の matrix と同じ並び）。 */
export interface ParadisMetafileMatrix {
	readonly a: number;
	readonly b: number;
	readonly c: number;
	readonly d: number;
	readonly e: number;
	readonly f: number;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** 小数 2 桁の数。有限でなければ止める。 */
export function formatMetafileNumber(value: number): string {
	if (!Number.isFinite(value)) {
		throw new ParadisOfficeMetafileStop('malformed', 'coordinate');
	}
	const rounded = Math.round(value * 100) / 100;
	return Object.is(rounded, -0) ? '0' : String(rounded);
}

function color(value: ParadisMetafileColor): string {
	return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** 要素の中身・属性の値に書く文字。DOM の textContent と同じく、文字としてだけ扱われる形にする。 */
export function escapeMetafileText(value: string): string {
	let out = '';
	for (const character of value) {
		const code = character.codePointAt(0)!;
		// XML に書けない制御文字と、対になっていないサロゲートは書かない。
		if (code < 0x20 && code !== 0x09 || code === 0xfffe || code === 0xffff || code >= 0xd800 && code <= 0xdfff) {
			continue;
		}
		switch (character) {
			case '&': out += '&amp;'; break;
			case '<': out += '&lt;'; break;
			case '>': out += '&gt;'; break;
			case '"': out += '&quot;'; break;
			case '\'': out += '&#39;'; break;
			default: out += character;
		}
	}
	return out;
}

/** 書体名から、属性に書いてよい文字だけを残す。 */
export function safeMetafileFontFamily(value: string): string {
	return value.replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 64);
}

/** 経路を出力の座標で組み立てる。点の数は描き先の上限に数える。 */
export class ParadisMetafilePathBuilder {
	private parts: string[] = [];
	private points = 0;
	private open = false;

	constructor(private readonly canvas: ParadisMetafileSvgCanvas) { }

	get empty(): boolean {
		return this.parts.length === 0;
	}

	moveTo(x: number, y: number): void {
		this.count(1);
		this.parts.push(`M${formatMetafileNumber(x)} ${formatMetafileNumber(y)}`);
		this.open = true;
	}

	lineTo(x: number, y: number): void {
		this.count(1);
		this.parts.push(`L${formatMetafileNumber(x)} ${formatMetafileNumber(y)}`);
	}

	bezierTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
		this.count(3);
		this.parts.push(`C${formatMetafileNumber(x1)} ${formatMetafileNumber(y1)} ${formatMetafileNumber(x2)} ${formatMetafileNumber(y2)} ${formatMetafileNumber(x)} ${formatMetafileNumber(y)}`);
	}

	close(): void {
		if (this.open) {
			this.parts.push('Z');
		}
	}

	get pointCount(): number {
		return this.points;
	}

	toString(): string {
		return this.parts.join('');
	}

	private count(points: number): void {
		this.points += points;
		this.canvas.countPoints(points);
	}
}

interface PendingFill {
	readonly key: string;
	readonly parts: string[];
	readonly fill: string;
	readonly rule: 'nonzero' | 'evenodd';
}

/**
 * SVG の描き先。描く順に要素を並べ、同じ切り抜き・同じ塗りの続く塗りは 1 つの path にまとめる（文字を輪郭で
 * 描いた画像では、要素の数がこれで大きく減る）。
 */
export class ParadisMetafileSvgCanvas {
	private readonly body: string[] = [];
	private readonly definitions: string[] = [];
	private readonly clipIds = new Map<string, string>();
	private readonly patternIds = new Map<string, string>();
	private currentClipKey = '';
	private groupOpen = false;
	private pending: PendingFill | undefined;
	private characters = 0;
	private points = 0;
	private patternRects = 0;
	private textCharacters = 0;
	private nextId = 0;

	constructor(private readonly limits: ParadisOfficeMetafileOutputLimits) { }

	countPoints(points: number): void {
		this.points += points;
		if (this.points > this.limits.points) {
			throw new ParadisOfficeMetafileStop('limitExceeded', 'points');
		}
	}

	/** これから描く要素の切り抜き（外側から順に、すべての交わり）。 */
	setClip(chain: readonly ParadisMetafileClip[]): void {
		let key = '';
		let id = '';
		for (const clip of chain) {
			key += `|${clip.rule}:${clip.d}`;
			let existing = this.clipIds.get(key);
			if (!existing) {
				existing = `c${this.nextId++}`;
				this.clipIds.set(key, existing);
				this.define(`<clipPath id="${existing}" clipPathUnits="userSpaceOnUse"${id ? ` clip-path="url(#${id})"` : ''}><path d="${clip.d}" clip-rule="${clip.rule}"/></clipPath>`);
			}
			id = existing;
		}
		if (key === this.currentClipKey) {
			return;
		}
		this.flush();
		if (this.groupOpen) {
			this.emit('</g>');
			this.groupOpen = false;
		}
		this.currentClipKey = key;
		if (id) {
			this.emit(`<g clip-path="url(#${id})">`);
			this.groupOpen = true;
		}
	}

	fill(d: string, fill: ParadisMetafileColor, rule: 'nonzero' | 'evenodd'): void {
		if (!d) {
			return;
		}
		const fillText = color(fill);
		const key = `${this.currentClipKey}\u0000${fillText}\u0000${rule}`;
		if (this.pending && this.pending.key === key) {
			this.pending.parts.push(d);
			this.countCharacters(d.length);
			return;
		}
		this.flush();
		this.pending = { key, parts: [d], fill: fillText, rule };
		this.countCharacters(d.length + 48);
	}

	stroke(d: string, pen: ParadisMetafilePen): void {
		if (!d || pen.kind === 'null') {
			return;
		}
		this.flush();
		const width = Math.max(pen.width, 0);
		const dash = dashArray(pen.kind, Math.max(width, 1));
		this.emit(`<path d="${d}" fill="none" stroke="${color(pen.color)}" stroke-width="${formatMetafileNumber(width)}" stroke-linecap="${pen.cap}" stroke-linejoin="${pen.join}"${pen.join === 'miter' ? ` stroke-miterlimit="${formatMetafileNumber(Math.max(1, pen.miterLimit))}"` : ''}${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
	}

	text(value: ParadisMetafileText): void {
		if (!value.text) {
			return;
		}
		this.textCharacters += value.text.length;
		if (this.textCharacters > this.limits.textCharacters) {
			throw new ParadisOfficeMetafileStop('limitExceeded', 'text');
		}
		this.flush();
		const family = safeMetafileFontFamily(value.fontFamily);
		const families = family ? `${family}, ${value.generic}` : value.generic;
		const x = value.positions && value.positions.length > 0 ? value.positions.map(formatMetafileNumber).join(' ') : formatMetafileNumber(value.x);
		const decorations = [value.underline ? 'underline' : '', value.strikeOut ? 'line-through' : ''].filter(Boolean).join(' ');
		const rotate = value.rotation ? ` transform="rotate(${formatMetafileNumber(value.rotation)} ${formatMetafileNumber(value.x)} ${formatMetafileNumber(value.y)})"` : '';
		this.emit(`<text x="${x}" y="${formatMetafileNumber(value.y)}" font-family="${escapeMetafileText(families)}" font-size="${formatMetafileNumber(value.size)}" font-weight="${Math.min(900, Math.max(100, Math.round(value.weight / 100) * 100 || 400))}"${value.italic ? ' font-style="italic"' : ''}${decorations ? ` text-decoration="${decorations}"` : ''}${value.anchor !== 'start' ? ` text-anchor="${value.anchor}"` : ''} fill="${color(value.color)}" xml:space="preserve"${rotate}>${escapeMetafileText(value.text)}</text>`);
	}

	/**
	 * ビットマップを描く。ビットマップは模様（同じ色の続く画素を 1 つの矩形にしたもの）にして 1 度だけ定義し、
	 * `source` の範囲を `matrix` で出力の座標へ写して塗る。画像の中の画像（data URL）は使わない。
	 */
	bitmap(value: ParadisMetafileBitmap, source: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, matrix: ParadisMetafileMatrix): void {
		if (value.width * value.height > this.limits.bitmapPixels) {
			throw new ParadisOfficeMetafileStop('limitExceeded', 'bitmapPixels');
		}
		this.flush();
		const id = this.pattern(value);
		this.emit(`<rect x="${formatMetafileNumber(source.x)}" y="${formatMetafileNumber(source.y)}" width="${formatMetafileNumber(source.width)}" height="${formatMetafileNumber(source.height)}" fill="url(#${id})" transform="matrix(${[matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].map(formatMetafileNumber).join(' ')})"/>`);
	}

	/** 描き終えた SVG。`viewBox` は出力の座標、`width`・`height` は CSS の px。 */
	finish(viewBox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, width: number, height: number): string {
		this.flush();
		if (this.groupOpen) {
			this.emit('</g>');
			this.groupOpen = false;
		}
		const head = `<svg xmlns="${SVG_NAMESPACE}" width="${formatMetafileNumber(width)}" height="${formatMetafileNumber(height)}" viewBox="${[viewBox.x, viewBox.y, viewBox.width, viewBox.height].map(formatMetafileNumber).join(' ')}" preserveAspectRatio="none">`;
		return `${head}${this.definitions.length ? `<defs>${this.definitions.join('')}</defs>` : ''}${this.body.join('')}</svg>`;
	}

	private pattern(value: ParadisMetafileBitmap): string {
		const key = `${value.width}x${value.height}:${Array.from(value.pixels, pixel => pixel.toString(36)).join(',')}`;
		const existing = this.patternIds.get(key);
		if (existing) {
			return existing;
		}
		const id = `p${this.nextId++}`;
		this.patternIds.set(key, id);
		const rects: string[] = [];
		for (let y = 0; y < value.height; y++) {
			let x = 0;
			while (x < value.width) {
				const pixel = value.pixels[y * value.width + x];
				let end = x + 1;
				while (end < value.width && value.pixels[y * value.width + end] === pixel) {
					end++;
				}
				rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${color(pixel)}"/>`);
				x = end;
			}
		}
		this.patternRects += rects.length;
		if (this.patternRects > this.limits.patternRects) {
			throw new ParadisOfficeMetafileStop('limitExceeded', 'patternRects');
		}
		this.define(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${value.width}" height="${value.height}"><g shape-rendering="crispEdges">${rects.join('')}</g></pattern>`);
		return id;
	}

	private flush(): void {
		const pending = this.pending;
		if (!pending) {
			return;
		}
		this.pending = undefined;
		this.body.push(`<path d="${pending.parts.join('')}" fill="${pending.fill}"${pending.rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}/>`);
	}

	private define(value: string): void {
		this.countCharacters(value.length);
		this.definitions.push(value);
	}

	private emit(value: string): void {
		this.countCharacters(value.length);
		this.body.push(value);
	}

	private countCharacters(length: number): void {
		this.characters += length;
		if (this.characters > this.limits.outputCharacters) {
			throw new ParadisOfficeMetafileStop('limitExceeded', 'output');
		}
	}
}

function dashArray(kind: ParadisMetafilePen['kind'], width: number): string | undefined {
	const unit = (values: readonly number[]) => values.map(value => formatMetafileNumber(value * width)).join(' ');
	switch (kind) {
		case 'dash': return unit([3, 1]);
		case 'dot': return unit([1, 1]);
		case 'dashDot': return unit([3, 1, 1, 1]);
		case 'dashDotDot': return unit([3, 1, 1, 1, 1, 1]);
		default: return undefined;
	}
}
