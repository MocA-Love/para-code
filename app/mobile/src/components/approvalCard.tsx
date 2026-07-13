// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme.js';
import { hapticSuccess, hapticWarning } from '../haptics.js';
import type { AgentApprovalChoice } from '../store.js';

/**
 * エージェントの許可確認(permission)カード。Codex app-serverが広告した選択肢は
 * そのまま表示し、hookだけの旧経路では許可/拒否の2択へフォールバックする。
 * agent.tsx（TUIチャット画面）とホーム画面のアテンションカードの両方から使う。
 */
export function ApprovalCard({ interactionId, onApprove, title, detail, choices }: {
	interactionId: string;
	onApprove: (interactionId: string, choice: string) => Promise<boolean>;
	title?: string;
	detail?: string;
	choices?: readonly AgentApprovalChoice[];
}) {
	const [submitting, setSubmitting] = useState(false);
	const effectiveChoices: readonly AgentApprovalChoice[] = choices ?? [
		{ id: 'yes', label: '許可', tone: 'approve' },
		{ id: 'no', label: '拒否', tone: 'deny' },
	];
	const submit = (choice: AgentApprovalChoice) => {
		setSubmitting(true);
		const retry = setTimeout(() => setSubmitting(false), 15_000);
		void onApprove(interactionId, choice.id).then(accepted => { if (!accepted) { clearTimeout(retry); setSubmitting(false); } });
	};
	return (
		<View style={styles.approvalBar}>
			<Text style={styles.approvalText}>{title ?? 'エージェントが確認を求めています'}</Text>
			{detail !== undefined && detail.length > 0 ? (
				<Text style={styles.approvalDetail} numberOfLines={6} selectable>{detail}</Text>
			) : null}
			{effectiveChoices.length > 0 ? (
				<View style={styles.approvalButtons}>
					{effectiveChoices.map(choice => (
						<Pressable
							key={choice.id}
							disabled={submitting}
							accessibilityRole="button"
							accessibilityState={{ disabled: submitting }}
							style={[styles.approvalBtn, choice.tone === 'approve' ? styles.approveBtn : choice.tone === 'deny' ? styles.denyBtn : styles.neutralBtn, submitting && styles.disabled]}
							onPress={() => { choice.tone === 'deny' ? hapticWarning() : hapticSuccess(); submit(choice); }}
						>
							<Text style={choice.tone === 'approve' ? styles.approveBtnText : choice.tone === 'deny' ? styles.denyBtnText : styles.neutralBtnText}>{choice.label}</Text>
						</Pressable>
					))}
				</View>
			) : null}
			<Text style={styles.approvalHint}>{effectiveChoices.length > 0 ? 'PC側で回答した場合も自動的に閉じます' : 'PCのCodex画面で承認内容を確認してください'}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	approvalBar: { backgroundColor: 'rgba(224,192,125,.10)', borderWidth: 1, borderColor: colors.yellow, borderRadius: 16, padding: 14, gap: 8 },
	approvalText: { color: colors.text, fontSize: 13, fontWeight: '600' },
	approvalDetail: { color: colors.text, fontSize: 11.5, lineHeight: 16, fontFamily: 'Menlo', backgroundColor: colors.surface2, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
	approvalButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
	approvalBtn: { flexGrow: 1, flexBasis: '46%', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
	disabled: { opacity: 0.6 },
	approveBtn: { backgroundColor: colors.green },
	neutralBtn: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
	denyBtn: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: 'rgba(244,114,114,.3)' },
	approveBtnText: { color: colors.bg, fontSize: 13, fontWeight: '700' },
	neutralBtnText: { color: colors.text, fontSize: 12, fontWeight: '600', textAlign: 'center' },
	denyBtnText: { color: colors.red, fontSize: 13, fontWeight: '700' },
	approvalHint: { color: colors.textDim, fontSize: 10 },
});
