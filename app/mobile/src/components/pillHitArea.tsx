// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { HIT_SIZE } from '../theme.js';

/**
 * 見た目の小さいピル・チップ（`SelectablePill`）の当たり判定を HIT_SIZE まで広げる外枠。
 *
 * `SelectablePill` の外殻（ガラス）は色被せ層を切り抜くために `overflow: 'hidden'` を持つ。
 * iOS のヒットテストは clipsToBounds の親の外まで子を探さないので、内側の Pressable に
 * hitSlop を付けてもピルの外のタッチは届かない。そこで外側にもう1枚 Pressable を置き、
 * ピルの周りのタッチはこちらで受ける。ピルの上のタッチはより深い内側の Pressable が先に
 * 応答者になるので、二重には発火しない。
 *
 * 外枠は最低 HIT_SIZE の正方形になるので、並べる行の上下の余白は呼び出し側で詰めること
 * （ピルの見た目の位置を変えずに、当たり判定だけを広げたいため）。
 * 読み上げは内側のピルに任せる（外枠は読み上げの対象にしない）。
 */
export function PillHitArea({ onPress, disabled, children }: {
	onPress: () => void;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<Pressable
			onPress={onPress}
			disabled={disabled}
			accessible={false}
			importantForAccessibility="no"
			style={styles.hit}
		>
			{children}
		</Pressable>
	);
}

/**
 * 見た目の高さ `visualHeight` のピルを PillHitArea で包んだとき、上下にはみ出す当たり判定の幅。
 * 並べる行の marginTop / marginBottom からこれを引くと、ピルの見た目の位置が包む前と変わらない。
 */
export function hitInset(visualHeight: number): number {
	return Math.max(0, (HIT_SIZE - visualHeight) / 2);
}

const styles = StyleSheet.create({
	hit: { minHeight: HIT_SIZE, minWidth: HIT_SIZE, alignItems: 'center', justifyContent: 'center' },
});
