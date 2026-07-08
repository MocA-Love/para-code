// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme.js';

/** ピル型セグメントコントロール（モックアップ mock-2.html 準拠）。 */
export function SegmentedControl<T extends string>({ value, onChange, options }: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string }[];
}) {
	return (
		<View style={styles.wrap}>
			{options.map(opt => {
				const active = opt.value === value;
				return (
					<Pressable key={opt.value} style={[styles.item, active && styles.itemActive]} onPress={() => onChange(opt.value)}>
						<Text style={[styles.text, active && styles.textActive]}>{opt.label}</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 13, padding: 3, marginHorizontal: 16, marginBottom: 12 },
	item: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 10 },
	itemActive: { backgroundColor: colors.surface3 },
	text: { color: colors.textDim, fontSize: 12.5, fontWeight: '600' },
	textActive: { color: colors.text },
});
