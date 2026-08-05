// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef } from 'react';
import { usePathname } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting } from '../../src/store.js';
import { WsDrawerLayout } from '../../src/components/wsDrawer.js';
import { useIsRegularWidth } from '../../src/hooks/useSizeClass.js';
import { colors } from '../../src/theme.js';
import { hapticSelection } from '../../src/haptics.js';

/** 下部タブのルートパス集合（タブ間遷移の判定用）。 */
const TAB_PATHS = new Set(['/', '/index', '/terminal', '/scm', '/files']);

/**
 * タブ切り替えの触覚フィードバック。NativeTabs はOSネイティブのタブバーで
 * JSのpressイベントを持たないため、パス変化（タブルート間の遷移のみ）で発火させる。
 * スタック遷移（エージェント詳細・設定等）は各ボタン側のハプティクスが担うため対象外。
 *
 * iPad幅のサイドバーは自前のPressableで自分で鳴らすため、二重に鳴らないよう
 * `enabled=false` で止める。
 */
function useTabSwitchHaptics(enabled: boolean): void {
	const pathname = usePathname();
	const previousRef = useRef(pathname);
	useEffect(() => {
		const previous = previousRef.current;
		previousRef.current = pathname;
		if (enabled && previous !== pathname && TAB_PATHS.has(previous) && TAB_PATHS.has(pathname)) {
			hapticSelection();
		}
	}, [enabled, pathname]);
}

/**
 * 下部タブ（ホーム/ターミナル/ソース管理/ファイル）。
 * 旧エージェントタブはホーム（全ワークスペース横断のエージェント一覧→詳細画面）に
 * 統合し、空いた枠へ旧「その他」のセグメント（ファイル/ブラウザ）を独立タブに昇格した。
 * その後、ブラウザは「エージェントの作業結果を見る」用途が実態のため独立タブを廃止し、
 * エージェント詳細ヘッダーのボタンから開くスタック画面（/browser）へ移した。
 * `NativeTabs`（expo-router/unstable-native-tabs）を使い、iOS 26実機ではOS標準の
 * Liquid Glass（半透明・屈折するタブバー）がそのまま適用される。ヘッダーはNativeTabsに
 * 概念が無いため、各画面側で独自ヘッダー（ワークスペースドロワーのチップ等）を描画する。
 *
 * 各Triggerの`contentStyle.backgroundColor`は、iOS 26+ではコンテンツにより自動決定され
 * 上書きできない（画面遷移時の白フラッシュ対策は代わりに root の _layout.tsx で
 * ThemeProviderのbackgroundをcolors.bgに合わせることで行っている）。
 * Android/iOS 18以下では引き続き有効なため、後方互換のため残す。
 *
 * iPadの広い幅（size class = regular）では、この4つを常設サイドバー下部の
 * Liquid Glassセグメント（`src/ipad/ipadSidebar.tsx`）へ移すため、タブバー自体は
 * 隠してJS版の`Tabs`に切り替える。NativeTabsはiPadOSでOSがタブバーの見せ方
 * （上部タブ／サイドバー）を決めてしまい、こちらのサイドバーと二重になるため使わない。
 */
export default function TabsLayout() {
	const regular = useIsRegularWidth();
	useTabSwitchHaptics(!regular);
	// 応答待ちエージェント数 → ホーム/ターミナルタブのバッジ。
	// workspace 本体ではなく件数（数値）を選ぶ。本体を購読すると、PCからのstate再送のたびに
	// ドロワーとタブバーごと再構築されてしまう（バッジに要るのはこの数値だけ）。
	const pending = useAppStore(s => (s.workspace?.terminals ?? []).filter(t => isAgentWaiting(t.agentStatus)).length);
	const badge = pending > 0 ? String(pending) : undefined;

	return (
		// ワークスペースドロワーはタブバーごと覆う全画面オーバーレイ（X等と同じ）。
		// ここで1回だけ包み、各画面はuseWsDrawer()経由で開く。
		// iPad幅では常設サイドバーがあるため、この中では素通しになる（wsDrawer.tsx参照）。
		<WsDrawerLayout>
		{regular ? (
			// 注意: `Tabs` は `app/(tabs)/` 配下の**全ファイル**を自動でタブとして登録する
			// （`NativeTabs` は下で明示したものだけを使う）。このディレクトリにファイルを足すときは、
			// 両者で登録されるルートがずれないよう、ここのScreenと下のTriggerを必ず揃えること。
			<Tabs
				screenOptions={{
					headerShown: false,
					// タブバーはサイドバー下部へ移したのでここには出さない。
					tabBarStyle: { display: 'none' },
					sceneStyle: { backgroundColor: colors.bg },
					// 切り替えは瞬時にする（サイドバーのセグメントはタブバーと同じ「区画の切り替え」で、
					// 横スライドのアニメーションが付くと押した位置と動く方向が噛み合わない）。
					animation: 'none',
				}}
			>
				<Tabs.Screen name="index" />
				<Tabs.Screen name="terminal" />
				<Tabs.Screen name="scm" />
				<Tabs.Screen name="files" />
			</Tabs>
		) : (
			<NativeTabs
				blurEffect="systemUltraThinMaterialDark"
				tintColor={colors.accent}
				iconColor={{ default: colors.textDim, selected: colors.accent }}
				labelStyle={{ default: { color: colors.textDim }, selected: { color: colors.text } }}
				badgeBackgroundColor={colors.red}
			>
				<NativeTabs.Trigger name="index" contentStyle={{ backgroundColor: colors.bg }}>
					<NativeTabs.Trigger.Label>ホーム</NativeTabs.Trigger.Label>
					<NativeTabs.Trigger.Icon src={<NativeTabs.Trigger.VectorIcon family={Ionicons} name="home-outline" />} />
					{badge ? <NativeTabs.Trigger.Badge>{badge}</NativeTabs.Trigger.Badge> : null}
				</NativeTabs.Trigger>
				<NativeTabs.Trigger name="terminal" contentStyle={{ backgroundColor: colors.bg }}>
					<NativeTabs.Trigger.Label>ターミナル</NativeTabs.Trigger.Label>
					<NativeTabs.Trigger.Icon src={<NativeTabs.Trigger.VectorIcon family={Ionicons} name="terminal-outline" />} />
					{badge ? <NativeTabs.Trigger.Badge>{badge}</NativeTabs.Trigger.Badge> : null}
				</NativeTabs.Trigger>
				<NativeTabs.Trigger name="scm" contentStyle={{ backgroundColor: colors.bg }}>
					<NativeTabs.Trigger.Label>ソース管理</NativeTabs.Trigger.Label>
					<NativeTabs.Trigger.Icon src={<NativeTabs.Trigger.VectorIcon family={Ionicons} name="git-branch-outline" />} />
				</NativeTabs.Trigger>
				<NativeTabs.Trigger name="files" contentStyle={{ backgroundColor: colors.bg }}>
					<NativeTabs.Trigger.Label>ファイル</NativeTabs.Trigger.Label>
					<NativeTabs.Trigger.Icon src={<NativeTabs.Trigger.VectorIcon family={Ionicons} name="folder-outline" />} />
				</NativeTabs.Trigger>
			</NativeTabs>
		)}
		</WsDrawerLayout>
	);
}
