// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, space, type } from '../theme.js';
import { useDrawerGrabHandlers } from './bottomDrawer.js';

/**
 * 選択肢のシートの上に置く小さな見出し（モックの `.ash`）。13pt の弱い灰で、何についての
 * 操作かを添えるだけ。操作そのものの名前（「削除しますか？」など）には {@link DrawerTitle} を使う。
 */
export function DrawerCaption({ title, message }: { title?: string; message?: string }) {
	// シートの見出しとして、つまみと同じように下へ引いて閉じられる。
	const grab = useDrawerGrabHandlers();
	if (title === undefined && message === undefined) {
		return null;
	}
	return (
		<View style={styles.caption} {...grab}>
			{title !== undefined ? <Text style={styles.captionTitle} numberOfLines={1}>{title}</Text> : null}
			{message !== undefined ? <Text style={styles.captionMessage}>{message}</Text> : null}
		</View>
	);
}

/**
 * 入力や確認のシートの見出し（モックの `.dtitle`）。15pt。右に「クリア」などの小さな操作を置ける。
 */
export function DrawerTitle({ title, right }: { title: string; right?: ReactNode }) {
	// シートの見出しとして、つまみと同じように下へ引いて閉じられる（右のボタンは押せたまま）。
	const grab = useDrawerGrabHandlers();
	return (
		<View style={styles.titleRow} {...grab}>
			<Text style={styles.title} accessibilityRole="header">{title}</Text>
			{right}
		</View>
	);
}

const styles = StyleSheet.create({
	caption: {
		paddingHorizontal: space.xs,
		paddingBottom: space.sm,
	},
	captionTitle: {
		fontSize: type.label,
		fontWeight: '500',
		color: colors.textMuted,
	},
	captionMessage: {
		fontSize: type.meta,
		color: colors.textMuted,
		marginTop: 2,
	},
	titleRow: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		paddingHorizontal: space.xs,
		marginBottom: space.md,
	},
	title: {
		flex: 1,
		fontSize: type.input,
		fontWeight: '600',
		color: colors.text,
	},
});
