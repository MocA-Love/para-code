// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { monoFamily } from '../../monoFont.js';
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN, defaultTerminalFontSize, terminalGridFor } from '../../terminalViewport.js';
import { isTablet } from '../../hooks/useSizeClass.js';
import { colors, radius, space, type } from '../../theme.js';
import { BottomDrawer, DrawerCaption, ListGroup, ListRow } from '../../ui/index.js';

/**
 * Menlo の代表値（100pt のときの1文字送り / 行送り）。見本の桁数の概算にだけ使う
 * （旧「ターミナル」設定画面と同じ値。実寸は WebView でしか測れない）。
 */
const MENLO_APPROX = { charWidth100: 60.205, lineHeight100: 120 };

const SIZES: readonly number[] = Array.from(
	{ length: TERMINAL_FONT_SIZE_MAX - TERMINAL_FONT_SIZE_MIN + 1 },
	(_, index) => TERMINAL_FONT_SIZE_MIN + index,
);

/**
 * ターミナルの文字サイズを選ぶシート（モックの「ターミナルの文字サイズ」）。
 * 上に実物と同じ地の見本（選んでいる大きさ）と、この幅でおよその桁数、下に大きさの一覧。
 *
 * 幅は見本の枠を実測する（ウィンドウ幅から引き算すると、iPad では本文の列より広く出てしまう）。
 */
export function TerminalFontSizeDrawer({ visible, fontSize, onSelect, onClose }: {
	visible: boolean;
	fontSize: number;
	onSelect: (size: number) => void;
	onClose: () => void;
}) {
	const [previewWidth, setPreviewWidth] = useState(0);
	const grid = terminalGridFor(previewWidth - space.md * 2, 1000, fontSize, MENLO_APPROX);
	return (
		<BottomDrawer visible={visible} onClose={onClose} accessibilityLabel="ターミナルの文字サイズ">
			<DrawerCaption title="ターミナルの文字サイズ" />
			<View style={styles.preview} onLayout={event => setPreviewWidth(event.nativeEvent.layout.width)}>
				<Text style={[styles.line, { fontSize }]} numberOfLines={1}>
					<Text style={styles.prompt}>$ </Text>git status --short
				</Text>
				<Text style={[styles.line, styles.modified, { fontSize }]} numberOfLines={1}> M src/components/termView.tsx</Text>
				<Text style={[styles.line, { fontSize }]} numberOfLines={1}>
					<Text style={styles.prompt}>$ </Text>▊
				</Text>
			</View>
			{grid !== undefined ? <Text style={styles.cols}>この幅でおよそ 1行 {grid.cols} 桁</Text> : null}
			<ListGroup>
				{SIZES.map(size => (
					<ListRow
						key={size}
						label={`${size}pt`}
						hint={size === defaultTerminalFontSize(isTablet) ? '既定' : undefined}
						trailing={size === fontSize ? 'check' : 'none'}
						selected={size === fontSize}
						onPress={() => onSelect(size)}
					/>
				))}
			</ListGroup>
		</BottomDrawer>
	);
}

const styles = StyleSheet.create({
	preview: {
		marginHorizontal: space.xs,
		marginBottom: space.sm,
		paddingVertical: space.sm + 2,
		paddingHorizontal: space.md,
		backgroundColor: colors.terminalBg,
		borderRadius: radius.row,
		overflow: 'hidden',
	},
	line: {
		fontFamily: monoFamily,
		color: colors.terminalFg,
	},
	prompt: {
		color: colors.add,
	},
	// 端末の git status の「M」の色。アプリの配色ではなく端末側の色のまま置く
	modified: {
		color: colors.orange,
	},
	cols: {
		fontSize: type.meta,
		color: colors.textMuted,
		marginHorizontal: space.xs,
		marginBottom: space.md,
	},
});
