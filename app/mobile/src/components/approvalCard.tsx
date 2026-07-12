// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme.js';
import { hapticSuccess, hapticWarning } from '../haptics.js';

/**
 * エージェントの許可確認(permission)カード。許可/拒否の2択クイックアクション。
 * detail には PermissionRequest hook 由来の承認内容（ツール名+コマンド等）が入る。
 * 選択肢が複数ある場合はTUI側（ターミナルタブ）での回答を促す注記を出す
 * （PTY注入は番号ベースのため、選択肢が2つより多いケースを安全に扱えないため）。
 * agent.tsx（TUIチャット画面）とホーム画面のアテンションカードの両方から使う。
 */
export function ApprovalCard({ interactionId, onApprove, detail }: { interactionId: string; onApprove: (interactionId: string, choice: 'yes' | 'no') => Promise<boolean>; detail?: string }) {
	const [submitting, setSubmitting] = useState(false);
	const submit = (choice: 'yes' | 'no') => {
		setSubmitting(true);
		void onApprove(interactionId, choice).then(accepted => { if (!accepted) { setSubmitting(false); } });
	};
	return (
		<View style={styles.approvalBar}>
			<Text style={styles.approvalText}>エージェントが確認を求めています</Text>
			{detail !== undefined && detail.length > 0 ? (
				<Text style={styles.approvalDetail} numberOfLines={6} selectable>{detail}</Text>
			) : null}
			<View style={styles.approvalButtons}>
				<Pressable disabled={submitting} style={[styles.approvalBtn, styles.approveBtn, submitting && styles.disabled]} onPress={() => { hapticSuccess(); submit('yes'); }}>
					<Text style={styles.approveBtnText}>許可</Text>
				</Pressable>
				<Pressable disabled={submitting} style={[styles.approvalBtn, styles.denyBtn, submitting && styles.disabled]} onPress={() => { hapticWarning(); submit('no'); }}>
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
	approvalDetail: { color: colors.text, fontSize: 11.5, lineHeight: 16, fontFamily: 'Menlo', backgroundColor: colors.surface2, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
	approvalButtons: { flexDirection: 'row', gap: 10 },
	approvalBtn: { flex: 1, borderRadius: 12, paddingVertical: 10, alignItems: 'center' },
	disabled: { opacity: 0.6 },
	approveBtn: { backgroundColor: colors.green },
	denyBtn: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: 'rgba(244,114,114,.3)' },
	approveBtnText: { color: colors.bg, fontSize: 13, fontWeight: '700' },
	denyBtnText: { color: colors.red, fontSize: 13, fontWeight: '700' },
	approvalHint: { color: colors.textDim, fontSize: 10 },
});
