// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting } from '../../src/store.js';
import { WsDrawerLayout } from '../../src/components/wsDrawer.js';
import { colors } from '../../src/theme.js';

/**
 * 下部タブ（ホーム/ターミナル/ソース管理/ファイル/ブラウザ）。
 * 旧エージェントタブはホーム（全ワークスペース横断のエージェント一覧→詳細画面）に
 * 統合し、空いた枠へ旧「その他」のセグメント（ファイル/ブラウザ）を独立タブに昇格した。
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
			<NativeTabs.Trigger name="browser" contentStyle={{ backgroundColor: colors.bg }}>
				<NativeTabs.Trigger.Label>ブラウザ</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon src={<NativeTabs.Trigger.VectorIcon family={Ionicons} name="globe-outline" />} />
			</NativeTabs.Trigger>
		</NativeTabs>
		</WsDrawerLayout>
	);
}
