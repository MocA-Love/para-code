// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { RefObject } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Check, Plus, type LucideIcon } from 'lucide-react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { SPACE_NOTE_MAX_LENGTH, type SpaceNoteLine } from '../../spaceNote.js';
import { colors, radius, space, type } from '../../theme.js';
import { Icon, iconSize, useThemeColors } from '../../ui/index.js';

/**
 * スペースのメモの画面の部品（旧画面 `legacy-screens/space-note.tsx` を Orca の見た目で作り直したもの）。
 * チェック項目の行・項目を足す行・キーボードの上の記号のバー。
 */

/** チェックボックスの見た目の大きさ（pt）。行の高さは 44 以上にする。 */
const CHECK_SIZE = 18;
/** 行の最小の高さ（当たり判定）。 */
const ROW_MIN = 44;

/** 本文の各行（見出し・ふつうの行・チェック項目）。チェック項目を押すと完了を切り替える。 */
export function NoteLines({ lines, onToggle, disabled }: {
	lines: readonly SpaceNoteLine[];
	onToggle: (lineIndex: number) => void;
	disabled: boolean;
}) {
	const theme = useThemeColors();
	return (
		<>
			{lines.map(line => {
				switch (line.kind) {
					case 'blank':
						return <View key={line.index} style={styles.blank} />;
					case 'heading':
						return <Text key={line.index} style={styles.heading} accessibilityRole="header">{line.text}</Text>;
					case 'text':
						return <Text key={line.index} style={styles.text}>{line.text}</Text>;
					case 'task':
						return (
							<Pressable
								key={line.index}
								onPress={() => onToggle(line.index)}
								disabled={disabled}
								style={({ pressed }) => [styles.task, pressed ? styles.pressed : undefined]}
								accessibilityRole="checkbox"
								accessibilityState={{ checked: line.done, disabled }}
								accessibilityLabel={line.text.length > 0 ? line.text : '空のチェック項目'}
							>
								<View style={[styles.check, line.done ? { borderColor: theme.primary, backgroundColor: theme.primary } : undefined]}>
									{line.done ? <Icon icon={Check} size={iconSize.xs} color={theme.onPrimary} strokeWidth={3} /> : null}
								</View>
								<Text style={[styles.taskLabel, line.done ? styles.taskLabelDone : undefined]}>{line.text}</Text>
							</Pressable>
						);
				}
			})}
		</>
	);
}

/** 一覧の末尾の「項目を追加」。 */
export function NoteAddButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
	return (
		<Pressable
			onPress={onPress}
			disabled={disabled}
			style={({ pressed }) => [styles.task, pressed ? styles.pressed : undefined, disabled ? styles.disabled : undefined]}
			accessibilityRole="button"
			accessibilityLabel="項目を追加"
		>
			<View style={[styles.check, styles.checkGhost]}>
				<Icon icon={Plus} size={iconSize.xs} color={colors.textMuted} />
			</View>
			<Text style={styles.addLabel}>項目を追加</Text>
		</Pressable>
	);
}

/**
 * 項目を足す入力欄（一覧の末尾に出す）。**uncontrolled**（`value` を渡さない）にして、PC からの
 * 同期で再描画しても日本語の変換途中の文字へ書き戻さない。確定したら呼び出し側が `clear()` する。
 */
export function NoteAddInput({ inputRef, onChange, onSubmit, onBlur }: {
	inputRef: RefObject<TextInput | null>;
	onChange: (text: string) => void;
	onSubmit: () => void;
	onBlur: () => void;
}) {
	return (
		<View style={styles.task}>
			<View style={[styles.check, styles.checkGhost]} importantForAccessibility="no" accessibilityElementsHidden />
			<TextInput
				ref={inputRef}
				style={styles.addInput}
				onChangeText={onChange}
				onSubmitEditing={onSubmit}
				onBlur={onBlur}
				autoFocus
				spellCheck={false}
				autoCorrect={false}
				returnKeyType="done"
				submitBehavior="submit"
				maxLength={SPACE_NOTE_MAX_LENGTH}
				placeholder="項目を書いて確定"
				placeholderTextColor={colors.textMuted}
				keyboardAppearance="dark"
				accessibilityLabel="チェック項目を追加"
			/>
		</View>
	);
}

export interface NoteToolbarAction {
	readonly key: string;
	readonly icon: LucideIcon;
	readonly label: string;
	readonly onPress: () => void;
}

/** 編集中・追加中にキーボードのすぐ上に出す記号のバー（押すと行頭の記号を付け替える）。 */
export function NoteToolbar({ actions, bottomInset }: { actions: readonly NoteToolbarAction[]; bottomInset: number }) {
	return (
		<View style={[styles.toolbar, { paddingBottom: space.sm + bottomInset }]}>
			<ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.toolbarContent}>
				{actions.map(action => (
					<Pressable
						key={action.key}
						onPress={action.onPress}
						hitSlop={hitSlopToMinimum(TOOL_HEIGHT)}
						style={({ pressed }) => [styles.tool, pressed ? styles.toolPressed : undefined]}
						accessibilityRole="button"
						accessibilityLabel={action.label}
					>
						<Icon icon={action.icon} size={iconSize.sm} />
						<Text style={styles.toolLabel}>{action.label}</Text>
					</Pressable>
				))}
			</ScrollView>
		</View>
	);
}

/** 記号のバーのボタンの見た目の高さ（pt）。当たり判定は 44 に広げる。 */
const TOOL_HEIGHT = 34;

const styles = StyleSheet.create({
	blank: {
		height: space.sm,
	},
	heading: {
		fontSize: type.heading,
		fontWeight: '700',
		color: colors.text,
		marginTop: space.md,
		marginBottom: space.xs,
	},
	text: {
		fontSize: type.body,
		lineHeight: 20,
		color: colors.text,
		paddingVertical: space.xs,
	},
	task: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.md,
		minHeight: ROW_MIN,
		paddingVertical: space.xs,
		borderRadius: radius.row,
	},
	pressed: {
		backgroundColor: colors.raised,
	},
	disabled: {
		opacity: 0.5,
	},
	check: {
		width: CHECK_SIZE,
		height: CHECK_SIZE,
		borderRadius: radius.key,
		borderWidth: 1.5,
		borderColor: colors.textMuted,
		alignItems: 'center',
		justifyContent: 'center',
	},
	checkGhost: {
		borderStyle: 'dashed',
	},
	taskLabel: {
		flex: 1,
		fontSize: type.body,
		lineHeight: 20,
		color: colors.text,
	},
	taskLabelDone: {
		color: colors.textMuted,
		textDecorationLine: 'line-through',
	},
	addLabel: {
		flex: 1,
		fontSize: type.body,
		color: colors.textMuted,
	},
	addInput: {
		flex: 1,
		minHeight: ROW_MIN - space.sm,
		fontSize: type.body,
		color: colors.text,
		padding: 0,
	},
	toolbar: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
		backgroundColor: colors.panel,
		paddingTop: space.sm,
	},
	toolbarContent: {
		gap: space.sm,
		paddingHorizontal: space.md,
	},
	tool: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs + 2,
		height: TOOL_HEIGHT,
		paddingHorizontal: space.md,
		borderRadius: radius.button,
		backgroundColor: colors.raised,
	},
	toolPressed: {
		backgroundColor: colors.surface3,
	},
	toolLabel: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
	},
});
