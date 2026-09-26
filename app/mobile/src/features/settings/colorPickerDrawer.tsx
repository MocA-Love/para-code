// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { hapticSelection } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { colorChoices, colors, radius, space, type } from '../../theme.js';
import {
	BottomDrawer,
	DEFAULT_THEME_COLORS,
	DrawerTitle,
	THEME_COLOR_SLOT_LABELS,
	colorWarnings,
	contrastRatio,
	parseHexInput,
	textColorOn,
	textToneOn,
	themeColorOf,
	useThemeColorStore,
	useThemeColors,
	type ThemeColorSlot,
} from '../../ui/index.js';
import { ColorPreview } from './colorPreview.js';

/** 候補の並び（6列。モックの `.palette`）。 */
const COLUMNS = 6;
const CHOICE_ROWS = Array.from({ length: Math.ceil(colorChoices.length / COLUMNS) }, (_, row) => colorChoices.slice(row * COLUMNS, row * COLUMNS + COLUMNS));

/**
 * 場所の色を選ぶシート（モックの `.drawer`）。12 色の候補と hex の入力、上の文字の色とコントラスト比、
 * 状態の色に近い・画面の地と見分けにくいときの注意、いまの色の見本。選ぶとすぐ画面に当たり、保存する。
 *
 * `slot` は閉じる途中も見出しが変わらないよう、親が閉じても持ち続ける。
 */
export function ColorPickerDrawer({ visible, slot, onChange, onClose }: {
	visible: boolean;
	slot: ThemeColorSlot;
	/** 色を変える（undefined で既定に戻す）。保存の失敗は親が知らせる。 */
	onChange: (slot: ThemeColorSlot, hex: string | undefined) => void;
	onClose: () => void;
}) {
	const hex = useThemeColorStore(s => themeColorOf(s.settings, slot));
	const theme = useThemeColors();
	const [text, setText] = useState(hex.toUpperCase());
	const [opened, setOpened] = useState<{ readonly visible: boolean; readonly slot: ThemeColorSlot }>({ visible, slot });
	// 開いた瞬間・場所が替わった瞬間に、入力欄をいまの色へ戻す（描画の前に済ませる）。
	if (opened.visible !== visible || opened.slot !== slot) {
		setOpened({ visible, slot });
		if (visible) {
			setText(hex.toUpperCase());
		}
	}

	const choose = (next: string | undefined) => {
		hapticSelection();
		setText((next ?? DEFAULT_THEME_COLORS[slot]).toUpperCase());
		onChange(slot, next);
	};
	const changeText = (value: string) => {
		setText(value);
		const parsed = parseHexInput(value);
		if (parsed !== undefined && parsed !== hex) {
			onChange(slot, parsed);
		}
	};

	const label = THEME_COLOR_SLOT_LABELS[slot];
	const warnings = colorWarnings(hex);
	const tone = textToneOn(hex) === 'dark' ? '黒' : '白';
	const ratio = contrastRatio(hex, textColorOn(hex)).toFixed(1);
	return (
		<BottomDrawer visible={visible} onClose={onClose} accessibilityLabel={`${label.name}の色`}>
			<DrawerTitle
				title={label.name}
				right={(
					<Pressable onPress={() => choose(undefined)} hitSlop={hitSlopToMinimum(RESET_HEIGHT)} accessibilityRole="button" accessibilityLabel="既定に戻す">
						<Text style={styles.reset}>既定に戻す</Text>
					</Pressable>
				)}
			/>
			<View style={styles.palette}>
				{CHOICE_ROWS.map(row => (
					<View key={row.map(choice => choice.hex).join()} style={styles.paletteRow}>
						{row.map(choice => {
							const selected = choice.hex.toLowerCase() === hex;
							return (
								<Pressable
									key={choice.hex}
									style={styles.choice}
									onPress={() => choose(choice.hex)}
									accessibilityRole="button"
									accessibilityLabel={choice.name}
									accessibilityState={{ selected }}
								>
									<View style={[styles.swatch, { backgroundColor: choice.hex }, selected ? styles.swatchSelected : undefined]} />
									<Text style={styles.choiceName} numberOfLines={1}>{choice.name}</Text>
								</Pressable>
							);
						})}
					</View>
				))}
			</View>
			<TextInput
				style={styles.input}
				value={text}
				onChangeText={changeText}
				placeholder="#RRGGBB"
				placeholderTextColor={colors.textMuted}
				selectionColor={theme.accent}
				autoCapitalize="characters"
				autoCorrect={false}
				spellCheck={false}
				maxLength={HEX_MAX_LENGTH}
				keyboardAppearance="dark"
				returnKeyType="done"
				accessibilityLabel="色の hex"
			/>
			<Text style={styles.info}>{`上の文字は${tone}（コントラスト比 ${ratio}）`}</Text>
			{warnings.length > 0 ? <Text style={styles.warning}>{warnings.join('、')}</Text> : null}
			<View style={styles.preview}>
				<ColorPreview />
			</View>
		</BottomDrawer>
	);
}

/** モックの寸法（pt）。 */
const SWATCH_HEIGHT = 44;
const SWATCH_BORDER = 2;
const RESET_HEIGHT = 20;
/** `#` と 6 桁。 */
const HEX_MAX_LENGTH = 7;

const styles = StyleSheet.create({
	reset: {
		fontSize: type.label,
		color: colors.textMuted,
	},
	palette: {
		gap: space.md,
	},
	paletteRow: {
		flexDirection: 'row',
		gap: space.sm + 2,
	},
	choice: {
		flex: 1,
		alignItems: 'stretch',
	},
	swatch: {
		height: SWATCH_HEIGHT,
		borderRadius: radius.tile,
		borderWidth: SWATCH_BORDER,
		borderColor: 'transparent',
	},
	swatchSelected: {
		borderColor: colors.text,
	},
	choiceName: {
		marginTop: space.xs,
		fontSize: type.badge,
		color: colors.textMuted,
		textAlign: 'center',
	},
	input: {
		marginTop: space.lg,
		minHeight: SWATCH_HEIGHT,
		backgroundColor: colors.raised,
		color: colors.text,
		borderRadius: radius.input,
		borderWidth: 1,
		borderColor: colors.border,
		paddingHorizontal: space.md,
		fontFamily: monoFamily,
		fontSize: type.body,
	},
	info: {
		marginTop: space.sm + 2,
		paddingHorizontal: space.xs,
		fontSize: type.meta,
		lineHeight: 18,
		color: colors.textMuted,
	},
	warning: {
		marginTop: 2,
		paddingHorizontal: space.xs,
		fontSize: type.meta,
		lineHeight: 18,
		color: colors.amber,
	},
	preview: {
		marginTop: space.md,
	},
});
