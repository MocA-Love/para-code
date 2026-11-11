// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, type } from '../theme.js';

/**
 * 「名前を打って確認」の段のプリセットで、名前を打たせる欄（一覧のシートとクイックコマンドの両方で使う）。
 * 打った名前が一致するまで、呼ぶ側は「実行」を押せないようにする（presets.ts の presetTypedNameMatches）。
 */
export function PresetTypeName({ name, value, onChange }: { name: string; value: string; onChange: (value: string) => void }) {
	const label = `確かめるため、プリセットの名前「${name}」を打ってください`;
	return (
		<View style={styles.wrap}>
			<Text style={styles.label}>{label}</Text>
			<TextInput
				style={styles.input}
				value={value}
				onChangeText={onChange}
				autoCapitalize="none"
				autoCorrect={false}
				spellCheck={false}
				placeholder={name}
				placeholderTextColor={colors.textMuted}
				accessibilityLabel={label}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: { gap: 6, paddingTop: 4 },
	label: { color: colors.text, fontSize: type.meta, lineHeight: 17 },
	input: {
		minHeight: 40,
		paddingHorizontal: 12,
		borderRadius: radius.input,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.borderStrong,
		backgroundColor: colors.surface2,
		color: colors.text,
		fontSize: type.body,
	},
});
