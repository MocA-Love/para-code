// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { pinKeyForTerminal } from '../src/store.js';
import { AgentRowContent, agentRowStyles, type AgentRowData } from '../src/components/agentRow.js';
import { SwipeRow } from '../src/components/swipeRow.js';
import { wsColor } from '../src/components/wsDrawer.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { colors } from '../src/theme.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';
import { createAgentLatestEntryToken } from '../src/agentNavigation.js';

/**
 * アーカイブ一覧。ホームヘッダーの箱アイコンから開く（入口はしまってあるものが
 * 1件以上ある時だけ出る）。行を右スワイプでホームへ戻し、タップすると通常どおり
 * エージェント画面が開く。
 *
 * アーカイブはこの端末だけの印で、PC側のターミナルはアーカイブ中も動き続ける。
 * 質問・応答待ちになったものは自動で解除されてホームへ戻るため、ここには出ない
 * （規則は archivedAgents.ts）。
 */
export default function ArchiveScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const { workspace, archivedKeys, pinnedKeys, setArchived, setSelectedWs, setSelectedTerminalKey } = useAppStore(useShallow(s => ({
		workspace: s.workspace, archivedKeys: s.archivedKeys, pinnedKeys: s.pinnedKeys, setArchived: s.setArchived,
		setSelectedWs: s.setSelectedWs, setSelectedTerminalKey: s.setSelectedTerminalKey,
	})));

	const rows = (workspace?.terminals ?? []).filter(t => t.agent === true && archivedKeys.has(pinKeyForTerminal(t)));
	const resolveWs = (terminal: { ws?: string }) =>
		(workspace?.workspaces ?? []).find(w => w.id === (terminal.ws ?? workspace?.activeWs));

	const openAgent = (wsId: string, terminalKey: string) => {
		hapticSelection();
		// setSelectedWs は selectedTerminalKey をリセットするため、この順序を厳守する。
		setSelectedWs(wsId);
		setSelectedTerminalKey(terminalKey);
		router.dismissTo('/agent');
	};

	return (
		<View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
			<View style={styles.header}>
				<Text style={styles.title}>アーカイブ</Text>
				{rows.length > 0 ? (
					<Pressable
						style={styles.restoreAllBtn}
						onPress={() => { hapticImpact('light'); for (const t of rows) { setArchived(pinKeyForTerminal(t), false); } }}
						accessibilityLabel="すべてホームに戻す"
					>
						<Text style={styles.restoreAllText}>すべて戻す</Text>
					</Pressable>
				) : null}
				<Pressable style={styles.closeBtn} onPress={() => { hapticImpact('light'); router.back(); }} accessibilityLabel="閉じる">
					<Ionicons name="close" size={16} color={colors.textDim} />
				</Pressable>
			</View>
			<ScrollView style={styles.list} contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}>
				{rows.length === 0 ? (
					<Text style={styles.empty}>アーカイブしたエージェントはありません{'\n'}ホームの一覧を左へスワイプするとここに入ります</Text>
				) : (
					<Text style={styles.note}>PCではそのまま動いています。質問や応答待ちになったものは自動でホームへ戻ります。</Text>
				)}
				{rows.map(t => {
					const ws = resolveWs(t);
					const rowData: AgentRowData = {
						title: t.title, wsName: ws?.name ?? '—', wsColor: ws ? wsColor(ws) : colors.accent,
						// ピン留めはアーカイブしても外さない（戻せば元の並びに戻る）ので、ここでも印を出す
						branch: ws?.branch, pinned: pinnedKeys.has(pinKeyForTerminal(t)), agentStatus: t.agentStatus, waiting: false,
					};
					return (
						<SwipeRow
							key={t.terminalKey}
							direction="right"
							label="ホームに戻す"
							icon="arrow-undo-outline"
							color={colors.accent2}
							onTrigger={() => setArchived(pinKeyForTerminal(t), false)}
						>
							<Pressable
								style={[agentRowStyles.container, styles.rowDim]}
								onPress={() => { if (ws) { openAgent(ws.id, t.terminalKey); } }}
								accessibilityLabel={`${t.title} を開く`}
							>
								<AgentRowContent data={rowData} />
							</Pressable>
						</SwipeRow>
					);
				})}
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 10 },
	title: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3, flex: 1 },
	restoreAllBtn: { height: 32, borderRadius: 16, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
	restoreAllText: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
	closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	list: { flex: 1, paddingHorizontal: 14 },
	listContent: { paddingBottom: 32 },
	empty: { color: colors.textDim, fontSize: 13, lineHeight: 21, textAlign: 'center', paddingVertical: 32 },
	note: { color: colors.textDim, fontSize: 11, lineHeight: 16, paddingHorizontal: 4, paddingBottom: 10 },
	// しまってあるものなので、ホームの行より一段落とす
	rowDim: { opacity: 0.72 },
});
