// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';
import { colors, radius, space, type } from '../theme.js';
import { BottomDrawer } from './bottomDrawer.js';
import { Button } from './button.js';
import { DrawerTitle } from './drawerHeader.js';

/**
 * 1行の文字を入れるシート（モックの名前の変更）。開くと入力欄にフォーカスし、キーボードの上に
 * シートが持ち上がる。空欄では保存できない（`allowEmpty` で許す）。前後の空白は落として渡す。
 *
 * ```tsx
 * <TextInputDrawer
 *   visible={renaming}
 *   title="名前を変更"
 *   defaultValue={terminal.title}
 *   onSubmit={name => renameTerminal(terminal.terminalKey, name)}
 *   onClose={() => setRenaming(false)}
 * />
 * ```
 */
export function TextInputDrawer({
	visible, title, message, defaultValue = '', placeholder, submitLabel = '保存', cancelLabel = 'キャンセル',
	allowEmpty = false, selectTextOnFocus = true, keyboardType, maxLength, validate, onSubmit, onClose,
}: {
	visible: boolean;
	title: string;
	message?: string;
	defaultValue?: string;
	placeholder?: string;
	submitLabel?: string;
	cancelLabel?: string;
	allowEmpty?: boolean;
	selectTextOnFocus?: boolean;
	keyboardType?: KeyboardTypeOptions;
	/** 入れられる文字数の上限（入力欄が止める）。 */
	maxLength?: number;
	/**
	 * 前後の空白を落とした値を見て、保存できない理由を返す（保存できるなら undefined）。
	 * 理由は入力欄の下に出し、保存のボタンを押せなくする（重複など、入力欄だけでは止められないもの）。
	 */
	validate?: (value: string) => string | undefined;
	onSubmit: (value: string) => void;
	onClose: () => void;
}) {
	const [value, setValue] = useState(defaultValue);
	const [wasVisible, setWasVisible] = useState(visible);
	// 開いた瞬間に前回の入力を捨てて初期値へ戻す（描画の前に済ませ、古い値を1フレームも見せない）。
	if (visible !== wasVisible) {
		setWasVisible(visible);
		if (visible) {
			setValue(defaultValue);
		}
	}
	const trimmed = value.trim();
	const problem = validate?.(trimmed);
	const canSubmit = (allowEmpty || trimmed.length > 0) && problem === undefined;
	const submit = () => {
		if (!canSubmit) {
			return;
		}
		onSubmit(trimmed);
		onClose();
	};

	return (
		<BottomDrawer visible={visible} onClose={onClose} accessibilityLabel={title}>
			<DrawerTitle title={title} />
			{message !== undefined ? <Text style={styles.message}>{message}</Text> : null}
			<TextInput
				style={styles.input}
				value={value}
				onChangeText={setValue}
				placeholder={placeholder}
				placeholderTextColor={colors.textMuted}
				selectionColor={colors.accent}
				autoFocus
				autoCapitalize="none"
				autoCorrect={false}
				selectTextOnFocus={selectTextOnFocus}
				keyboardType={keyboardType}
				maxLength={maxLength}
				keyboardAppearance="dark"
				returnKeyType="done"
				onSubmitEditing={submit}
				accessibilityLabel={title}
			/>
			{problem !== undefined && trimmed.length > 0 ? <Text style={styles.problem}>{problem}</Text> : null}
			<View style={styles.buttons}>
				<Button label={cancelLabel} variant="secondary" onPress={onClose} style={styles.button} />
				<Button label={submitLabel} onPress={submit} disabled={!canSubmit} style={styles.button} />
			</View>
		</BottomDrawer>
	);
}

const styles = StyleSheet.create({
	message: {
		fontSize: type.label,
		color: colors.textMuted,
		paddingHorizontal: space.xs,
		marginTop: -space.sm,
		marginBottom: space.sm,
	},
	input: {
		backgroundColor: colors.raised,
		color: colors.text,
		borderRadius: radius.input,
		borderWidth: 1,
		borderColor: colors.border,
		paddingHorizontal: space.md,
		paddingVertical: space.sm + 2,
		fontSize: type.input,
	},
	problem: {
		fontSize: type.meta,
		color: colors.amber,
		paddingHorizontal: space.xs,
		marginTop: space.sm,
	},
	buttons: {
		flexDirection: 'row',
		gap: space.sm,
		marginTop: space.lg,
	},
	button: {
		flex: 1,
	},
});
