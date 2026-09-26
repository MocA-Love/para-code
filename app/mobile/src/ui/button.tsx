// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { hitSlopToMinimum } from '../components/hitSlop.js';
import { HIT_SIZE, colors, radius, space, type } from '../theme.js';
import { Icon, iconSize, type LucideIcon } from './icon.js';
import { useThemeColors } from './themeColorsStore.js';

/**
 * ボタンの種類（モックの値）。
 *  - `primary`: 白地に黒文字。流れを先へ進める操作。**1画面に1つだけ**（起動する・コミット・保存）。
 *    地の色は設定 → 色の「主ボタン」で変わる（上の文字の色は地の明るさから決まる）
 *  - `secondary`: 一段明るい面（`colors.raised`）に白文字。キャンセル・並べて置く操作
 *  - `outline`: 枠だけ。主ボタンの下の「あとで」など
 *  - `ghost`: 地も枠も無い。見出しの横の「クリア」「すべて既読」など
 *  - `danger`: 赤地に白文字。削除の確定
 */
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';

/** 高さ: `md` は 44pt（シートの確定・オンボーディング）、`sm` は 36pt（行の中・一括操作）。 */
export type ButtonSize = 'md' | 'sm';

const HEIGHT: Record<ButtonSize, number> = { md: HIT_SIZE, sm: 36 };

const SURFACE: Record<ButtonVariant, ViewStyle> = {
	primary: { backgroundColor: colors.primary },
	secondary: { backgroundColor: colors.raised },
	outline: { borderWidth: 1, borderColor: colors.border },
	ghost: {},
	danger: { backgroundColor: colors.red },
};

const FOREGROUND: Record<ButtonVariant, string> = {
	primary: colors.onPrimary,
	secondary: colors.text,
	outline: colors.textDim,
	ghost: colors.textDim,
	danger: colors.onRed,
};

/**
 * ボタン（Orca の寸法: 高さ 44 / 36、角丸 6）。見た目が 44pt 未満でも当たり判定は 44pt にする。
 *
 * ```tsx
 * <Button label="起動する" onPress={launch} />
 * <Button label="キャンセル" variant="secondary" onPress={close} style={{ flex: 1 }} />
 * <Button label="削除" variant="danger" onPress={remove} style={{ flex: 1 }} />
 * ```
 */
export function Button({ label, onPress, variant = 'primary', size = 'md', icon, disabled = false, loading = false, style, accessibilityLabel }: {
	label: string;
	onPress: () => void;
	variant?: ButtonVariant;
	size?: ButtonSize;
	/** ラベルの左のアイコン。 */
	icon?: LucideIcon;
	disabled?: boolean;
	/** 処理中はラベルの代わりにくるくるを出し、押せなくする。 */
	loading?: boolean;
	/** 並べ方（`flex: 1`・余白など）だけを渡す。色や大きさは variant / size で決める。 */
	style?: StyleProp<ViewStyle>;
	accessibilityLabel?: string;
}) {
	const height = HEIGHT[size];
	const theme = useThemeColors();
	const fg = variant === 'primary' ? theme.onPrimary : FOREGROUND[variant];
	return (
		<Pressable
			onPress={onPress}
			disabled={disabled || loading}
			hitSlop={hitSlopToMinimum(height)}
			style={({ pressed }) => [
				styles.base,
				{ minHeight: height, paddingHorizontal: size === 'md' ? space.lg : space.md },
				SURFACE[variant],
				variant === 'primary' ? { backgroundColor: theme.primary } : undefined,
				pressed ? styles.pressed : undefined,
				disabled ? styles.disabled : undefined,
				style,
			]}
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel ?? label}
			accessibilityState={{ disabled: disabled || loading, busy: loading }}
		>
			{loading ? <ActivityIndicator size="small" color={fg} /> : (
				<>
					{icon !== undefined ? <Icon icon={icon} size={iconSize.md} color={fg} /> : null}
					<Text
						style={[
							styles.label,
							{ color: fg, fontSize: size === 'md' ? type.input : type.body },
							variant === 'primary' || variant === 'danger' ? styles.labelStrong : undefined,
							variant === 'ghost' ? styles.labelGhost : undefined,
						]}
						numberOfLines={1}
					>
						{label}
					</Text>
				</>
			)}
		</Pressable>
	);
}

const styles = StyleSheet.create({
	base: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: space.xs + 2,
		borderRadius: radius.button,
	},
	pressed: {
		opacity: 0.7,
	},
	disabled: {
		opacity: 0.45,
	},
	label: {
		fontWeight: '600',
	},
	labelStrong: {
		fontWeight: '700',
	},
	labelGhost: {
		fontWeight: '400',
	},
});
