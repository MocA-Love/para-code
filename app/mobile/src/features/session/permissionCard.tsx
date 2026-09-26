// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ShieldQuestion, TriangleAlert } from 'lucide-react-native';
import { isSubmissionLocked } from '../../components/answerSubmission.js';
import { APPROVAL_DETAIL_LINES, approvalButtonLayout, isLongApprovalDetail, orderApprovalChoices } from '../../components/approvalCardBehavior.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { dangerousCommandLabels } from '../../dangerousCommand.js';
import { hapticSelection, hapticSuccess, hapticWarning } from '../../haptics.js';
import { useAnswerSubmission } from '../../hooks/useAnswerSubmission.js';
import { monoFamily } from '../../monoFont.js';
import type { AgentApprovalChoice, AgentMessageSendResult } from '../../store.js';
import { alpha, colors, radius, space, tint, type } from '../../theme.js';
import { BottomDrawer, DrawerTitle, Icon } from '../../ui/index.js';
import { cardStyles } from './answerCardStyles.js';
import { SubmissionStatus } from './submissionStatus.js';

/** 「全文を表示」の見た目の高さ（当たり判定は 44 に広げる）。 */
const LINK_HEIGHT = 20;

/**
 * 許可待ちに答えるカード（Orca の MobileNativeChatPermission。モックの許可待ちの `.pcard`）。
 *
 * 送る内容と送り方は旧カード（`components/approvalCard.tsx`）と同じ: PC が広告した選択肢の ID を
 * `onApprove` で送り、送信後の状態は `useAnswerSubmission`（送信済み・応答なし・受け付け済み）。
 * 選択肢が届いていない旧経路では「許可 / 拒否」の2択へ倒す。
 *
 * 見た目はモックに合わせ、主ボタン（最初の許可）を青の塗りで先頭に置き、その他・拒否の順に並べる。
 * 取り消しの利かない操作を含むコマンドは赤いラベルで示し、長い詳細は「全文を表示」でシートに開く。
 */
export function PermissionCard({ interactionId, onApprove, title, detail, choices, refreshing }: {
	interactionId: string;
	onApprove: (interactionId: string, choice: string) => Promise<AgentMessageSendResult>;
	title?: string;
	detail?: string;
	choices?: readonly AgentApprovalChoice[];
	refreshing: boolean;
}) {
	const submission = useAnswerSubmission(interactionId);
	const [detailOpen, setDetailOpen] = useState(false);
	const locked = isSubmissionLocked(submission.state);
	const disabled = locked || refreshing;
	const effectiveChoices: readonly AgentApprovalChoice[] = choices ?? [
		{ id: 'yes', label: '許可', tone: 'approve' },
		{ id: 'no', label: '拒否', tone: 'deny' },
	];
	// 並びは主ボタン → その他（PC の広告順）→ 拒否。どれが主ボタンかは既存の決め方に従う。
	const ordered = useMemo(() => {
		const specs = orderApprovalChoices(effectiveChoices);
		const rank = (variant: string) => (variant === 'primary' ? 0 : variant === 'destructive' ? 2 : 1);
		return [...specs].sort((a, b) => rank(a.variant) - rank(b.variant));
	}, [effectiveChoices]);
	const layout = approvalButtonLayout(effectiveChoices);
	const hasDetail = detail !== undefined && detail.length > 0;
	const longDetail = isLongApprovalDetail(detail);
	const dangers = useMemo(
		() => dangerousCommandLabels([title, detail].filter((part): part is string => part !== undefined).join('\n')),
		[title, detail],
	);
	const error = submission.state.phase === 'idle' ? submission.state.error : undefined;
	const submit = (choice: AgentApprovalChoice) => {
		if (choice.tone === 'deny') {
			hapticWarning();
		} else {
			hapticSuccess();
		}
		void submission.run(() => onApprove(interactionId, choice.id));
	};
	return (
		<View style={cardStyles.card}>
			<View style={cardStyles.head}>
				<Icon icon={ShieldQuestion} color={colors.accent} />
				<Text style={cardStyles.title}>{title ?? 'エージェントが確認を求めています'}</Text>
			</View>
			{dangers.length > 0 ? (
				<View style={styles.dangers}>
					{dangers.map(label => (
						<View key={label} style={styles.danger}>
							<Icon icon={TriangleAlert} size={11} color={colors.red} strokeWidth={2.4} />
							<Text style={styles.dangerText}>{label}</Text>
						</View>
					))}
				</View>
			) : null}
			{hasDetail ? (
				<Text style={cardStyles.command} numberOfLines={APPROVAL_DETAIL_LINES} selectable>{detail}</Text>
			) : null}
			{longDetail ? (
				<Pressable onPress={() => { hapticSelection(); setDetailOpen(true); }} hitSlop={hitSlopToMinimum(LINK_HEIGHT)} accessibilityRole="button">
					<Text style={cardStyles.link}>全文を表示</Text>
				</Pressable>
			) : null}
			{locked ? (
				<SubmissionStatus state={submission.state} onRetry={submission.retry} onReselect={submission.reset} />
			) : effectiveChoices.length > 0 ? (
				<View style={layout === 'row' ? styles.row : styles.column}>
					{ordered.map(({ choice, variant }) => (
						<Pressable
							key={choice.id}
							disabled={disabled}
							onPress={() => submit(choice)}
							style={({ pressed }) => [
								cardStyles.option,
								styles.choice,
								variant === 'primary' ? styles.primary : undefined,
								disabled ? cardStyles.optionDisabled : undefined,
								pressed ? cardStyles.optionPressed : undefined,
							]}
							accessibilityRole="button"
							accessibilityState={{ disabled }}
						>
							<Text style={[styles.choiceText, variant === 'primary' ? styles.primaryText : undefined]}>{choice.label}</Text>
						</Pressable>
					))}
				</View>
			) : null}
			{error !== undefined ? <Text style={cardStyles.error}>{error}</Text> : null}
			{refreshing ? <Text style={cardStyles.error}>最新の内容を取得しています。届くまで回答できません</Text> : null}
			{!locked ? <Text style={cardStyles.hint}>{effectiveChoices.length > 0 ? 'PC 側で回答した場合も自動的に閉じます' : 'PC の Codex の画面で承認内容を確認してください'}</Text> : null}
			{longDetail ? (
				<BottomDrawer visible={detailOpen} onClose={() => setDetailOpen(false)} accessibilityLabel="確認の内容">
					<DrawerTitle title={title ?? '確認の内容'} />
					<Text style={styles.full} selectable>{detail}</Text>
				</BottomDrawer>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	dangers: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.xs,
	},
	danger: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: tint(colors.red, alpha.strong),
		borderRadius: radius.key,
		paddingHorizontal: 6,
		paddingVertical: 1,
	},
	dangerText: {
		fontSize: type.caption,
		fontWeight: '700',
		color: colors.red,
	},
	row: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.sm,
	},
	column: {
		gap: space.sm,
	},
	choice: {
		alignItems: 'center',
	},
	choiceText: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	primary: {
		backgroundColor: colors.accent,
		borderColor: colors.accent,
	},
	primaryText: {
		color: colors.onAccent,
	},
	full: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		lineHeight: 18,
		color: colors.text,
		backgroundColor: colors.panel,
		borderRadius: radius.control,
		padding: space.md,
	},
});
