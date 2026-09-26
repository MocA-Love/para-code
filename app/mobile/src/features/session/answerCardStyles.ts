// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet } from 'react-native';
import { monoFamily } from '../../monoFont.js';
import { HIT_SIZE, colors, radius, space, squircle, type } from '../../theme.js';

/**
 * コンポーザーの直上に出す回答カード（Orca の Permission / Ask。モックの `.pcard`）の共通の見た目。
 * 許可・質問・「読み込み中」の案内が同じ器を使う。
 */
export const cardStyles = StyleSheet.create({
	card: {
		padding: space.md,
		gap: space.sm,
		borderRadius: radius.card,
		...squircle,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.panel,
	},
	head: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	title: {
		flex: 1,
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	question: {
		flex: 1,
		fontSize: type.input,
		fontWeight: '600',
		lineHeight: 21,
		color: colors.text,
	},
	detail: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textDim,
	},
	command: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.text,
		backgroundColor: colors.bg,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		borderRadius: radius.control,
		paddingHorizontal: 10,
		paddingVertical: space.sm,
	},
	/** 選択肢のボタン（モックの `.popt` / `.qopt`）。 */
	option: {
		minHeight: HIT_SIZE,
		justifyContent: 'center',
		paddingHorizontal: space.md,
		paddingVertical: space.sm,
		borderRadius: radius.control,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.raised,
	},
	optionSelected: {
		borderColor: colors.accent,
		backgroundColor: colors.accentWash,
	},
	optionDisabled: {
		opacity: 0.5,
	},
	optionPressed: {
		opacity: 0.7,
	},
	optionLabel: {
		fontSize: type.input,
		color: colors.text,
	},
	optionDescription: {
		marginTop: 2,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
	},
	chip: {
		overflow: 'hidden',
		fontSize: type.caption,
		fontWeight: '600',
		color: colors.textDim,
		backgroundColor: colors.raised,
		borderRadius: radius.key,
		paddingHorizontal: space.sm,
		paddingVertical: 2,
	},
	hint: {
		fontSize: type.caption,
		lineHeight: 15,
		color: colors.textMuted,
	},
	error: {
		fontSize: type.caption,
		lineHeight: 15,
		color: colors.red,
	},
	link: {
		alignSelf: 'flex-start',
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.accent,
	},
});
