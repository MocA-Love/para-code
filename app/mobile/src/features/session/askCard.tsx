// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Check, CircleHelp, Square, SquareCheck } from 'lucide-react-native';
import type { AgentQuestionShape } from '../../agentQuestionKeys.js';
import { isSubmissionLocked } from '../../components/answerSubmission.js';
import type { QuestionFreeTextRequest } from '../../components/questionCard.js';
import { hapticImpact, hapticSelection } from '../../haptics.js';
import type { QuestionGroupAnswer } from '../../hooks/useAgentActions.js';
import { useAnswerSubmission } from '../../hooks/useAnswerSubmission.js';
import { setMobileSpanAttributes, startMobileSpan } from '../../sentry.js';
import type { AgentChatMessage, AgentMessageSendResult } from '../../store.js';
import { colors, radius, space, type } from '../../theme.js';
import { Button, Icon, iconSize } from '../../ui/index.js';
import { cardStyles } from './answerCardStyles.js';
import { SubmissionStatus } from './submissionStatus.js';

/** 質問を切り替える丸いタブの当たり判定（見た目 36、上下 4 ずつ。スクロールの内側に収まる）。 */
const STEP_SLOP = { top: 4, bottom: 4, left: 0, right: 0 };

const REFRESHING_MESSAGE = '最新の内容を取得しています。届くまで回答できません';

/**
 * 質問に答えるカード（Orca の MobileNativeChatAsk。モックの質問の `.pcard`）。
 *
 * 送る内容と送り方は旧カード（`components/questionCard.tsx`）と同じ:
 *  - 選択肢を選んでから「回答する」で送る（押しただけでは送らない。誤タップで取り消せないため）
 *  - 複数選択はタップで切り替えて「回答する」
 *  - 「その他（入力して回答）」は下のコンポーザーを回答入力に切り替える（`onRequestFreeText`）
 * 回答をキー操作へ直すのは既存の `useAgentActions`（`agentQuestionKeys.ts`）。
 */
export function AskCard({ message, refreshing, onAnswer, onMulti, onFreeText, onRequestFreeText, freeTextActive }: {
	message: AgentChatMessage;
	refreshing: boolean;
	onAnswer: (interactionId: string, question: AgentQuestionShape, optionIndex: number) => Promise<AgentMessageSendResult>;
	onMulti: (interactionId: string, question: AgentQuestionShape, indices: number[]) => Promise<AgentMessageSendResult>;
	onFreeText: (interactionId: string, question: AgentQuestionShape, text: string) => Promise<AgentMessageSendResult>;
	onRequestFreeText: (request: QuestionFreeTextRequest | undefined) => void;
	freeTextActive: boolean;
}) {
	const [selected, setSelected] = useState<number | undefined>(undefined);
	const [toggled, setToggled] = useState<ReadonlySet<number>>(new Set());
	const multiSelect = message.multiSelect === true;
	const options = message.options ?? [];
	const question: AgentQuestionShape = { optionCount: options.length, multiSelect };
	const interactionId = message.questionGroup ?? message.toolUseId;
	const submission = useAnswerSubmission(`open:${interactionId ?? ''}`);
	const locked = isSubmissionLocked(submission.state);
	const error = submission.state.phase === 'idle' ? submission.state.error : undefined;
	const interactive = interactionId !== undefined;
	const disabled = !interactive || locked || refreshing;
	const submit = (kind: 'option' | 'multi' | 'text', action: () => Promise<AgentMessageSendResult>) =>
		submission.run(() => startMobileSpan('agentQuestion', 'submit-single', () => action().then(result => {
			setMobileSpanAttributes({ safe_status: result.status });
			return result;
		}), {
			safe_answer_kind: kind,
			safe_option_count: options.length,
			safe_multi_select: multiSelect,
		}));
	// コンポーザーからの回答は依頼したあとで非同期に届く。送る時点の最新の値で送る。
	const latestRef = useRef({ submit, onFreeText, question, refreshing });
	latestRef.current = { submit, onFreeText, question, refreshing };
	const requestFreeText = () => {
		if (interactionId === undefined) {
			return;
		}
		hapticSelection();
		setSelected(undefined);
		onRequestFreeText({
			id: interactionId,
			prompt: message.text,
			submit: text => {
				const latest = latestRef.current;
				if (latest.refreshing) {
					return Promise.resolve({ status: 'rejected', message: REFRESHING_MESSAGE });
				}
				return latest.submit('text', () => latestRef.current.onFreeText(interactionId, latestRef.current.question, text));
			},
		});
	};
	const pick = (index: number) => {
		hapticSelection();
		if (freeTextActive) {
			onRequestFreeText(undefined);
		}
		if (multiSelect) {
			setToggled(previous => {
				const next = new Set(previous);
				if (next.has(index)) {
					next.delete(index);
				} else {
					next.add(index);
				}
				return next;
			});
		} else {
			setSelected(index);
		}
	};
	const canConfirm = multiSelect ? toggled.size > 0 : selected !== undefined;
	const confirm = () => {
		if (interactionId === undefined || !canConfirm) {
			return;
		}
		hapticImpact('medium');
		if (multiSelect) {
			void submit('multi', () => onMulti(interactionId, question, [...toggled].sort((a, b) => a - b)));
		} else if (selected !== undefined) {
			const index = selected;
			void submit('option', () => onAnswer(interactionId, question, index));
		}
	};
	return (
		<View style={cardStyles.card}>
			<View style={cardStyles.head}>
				<Icon icon={CircleHelp} size={15} color={colors.accent} strokeWidth={2.2} />
				<Text style={cardStyles.question} selectable>{message.text}</Text>
			</View>
			{message.header !== undefined || multiSelect ? (
				<View style={styles.chips}>
					{message.header !== undefined ? <Text style={cardStyles.chip}>{message.header}</Text> : null}
					{multiSelect ? <Text style={cardStyles.chip}>複数選択可</Text> : null}
				</View>
			) : null}
			<View style={styles.options}>
				{options.map((option, index) => (
					<OptionButton
						key={index}
						label={option.label}
						description={option.description}
						selected={multiSelect ? toggled.has(index) : selected === index}
						multiSelect={multiSelect}
						disabled={disabled}
						onPress={() => pick(index)}
					/>
				))}
				{interactive ? (
					<OptionButton
						label="その他（入力して回答）"
						selected={freeTextActive}
						disabled={disabled}
						hint="下の入力欄が、この質問への回答の入力に切り替わります"
						onPress={requestFreeText}
					/>
				) : null}
			</View>
			{locked ? (
				<SubmissionStatus state={submission.state} onRetry={submission.retry} onReselect={submission.reset} />
			) : interactive && options.length > 0 && !freeTextActive ? (
				<Button
					label={multiSelect && toggled.size > 0 ? `回答する（${toggled.size}件）` : '回答する'}
					disabled={!canConfirm || refreshing}
					onPress={confirm}
				/>
			) : null}
			{interactive && options.length === 0 ? <Text style={cardStyles.hint}>選択肢を取得できませんでした。番号がずれる可能性があるため、ターミナル表示での回答が確実です</Text> : null}
			{!interactive ? <Text style={cardStyles.hint}>この質問はモバイルから安全に回答できません。ターミナル表示で回答してください</Text> : null}
			{interactive && refreshing ? <Text style={cardStyles.hint}>{REFRESHING_MESSAGE}</Text> : null}
			{error !== undefined ? <Text style={cardStyles.error}>{error}</Text> : null}
			{!disabled && freeTextActive ? <Text style={cardStyles.hint}>下の入力欄に回答を入力して送信してください</Text> : null}
			{!disabled && !freeTextActive && options.length > 0 ? <Text style={cardStyles.hint}>{multiSelect ? 'タップで選び「回答する」で送信します' : '選んでから「回答する」で送信します'}</Text> : null}
		</View>
	);
}

/**
 * 複数の質問（AskUserQuestion の questions が2つ以上）のカード。上の丸いタブで質問を切り替え、
 * 回答は手元に溜めて**全問そろってから一括で送る**（1問ずつ送ると TUI がフォーム全体を送信するため）。
 */
export function AskGroupCard({ messages, refreshing, onSubmit, onRequestFreeText, freeTextActiveId }: {
	messages: AgentChatMessage[];
	refreshing: boolean;
	onSubmit: (interactionId: string, questions: readonly AgentQuestionShape[], answers: QuestionGroupAnswer[]) => Promise<AgentMessageSendResult>;
	onRequestFreeText: (request: QuestionFreeTextRequest | undefined) => void;
	freeTextActiveId: string | undefined;
}) {
	const [step, setStep] = useState(0);
	const [answers, setAnswers] = useState<(QuestionGroupAnswer | undefined)[]>(() => messages.map(() => undefined));
	const interactionId = messages[0]?.questionGroup ?? messages[0]?.toolUseId;
	const submission = useAnswerSubmission(`open:${interactionId ?? ''}`);
	const locked = isSubmissionLocked(submission.state);
	const error = submission.state.phase === 'idle' ? submission.state.error : undefined;
	const interactive = interactionId !== undefined;
	const disabled = !interactive || locked || refreshing;
	const current = messages[step];
	const options = current?.options ?? [];
	const multiSelect = current?.multiSelect === true;
	const questions: AgentQuestionShape[] = messages.map(m => ({ optionCount: m.options?.length ?? 0, multiSelect: m.multiSelect === true }));
	const answeredCount = answers.filter(answer => answer !== undefined).length;
	const allAnswered = answeredCount === messages.length;
	const answersRef = useRef(answers);
	answersRef.current = answers;
	const latestRef = useRef({ messages, refreshing });
	latestRef.current = { messages, refreshing };
	useEffect(() => {
		setAnswers(previous => messages.map((_, index) => previous[index]));
		setStep(previous => Math.min(previous, Math.max(0, messages.length - 1)));
	}, [messages.length]);

	/** 答えたら未回答の次の質問へ進む（全部答えていれば動かない）。 */
	const advance = (from: number, next: (QuestionGroupAnswer | undefined)[]) => {
		const count = latestRef.current.messages.length;
		for (let i = 1; i <= count; i++) {
			const candidate = (from + i) % count;
			if (next[candidate] === undefined) {
				setStep(candidate);
				return;
			}
		}
	};
	const currentAnswer = answers[step];
	const toggledIndices = currentAnswer?.kind === 'multi' ? currentAnswer.indices : [];
	const stepRequestId = (index: number) => `${interactionId ?? ''}:${index}`;
	const otherSelected = freeTextActiveId === stepRequestId(step);

	const requestFreeText = () => {
		if (interactionId === undefined || current === undefined) {
			return;
		}
		hapticSelection();
		const index = step;
		onRequestFreeText({
			id: stepRequestId(index),
			prompt: current.text,
			// ここでは送らない。この問いの回答として控え、全問そろってから一括で送る。
			submit: text => {
				const latest = latestRef.current;
				if (latest.refreshing) {
					return Promise.resolve({ status: 'rejected', message: REFRESHING_MESSAGE });
				}
				const optionCount = latest.messages[index]?.options?.length ?? 0;
				const next = answersRef.current.map((value, i) => (i === index ? { kind: 'text' as const, optionCount, text } : value));
				setAnswers(next);
				advance(index, next);
				return Promise.resolve({ status: 'accepted' });
			},
		});
	};
	const pick = (optionIndex: number) => {
		hapticSelection();
		if (otherSelected) {
			onRequestFreeText(undefined);
		}
		if (multiSelect) {
			const next = toggledIndices.includes(optionIndex)
				? toggledIndices.filter(value => value !== optionIndex)
				: [...toggledIndices, optionIndex].sort((a, b) => a - b);
			setAnswers(previous => previous.map((value, i) => (i === step ? (next.length > 0 ? { kind: 'multi', indices: next } : undefined) : value)));
		} else {
			const next = answers.map((value, i) => (i === step ? { kind: 'option' as const, index: optionIndex } : value));
			setAnswers(next);
			advance(step, next);
		}
	};
	const submitAll = () => {
		if (interactionId === undefined) {
			return;
		}
		hapticImpact('medium');
		const picked = answers.filter((answer): answer is QuestionGroupAnswer => answer !== undefined);
		void submission.run(() => startMobileSpan('agentQuestion', 'submit-group', () =>
			onSubmit(interactionId, questions, picked).then(result => {
				setMobileSpanAttributes({ safe_status: result.status });
				return result;
			}), {
			safe_question_count: messages.length,
			safe_answer_count: picked.length,
			safe_option_counts: questions.map(q => q.optionCount).join(','),
			safe_multi_select_count: questions.filter(q => q.multiSelect).length,
			safe_free_text_count: picked.filter(answer => answer.kind === 'text').length,
		}));
	};
	return (
		<View style={cardStyles.card}>
			<View style={cardStyles.head}>
				<Icon icon={CircleHelp} size={15} color={colors.accent} strokeWidth={2.2} />
				<Text style={cardStyles.title}>{`${messages.length}つの質問`}</Text>
			</View>
			<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.steps} keyboardShouldPersistTaps="handled">
				{messages.map((m, index) => (
					<Pressable
						key={index}
						disabled={disabled}
						onPress={() => { hapticSelection(); setStep(index); }}
						hitSlop={STEP_SLOP}
						style={[styles.step, index === step ? styles.stepOn : undefined]}
						accessibilityRole="tab"
						accessibilityState={{ selected: index === step, disabled }}
					>
						{answers[index] !== undefined ? <Icon icon={Check} size={iconSize.xs} color={colors.green} /> : null}
						<Text style={[styles.stepText, index === step ? styles.stepTextOn : undefined]} numberOfLines={1}>{m.header ?? `Q${index + 1}`}</Text>
					</Pressable>
				))}
			</ScrollView>
			{current !== undefined ? <Text style={cardStyles.question} selectable>{current.text}</Text> : null}
			{multiSelect ? <View style={styles.chips}><Text style={cardStyles.chip}>複数選択可</Text></View> : null}
			<View style={styles.options}>
				{options.map((option, index) => (
					<OptionButton
						key={index}
						label={option.label}
						description={option.description}
						selected={multiSelect ? toggledIndices.includes(index) : currentAnswer?.kind === 'option' && currentAnswer.index === index}
						multiSelect={multiSelect}
						disabled={disabled}
						onPress={() => pick(index)}
					/>
				))}
				{interactive ? (
					<OptionButton
						label="その他（入力して回答）"
						description={currentAnswer?.kind === 'text' ? currentAnswer.text : undefined}
						selected={otherSelected || currentAnswer?.kind === 'text'}
						disabled={disabled}
						hint="下の入力欄が、この質問への回答の入力に切り替わります"
						onPress={requestFreeText}
					/>
				) : null}
			</View>
			{locked ? (
				<SubmissionStatus state={submission.state} onRetry={submission.retry} onReselect={submission.reset} />
			) : interactive ? (
				<Button label={`回答を送信（${answeredCount}/${messages.length}）`} disabled={!allAnswered || refreshing} onPress={submitAll} />
			) : null}
			{!disabled && otherSelected ? <Text style={cardStyles.hint}>下の入力欄に回答を入力して送信してください</Text> : null}
			{!disabled ? <Text style={cardStyles.hint}>すべての質問に回答してから送信されます（1問ずつは送信されません）</Text> : null}
			{!interactive ? <Text style={cardStyles.hint}>この質問はターミナル表示で回答してください</Text> : null}
			{interactive && refreshing ? <Text style={cardStyles.hint}>{REFRESHING_MESSAGE}</Text> : null}
			{error !== undefined ? <Text style={cardStyles.error}>{error}</Text> : null}
		</View>
	);
}

function OptionButton({ label, description, selected, multiSelect = false, disabled, hint, onPress }: {
	label: string;
	description?: string;
	selected: boolean;
	multiSelect?: boolean;
	disabled: boolean;
	hint?: string;
	onPress: () => void;
}) {
	return (
		<Pressable
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => [
				cardStyles.option,
				styles.option,
				selected ? cardStyles.optionSelected : undefined,
				disabled ? cardStyles.optionDisabled : undefined,
				pressed ? cardStyles.optionPressed : undefined,
			]}
			accessibilityRole="button"
			accessibilityState={{ selected, disabled }}
			accessibilityHint={hint}
		>
			{multiSelect ? <Icon icon={selected ? SquareCheck : Square} color={selected ? colors.accent : colors.textDim} /> : null}
			<View style={styles.optionBody}>
				<Text style={cardStyles.optionLabel}>{label}</Text>
				{description !== undefined && description.length > 0 ? <Text style={cardStyles.optionDescription} numberOfLines={3}>{description}</Text> : null}
			</View>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	chips: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.xs,
	},
	options: {
		gap: space.xs,
	},
	option: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	optionBody: {
		flex: 1,
		minWidth: 0,
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
	stepOn: {
		borderColor: colors.accent,
		backgroundColor: colors.accentWash,
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
