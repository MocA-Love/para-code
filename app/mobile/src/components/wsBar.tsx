// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { isAgentWaiting } from '../store.js';
import { colors } from '../theme.js';

/**
 * ワークスペース切り替えバー（モックアップ準拠）。ターミナル/ソース管理/ファイル/
 * ブラウザの4画面で共有し、選択は全画面で連動する。応答待ちのエージェントがいる
 * ワークスペースには赤バッジを表示する。
 */
export function WsBar() {
	const { workspace, selectedWs, setSelectedWs } = useAppStore(useShallow(s => ({
		workspace: s.workspace, selectedWs: s.selectedWs, setSelectedWs: s.setSelectedWs,
	})));
	const list = workspace?.workspaces ?? [];
	if (list.length === 0) {
		return null;
	}
	const effective = selectedWs && list.some(w => w.id === selectedWs) ? selectedWs : list[0]?.id;
	const pendingByWs = new Map<string, number>();
	for (const t of workspace?.terminals ?? []) {
		if (isAgentWaiting(t.agentStatus) && t.ws) {
			pendingByWs.set(t.ws, (pendingByWs.get(t.ws) ?? 0) + 1);
		}
	}
	return (
		<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bar} contentContainerStyle={styles.content}>
			{list.map(ws => {
				const active = ws.id === effective;
				const pending = pendingByWs.get(ws.id) ?? 0;
				return (
					<Pressable key={ws.id} style={[styles.chip, active && styles.chipActive]} onPress={() => setSelectedWs(ws.id)}>
						<Text style={[styles.chipText, active && styles.chipTextActive]}>{ws.name}</Text>
						{pending > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{pending}</Text></View> : null}
					</Pressable>
				);
			})}
		</ScrollView>
	);
}

/** 現在有効な選択ワークスペースIDを返すフック（未選択時は先頭）。 */
export function useEffectiveWs(): { id: string; name: string; branch?: string } | undefined {
	const { workspace, selectedWs } = useAppStore(useShallow(s => ({ workspace: s.workspace, selectedWs: s.selectedWs })));
	const list = workspace?.workspaces ?? [];
	return list.find(w => w.id === selectedWs) ?? list[0];
}

const styles = StyleSheet.create({
	bar: { flexGrow: 0, flexShrink: 0 },
	content: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
	chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 7 },
	chipActive: { backgroundColor: 'rgba(0,122,204,.16)', borderColor: colors.accent2 },
	chipText: { color: colors.textDim, fontSize: 13 },
	chipTextActive: { color: colors.text, fontWeight: '600' },
	badge: { backgroundColor: colors.red, minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
	badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
});
