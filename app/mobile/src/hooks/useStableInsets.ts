// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { EdgeInsets, initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * `useSafeAreaInsets` の安定版。expo-routerのNativeTabsはタブごとに独立した
 * `SafeAreaProvider`（initialMetrics無し）でラップするため、非表示タブが
 * デタッチ/フリーズ中にオフスクリーン測定でinset=0を掴むと、タブ復帰後も
 * 再測定が来ず0のまま描画され、ノッチやタブバーへのUI被りになる。
 * ネイティブ起動時の実測値（initialWindowMetrics）を下限として一過性の0を吸収する。
 *
 * この「下限」が成り立つのは、inset が向きで変わらない場合だけ。
 *  - iPhone: portrait固定（app.jsonの `UISupportedInterfaceOrientations`）なので不変
 *  - iPad: 回転できるようにしたが、左右にノッチが無く上下のinsetも向きで変わらないため
 *    実質不変（横向きでも上24pt / 下20pt のまま）
 * 例外はウィンドウが画面全体を占めない場合（Slide Over / Stage Manager）で、
 * 本来より大きな下限が残りうる。過剰な余白になるだけで欠けは起こさないため許容している。
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
