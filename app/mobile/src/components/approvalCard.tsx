// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme.js';

/**
 * エージェントの許可確認(permission)カード。許可/拒否の2択クイックアクション。
 * 選択肢が複数ある場合はTUI側（ターミナルタブ）での回答を促す注記を出す
 * （PTY注入は番号ベースのため、選択肢が2つより多いケースを安全に扱えないため）。
 * agent.tsx（TUIチャット画面）とホーム画面のアテンションカードの両方から使う。
 */
export function ApprovalCard({ onApprove }: { onApprove: (choice: 'yes' | 'no') => void }) {
	return (
		<View style={styles.approvalBar}>
			<Text style={styles.approvalText}>エージェントが確認を求めています</Text>
			<View style={styles.approvalButtons}>
				<Pressable style={[styles.approvalBtn, styles.approveBtn]} onPress={() => onApprove('yes')}>
					<Text style={styles.approveBtnText}>許可</Text>
				</Pressable>
				<Pressable style={[styles.approvalBtn, styles.denyBtn]} onPress={() => onApprove('no')}>
					<Text style={styles.denyBtnText}>拒否</Text>
				</Pressable>
			</View>
			<Text style={styles.approvalHint}>選択肢が複数ある場合はターミナルタブで確認できます</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	approvalBar: { backgroundColor: 'rgba(224,192,125,.10)', borderWidth: 1, borderColor: colors.yellow, borderRadius: 16, padding: 14, gap: 8 },
	approvalText: { color: colors.text, fontSize: 13, fontWeight: '600' },
	approvalButtons: { flexDirection: 'row', gap: 10 },
	approvalBtn: { flex: 1, borderRadius: 12, paddingVertical: 10, alignItems: 'center' },
	approveBtn: { backgroundColor: colors.green },
	denyBtn: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: 'rgba(244,114,114,.3)' },
	approveBtnText: { color: colors.bg, fontSize: 13, fontWeight: '700' },
	denyBtnText: { color: colors.red, fontSize: 13, fontWeight: '700' },
	approvalHint: { color: colors.textDim, fontSize: 10 },
});
