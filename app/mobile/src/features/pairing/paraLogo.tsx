// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { colors, radius } from '../../theme.js';

/** Para Code の印（モックの `logo()`）。大きさは置き場所で決める（見出し 18・通知の見本 20・このアプリについて 34）。 */
export function ParaLogo({ size }: { size: number }) {
	return <Image source={require('../../../assets/pairing-logo.png')} style={{ width: size, height: size }} resizeMode="contain" accessibilityIgnoresInvertColors />;
}

/** 印を一段明るい面の角丸の台に載せる（モックの `.oicon` 64×64・角丸 14）。 */
export function LogoTile({ children }: { children: ReactNode }) {
	return <View style={styles.tile}>{children}</View>;
}

/** 台の大きさ（pt。モックの `.oicon`）。 */
const TILE_SIZE = 64;

const styles = StyleSheet.create({
	tile: {
		width: TILE_SIZE,
		height: TILE_SIZE,
		borderRadius: radius.card,
		backgroundColor: colors.raised,
		alignItems: 'center',
		justifyContent: 'center',
	},
});
