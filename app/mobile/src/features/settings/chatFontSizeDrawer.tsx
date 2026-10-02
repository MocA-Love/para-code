// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, Text, View } from 'react-native';
import { CHAT_FONT_SCALE_STEPS, chatFontSizeLabel, scaleChatStyles, type ChatFontSize } from '../../chatTextScale.js';
import { monoFamily } from '../../monoFont.js';
import { colors, radius, space, squircle, type } from '../../theme.js';
import { useChatTextScaleFor } from '../../ui/chatTextScale.js';
import { BottomDrawer, DrawerCaption, ListGroup, ListRow, useThemeColors } from '../../ui/index.js';

const OPTIONS: readonly ChatFontSize[] = ['system', ...CHAT_FONT_SCALE_STEPS];

/**
 * 会話表示の文字サイズを選ぶシート（ターミナルの文字サイズのシートと同じ作り）。
 * 上に会話の見本（自分の発言・エージェントの発言・コード）を選んでいる大きさで描き、下に大きさの一覧。
 *
 * 見本は会話の部品と同じ倍率の計算（`scaleChatStyles`）を通すので、OS の文字サイズとの関係も
 * 実物と同じに見える。
 */
export function ChatFontSizeDrawer({ visible, fontSize, onSelect, onClose }: {
	visible: boolean;
	fontSize: ChatFontSize;
	onSelect: (size: ChatFontSize) => void;
	onClose: () => void;
}) {
	const theme = useThemeColors();
	const styles = scaleChatStyles(baseStyles, useChatTextScaleFor(fontSize));
	return (
		<BottomDrawer visible={visible} onClose={onClose} accessibilityLabel="チャットの文字サイズ">
			<DrawerCaption title="チャットの文字サイズ" />
			<View style={styles.preview} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
				<View style={styles.userRow}>
					<View style={[styles.bubble, { backgroundColor: theme.bubble }]}>
						<Text style={[styles.bubbleText, { color: theme.onBubble }]}>テストを直してください</Text>
					</View>
				</View>
				<Text style={styles.body}>失敗していた 2 件を直しました。<Text style={styles.bold}>日付の境界</Text>の扱いが原因です。</Text>
				<View style={styles.code}>
					<Text style={styles.codeText} numberOfLines={1}>{"expect(parse('2026-10-01')).toBe(1)"}</Text>
				</View>
			</View>
			<ListGroup>
				{OPTIONS.map(option => (
					<ListRow
						key={String(option)}
						label={chatFontSizeLabel(option)}
						hint={option === 'system' ? '既定。iPhone・iPad の文字サイズの設定に従います' : option === 100 ? '標準の大きさ（OS の設定はかけません）' : undefined}
						trailing={option === fontSize ? 'check' : 'none'}
						selected={option === fontSize}
						onPress={() => onSelect(option)}
					/>
				))}
			</ListGroup>
		</BottomDrawer>
	);
}

/** 会話の行（`chatItems.tsx`・`markdownText.tsx`）と同じ値。 */
const baseStyles = StyleSheet.create({
	preview: {
		marginHorizontal: space.xs,
		marginBottom: space.md,
		paddingVertical: space.md,
		paddingHorizontal: space.md,
		gap: space.sm,
		backgroundColor: colors.bg,
		borderRadius: radius.row,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		overflow: 'hidden',
	},
	userRow: {
		flexDirection: 'row',
		justifyContent: 'flex-end',
	},
	bubble: {
		flexShrink: 1,
		paddingHorizontal: space.md,
		paddingVertical: space.sm,
		borderRadius: radius.composer,
		...squircle,
	},
	bubbleText: {
		fontSize: type.chat,
		lineHeight: 23,
		fontWeight: '500',
	},
	body: {
		color: colors.text,
		fontSize: type.body,
		lineHeight: 20,
	},
	bold: {
		fontWeight: '700',
	},
	code: {
		padding: 8,
		backgroundColor: colors.codeBg,
		borderRadius: radius.control,
		...squircle,
		borderWidth: 1,
		borderColor: colors.border,
	},
	codeText: {
		color: colors.text,
		fontFamily: monoFamily,
		fontSize: type.caption,
		lineHeight: 16,
	},
});
