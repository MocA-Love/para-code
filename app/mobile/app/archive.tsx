// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
// ホーム一覧と同じ理由でRNGH版のScrollViewを使う（swipeRow.tsx 参照）。
import { ScrollView } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { pinKeyForTerminal } from '../src/store.js';
import { AgentRowContent, agentRowStyles, type AgentRowData } from '../src/components/agentRow.js';
import { closeOpenedSwipeRow, SwipeRow } from '../src/components/swipeRow.js';
import { wsColor } from '../src/components/wsDrawer.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useParaHeader, useParaHeaderHeight, type ParaHeaderSpec } from '../src/paraHeader.js';
import { useContentColumnStyle } from '../src/ipad/useContentColumn.js';
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
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	const { workspace, archivedKeys, pinnedKeys, setArchived, setSelectedWs, setSelectedTerminalKey } = useAppStore(useShallow(s => ({
		workspace: s.workspace, archivedKeys: s.archivedKeys, pinnedKeys: s.pinnedKeys, setArchived: s.setArchived,
		setSelectedWs: s.setSelectedWs, setSelectedTerminalKey: s.setSelectedTerminalKey,
	})));

	// **rows は useMemo で安定させる。** filter は毎レンダー新配列になるので、素のままだと
	// 下の headerSpec の useMemo が毎回切れて層への spec 登録（useEffect）が再送のたびに走る。
	// `workspace?.terminals` は構造共有で中身が同じ間は同じ参照が据え置かれ、archivedKeys も
	// 値が変わったときだけ新 Set になる（appState の setArchived）ため、deps の浅い比較が効く。
	const rows = useMemo(
		() => (workspace?.terminals ?? []).filter(t => t.agent === true && archivedKeys.has(pinKeyForTerminal(t))),
		[workspace?.terminals, archivedKeys]);
	const resolveWs = (terminal: { ws?: string }) =>
		(workspace?.workspaces ?? []).find(w => w.id === (terminal.ws ?? workspace?.activeWs));

	const openAgent = (wsId: string, terminalKey: string) => {
		hapticSelection();
		// setSelectedWs は selectedTerminalKey をリセットするため、この順序を厳守する。
		setSelectedWs(wsId);
		setSelectedTerminalKey(terminalKey);
		router.dismissTo('/agent');
	};

	// ヘッダーは常設のヘッダー層が描く。ホームの［島］［4連ピル］から push すると、
	// 島が「アーカイブ」の島へ、4連ピルが［すべて戻す］［✕］の2枚へ**分裂**する。
	const headerSpec = useMemo<ParaHeaderSpec>(() => ({
		left: { kind: 'island', label: 'アーカイブ', avatarIcon: 'file-tray-full-outline', color: colors.accent, name: 'アーカイブ', maxWidth: 160 },
		...(rows.length > 0 ? {
			rightA: {
				kind: 'text' as const, label: 'すべて戻す',
				onPress: () => { hapticImpact('light'); for (const t of rows) { setArchived(pinKeyForTerminal(t), false); } },
			},
		} : {}),
		rightB: { key: 'close', icon: 'close', label: '閉じる', onPress: () => { hapticImpact('light'); router.back(); } },
	}), [rows, setArchived, router]);
	useParaHeader(headerSpec);
	const headerHeight = useParaHeaderHeight();

	return (
		<View style={styles.screen}>
			{/* スクロールし始めたら開きっぱなしのスワイプ行を畳む（ホーム一覧と同じ流儀）。 */}
			<ScrollView style={styles.list} contentContainerStyle={[styles.listContent, { paddingTop: headerHeight, paddingBottom: insets.bottom + 24 }, column]} onScrollBeginDrag={closeOpenedSwipeRow}>
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
						branch: ws?.branch, pinned: pinnedKeys.has(pinKeyForTerminal(t)), agentStatus: t.agentStatus,
					};
					return (
						<SwipeRow
							key={t.terminalKey}
							direction="right"
							actions={[{
								key: 'restore',
								label: '戻す',
								icon: 'arrow-undo-outline',
								color: colors.accent2,
								fullSwipe: true,
								onPress: () => setArchived(pinKeyForTerminal(t), false),
							}]}
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
	list: { flex: 1, paddingHorizontal: 14 },
	listContent: { paddingBottom: 32 },
	empty: { color: colors.textDim, fontSize: 13, lineHeight: 21, textAlign: 'center', paddingVertical: 32 },
	note: { color: colors.textDim, fontSize: 11, lineHeight: 16, paddingHorizontal: 4, paddingBottom: 10 },
	// しまってあるものなので、ホームの行より一段落とす
	rowDim: { opacity: 0.72 },
});
