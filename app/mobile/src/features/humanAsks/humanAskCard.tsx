// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { QuestionCard, QuestionGroupCard } from '../../components/questionCard.js';
import { haptic } from '../../haptics.js';
import { useParaToast } from '../../paraToast.js';
import type { AgentMessageSendResult, AgentQuestionAnswer } from '../../store.js';
import { formatRelativeTime } from '../../time.js';
import { Button, ConfirmDrawer } from '../../ui/index.js';
import { TextInputDrawer } from '../../ui/textInputDrawer.js';
import { colors, radius, space, type } from '../../theme.js';
import { answerHumanAsk } from './humanAskStore.js';
import {
	humanAskQuestionAnswer,
	humanAskQuestionMessages,
	humanAskRefusalText,
	humanAskSourceLabel,
	newHumanAskOpId,
	type HumanAsk,
	type HumanAskAction,
	type HumanAskAnswer,
	type HumanAskQuestionAnswer,
} from './humanAsks.js';

/**
 * 要対応の台帳の 1 件のカード（ボードの質問・承認・止まった、Bot の質問、ask_human の質問）。
 *
 * 質問は今の質問カード（選んでから「回答する」）、ボタンはボードの画面・受信箱と同じ確認を挟む（`confirm` のある
 * ボタンは確認のシート、文を添えられるボタンは入力のシート）。許可はここに出ない（今の許可カードのまま）。
 */
export const HumanAskCard = memo(function HumanAskCard({ pcId, ask, now }: { pcId: string; ask: HumanAsk; now: number }) {
	const [answered, setAnswered] = useState(false);
	const [sending, setSending] = useState(false);
	const [confirming, setConfirming] = useState<HumanAskAction | undefined>(undefined);
	const [writing, setWriting] = useState<HumanAskAction | undefined>(undefined);
	const messages = useMemo(() => humanAskQuestionMessages(ask), [ask]);
	const locked = answered || sending || ask.busy;

	const send = useCallback(async (answer: HumanAskAnswer): Promise<AgentMessageSendResult> => {
		setSending(true);
		const outcome = await answerHumanAsk(pcId, ask.key, answer, newHumanAskOpId());
		setSending(false);
		if (outcome.ok) {
			setAnswered(true);
			haptic('success');
			useParaToast.getState().show({ key: `human-ask-${ask.key}`, text: '回答を送りました', sub: ask.from.title, icon: 'checkmark-circle-outline', tone: 'done' }, 2_500);
			return { status: 'accepted' };
		}
		if (outcome.reason === 'gone') {
			setAnswered(true);
		}
		const message = humanAskRefusalText(outcome.reason);
		useParaToast.getState().show({ key: `human-ask-${ask.key}`, text: message, icon: 'alert-circle-outline', tone: 'warn' }, 3_500);
		return { status: 'rejected', message };
	}, [pcId, ask.key, ask.from.title]);

	const answerOne = useCallback((index: number, answer: AgentQuestionAnswer) => {
		const question = ask.questions[index];
		const item = question !== undefined ? humanAskQuestionAnswer(question, answer) : undefined;
		return item !== undefined ? send({ type: 'answers', answers: [item] }) : Promise.resolve<AgentMessageSendResult>({ status: 'rejected', message: humanAskRefusalText('invalid') });
	}, [ask.questions, send]);

	const submitGroup = useCallback((_id: string, _questions: unknown, answers: readonly AgentQuestionAnswer[]) => {
		const items = ask.questions.map((question, index) => answers[index] !== undefined ? humanAskQuestionAnswer(question, answers[index]) : undefined);
		const complete = items.every((item): item is HumanAskQuestionAnswer => item !== undefined);
		return complete ? send({ type: 'answers', answers: items }) : Promise.resolve<AgentMessageSendResult>({ status: 'rejected', message: humanAskRefusalText('invalid') });
	}, [ask.questions, send]);

	const press = (action: HumanAskAction) => {
		if (action.allowText === true) {
			setWriting(action);
		} else if (action.confirm !== undefined) {
			setConfirming(action);
		} else {
			void send({ type: 'action', actionId: action.id });
		}
	};

	return (
		<View style={styles.card} accessible={false}>
			<View style={styles.top}>
				<View style={styles.chip}><Text style={styles.chipText}>{humanAskSourceLabel(ask)}</Text></View>
				<Text style={styles.title} numberOfLines={1}>{ask.from.title}</Text>
				<Text style={styles.time}>{formatRelativeTime(ask.askedAt, now)}</Text>
			</View>
			{ask.from.detail !== undefined ? <Text style={styles.detail} numberOfLines={1}>{ask.from.detail}</Text> : null}
			{ask.preface !== undefined ? <Text style={styles.preface} numberOfLines={5}>{ask.preface}</Text> : null}
			{ask.busy ? <Text style={styles.note}>ほかの場所で答えて、届けています</Text> : ask.failed ? <Text style={styles.note}>前の答えを届けられませんでした</Text> : null}
			{messages.length === 1 && messages[0] !== undefined ? (
				<QuestionCard
					message={messages[0]}
					answered={answered}
					refreshing={locked}
					onAnswer={(_id, _shape, index) => answerOne(0, { kind: 'option', index })}
					onMulti={(_id, _shape, indices) => answerOne(0, { kind: 'multi', indices })}
					onFreeText={(_id, shape, text) => answerOne(0, { kind: 'text', optionCount: shape.optionCount, text })}
				/>
			) : messages.length > 1 ? (
				<QuestionGroupCard messages={messages} answered={answered} refreshing={locked} onSubmit={submitGroup} />
			) : null}
			{ask.actions.length > 0 || ask.canSkip ? (
				<View style={styles.actions}>
					{ask.actions.map((action, index) => (
						<Button key={action.id} label={action.label} size="sm" variant={index === 0 ? 'primary' : 'outline'} disabled={locked} onPress={() => press(action)} />
					))}
					{ask.canSkip ? <Button label="飛ばす" size="sm" variant="ghost" disabled={locked} onPress={() => void send({ type: 'skip' })} /> : null}
				</View>
			) : null}
			<ConfirmDrawer
				visible={confirming !== undefined}
				title={confirming?.confirm?.title ?? ''}
				{...(confirming?.confirm?.body !== undefined ? { message: confirming.confirm.body } : {})}
				confirmLabel={confirming?.confirm?.ok ?? ''}
				destructive={false}
				onConfirm={() => {
					const action = confirming;
					if (action !== undefined) {
						void send({ type: 'action', actionId: action.id });
					}
				}}
				onClose={() => setConfirming(undefined)}
			/>
			<TextInputDrawer
				visible={writing !== undefined}
				title={writing?.confirm?.title ?? writing?.label ?? ''}
				{...(writing?.confirm?.body !== undefined ? { message: writing.confirm.body } : {})}
				placeholder="ひとこと添える（任意）"
				submitLabel={writing?.confirm?.ok ?? writing?.label ?? '送る'}
				allowEmpty
				maxLength={8000}
				onSubmit={value => {
					const action = writing;
					if (action !== undefined) {
						const note = value.trim();
						void send({ type: 'action', actionId: action.id, ...(note.length > 0 ? { text: note } : {}) });
					}
				}}
				onClose={() => setWriting(undefined)}
			/>
		</View>
	);
});

const styles = StyleSheet.create({
	card: {
		marginHorizontal: space.lg,
		marginVertical: space.xs,
		padding: space.md,
		gap: space.xs,
		borderRadius: radius.card,
		backgroundColor: colors.panel,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
	},
	top: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.snug,
	},
	chip: {
		paddingHorizontal: space.xs,
		paddingVertical: 1,
		borderRadius: radius.pill,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.borderStrong,
	},
	chipText: {
		fontSize: type.caption,
		color: colors.textDim,
	},
	title: {
		flexShrink: 1,
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	time: {
		marginLeft: 'auto',
		fontSize: type.caption,
		color: colors.textMuted,
	},
	detail: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	preface: {
		fontSize: type.body,
		color: colors.textDim,
	},
	note: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	actions: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.xs,
		paddingTop: space.xs,
	},
});
