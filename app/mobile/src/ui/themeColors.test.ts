// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { colors } from '../theme.js';
import {
	colorName,
	colorWarnings,
	contrastRatio,
	isDefaultThemeColor,
	parseHexInput,
	parseThemeColorSettings,
	pressedColorOf,
	resolveThemeColors,
	serializeThemeColorSettings,
	textColorOn,
	withThemeColor,
} from './themeColors.js';

describe('contrastRatio', () => {
	test('黒と白は 21、同じ色は 1', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
		expect(contrastRatio('#3b82f6', '#3b82f6')).toBeCloseTo(1, 5);
	});

	test('順番に依らない（モックの表の値と同じ）', () => {
		expect(contrastRatio('#f5f5f5', colors.bg)).toBeCloseTo(contrastRatio(colors.bg, '#f5f5f5'), 10);
		expect(contrastRatio('#f5f5f5', colors.bg).toFixed(1)).toBe('17.3');
		expect(contrastRatio('#e0e0e0', colors.bg).toFixed(1)).toBe('14.3');
		expect(contrastRatio('#3b82f6', colors.bg).toFixed(1)).toBe('5.1');
	});
});

describe('textColorOn', () => {
	test('明るい色の上は黒（画面の地の色）、暗い色の上は白', () => {
		expect(textColorOn('#f5f5f5')).toBe(colors.bg);
		expect(textColorOn('#7dd3fc')).toBe(colors.bg);
		expect(textColorOn('#3f3f46')).toBe(colors.onDarkFill);
		expect(textColorOn('#6366f1')).toBe(colors.onDarkFill);
	});

	test('コントラストの高い方を選ぶ（青は黒の方が読みやすい）', () => {
		expect(textColorOn('#3b82f6')).toBe(colors.bg);
		expect(contrastRatio('#3b82f6', colors.bg)).toBeGreaterThan(contrastRatio('#3b82f6', colors.onDarkFill));
	});
});

describe('colorWarnings', () => {
	test('状態の色に近いと、どの状態かを添えて注意する', () => {
		expect(colorWarnings('#ef4444')).toEqual(['要対応の赤に近く、状態の色と見分けにくい']);
		expect(colorWarnings('#f0c020')).toEqual(['実行中の黄に近く、状態の色と見分けにくい']);
		expect(colorWarnings('#14b8a6')).toEqual(['未確認の緑に近く、状態の色と見分けにくい']);
	});

	test('画面の地と見分けにくい色は注意する', () => {
		expect(colorWarnings('#1a1a1a')).toEqual(['画面の地とほとんど同じで、見えにくい']);
	});

	test('既定の色と、離れた色は注意しない', () => {
		expect(colorWarnings('#f5f5f5')).toEqual([]);
		expect(colorWarnings('#e0e0e0')).toEqual([]);
		expect(colorWarnings('#3b82f6')).toEqual([]);
		expect(colorWarnings('#a78bfa')).toEqual([]);
	});
});

describe('parseHexInput', () => {
	test('# の有無・大文字小文字・前後の空白を吸収して小文字の #rrggbb にする', () => {
		expect(parseHexInput('#3B82F6')).toBe('#3b82f6');
		expect(parseHexInput(' 3b82f6 ')).toBe('#3b82f6');
	});

	test('6 桁の hex でなければ undefined', () => {
		expect(parseHexInput('#3b82f')).toBeUndefined();
		expect(parseHexInput('#fff')).toBeUndefined();
		expect(parseHexInput('#gggggg')).toBeUndefined();
		expect(parseHexInput('')).toBeUndefined();
	});
});

describe('withThemeColor', () => {
	test('色を変える・既定と同じ色や undefined なら保存から消す', () => {
		const changed = withThemeColor({}, 'accent', '#A78BFA');
		expect(changed).toEqual({ accent: '#a78bfa' });
		expect(withThemeColor(changed, 'accent', colors.accent)).toEqual({});
		expect(withThemeColor(changed, 'accent', undefined)).toEqual({});
		expect(isDefaultThemeColor(changed, 'accent')).toBe(false);
		expect(isDefaultThemeColor(changed, 'primary')).toBe(true);
	});

	test('色でない値は無視する（元の設定を返す）', () => {
		const settings = { bubble: '#14b8a6' };
		expect(withThemeColor(settings, 'bubble', 'blue')).toBe(settings);
	});
});

describe('resolveThemeColors', () => {
	test('既定は今の見た目と同じ theme の値', () => {
		expect(resolveThemeColors({})).toEqual({
			primary: colors.primary,
			onPrimary: colors.onPrimary,
			primaryPressed: colors.text,
			bubble: colors.text,
			onBubble: colors.bg,
			accent: colors.accent,
			onAccent: colors.bg,
			accentWash: colors.accentWash,
		});
	});

	test('変えた場所だけ色が替わり、上の文字と薄めた地も選んだ色から作る', () => {
		const resolved = resolveThemeColors({ primary: '#3f3f46', accent: '#a78bfa' });
		expect(resolved.primary).toBe('#3f3f46');
		expect(resolved.onPrimary).toBe(colors.onDarkFill);
		expect(resolved.bubble).toBe(colors.text);
		expect(resolved.accent).toBe('#a78bfa');
		expect(resolved.accentWash).toBe('#a78bfa1f');
	});

	test('押している間は、暗い色なら明るく・明るい色なら暗くなる', () => {
		expect(pressedColorOf('#f5f5f5')).toBe('#e0e0e0');
		expect(contrastRatio(pressedColorOf('#3f3f46'), '#ffffff')).toBeLessThan(contrastRatio('#3f3f46', '#ffffff'));
	});
});

describe('colorName', () => {
	test('候補の名前、本文色、それ以外は大文字の hex', () => {
		expect(colorName('#09AFD9')).toBe('水色');
		expect(colorName('#e0e0e0')).toBe('白（本文色）');
		expect(colorName('#123abc')).toBe('#123ABC');
	});
});

describe('parseThemeColorSettings / serializeThemeColorSettings', () => {
	test('保存したものを読み戻せる', () => {
		const settings = { primary: '#09afd9', bubble: '#14b8a6' };
		expect(parseThemeColorSettings(serializeThemeColorSettings(settings))).toEqual(settings);
	});

	test('保存が無い・壊れている・形が違うときは undefined', () => {
		expect(parseThemeColorSettings(null)).toBeUndefined();
		expect(parseThemeColorSettings('{')).toBeUndefined();
		expect(parseThemeColorSettings('[]')).toBeUndefined();
		expect(parseThemeColorSettings('"#ffffff"')).toBeUndefined();
	});

	test('知らない場所・色でない値・既定と同じ色は落とす', () => {
		const raw = JSON.stringify({ primary: '#ZZZZZZ', bubble: 12, accent: '#3B82F6', selected: '#ffffff', send: '#14b8a6' });
		expect(parseThemeColorSettings(raw)).toEqual({});
		expect(parseThemeColorSettings(JSON.stringify({ bubble: '#14B8A6' }))).toEqual({ bubble: '#14b8a6' });
	});
});
