// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import { resolveThemeColors, type ThemeColors, type ThemeColorSettings } from './themeColors.js';

/**
 * 設定 → 色の、いまの値（画面が読む側）。保存と読み込み（Keychain）は
 * `src/features/settings/themeColorSettings.ts` が行い、ここへ書き込む。
 *
 * ここでは端末の保存領域（`platform.ts`）を import しない。旧部品（`src/components/`）からも
 * このフックを使うので、保存の実装を引くとそれらのテスト（Node で動く）が読み込みで落ちる。
 */
interface ThemeColorState {
	/** 利用者が変えた場所の色（無い場所は既定）。 */
	readonly settings: ThemeColorSettings;
	/** 画面が使う色（`settings` から作る。変わったときだけ作り直すので、そのまま比較できる）。 */
	readonly resolved: ThemeColors;
	/** 保存の読み込みを1度試し終えたか（読めなかった場合も true）。 */
	readonly settled: boolean;
}

export const useThemeColorStore = create<ThemeColorState>(() => ({
	settings: {},
	resolved: resolveThemeColors({}),
	settled: false,
}));

/** 設定を差し替える（画面にすぐ当たる）。保存はしない。 */
export function applyThemeColorSettings(settings: ThemeColorSettings): void {
	useThemeColorStore.setState({ settings, resolved: resolveThemeColors(settings) });
}

/**
 * 画面が使う色（場所ごとの色と、その上の文字の色）。StyleSheet に固定した色は、当てる場所だけ
 * style の配列で上書きする。
 *
 * ```tsx
 * const theme = useThemeColors();
 * <View style={[styles.fab, { backgroundColor: theme.primary }]}>
 *   <Icon icon={Plus} color={theme.onPrimary} />
 * </View>
 * ```
 */
export function useThemeColors(): ThemeColors {
	return useThemeColorStore(s => s.resolved);
}
