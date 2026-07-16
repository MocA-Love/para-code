// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentCommandCatalogState, AgentCommandOption } from '../store.js';
import { colors } from '../theme.js';
import { hapticSelection } from '../haptics.js';
import { GlassSurface, liquidGlass } from './glassSurface.js';

/** スラッシュ候補と取得状態を既存のLiquid Glass面へ表示する。 */
export function AgentSlashCommandMenu({ catalog, commands, agent, onSelect, onRetry }: {
	catalog: AgentCommandCatalogState | undefined;
	commands: readonly AgentCommandOption[];
	agent: string | undefined;
	onSelect: (command: AgentCommandOption) => void;
	onRetry: () => void;
}) {
	const accent = agent === 'claude' ? colors.claude : colors.accent;
	return (
		<GlassSurface style={[styles.surface, !liquidGlass && styles.fallbackBorder]}>
			{catalog === undefined || catalog.status === 'loading' ? (
				<View style={styles.messageRow}>
					<ActivityIndicator size="small" color={accent} />
					<Text style={styles.message}>コマンド一覧を取得中…</Text>
				</View>
			) : catalog.status === 'error' ? (
				<Pressable style={styles.messageRow} onPress={onRetry} accessibilityRole="button" accessibilityLabel="コマンド一覧を再取得">
					<Ionicons name="refresh" size={16} color={accent} />
					<View style={styles.messageBody}>
						<Text style={styles.errorText}>{catalog.errorMessage ?? 'コマンド一覧を取得できませんでした'}</Text>
						<Text style={[styles.retryText, { color: accent }]}>タップして再試行</Text>
					</View>
				</Pressable>
			) : commands.length === 0 ? (
				<View style={styles.messageRow}>
					<Ionicons name="search-outline" size={16} color={colors.textDim} />
					<Text style={styles.message}>一致するコマンドがありません</Text>
				</View>
			) : (
				<ScrollView keyboardShouldPersistTaps="always" showsVerticalScrollIndicator={commands.length > 5} style={styles.list}>
					{commands.map(command => (
						<Pressable
							key={`${command.source}:${command.kind}:${command.name}`}
							style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
							onPress={() => { hapticSelection(); onSelect(command); }}
							accessibilityRole="button"
							accessibilityLabel={`${command.insertText} ${command.description}`}
						>
							<Ionicons name={command.kind === 'skill' ? 'sparkles-outline' : command.kind === 'prompt' ? 'document-text-outline' : 'terminal-outline'} size={16} color={accent} />
							<View style={styles.commandBody}>
								<View style={styles.commandHead}>
									<Text style={styles.commandName}>{command.insertText}</Text>
									{command.argumentHint !== undefined ? <Text style={styles.argumentHint} numberOfLines={1}>{command.argumentHint}</Text> : null}
								</View>
								<Text style={styles.description} numberOfLines={1}>{command.description}</Text>
							</View>
							<Text style={styles.source}>{sourceLabel(command.source)}</Text>
						</Pressable>
					))}
				</ScrollView>
			)}
		</GlassSurface>
	);
}

function sourceLabel(source: AgentCommandOption['source']): string {
	if (source === 'user') { return 'ユーザー'; }
	if (source === 'project') { return 'プロジェクト'; }
	return '組み込み';
}

const styles = StyleSheet.create({
	// flexShrink: キーボードが高い端末でヘッダー（＋Subagentストリップ）と重なる場合は
	// maxHeightより優先して縮む（親チェーンのminHeight/flexShrink制約による。内容はScrollViewで送る）
	surface: { maxHeight: 292, flexShrink: 1, borderRadius: 20, overflow: 'hidden', marginBottom: 8 },
	fallbackBorder: { borderWidth: 1, borderColor: colors.glassBorder },
	// flexShrink: surfaceの圧縮にビューポートを追随させ、クリップされた行へもスクロールで到達できるようにする
	list: { maxHeight: 292, flexShrink: 1 },
	row: { minHeight: 54, paddingHorizontal: 14, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
	rowPressed: { backgroundColor: colors.surface2 },
	commandBody: { flex: 1, minWidth: 0 },
	commandHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
	commandName: { color: colors.text, fontFamily: 'Menlo', fontSize: 13, fontWeight: '700' },
	argumentHint: { color: colors.textDim, fontFamily: 'Menlo', fontSize: 10, flexShrink: 1 },
	description: { color: colors.textDim, fontSize: 12, marginTop: 2 },
	source: { color: colors.textDim, fontSize: 9, flexShrink: 0 },
	messageRow: { minHeight: 58, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
	messageBody: { flex: 1 },
	message: { color: colors.textDim, fontSize: 13 },
	errorText: { color: colors.text, fontSize: 12 },
	retryText: { fontSize: 11, marginTop: 2 },
});
