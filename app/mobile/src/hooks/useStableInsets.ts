// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { EdgeInsets, initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * `useSafeAreaInsets` の安定版。expo-routerのNativeTabsはタブごとに独立した
 * `SafeAreaProvider`（initialMetrics無し）でラップするため、非表示タブが
 * デタッチ/フリーズ中にオフスクリーン測定でinset=0を掴むと、タブ復帰後も
 * 再測定が来ず0のまま描画され、ノッチやタブバーへのUI被りになる。
 * 本アプリはportrait固定（app.json）でinsetは起動時から不変なので、
 * ネイティブ起動時の実測値（initialWindowMetrics）を下限として一過性の0を吸収する。
 */
export function useStableInsets(): EdgeInsets {
	const insets = useSafeAreaInsets();
	const initial = initialWindowMetrics?.insets;
	return {
		top: Math.max(insets.top, initial?.top ?? 0),
		bottom: Math.max(insets.bottom, initial?.bottom ?? 0),
		left: Math.max(insets.left, initial?.left ?? 0),
		right: Math.max(insets.right, initial?.right ?? 0),
	};
}
