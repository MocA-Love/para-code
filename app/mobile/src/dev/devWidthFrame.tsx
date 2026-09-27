// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useDevWidthOverride } from '../hooks/useSizeClass.js';

/**
 * 開発ビルド専用: `setDevWidthOverride` で狭めた幅でアプリを描き、右の余りを「ほかのアプリ」に見立てて塗る
 * （シミュレータでは Split View を作りにくいので、幅の判定と画面の組み替えをこれで確かめる）。
 *
 * 狭める・戻すで木の形が変わらないよう、中身は常に同じ View の中に置き、幅だけを変える。
 * ルートレイアウトは `__DEV__` のときだけこれで包む（リリースビルドには入らない）。
 */
export function DevWidthFrame({ children }: { children: ReactNode }) {
	const width = useDevWidthOverride();
	return (
		<View style={styles.root}>
			<View style={width !== undefined ? { width } : styles.full}>{children}</View>
			{width !== undefined ? (
				<View style={styles.other}>
					<Text style={styles.label}>{`開発用: アプリの幅 ${width}pt`}</Text>
				</View>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	root: {
		flex: 1,
		flexDirection: 'row',
		backgroundColor: '#000000',
	},
	full: {
		flex: 1,
	},
	other: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		borderLeftWidth: 6,
		borderLeftColor: '#000000',
		backgroundColor: '#1c1c1e',
	},
	label: {
		color: '#8c8c8c',
		fontSize: 13,
	},
});
