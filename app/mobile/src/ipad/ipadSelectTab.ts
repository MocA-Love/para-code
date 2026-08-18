// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useRouter } from 'expo-router';
import { hapticSelection } from '../haptics.js';
import type { SidebarTab } from './ipadTabs.js';

/**
 * サイドバーのタブ（展開時の `SidebarTabBar`、畳んだ時の `IpadSidebarRail` の両方）を
 * 押したときの遷移。両者から参照するため、どちらのファイルにも属さないここへ切り出している
 * （`ipadSidebar.tsx` から export する形だと、`ipadSidebarRail.tsx` ↔ `ipadSidebar.tsx` の
 * 循環importになるため）。
 *
 * タブそのもの以外（エージェント詳細・ブラウザ・アーカイブ等）を開いている間も、出発点の
 * タブを選択状態で見せている。そのため「選択中なら何もしない」で済ませると、`/agent` から
 * ホームへ戻れない押せないボタンになってしまう。
 *
 * また `router.navigate('/terminal')` をスタック画面から呼ぶと、React Navigationの
 * StackRouterは既存の `(tabs)` へ戻さず**もう1枚積む**（NAVIGATEは`pop`指定が無い限り
 * 既存routeを探しに行かない）。タブ群が二重にマウントされてしまうため、スタックを
 * 畳める状況では `dismissTo` を使って既存の `(tabs)` まで戻しつつタブを切り替える。
 */
export function selectTab(router: ReturnType<typeof useRouter>, tab: SidebarTab, active: SidebarTab['name'] | undefined): void {
	// スタックを畳めない＝タブ直下にいる。そこで既に選択中なら本当に何もすることが無い。
	const stacked = router.canDismiss();
	if (!stacked && active === tab.name) {
		return;
	}
	hapticSelection();
	if (stacked) {
		router.dismissTo(tab.href);
		return;
	}
	router.navigate(tab.href);
}
