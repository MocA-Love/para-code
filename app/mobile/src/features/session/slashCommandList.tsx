// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { FileText, RotateCw, Search, Sparkles, SquareTerminal } from 'lucide-react-native';
import { hapticSelection } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import type { AgentCommandCatalogState, AgentCommandOption } from '../../store.js';
import { HIT_SIZE, colors, radius, space, squircle, type } from '../../theme.js';
import { Icon, useThemeColors } from '../../ui/index.js';

/** 候補の一覧の高さの上限（5行ぶん。超えたら中でスクロールする）。 */
const LIST_MAX_HEIGHT = 260;

/**
 * `/` で始めたときに入力欄の上へ出すスラッシュコマンドの候補（Orca の MobileNativeChatComposerSuggestions）。
 * 候補の絞り込みと挿入する文字は既存の `components/agentSlashCommands.ts`。
 */
export function SlashCommandList({ catalog, commands, onSelect, onRetry }: {
	catalog: AgentCommandCatalogState | undefined;
	commands: readonly AgentCommandOption[];
	onSelect: (command: AgentCommandOption) => void;
	onRetry: () => void;
}) {
	const theme = useThemeColors();
	return (
		<View style={styles.surface}>
			{catalog === undefined || catalog.status === 'loading' ? (
				<View style={styles.message}>
					<ActivityIndicator size="small" color={colors.textDim} />
					<Text style={styles.messageText}>コマンドの一覧を取得しています…</Text>
				</View>
			) : catalog.status === 'error' ? (
				<Pressable style={styles.message} onPress={onRetry} accessibilityRole="button" accessibilityLabel="コマンドの一覧を取り直す">
					<Icon icon={RotateCw} color={colors.textDim} />
					<View style={styles.body}>
						<Text style={styles.error}>{catalog.errorMessage ?? 'コマンドの一覧を取得できませんでした'}</Text>
						<Text style={[styles.retry, { color: theme.accent }]}>押して取り直す</Text>
					</View>
				</Pressable>
			) : commands.length === 0 ? (
				<View style={styles.message}>
					<Icon icon={Search} color={colors.textMuted} />
					<Text style={styles.messageText}>一致するコマンドはありません</Text>
				</View>
			) : (
				<ScrollView keyboardShouldPersistTaps="always" style={styles.list}>
					{commands.map((command, index) => (
						<Pressable
							key={`${command.source}:${command.kind}:${command.name}`}
							style={({ pressed }) => [styles.row, index > 0 ? styles.divider : undefined, pressed ? styles.pressed : undefined]}
							onPress={() => { hapticSelection(); onSelect(command); }}
							accessibilityRole="button"
							accessibilityLabel={`${command.insertText} ${command.description}`}
						>
							<Icon icon={command.kind === 'skill' ? Sparkles : command.kind === 'prompt' ? FileText : SquareTerminal} color={colors.textDim} />
							<View style={styles.body}>
								<View style={styles.nameLine}>
									<Text style={styles.name}>{command.insertText}</Text>
									{command.argumentHint !== undefined ? <Text style={styles.argument} numberOfLines={1}>{command.argumentHint}</Text> : null}
								</View>
								<Text style={styles.description} numberOfLines={1}>{command.description}</Text>
							</View>
						</Pressable>
					))}
				</ScrollView>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	surface: {
		flexShrink: 1,
		maxHeight: LIST_MAX_HEIGHT,
		marginBottom: space.sm,
		borderRadius: radius.card,
		...squircle,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.panel,
		overflow: 'hidden',
	},
	list: {
		flexShrink: 1,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.md,
		minHeight: HIT_SIZE,
		paddingHorizontal: space.md,
		paddingVertical: space.sm,
	},
	divider: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	pressed: {
		backgroundColor: colors.raised,
	},
	body: {
		flex: 1,
		minWidth: 0,
	},
	nameLine: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	name: {
		fontFamily: monoFamily,
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
	},
	argument: {
		flexShrink: 1,
		fontFamily: monoFamily,
		fontSize: type.caption,
		color: colors.textMuted,
	},
	description: {
		marginTop: 2,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	message: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.md,
		minHeight: HIT_SIZE,
		padding: space.md,
	},
	messageText: {
		fontSize: type.body,
		color: colors.textDim,
	},
	error: {
		fontSize: type.meta,
		color: colors.text,
	},
	retry: {
		marginTop: 2,
		fontSize: type.caption,
		color: colors.accent,
	},
});
