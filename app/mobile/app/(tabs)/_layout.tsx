// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting } from '../../src/store.js';
import { colors } from '../../src/theme.js';

/** 下部タブ（モックアップ準拠: ホーム/ターミナル/ソース管理/ファイル/ブラウザ）。 */
export default function TabsLayout() {
	const { workspace } = useAppStore(useShallow(s => ({ workspace: s.workspace })));
	// 応答待ちエージェント数 → ターミナルタブのバッジ
	const pending = (workspace?.terminals ?? []).filter(t => isAgentWaiting(t.agentStatus)).length;

	return (
		<Tabs
			screenOptions={{
				headerStyle: { backgroundColor: colors.panel },
				headerTintColor: colors.text,
				tabBarStyle: { backgroundColor: 'rgba(30,30,30,.98)', borderTopColor: colors.border },
				tabBarActiveTintColor: colors.accent,
				tabBarInactiveTintColor: colors.textDim,
				sceneStyle: { backgroundColor: colors.bg },
			}}
		>
			<Tabs.Screen name="index" options={{
				title: 'ホーム',
				headerTitle: 'Para Code Mobile',
				tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" color={color} size={size} />,
			}} />
			<Tabs.Screen name="agent" options={{
				title: 'エージェント',
				tabBarIcon: ({ color, size }) => <Ionicons name="chatbubbles-outline" color={color} size={size} />,
				...(pending > 0 ? { tabBarBadge: pending, tabBarBadgeStyle: { backgroundColor: colors.red, color: '#fff', fontSize: 10 } } : {}),
			}} />
			<Tabs.Screen name="terminal" options={{
				title: 'ターミナル',
				tabBarIcon: ({ color, size }) => <Ionicons name="terminal-outline" color={color} size={size} />,
				...(pending > 0 ? { tabBarBadge: pending, tabBarBadgeStyle: { backgroundColor: colors.red, color: '#fff', fontSize: 10 } } : {}),
			}} />
			<Tabs.Screen name="scm" options={{
				title: 'ソース管理',
				tabBarIcon: ({ color, size }) => <Ionicons name="git-branch-outline" color={color} size={size} />,
			}} />
			<Tabs.Screen name="files" options={{
				title: 'ファイル',
				tabBarIcon: ({ color, size }) => <Ionicons name="folder-outline" color={color} size={size} />,
			}} />
			<Tabs.Screen name="browser" options={{
				title: 'ブラウザ',
				tabBarIcon: ({ color, size }) => <Ionicons name="globe-outline" color={color} size={size} />,
			}} />
		</Tabs>
	);
}
