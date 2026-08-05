// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, type ViewStyle } from 'react-native';
import { useIsRegularWidth } from '../hooks/useSizeClass.js';
import { CONTENT_MAX_WIDTH } from './ipadLayout.js';

const styles = StyleSheet.create({
	// `width: '100%'` が無いと、maxWidthだけでは中身の実幅まで縮んでしまう。
	column: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
});

/**
 * iPadの広い幅で本文を「読みやすい列幅」に収めて中央へ寄せるスタイル。
 * 幅が狭いとき（iPhone、Split Viewの細い幅）は `undefined` を返すので、
 * スタイル配列に混ぜてもiPhoneの見た目は一切変わらない。
 *
 * 使い方: ScrollViewの `contentContainerStyle` に足す。
 *
 * ```tsx
 * const column = useContentColumnStyle();
 * <ScrollView contentContainerStyle={[styles.content, column]}>
 * ```
 *
 * **注意**: `marginHorizontal` を持つスタイルと重ねてはいけない。`width: '100%'` と
 * 併用すると親より左右marginぶん widerになってはみ出す。その場合は margin を
 * padding に付け替えてから重ねること（`app/agent.tsx` の承認バーが実例）。
 *
 * ターミナルやdiffなど「広いほど読みやすい」ものには使わない。
 */
export function useContentColumnStyle(): ViewStyle | undefined {
	return useIsRegularWidth() ? styles.column : undefined;
}
