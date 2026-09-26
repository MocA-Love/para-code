// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, Text, View } from 'react-native';
import { ArrowUp } from 'lucide-react-native';
import { alpha, colors, radius, space, squircle, tint, type } from '../../theme.js';
import { Card, Icon, useThemeColors } from '../../ui/index.js';

/**
 * 設定 → 色のプレビュー（モックの `.pv`）。いまの色で、自分の発言・リンク・拒否と許可・
 * キャンセルと起動する・入力と送信を並べる。押せない見本なので、読み上げでは1枚の絵として扱う。
 */
export function ColorPreview() {
	const theme = useThemeColors();
	return (
		<Card style={styles.card}>
			<View accessible accessibilityRole="image" accessibilityLabel="いまの色の見本">
				<View style={styles.bubbleWrap}>
					<View style={[styles.bubble, { backgroundColor: theme.bubble }]}>
						<Text style={[styles.bubbleText, { color: theme.onBubble }]}>テストも追加して</Text>
					</View>
				</View>
				<Text style={styles.agent}>
					了解しました。
					<Text style={[styles.link, { color: theme.accent }]}>session.ts</Text>
					を確認します。
				</Text>
				<View style={styles.buttons}>
					<View style={[styles.button, styles.deny]}><Text style={[styles.buttonText, styles.denyText]}>拒否</Text></View>
					<View style={[styles.button, { backgroundColor: theme.primary }]}><Text style={[styles.buttonText, { color: theme.onPrimary }]}>許可</Text></View>
				</View>
				<View style={styles.buttons}>
					<View style={[styles.button, styles.secondary]}><Text style={styles.buttonText}>キャンセル</Text></View>
					<View style={[styles.button, { backgroundColor: theme.primary }]}><Text style={[styles.buttonText, { color: theme.onPrimary }]}>起動する</Text></View>
				</View>
				<View style={styles.composer}>
					<View style={styles.input}><Text style={styles.placeholder} numberOfLines={1}>メッセージ、/ コマンド</Text></View>
					<View style={[styles.send, { backgroundColor: theme.bubble }]}>
						<Icon icon={ArrowUp} size={SEND_ICON} color={theme.onBubble} strokeWidth={2.6} />
					</View>
				</View>
			</View>
		</Card>
	);
}

/** モックの寸法（pt）。 */
const BUBBLE_MAX_WIDTH = 240;
const BUTTON_HEIGHT = 40;
const SEND_SIZE = 36;
const SEND_ICON = 18;

const styles = StyleSheet.create({
	card: {
		padding: space.md,
	},
	bubbleWrap: {
		flexDirection: 'row',
		justifyContent: 'flex-end',
	},
	bubble: {
		maxWidth: BUBBLE_MAX_WIDTH,
		paddingHorizontal: space.md,
		paddingVertical: space.sm,
		borderRadius: radius.composer,
		...squircle,
	},
	bubbleText: {
		fontSize: type.input,
		lineHeight: 22,
		fontWeight: '500',
	},
	agent: {
		fontSize: type.body,
		lineHeight: 20,
		color: colors.text,
		marginVertical: space.sm,
		marginHorizontal: 2,
	},
	link: {
		textDecorationLine: 'underline',
	},
	buttons: {
		flexDirection: 'row',
		gap: space.sm,
		marginTop: space.sm + 2,
	},
	button: {
		flex: 1,
		height: BUTTON_HEIGHT,
		borderRadius: radius.button,
		borderWidth: 1,
		borderColor: 'transparent',
		alignItems: 'center',
		justifyContent: 'center',
	},
	buttonText: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	deny: {
		backgroundColor: colors.raised,
		borderColor: tint(colors.red, alpha.line),
	},
	denyText: {
		color: colors.red,
	},
	secondary: {
		backgroundColor: colors.raised,
		borderColor: colors.border,
	},
	composer: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		marginTop: space.sm + 2,
		padding: space.sm,
		backgroundColor: colors.bg,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: radius.composer,
		...squircle,
	},
	input: {
		flex: 1,
		backgroundColor: colors.raised,
		borderRadius: radius.input,
		paddingVertical: space.sm,
		paddingHorizontal: space.sm + 2,
	},
	placeholder: {
		fontSize: type.label,
		color: colors.textMuted,
	},
	send: {
		width: SEND_SIZE,
		height: SEND_SIZE,
		borderRadius: radius.pill,
		alignItems: 'center',
		justifyContent: 'center',
	},
});
