// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../appState.js';
import { isAgentWaiting } from '../store.js';
import { GlassSurface } from '../components/glassSurface.js';
import { WsDrawerContent } from '../components/wsDrawer.js';
import { colors, radius, squircle } from '../theme.js';
import { hapticSelection } from '../haptics.js';
import { activeSidebarTab, SIDEBAR_TABS, type SidebarTab } from './ipadTabs.js';

/**
 * iPadの常設サイドバー。中身はiPhone版のワークスペースドロワーそのもの
 * （`WsDrawerContent`）で、最下部にだけiPhone版の下部タブに相当する
 * Liquid Glassのセグメントを足す。
 *
 * エージェント個別の会話とAgent tree & Tasksをここに置かないのは、iPhone版と
 * 動線を揃えるため。会話はホーム一覧の行から、Agent tree & Tasksは会話画面の
 * 「実行中」ストリップから開く。
 */
export function IpadSidebar() {
	return <WsDrawerContent onClose={noop} navigation={<SidebarTabBar />} />;
}

function noop(): void {
	// 常設サイドバーは閉じない（配下のドロワー用APIを満たすためのプレースホルダー）。
}

/** サイドバー最下部のタブセグメント（iPhone版の下部タブと同じ4つ）。 */
function SidebarTabBar() {
	const router = useRouter();
	const pathname = usePathname();
	const active = activeSidebarTab(pathname);
	// 応答待ち件数のバッジ。iPhone版のNativeTabsと同じく件数（数値）だけを購読して、
	// PCからのstate再送のたびにサイドバーごと再構築されるのを避ける。
	const pending = useAppStore(s => (s.workspace?.terminals ?? []).filter(t => isAgentWaiting(t.agentStatus)).length);

	return (
		<View style={styles.wrap}>
			<GlassSurface style={styles.bar}>
				{SIDEBAR_TABS.map(tab => (
					<TabButton
						key={tab.name}
						tab={tab}
						active={active === tab.name}
						badge={tab.badge && pending > 0 ? pending : undefined}
						onPress={() => selectTab(router, tab, active)}
					/>
				))}
			</GlassSurface>
		</View>
	);
}

/**
 * サイドバーのセグメントを押したときの遷移。
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
function selectTab(router: ReturnType<typeof useRouter>, tab: SidebarTab, active: SidebarTab['name'] | undefined): void {
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

function TabButton({ tab, active, badge, onPress }: { tab: SidebarTab; active: boolean; badge?: number; onPress: () => void }) {
	return (
		<Pressable
			style={styles.tab}
			onPress={onPress}
			accessibilityRole="tab"
			accessibilityState={{ selected: active }}
			accessibilityLabel={tab.label}
		>
			<View>
				<Ionicons name={active ? tab.iconActive : tab.icon} size={20} color={active ? colors.accent : colors.textDim} />
				{badge !== undefined ? (
					<View style={styles.badge}><Text style={styles.badgeText}>{badge}</Text></View>
				) : null}
			</View>
			<Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>{tab.label}</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	wrap: { paddingHorizontal: 10, paddingTop: 10 },
	// Apple HIGに従いglassの上にglassを重ねない。個々のタブは背景を持たず、
	// 選択状態はアイコンとラベルの色だけで示す。
	// 枠線は GlassSurface が非対応環境でだけ描く（fallbackBorder）。ここでは形だけ決める。
	bar: {
		flexDirection: 'row', borderRadius: radius.panel, ...squircle,
		paddingVertical: 8, paddingHorizontal: 4,
	},
	tab: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 4 },
	label: { color: colors.textDim, fontSize: 9.5, fontWeight: '600' },
	labelActive: { color: colors.accent },
	badge: {
		position: 'absolute', top: -5, right: -9, minWidth: 15, height: 15, borderRadius: 8,
		backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
	},
	badgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },
});
