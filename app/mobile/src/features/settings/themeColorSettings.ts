// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { secureKeyStore } from '../../platform.js';
import {
	parseThemeColorSettings,
	serializeThemeColorSettings,
	withThemeColor,
	type ThemeColorSettings,
	type ThemeColorSlot,
} from '../../ui/themeColors.js';
import { applyThemeColorSettings, useThemeColorStore } from '../../ui/themeColorsStore.js';

/**
 * 設定 → 色の保存と読み込み（Keychain。ほかの端末ローカルの設定と同じ `secureKeyStore`）。
 * この端末の中だけの設定で、PC へは送らない。いまの値は `src/ui/themeColorsStore.ts`、
 * 形の判定は `src/ui/themeColors.ts`、画面は `app/settings/colors.tsx`。
 */
const THEME_COLORS_KEY = 'theme-colors';

let loading: Promise<void> | undefined;
/** 読み込みの前に変えられたか（変えた値を、あとから届いた保存値で上書きしない）。 */
let editedBeforeLoad = false;
/** 保存を順に行う（続けて色を選んだとき、古い値の書き込みが後から終わって勝たないように）。 */
let writeChain: Promise<void> = Promise.resolve();

function persist(settings: ThemeColorSettings): Promise<void> {
	const empty = Object.keys(settings).length === 0;
	const run = writeChain.then(() => (empty
		? secureKeyStore.deleteItem(THEME_COLORS_KEY)
		: secureKeyStore.setItem(THEME_COLORS_KEY, serializeThemeColorSettings(settings))));
	writeChain = run.catch(() => undefined);
	return run;
}

function update(settings: ThemeColorSettings): Promise<void> {
	if (!useThemeColorStore.getState().settled) {
		editedBeforeLoad = true;
	}
	applyThemeColorSettings(settings);
	return persist(settings);
}

/**
 * 保存された色を読み込む。何度呼んでもよい（1回だけ読む。読めなかったときは次に呼ばれたときに読み直す）。
 * **起動時にルートレイアウトから呼ぶ**（最初の画面を描くときから選んだ色を当てるため）。
 */
export function loadThemeColors(): Promise<void> {
	loading ??= secureKeyStore.getItem(THEME_COLORS_KEY).then(raw => {
		if (!editedBeforeLoad) {
			applyThemeColorSettings(parseThemeColorSettings(raw) ?? {});
		}
		useThemeColorStore.setState({ settled: true });
	}).catch((error: unknown) => {
		// Keychain がロック中などで読めないときは既定の色で動かす。
		console.warn('[theme-colors] failed to load', error);
		loading = undefined;
		useThemeColorStore.setState({ settled: true });
	});
	return loading;
}

/** 場所の色を変える（undefined で既定に戻す）。画面にはすぐ当たり、保存に失敗したら reject。 */
export function setThemeColor(slot: ThemeColorSlot, hex: string | undefined): Promise<void> {
	const current = useThemeColorStore.getState().settings;
	const next = withThemeColor(current, slot, hex);
	return next === current ? Promise.resolve() : update(next);
}

/** すべて既定に戻す。保存に失敗したら reject。 */
export function resetThemeColors(): Promise<void> {
	return update({});
}
