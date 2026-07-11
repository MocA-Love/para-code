// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef } from 'react';
import { usePathname } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting } from '../../src/store.js';
import { WsDrawerLayout } from '../../src/components/wsDrawer.js';
import { colors } from '../../src/theme.js';
import { hapticSelection } from '../../src/haptics.js';

/** 下部タブのルートパス集合（タブ間遷移の判定用）。 */
const TAB_PATHS = new Set(['/', '/index', '/terminal', '/scm', '/files']);

/**
 * タブ切り替えの触覚フィードバック。NativeTabs はOSネイティブのタブバーで
 * JSのpressイベントを持たないため、パス変化（タブルート間の遷移のみ）で発火させる。
 * スタック遷移（エージェント詳細・設定等）は各ボタン側のハプティクスが担うため対象外。
 */
function useTabSwitchHaptics(): void {
	const pathname = usePathname();
	const previousRef = useRef(pathname);
	useEffect(() => {
		const previous = previousRef.current;
		previousRef.current = pathname;
		if (previous !== pathname && TAB_PATHS.has(previous) && TAB_PATHS.has(pathname)) {
			hapticSelection();
		}
	}, [pathname]);
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
 */
export default function TabsLayout() {
	useTabSwitchHaptics();
	const { workspace } = useAppStore(useShallow(s => ({ workspace: s.workspace })));
	// 応答待ちエージェント数 → ホーム/ターミナルタブのバッジ
	const pending = (workspace?.terminals ?? []).filter(t => isAgentWaiting(t.agentStatus)).length;
	const badge = pending > 0 ? String(pending) : undefined;

	return (
		// ワークスペースドロワーはタブバーごと覆う全画面オーバーレイ（X等と同じ）。
		// ここで1回だけ包み、各画面はuseWsDrawer()経由で開く。
		<WsDrawerLayout>
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
		</WsDrawerLayout>
	);
}
