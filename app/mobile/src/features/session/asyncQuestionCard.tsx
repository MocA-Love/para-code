// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Check, CircleHelp } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import {
	asyncAnswerText, buildAsyncReply, useAsyncQuestionDrafts, type AsyncQuestion,
} from '../../asyncQuestions.js';
import type { QuestionFreeTextRequest } from '../../components/questionCard.js';
import { haptic } from '../../haptics.js';
import type { AgentMessageSendResult } from '../../store.js';
import { colors, radius, space, type } from '../../theme.js';
import { Button, Icon, iconSize, useThemeColors } from '../../ui/index.js';
import { useChatIconSize, useChatStyles } from '../../ui/chatTextScale.js';
import { cardStyles as baseCardStyles } from './answerCardStyles.js';
import { OptionButton } from './askCard.js';

/** 「その他（入力して回答）」の依頼の ID の頭（ほかの質問の依頼と分ける。agentChatPane が見る）。 */
export const ASYNC_FREE_TEXT_PREFIX = 'async:';

/** 丸いタブの当たり判定（askCard と同じ）。 */
const STEP_SLOP = { top: 4, bottom: 4, left: 0, right: 0 };

/**
 * Codex の非同期の質問（request_user_input_async）のカード。見た目は質問のカード（askCard の AskGroupCard）と同じ器で、
 * 1 回の呼び出しの問いを丸いタブで切り替える。
 *
 * 違うのは、作業を止めずに出る質問なので「作業は続いています／終わっています」の札を出すことと、**一部の問いだけ答えて送れる**こと。
 * 送るのは答えた問いだけで、残りの問いはこのカードに残る（書きかけはこの端末の `useAsyncQuestionDrafts` に持つ）。
 * 答えは Codex が決めた返信の形の発言に組み立てて、普通の発言と同じ `onSend` で送る。
 */
export function AsyncQuestionCard({ questions, working, onSend, onRequestFreeText, freeTextActiveId }: {
	/** 1 回の呼び出しのうち、まだ答えていない問い（番号順）。 */
	questions: readonly AsyncQuestion[];
	/** エージェントが作業中か（送るとその作業に割り込む）。 */
	working: boolean;
	onSend: (text: string) => Promise<AgentMessageSendResult>;
	onRequestFreeText: (request: QuestionFreeTextRequest | undefined) => void;
	/** 下の入力欄が答えの入力になっている問い（{@link ASYNC_FREE_TEXT_PREFIX} 付きの ID）。 */
	freeTextActiveId: string | undefined;
}) {
	const theme = useThemeColors();
	const cardStyles = useChatStyles(baseCardStyles);
	const styles = useChatStyles(baseStyles);
	const headIconSize = useChatIconSize(15);
	const checkIconSize = useChatIconSize(iconSize.xs);
	const { drafts, setDraft, markSent, dismiss } = useAsyncQuestionDrafts(useShallow(s => ({ drafts: s.drafts, setDraft: s.setDraft, markSent: s.markSent, dismiss: s.dismiss })));
	const [step, setStep] = useState(0);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	useEffect(() => {
		setStep(previous => Math.min(previous, Math.max(0, questions.length - 1)));
	}, [questions.length]);
	const current = questions[Math.min(step, questions.length - 1)];
	const answeredCount = questions.filter(question => asyncAnswerText(question, drafts[question.id]) !== undefined).length;
	const latestRef = useRef({ questions, drafts, onSend });
	latestRef.current = { questions, drafts, onSend };
	if (current === undefined) {
		return null;
	}
	const currentDraft = drafts[current.id];
	const freeTextId = `${ASYNC_FREE_TEXT_PREFIX}${current.id}`;
	const otherSelected = freeTextActiveId === freeTextId;
	const typed = currentDraft?.text?.trim() ?? '';
	const options = current.options ?? [];

	/** 答えたら、まだ答えていない次の問いへ進む（全部答えていれば動かない）。 */
	const advance = (fromId: string) => {
		// 描いた時点ではなく今の書きかけで見る（選んだ直後・入力欄から控えた直後に呼ぶため）
		const list = latestRef.current.questions;
		const latest = useAsyncQuestionDrafts.getState().drafts;
		const from = list.findIndex(question => question.id === fromId);
		for (let i = 1; i <= list.length; i++) {
			const candidate = (from + i) % list.length;
			const question = list[candidate];
			if (question !== undefined && asyncAnswerText(question, latest[question.id]) === undefined) {
				setStep(candidate);
				return;
			}
		}
	};
	const pick = (optionIndex: number) => {
		haptic('tick');
		if (otherSelected) {
			onRequestFreeText(undefined);
		}
		setError(undefined);
		// もう一度押すと選択を外す（その問いは答えずに残せる）
		if (currentDraft?.option === optionIndex && typed.length === 0) {
			setDraft(current.id, undefined);
			return;
		}
		setDraft(current.id, { option: optionIndex });
		advance(current.id);
	};
	const requestFreeText = () => {
		haptic('tick');
		setError(undefined);
		if (otherSelected) {
			onRequestFreeText(undefined);
			return;
		}
		const id = current.id;
		onRequestFreeText({
			id: `${ASYNC_FREE_TEXT_PREFIX}${id}`,
			prompt: current.title,
			// ここでは送らない。この問いの答えとして控え、「回答を送信」でまとめて送る
			submit: text => {
				useAsyncQuestionDrafts.getState().setDraft(id, { text: text.trim() });
				advance(id);
				return Promise.resolve({ status: 'accepted' });
			},
		});
	};
	const send = () => {
		const latest = latestRef.current;
		const reply = buildAsyncReply(latest.questions, useAsyncQuestionDrafts.getState().drafts);
		if (reply === undefined || sending) {
			return;
		}
		haptic('commit');
		setSending(true);
		setError(undefined);
		latest.onSend(reply.text).then(result => {
			setSending(false);
			if (result.status === 'rejected') {
				setError(result.message ?? '回答を送信できませんでした');
				return;
			}
			// 送った問いは PC の一覧から消えるまで隠す（同じ問いを二度送らない）。残りの問いはこのカードに残る
			markSent(reply.ids);
			if (freeTextActiveId !== undefined && reply.ids.some(id => `${ASYNC_FREE_TEXT_PREFIX}${id}` === freeTextActiveId)) {
				onRequestFreeText(undefined);
			}
		}, () => {
			setSending(false);
			setError('回答を送信できませんでした');
		});
	};
	const close = () => {
		haptic('tick');
		if (otherSelected) {
			onRequestFreeText(undefined);
		}
		dismiss(questions.map(question => question.id));
	};
	return (
		<View style={cardStyles.card}>
			<View style={cardStyles.head}>
				<Icon icon={CircleHelp} size={headIconSize} color={theme.accent} strokeWidth={2.2} />
				<Text style={cardStyles.title}>{questions.length > 1 ? `${questions.length}つの質問` : 'Codex からの質問'}</Text>
				<Text style={cardStyles.chip}>{working ? '作業は続いています' : '作業は終わっています'}</Text>
			</View>
			{questions.length > 1 ? (
				<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={baseStyles.steps} keyboardShouldPersistTaps="handled">
					{questions.map((question, index) => (
						<Pressable
							key={question.id}
							disabled={sending}
							onPress={() => { haptic('tick'); setStep(index); }}
							hitSlop={STEP_SLOP}
							style={[styles.step, question.id === current.id ? { borderColor: theme.accent, backgroundColor: theme.accentWash } : undefined]}
							accessibilityRole="tab"
							accessibilityState={{ selected: question.id === current.id, disabled: sending }}
						>
							{asyncAnswerText(question, drafts[question.id]) !== undefined ? <Icon icon={Check} size={checkIconSize} color={colors.green} /> : null}
							<Text style={[styles.stepText, question.id === current.id ? styles.stepTextOn : undefined]} numberOfLines={1}>{`Q${question.index + 1}`}</Text>
						</Pressable>
					))}
				</ScrollView>
			) : null}
			<Text style={cardStyles.question} selectable>{current.title}</Text>
			<View style={styles.options}>
				{options.map((option, index) => (
					<OptionButton
						key={index}
						label={option}
						selected={currentDraft?.option === index && typed.length === 0}
						disabled={sending}
						onPress={() => pick(index)}
					/>
				))}
				<OptionButton
					label={options.length > 0 ? 'その他（入力して回答）' : '回答を入力する'}
					{...(typed.length > 0 ? { description: typed } : {})}
					selected={otherSelected || typed.length > 0}
					disabled={sending}
					hint="下の入力欄が、この質問への回答の入力に切り替わります"
					onPress={requestFreeText}
				/>
			</View>
			<Button
				label={questions.length > 1 ? `回答を送信（${answeredCount}/${questions.length}）` : '回答を送信'}
				disabled={answeredCount === 0}
				loading={sending}
				onPress={send}
			/>
			{otherSelected ? <Text style={cardStyles.hint}>下の入力欄に回答を入力して送信してください（まだ Codex には送りません）</Text> : null}
			<Text style={cardStyles.hint}>{working
				? (questions.length > 1 ? '答えた質問だけを送ります。送ると書きかけの応答は打ち切られ、答えを読んで続けます' : '送ると書きかけの応答は打ち切られ、答えを読んで続けます')
				: '答えると新しい依頼として送ります。PC の画面からはこの質問は消えています'}</Text>
			{error !== undefined ? <Text style={cardStyles.error}>{error}</Text> : null}
			<Pressable onPress={close} disabled={sending} hitSlop={8} accessibilityRole="button" accessibilityHint="この端末でだけ閉じます。PC には知らせません">
				<Text style={cardStyles.link}>答えずに閉じる</Text>
			</Pressable>
		</View>
	);
}

const baseStyles = StyleSheet.create({
	options: {
		gap: space.xs,
	},
	steps: {
		gap: space.xs,
		paddingVertical: space.xs,
	},
	step: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		minHeight: 36,
		paddingHorizontal: space.md,
		borderRadius: radius.pill,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.raised,
	},
	stepText: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.textDim,
	},
	stepTextOn: {
		color: colors.text,
	},
});
