// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { alpha, colors, radius, space, squircle, tint, type } from '../theme.js';
import { monoFamily } from '../monoFont.js';
import { hapticSelection, hapticSuccess, hapticWarning } from '../haptics.js';
import type { AgentApprovalChoice, AgentMessageSendResult } from '../store.js';
import { dangerousCommandLabels } from '../dangerousCommand.js';
import { useAnswerSubmission } from '../hooks/useAnswerSubmission.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { Badge } from './badge.js';
import { BottomSheet } from './bottomSheet.js';
import { Button } from './button.js';
import { AnswerSubmissionStatus } from './answerSubmissionStatus.js';
import { isSubmissionLocked } from './answerSubmission.js';
import { APPROVAL_DETAIL_LINES, approvalButtonLayout, isLongApprovalDetail, orderApprovalChoices } from './approvalCardBehavior.js';

/**
 * エージェントの許可確認(permission)カード。Codex app-serverが広告した選択肢は
 * そのまま表示し、hookだけの旧経路では許可/拒否の2択へフォールバックする。
 * agent.tsx（TUIチャット画面）とホーム画面のアテンションカードの両方から使う。
 *
 * - コマンドに取り消しの利かない操作が含まれていれば赤いラベルで示す（`dangerousCommand.ts`）
 * - 詳細が長ければ「全文を表示」でシートに開く（カードは6行まで）
 * - ボタンは [拒否] [その他] [許可] の順。許可だけが主ボタン
 * - 送ったあとは「送信済み・PC の応答を待っています」。送信中のまま時間切れになったときだけ再送の導線を出す
 *   （PC が受け付けたあとに時間切れになったら、再送せず PC の画面での確認を促す）
 */
export function ApprovalCard({ interactionId, onApprove, title, detail, choices, refreshing }: {
	interactionId: string;
	onApprove: (interactionId: string, choice: string) => Promise<AgentMessageSendResult>;
	title?: string;
	detail?: string;
	choices?: readonly AgentApprovalChoice[];
	/** 再取得の応答待ち。カードは出したまま操作だけ止める（差し替えるとローカルの失敗表示が消える）。 */
	refreshing?: boolean;
}) {
	const submission = useAnswerSubmission(interactionId);
	const [detailOpen, setDetailOpen] = useState(false);
	// 対象が入れ替わったら開いていた全文シートも用済み。
	useEffect(() => { setDetailOpen(false); }, [interactionId]);
	const locked = isSubmissionLocked(submission.state);
	const disabled = locked || refreshing === true;
	const effectiveChoices: readonly AgentApprovalChoice[] = choices ?? [
		{ id: 'yes', label: '許可', tone: 'approve' },
		{ id: 'no', label: '拒否', tone: 'deny' },
	];
	const buttons = orderApprovalChoices(effectiveChoices);
	const layout = approvalButtonLayout(effectiveChoices);
	const hasDetail = detail !== undefined && detail.length > 0;
	const longDetail = isLongApprovalDetail(detail);
	// 危険な操作の判定は長いコマンドやパッチ全体を正規表現で走査する。カードは再取得中の切り替えや
	// 送信状態の変化でも描き直されるので、判定は見出しと詳細が変わったときだけやり直す。
	const dangers = useMemo(
		() => dangerousCommandLabels([title, detail].filter((part): part is string => part !== undefined).join('\n')),
		[title, detail],
	);
	const error = submission.state.phase === 'idle' ? submission.state.error : undefined;
	// 失敗理由は必ず画面へ出す。boolean だけを見ていた頃は、接続断・対象変更・PC側の
	// stale-interaction のどれで落ちても「押したのに何も起きない」としか見えなかった。
	const submit = (choice: AgentApprovalChoice) => {
		void submission.run(() => onApprove(interactionId, choice.id));
	};
	return (
		<View style={styles.approvalBar}>
			<Text style={styles.approvalText}>{title ?? 'エージェントが確認を求めています'}</Text>
			{dangers.length > 0 ? (
				<View style={styles.badges}>
					{dangers.map(label => <Badge key={label} label={label} tone="red" icon="warning-outline" />)}
				</View>
			) : null}
			{hasDetail ? (
				<Text style={styles.approvalDetail} numberOfLines={APPROVAL_DETAIL_LINES} selectable>{detail}</Text>
			) : null}
			{longDetail ? (
				<Button label="全文を表示" variant="ghost" size="sm" style={styles.fullBtn} onPress={() => { hapticSelection(); setDetailOpen(true); }} />
			) : null}
			{locked ? (
				<AnswerSubmissionStatus state={submission.state} onRetry={submission.retry} onReselect={submission.reset} />
			) : effectiveChoices.length > 0 ? (
				<View style={layout === 'row' ? styles.buttonsRow : styles.buttonsColumn}>
					{/* 縦に積むときは主ボタンを一番上に置く（指が最初に届く位置）。 */}
					{(layout === 'row' ? buttons : [...buttons].reverse()).map(({ choice, variant }) => (
						<Button
							key={choice.id}
							label={choice.label}
							variant={variant}
							flex={layout === 'row'}
							disabled={disabled}
							onPress={() => { choice.tone === 'deny' ? hapticWarning() : hapticSuccess(); submit(choice); }}
						/>
					))}
				</View>
			) : null}
			{error !== undefined ? <Text style={styles.approvalError}>{error}</Text> : null}
			{refreshing === true ? <Text style={styles.approvalError}>最新の内容を取得しています。届くまで回答できません</Text> : null}
			{!locked ? <Text style={styles.approvalHint}>{effectiveChoices.length > 0 ? 'PC側で回答した場合も自動的に閉じます' : 'PCのCodex画面で承認内容を確認してください'}</Text> : null}
			{longDetail ? <ApprovalDetailSheet visible={detailOpen} title={title} detail={detail ?? ''} onClose={() => setDetailOpen(false)} /> : null}
		</View>
	);
}

/** 詳細の全文。長いコマンドやパッチはカードの6行では読み切れないため、シートで全体をスクロールさせる。 */
function ApprovalDetailSheet({ visible, title, detail, onClose }: { visible: boolean; title?: string; detail: string; onClose: () => void }) {
	const insets = useStableInsets();
	return (
		<BottomSheet visible={visible} onClose={onClose} title={title ?? '確認の内容'}>
			<ScrollView style={styles.sheetBody} contentContainerStyle={{ paddingBottom: space.xl + insets.bottom }}>
				<Text style={styles.sheetDetail} selectable>{detail}</Text>
			</ScrollView>
		</BottomSheet>
	);
}

const styles = StyleSheet.create({
	// 面は無彩色にし、色は主ボタン（白）と拒否（赤文字）だけに使う。要対応であることはホームの札・見出しが示す。
	approvalBar: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.card, ...squircle, padding: 14, gap: 8 },
	approvalText: { color: colors.text, fontSize: type.body, fontWeight: '600' },
	badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
	approvalDetail: { color: colors.text, fontSize: type.meta, lineHeight: 17, fontFamily: monoFamily, backgroundColor: colors.surface2, borderRadius: radius.control, paddingHorizontal: 10, paddingVertical: 8 },
	fullBtn: { alignSelf: 'flex-start', paddingHorizontal: 4 },
	buttonsRow: { flexDirection: 'row', gap: 8 },
	buttonsColumn: { gap: 8 },
	approvalHint: { color: colors.textDim, fontSize: type.badge },
	approvalError: { color: colors.red, fontSize: type.caption, lineHeight: 15 },
	sheetBody: { paddingHorizontal: 20 },
	sheetDetail: { color: colors.text, fontSize: type.meta, lineHeight: 18, fontFamily: monoFamily, backgroundColor: tint(colors.textDim, alpha.faint), borderRadius: radius.control, ...squircle, padding: 12 },
});
