// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { haptic, type HapticToken } from '../haptics.js';
import { colors, space, type } from '../theme.js';
import { BottomDrawer } from './bottomDrawer.js';
import { Button } from './button.js';
import { DrawerTitle } from './drawerHeader.js';

/**
 * 確認のシート（モックの削除確認）。見出し・説明・「キャンセル」と確定の2つのボタン。
 * 確定は既定で赤（`destructive`）。取り消せる操作の確認なら `destructive={false}` で白の主ボタンにする。
 *
 * `onConfirm` は**シートが閉じ切ってから**呼ぶ（確定のあとに画面を移る・別のシートを出すことが多いため）。
 *
 * ```tsx
 * <ConfirmDrawer
 *   visible={confirming}
 *   title="ターミナルを閉じますか？"
 *   message="PC の Para Code でも閉じます。この操作は取り消せません。"
 *   confirmLabel="閉じる"
 *   onConfirm={closeTerminal}
 *   onClose={() => setConfirming(false)}
 * />
 * ```
 */
export function ConfirmDrawer({ visible, title, message, confirmLabel, cancelLabel = 'キャンセル', destructive = true, haptic: confirmHaptic, onConfirm, onCancelled, onClose }: {
	visible: boolean;
	title: string;
	message?: string;
	confirmLabel: string;
	cancelLabel?: string;
	destructive?: boolean;
	/**
	 * 確定を押したときの触覚。省くと `destructive` に合わせる（赤なら `danger`、白なら `commit`）。
	 * 見た目は白でも取り消せない操作（PR のマージなど）は `danger` を渡す。
	 */
	haptic?: HapticToken;
	onConfirm: () => void;
	/** 確定せずに閉じ切った後に呼ぶ（別のシートから開いた確かめで、元のシートへ戻すときに使う。任意）。 */
	onCancelled?: () => void;
	/** キャンセル・幕・引き下げで呼ばれる。親は `visible` を false にする。 */
	onClose: () => void;
}) {
	const confirmed = useRef(false);
	return (
		<BottomDrawer
			visible={visible}
			onClose={onClose}
			onAfterClose={() => {
				if (confirmed.current) {
					confirmed.current = false;
					onConfirm();
				} else {
					onCancelled?.();
				}
			}}
			accessibilityLabel={title}
		>
			<DrawerTitle title={title} />
			{message !== undefined ? <Text style={styles.message}>{message}</Text> : null}
			<View style={styles.buttons}>
				<Button label={cancelLabel} variant="secondary" onPress={onClose} style={styles.button} />
				<Button
					label={confirmLabel}
					variant={destructive ? 'danger' : 'primary'}
					onPress={() => {
						// 確定を押した時点で手応えを返す（取り消せない操作は danger、確認を出すときには鳴らさない）
						haptic(confirmHaptic ?? (destructive ? 'danger' : 'commit'));
						confirmed.current = true;
						onClose();
					}}
					style={styles.button}
				/>
			</View>
		</BottomDrawer>
	);
}

const styles = StyleSheet.create({
	message: {
		fontSize: type.body,
		lineHeight: 20,
		color: colors.textDim,
		paddingHorizontal: space.xs,
	},
	buttons: {
		flexDirection: 'row',
		gap: space.sm,
		marginTop: space.lg,
	},
	button: {
		flex: 1,
	},
});
