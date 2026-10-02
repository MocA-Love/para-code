// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { haptic } from '../../haptics.js';
import { colors, radius, space, type } from '../../theme.js';

/** チップの見た目の高さ（当たり判定は hitSlop で 44 まで広げる）。 */
const CHIP_HEIGHT = 32;

/**
 * 1つを選ぶ横並びのチップ（設定 → ウィジェットのプレビューの「案」と「大きさ」）。
 * src/ui に同じ役の部品が無いので、ここに置いている（src/ui へ上げたい）。
 */
export function SegmentChips<T extends string>({ options, selected, onSelect, accessibilityLabel }: {
	options: readonly { readonly value: T; readonly label: string }[];
	selected: T;
	onSelect: (value: T) => void;
	accessibilityLabel: string;
}) {
	return (
		<View style={styles.row} accessibilityRole="tablist" accessibilityLabel={accessibilityLabel}>
			{options.map(option => {
				const on = option.value === selected;
				return (
					<Pressable
						key={option.value}
						onPress={() => {
							if (!on) {
								haptic('tick');
								onSelect(option.value);
							}
						}}
						hitSlop={hitSlopToMinimum(CHIP_HEIGHT)}
						style={({ pressed }) => [styles.chip, on ? styles.chipOn : undefined, pressed && !on ? styles.chipPressed : undefined]}
						accessibilityRole="tab"
						accessibilityState={{ selected: on }}
						accessibilityLabel={option.label}
					>
						<Text style={[styles.label, on ? styles.labelOn : undefined]} numberOfLines={1}>{option.label}</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.sm,
	},
	chip: {
		height: CHIP_HEIGHT,
		paddingHorizontal: space.md,
		borderRadius: radius.pill,
		backgroundColor: colors.panel,
		borderWidth: 1,
		borderColor: colors.border,
		justifyContent: 'center',
	},
	chipOn: {
		backgroundColor: colors.raised,
		borderColor: colors.borderStrong,
	},
	chipPressed: {
		backgroundColor: colors.raised,
	},
	label: {
		fontSize: type.label,
		color: colors.textDim,
	},
	labelOn: {
		color: colors.text,
		fontWeight: '600',
	},
});
