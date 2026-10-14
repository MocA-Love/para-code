/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ウィンドウ透過とすりガラス（workbench.modernUIFrostedGlass）を両立させるための色の計算（q.html Q330 D）。
//
// すりガラスの層は「面の色を透け具合 a で半透明にしたもの」を、ぼかした背後の上に重ねる。背後がエディタの
// 地の色 E のとき、画面上の色は a×T + (1−a)×E になる。これを透過が無かったころ（paracode-165）の面の色 X に
// 揃えるため、層の色 T を T = (X − (1−a)×E) ÷ a で求める。ぼかしの強さは upstream のまま変わらない。

import { Color } from '../../../../base/common/color.js';
import { ColorIdentifier } from '../../../../platform/theme/common/colorUtils.js';
import { editorBackground, editorHoverBackground, editorWidgetBackground } from '../../../../platform/theme/common/colors/editorColors.js';
import { menuBackground } from '../../../../platform/theme/common/colors/menuColors.js';
import { quickInputBackground } from '../../../../platform/theme/common/colors/quickpickColors.js';
import { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { NOTIFICATIONS_BACKGROUND } from '../../../../workbench/common/theme.js';

/** 不透明な色（0〜255 の整数）。 */
export interface IParadisGlassRgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

/**
 * すりガラスの透け具合の範囲（`workbench.modernUIFrostedGlassOpacity` と同じ、%）。upstream の値は
 * layoutService.ts の `ModernUIFrostedGlassOpacity`（const enum）にあるが、browser 層なので common からは import できず写している。
 */
export const PARADIS_GLASS_OPACITY_MIN = 50;
export const PARADIS_GLASS_OPACITY_MAX = 100;
export const PARADIS_GLASS_OPACITY_DEFAULT = 80;

/** 透け具合の設定値（%）を範囲に収める。数値でなければ既定値。 */
export function clampParadisGlassOpacity(raw: number | undefined): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) {
		return PARADIS_GLASS_OPACITY_DEFAULT;
	}
	return Math.min(PARADIS_GLASS_OPACITY_MAX, Math.max(PARADIS_GLASS_OPACITY_MIN, raw));
}

/**
 * 背後が `backdrop` のときに、透け具合 `opacityPercent`（%）の層を重ねた結果が `surface` になる層の色を返す。
 * 0〜255 に収まらない成分は切り詰める（その成分だけ完全には揃わない）。
 */
export function computeParadisGlassTint(surface: IParadisGlassRgb, backdrop: IParadisGlassRgb, opacityPercent: number): IParadisGlassRgb {
	const a = clampParadisGlassOpacity(opacityPercent) / 100;
	const channel = (x: number, e: number) => Math.min(255, Math.max(0, Math.round((x - (1 - a) * e) / a)));
	return {
		r: channel(surface.r, backdrop.r),
		g: channel(surface.g, backdrop.g),
		b: channel(surface.b, backdrop.b),
	};
}

/** 層の色を CSS の値（透け具合を不透明度に持つ `rgb(... / a%)`）にする。 */
export function formatParadisGlassTint(tint: IParadisGlassRgb, opacityPercent: number): string {
	return `rgb(${tint.r} ${tint.g} ${tint.b} / ${clampParadisGlassOpacity(opacityPercent)}%)`;
}

/**
 * すりガラスの層ごとの [補正した色を入れる変数, 面の色, 背後の明るさ]。CSS（paradisWindowTransparency.css）が
 * upstream の層の色をこの変数で置き換える。背後は通常エディタの地の色で、ダイアログだけは画面全体を黒の 50% で
 * 暗くした上に出る（dialog.css の `.monaco-dialog-modal-block.dimmed`）ので、その明るさで計算する。
 */
export const PARADIS_GLASS_SURFACES: readonly [cssProperty: string, surface: ColorIdentifier, backdropScale: number][] = [
	['--paradis-glass-notifications-background', NOTIFICATIONS_BACKGROUND, 1],
	['--paradis-glass-quick-input-background', quickInputBackground, 1],
	['--paradis-glass-menu-background', menuBackground, 1],
	['--paradis-glass-hover-background', editorHoverBackground, 1],
	['--paradis-glass-dialog-background', editorWidgetBackground, 0.5],
];

/**
 * テーマの色から、すりガラスの層ごとの補正した色（CSS の値）を求める。面の色やエディタの地の色に透明度があるときは、
 * 透過が無かったころの下支えと同じくエディタの地の色の上で不透明にしてから計算する。色が取れない層は返さない
 * （CSS は upstream の層の色に戻る）。
 */
export function computeParadisGlassTintValues(theme: IColorTheme, opacityPercent: number): [string, string][] {
	const editor = theme.getColor(editorBackground);
	if (!editor) {
		return [];
	}
	const backdrop = toRgb(editor.makeOpaque(Color.black));
	const values: [string, string][] = [];
	for (const [property, id, backdropScale] of PARADIS_GLASS_SURFACES) {
		const surface = theme.getColor(id);
		if (!surface) {
			continue;
		}
		const scaled = { r: backdrop.r * backdropScale, g: backdrop.g * backdropScale, b: backdrop.b * backdropScale };
		const tint = computeParadisGlassTint(toRgb(surface.makeOpaque(editor.makeOpaque(Color.black))), scaled, opacityPercent);
		values.push([property, formatParadisGlassTint(tint, opacityPercent)]);
	}
	return values;
}

function toRgb(color: Color): IParadisGlassRgb {
	return { r: color.rgba.r, g: color.rgba.g, b: color.rgba.b };
}
