/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナル(xterm)をウィンドウ透過(paradis-transparent)対応させるためのヘルパー群。
// xtermTerminal.ts から最小限のPARA-PATCHで呼び出される（背景アルファ透明化・allowTransparency・WebGLパッチ）。
// 背景色のRGBは保持しalphaのみ0にする（xtermのminimumContrastRatioコントラスト計算とOSC 11背景色報告を壊さないため）。

import type { WebglAddon } from '@xterm/addon-webgl';
import { Color, RGBA } from '../../../../base/common/color.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { PARADIS_TRANSPARENT_CLASS } from '../common/paradisTransparency.js';

/**
 * ウィンドウ透過が実際に有効か（`.monaco-workbench` に `paradis-transparent` クラスが付与されているか）。
 * このクラスはネイティブウィンドウが `transparent: true` で生成された場合のみ付与されるため（`paradisWindowTransparency.contribution.ts`）、
 * これを唯一の真実として参照する。ターミナルはユーザー操作で生成されるためクラス付与(AfterRestored)より必ず後で、判定は安定する。
 */
export function isParadisTransparentActive(): boolean {
	// eslint-disable-next-line no-restricted-syntax -- ワークベンチルートに付与された既存クラスの有無を読むだけで、要素構築ではない
	return mainWindow.document.querySelector(`.monaco-workbench.${PARADIS_TRANSPARENT_CLASS}`) !== null;
}

/**
 * xtermテーマの `background` 文字列を返す。透過アクティブ時は元の背景色のRGBを保持したままalphaのみ0にする。
 * 背後の `.part.*`（panel/editor/sidebar 等）がCSSの `color-mix` で半透明背景を持つため、xterm背景は完全透明でよい。
 */
export function paradisXtermBackground(background: Color | undefined): string | undefined {
	if (!background) {
		return undefined;
	}
	if (!isParadisTransparentActive()) {
		return background.toString();
	}
	const rgba = background.rgba;
	return new Color(new RGBA(rgba.r, rgba.g, rgba.b, 0)).toString();
}

// ---------------------------------------------------------------------------------------------
// WebGLレンダラの背景矩形アルファ・パッチ（Superset webgl-vibrancy-patch.ts を移植、@xterm/addon-webgl 0.20.0-beta.287 で構造確認済み）
//
// `@xterm/addon-webgl` の `RectangleRenderer.prototype._updateRectangle` は、palette/RGB/default背景セルの矩形alphaを
// 常に `1`(不透明)でハードコードする。そのためテーマ背景を透明にしても、Claude Code / codex のTUIが
// truecolor(`\x1b[48;2;R;G;Bm`)で塗る暗色ブロックが不透明の黒帯として残る。prototypeを実行時にパッチしてalphaを尊重させる。
//
// - CM_P16/P256・default セルは、xtermテーマ色のrgbaに含まれるalpha(透過時は0)をそのまま尊重する
// - CM_RGB セルはSGRエンコードにalphaビットを持たないため、near-black閾値ヒューリスティックで判定する
//   （codexのOSC 11報告(0,0,0)由来の (30,30,30) 系ブロック対策。最暗チャンネル < 閾値なら透過扱い）
//   色付きハイライト(赤エラー・青選択等)は1チャンネル以上が閾値超えなので不透明のまま維持される
// - TextureAtlas は前景グリフを `color.opaque` で不透明化するため、背景alphaを0にしても文字は不透明のまま描画される
//
// パッチはidempotent(Symbolガード)。`isParadisTransparentActive()` が false の間は prototype に一切触れないため通常セッションは無影響。
// ---------------------------------------------------------------------------------------------

const PATCHED = Symbol.for('paradis.webgl.rectangleRenderer.alphaPatched');

const enum Attributes {
	CM_MASK = 0x3000000,
	CM_P16 = 0x1000000,
	CM_P256 = 0x2000000,
	CM_RGB = 0x3000000,
	PCOLOR_MASK = 0xff,
	RGB_MASK = 0xffffff,
}

const enum FgFlags {
	INVERSE = 0x4000000,
}

const INDICES_PER_RECTANGLE = 8;

/**
 * codexの `(30,30,30)` 系オーバーレイ塗りや他のratatui系TUIの暗いパネル塗りを拾うための閾値。
 * 明るい/色付きセル(赤エラー・青選択)は最低1チャンネルが約80以上なので、80は保守的なカットオフ。
 */
const NEAR_BLACK_THRESHOLD = 80;

let rgbTransparencyEnabled = false;

interface RectVertices {
	attributes: Float32Array;
}

interface RectangleRendererInternals {
	_terminal: { rows: number; cols: number };
	_themeService: {
		colors: {
			ansi: Array<{ rgba: number }>;
			background: { rgba: number };
			foreground: { rgba: number };
		};
	};
	_dimensions: { device: { cell: { width: number; height: number } } };
	_addRectangle(array: Float32Array, offset: number, x1: number, y1: number, w: number, h: number, r: number, g: number, b: number, a: number): void;
}

function expandFloat32Array(input: Float32Array, minLength: number): Float32Array {
	if (input.length >= minLength) {
		return input;
	}
	const next = new Float32Array(Math.max(input.length * 2, minLength));
	next.set(input);
	return next;
}

/**
 * beta.287 の `_updateRectangle(vertices, offset, fg, bg, startX, endX, y)` を、背景alphaを尊重する版に差し替える。
 * オリジナルは末尾で常に alpha=1 を渡すが、ここではセルの色モードに応じて計算した alpha を渡す。
 */
function paradisUpdateRectangle(this: RectangleRendererInternals, vertices: RectVertices, offset: number, fg: number, bg: number, startX: number, endX: number, y: number): void {
	let rgba: number;
	let alpha: number;

	if (fg & FgFlags.INVERSE) {
		switch (fg & Attributes.CM_MASK) {
			case Attributes.CM_P16:
			case Attributes.CM_P256:
				rgba = this._themeService.colors.ansi[fg & Attributes.PCOLOR_MASK].rgba;
				alpha = (rgba & 0xff) / 255;
				break;
			case Attributes.CM_RGB:
				rgba = (fg & Attributes.RGB_MASK) << 8;
				// 反転ハイライト(選択風)は反転文字の可読性のため不透明のまま維持する。
				alpha = 1;
				break;
			default:
				rgba = this._themeService.colors.foreground.rgba;
				alpha = (rgba & 0xff) / 255;
		}
	} else {
		switch (bg & Attributes.CM_MASK) {
			case Attributes.CM_P16:
			case Attributes.CM_P256:
				rgba = this._themeService.colors.ansi[bg & Attributes.PCOLOR_MASK].rgba;
				alpha = (rgba & 0xff) / 255;
				break;
			case Attributes.CM_RGB: {
				rgba = (bg & Attributes.RGB_MASK) << 8;
				if (rgbTransparencyEnabled) {
					const r = (rgba >> 24) & 0xff;
					const g = (rgba >> 16) & 0xff;
					const b = (rgba >> 8) & 0xff;
					alpha = Math.max(r, g, b) < NEAR_BLACK_THRESHOLD ? 0 : 1;
				} else {
					alpha = 1;
				}
				break;
			}
			default:
				rgba = this._themeService.colors.background.rgba;
				alpha = (rgba & 0xff) / 255;
		}
	}

	if (vertices.attributes.length < offset + INDICES_PER_RECTANGLE) {
		vertices.attributes = expandFloat32Array(vertices.attributes, (this._terminal.rows * this._terminal.cols + 1) * INDICES_PER_RECTANGLE);
	}

	const cellWidth = this._dimensions.device.cell.width;
	const cellHeight = this._dimensions.device.cell.height;
	const x1 = startX * cellWidth;
	const y1 = y * cellHeight;
	const r = ((rgba >> 24) & 0xff) / 255;
	const g = ((rgba >> 16) & 0xff) / 255;
	const b = ((rgba >> 8) & 0xff) / 255;

	this._addRectangle(vertices.attributes, offset, x1, y1, (endX - startX) * cellWidth, cellHeight, r, g, b, alpha);
}

/**
 * 与えられた `WebglAddon` の `RectangleRenderer.prototype._updateRectangle` を背景alpha尊重版へ差し替える。
 * 透過が有効なときのみ prototype に触れる（通常セッションは無影響）。idempotent で、複数ターミナルペインは単一のパッチ済みprototypeを共有する。
 */
export function installParadisWebglBackgroundAlphaPatch(addon: WebglAddon): void {
	const active = isParadisTransparentActive();
	rgbTransparencyEnabled = active;
	if (!active) {
		return;
	}
	try {
		const renderer = (addon as unknown as { _renderer?: { _rectangleRenderer?: { value?: unknown } } })._renderer;
		const instance = renderer?._rectangleRenderer?.value;
		if (!instance) {
			return;
		}
		const proto = Object.getPrototypeOf(instance) as Record<PropertyKey, unknown> & { [PATCHED]?: true };
		if (proto[PATCHED]) {
			return;
		}
		if (typeof proto._updateRectangle !== 'function') {
			return;
		}
		proto._updateRectangle = paradisUpdateRectangle;
		proto[PATCHED] = true;
	} catch {
		// private-API surgery のため、addon構造が変わっていたら黙ってスキップ（不透明ターミナルにフォールバック）。
	}
}
