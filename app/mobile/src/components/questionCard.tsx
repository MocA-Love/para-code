// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { questionHasPreview } from '../agentQuestionMod.js';
import type { AgentQuestionShape } from '../agentQuestionKeys.js';
import type { QuestionGroupAnswer } from '../hooks/useAgentActions.js';
import { useAnswerSubmission } from '../hooks/useAnswerSubmission.js';
import type { AgentChatMessage, AgentMessageSendResult } from '../store.js';
import { HIT_SIZE, colors, radius, squircle, type } from '../theme.js';
import { haptic, prepareHaptic } from '../haptics.js';
import { setMobileSpanAttributes, startMobileSpan } from '../sentry.js';
import { Button } from './button.js';
import { AnswerSubmissionStatus } from './answerSubmissionStatus.js';
import { isSubmissionLocked } from './answerSubmission.js';

const REFRESHING_MESSAGE = '最新の内容を取得しています。届くまで回答できません';
/** 会話に残っている未回答の質問（PCがもう待っていないもの）に添える一文。 */
const NO_LONGER_WAITING_MESSAGE = 'PC で回答済み、または対象外になりました';

/**
 * 「その他（入力して回答）」を選んだときに、下のコンポーザーへ渡す回答入力の依頼。
 * コンポーザーはこれを受け取ると入力欄を質問への回答入力に切り替え、送信で `submit` を呼ぶ。
 * 回答の送り方（キー列の組み立て等）はカード側が持つので、コンポーザーは本文を渡すだけでよい。
 */
export interface QuestionFreeTextRequest {
	/** どの質問への回答か（interactionId、複数質問ではその中の何問目か）。 */
	readonly id: string;
	/** 質問文（入力欄の上に出す）。 */
	readonly prompt: string;
	/** 回答として送る。拒否されたらコンポーザーは本文を入力欄へ戻す。 */
	readonly submit: (text: string) => Promise<AgentMessageSendResult>;
	/**
	 * `clarify`: 「質問に答えずに話す」。入力欄は「質問を取り下げて送ります」になり、送った本文はエージェントへの返事になる
	 * （質問はすべて取り下げる）。無ければ「その他」の回答の入力。
	 */
	readonly mode?: 'clarify';
}

/**
 * 質問カード（Claude Code の AskUserQuestion 等）。
 *  - 単一選択: 選択肢を選んでから「回答する」で回答（押しただけでは送らない。誤タップで取り消せないため）
 *  - 複数選択(multiSelect): タップでトグルし、「回答する」で回答
 *  - 自由入力: `onRequestFreeText` を渡すと「その他（入力して回答）」を出し、下のコンポーザーで入力して
 *    回答する（エージェント画面）。渡さなければカード内の入力欄から回答する（ホームの要対応カード）
 * どれもTUIのキー操作へ翻訳して送る（規則は agentQuestionKeys.ts）。
 * 同じ toolUseId の tool_result が届いたら回答済み表示になる。
 * agent.tsx（TUIチャット画面）とホーム画面のアテンションカードの両方から使う。
 */
export const QuestionCard = memo(function QuestionCard({ message, answered, refreshing, onAnswer, onMulti, onFreeText, onRequestFreeText, freeTextActive, readOnly }: {
	message: AgentChatMessage;
	answered: boolean;
	/** 再取得の応答待ち。表示は残したまま操作だけ止める（回答済みとは別の状態）。 */
	refreshing?: boolean;
	onAnswer: (interactionId: string, question: AgentQuestionShape, optionIndex: number) => Promise<AgentMessageSendResult>;
	onMulti: (interactionId: string, question: AgentQuestionShape, indices: number[]) => Promise<AgentMessageSendResult>;
	onFreeText: (interactionId: string, question: AgentQuestionShape, text: string) => Promise<AgentMessageSendResult>;
	/** 自由入力を下のコンポーザーで受ける。undefined を渡すと依頼の取り消し。 */
	onRequestFreeText?: (request: QuestionFreeTextRequest | undefined) => void;
	/** コンポーザーがこの質問への回答入力になっているか（「その他」を選択中として示す）。 */
	freeTextActive?: boolean;
	/** 会話の履歴として出すだけ（回答の操作を出さない）。 */
	readOnly?: boolean;
}) {
	const [selected, setSelected] = useState<number | undefined>(undefined);
	const [toggled, setToggled] = useState<Set<number>>(new Set());
	const [freeText, setFreeText] = useState('');
	const multiSelect = message.multiSelect === true;
	const options = message.options ?? [];
	/** TUI上の形。回答をキー列に直すのに要る（agentQuestionKeys.ts）。 */
	const question: AgentQuestionShape = { optionCount: options.length, multiSelect, hasPreview: questionHasPreview(message) };
	const interactionId = message.questionGroup ?? message.toolUseId;
	// PC側で回答された（answered）か、対象が入れ替わったら送信状態・失敗表示は用済み。
	const submission = useAnswerSubmission(`${answered ? 'answered' : 'open'}:${interactionId ?? ''}`);
	const locked = isSubmissionLocked(submission.state);
	const error = submission.state.phase === 'idle' ? submission.state.error : undefined;
	const interactive = !answered && readOnly !== true && interactionId !== undefined;
	const disabled = !interactive || locked || refreshing === true;
	const composerFreeText = onRequestFreeText !== undefined;
	const otherSelected = composerFreeText && freeTextActive === true;
	const isToggled = (i: number) => toggled.has(i);
	const toggle = (i: number) => {
		setToggled(prev => {
			const next = new Set(prev);
			if (next.has(i)) {
				next.delete(i);
			} else {
				next.add(i);
			}
			return next;
		});
	};
	// 失敗理由は必ず画面へ出す。boolean だけを見ていた頃は、接続断・対象変更・PC側の
	// stale-interaction のどれで落ちても「押したのに何も起きない」としか見えなかった。
	const submit = (kind: 'option' | 'multi' | 'text', action: () => Promise<AgentMessageSendResult>) =>
		submission.run(() => startMobileSpan('agentQuestion', 'submit-single', () => action().then(result => {
			setMobileSpanAttributes({ safe_status: result.status });
			return result;
		}), {
			safe_answer_kind: kind,
			safe_option_count: options.length,
			safe_multi_select: multiSelect,
		}));
	// コンポーザーからの回答は依頼したあとで非同期に届く。そのあいだに質問の形（選択肢の数など）や
	// 送り先が差し替わっても、依頼した時点の値ではなく送る時点の最新の値で送る（QuestionGroupCard の answersRef と同じ）。
	const latestRef = useRef({ submit, onFreeText, question, refreshing });
	latestRef.current = { submit, onFreeText, question, refreshing };
	const requestFreeText = () => {
		if (interactionId === undefined || onRequestFreeText === undefined) {
			return;
		}
		haptic('tick');
		setSelected(undefined);
		onRequestFreeText({
			id: interactionId,
			prompt: message.text,
			submit: text => {
				const latest = latestRef.current;
				if (latest.refreshing === true) {
					return Promise.resolve({ status: 'rejected', message: REFRESHING_MESSAGE });
				}
				return latest.submit('text', () => latestRef.current.onFreeText(interactionId, latestRef.current.question, text));
			},
		});
	};
	const pickOption = (i: number) => {
		haptic('tick');
		if (otherSelected) {
			onRequestFreeText?.(undefined);
		}
		if (multiSelect) {
			toggle(i);
		} else {
			setSelected(i);
		}
	};
	const canConfirm = multiSelect ? toggled.size > 0 : selected !== undefined;
	const confirm = () => {
		if (interactionId === undefined || !canConfirm) {
			return;
		}
		haptic('commit');
		if (multiSelect) {
			void submit('multi', () => onMulti(interactionId, question, [...toggled].sort((a, b) => a - b)));
		} else if (selected !== undefined) {
			const index = selected;
			void submit('option', () => onAnswer(interactionId, question, index));
		}
	};
	return (
		<View style={[styles.questionCard, answered && styles.questionCardAnswered]}>
			<View style={styles.questionHeader}>
				<Ionicons name="help-circle" size={16} color={answered || readOnly === true ? colors.textDim : colors.red} />
				{message.header ? <Text style={styles.questionChip}>{message.header}</Text> : null}
				{multiSelect ? <Text style={styles.questionChip}>複数選択可</Text> : null}
				{answered ? <Text style={styles.questionAnswered}>回答済み</Text> : null}
			</View>
			<Text style={styles.questionText} selectable>{message.text}</Text>
			{options.map((option, i) => {
				const isSelected = multiSelect ? isToggled(i) : selected === i;
				return (
					<Pressable
						key={i}
						style={[styles.questionOption, isSelected && styles.questionOptionSelected, disabled && styles.questionOptionDisabled]}
						disabled={disabled}
						accessibilityRole="button"
						accessibilityState={{ selected: isSelected, disabled }}
						onPress={() => pickOption(i)}
					>
						<Text style={styles.questionOptionLabel}>{multiSelect ? (isToggled(i) ? '☑' : '☐') : `${i + 1}.`} {option.label}</Text>
						{option.description ? <Text style={styles.questionOptionDesc} numberOfLines={3}>{option.description}</Text> : null}
					</Pressable>
				);
			})}
			{composerFreeText && interactive ? (
				<Pressable
					style={[styles.questionOption, otherSelected && styles.questionOptionSelected, disabled && styles.questionOptionDisabled]}
					disabled={disabled}
					accessibilityRole="button"
					accessibilityState={{ selected: otherSelected, disabled }}
					accessibilityHint="下の入力欄が、この質問への回答の入力に切り替わります"
					onPress={requestFreeText}
				>
					<Text style={styles.questionOptionLabel}>その他（入力して回答）</Text>
				</Pressable>
			) : null}
			{!composerFreeText && !disabled ? (
				<View style={styles.questionFreeRow}>
					<TextInput
						style={styles.questionFreeInput}
						value={freeText}
						onChangeText={setFreeText}
						placeholder="自由に入力して回答…"
						placeholderTextColor={colors.textDim}
						autoCapitalize="none"
						autoCorrect={false}
						onFocus={() => prepareHaptic('commit')}
					/>
					<Pressable
						style={[styles.questionFreeSend, freeText.trim().length === 0 && styles.confirmBtnDisabled]}
						disabled={freeText.trim().length === 0 || interactionId === undefined}
						accessibilityRole="button"
						accessibilityState={{ disabled: freeText.trim().length === 0 || interactionId === undefined }}
						onPress={() => { if (interactionId !== undefined) { haptic('commit'); void submit('text', () => onFreeText(interactionId, question, freeText.trim())); } }}
						accessibilityLabel="自由入力で回答"
					>
						<Ionicons name="arrow-up" size={16} color={colors.onPrimary} />
					</Pressable>
				</View>
			) : null}
			{locked ? (
				<AnswerSubmissionStatus state={submission.state} onRetry={submission.retry} onReselect={submission.reset} />
			) : interactive && options.length > 0 && !otherSelected ? (
				<Button
					label={multiSelect && toggled.size > 0 ? `回答する（${toggled.size}件）` : '回答する'}
					variant="primary"
					disabled={!canConfirm || refreshing === true}
					onPress={confirm}
				/>
			) : null}
			{interactive && options.length === 0 ? (
				<Text style={styles.hint}>選択肢を取得できませんでした。TUI側と番号がずれる可能性があるため、ターミナルタブでの回答が確実です</Text>
			) : null}
			{!answered && readOnly !== true && interactionId === undefined ? <Text style={styles.hint}>この質問はモバイルから安全に回答できません。ターミナルタブで回答してください</Text> : null}
			{interactive && refreshing === true ? <Text style={styles.hint}>{REFRESHING_MESSAGE}</Text> : null}
			{!answered && readOnly === true ? <Text style={styles.hint}>{NO_LONGER_WAITING_MESSAGE}</Text> : null}
			{error !== undefined ? <Text style={styles.questionError}>{error}</Text> : null}
			{!disabled && otherSelected ? <Text style={styles.hint}>下の入力欄に回答を入力して送信してください</Text> : null}
			{!disabled && !otherSelected && options.length > 0 ? <Text style={styles.hint}>{multiSelect ? 'タップで選び「回答する」で送信します' : '選んでから「回答する」で送信します'}</Text> : null}
		</View>
	);
});

/**
 * 複数質問グループ（AskUserQuestion の questions が2つ以上）のステップ式カード。
 * 質問は上部の横並びタブで切り替え、回答はローカルに溜めて**全問揃ってから一括送信**する。
 * TUIでは1問ごとのEnterがフォーム全体をSubmitしてしまうため、1問ずつの即時注入はしない
 * （送信キー列の組み立ては useAgentActions.answerQuestionGroup 側）。
 */
export const QuestionGroupCard = memo(function QuestionGroupCard({ messages, answered, refreshing, onSubmit, onRequestFreeText, freeTextActiveId, readOnly }: {
	/** 同一 questionGroup の質問（questionIndex 順）。 */
	messages: AgentChatMessage[];
	answered: boolean;
	/** 再取得の応答待ち。表示は残したまま操作だけ止める（回答済みとは別の状態）。 */
	refreshing?: boolean;
	onSubmit: (interactionId: string, questions: readonly AgentQuestionShape[], answers: QuestionGroupAnswer[]) => Promise<AgentMessageSendResult>;
	/** 自由入力を下のコンポーザーで受ける。undefined を渡すと依頼の取り消し。 */
	onRequestFreeText?: (request: QuestionFreeTextRequest | undefined) => void;
	/** コンポーザーが回答入力になっている依頼のID（{@link QuestionFreeTextRequest.id}）。 */
	freeTextActiveId?: string;
	/** 会話の履歴として出すだけ（回答の操作を出さない）。 */
	readOnly?: boolean;
}) {
	const [step, setStep] = useState(0);
	const [answers, setAnswers] = useState<(QuestionGroupAnswer | undefined)[]>(() => messages.map(() => undefined));
	const [freeTexts, setFreeTexts] = useState<string[]>(() => messages.map(() => ''));
	const interactionId = messages[0]?.questionGroup ?? messages[0]?.toolUseId;
	// PC側で回答された（answered）か、対象が入れ替わったら送信状態・失敗表示は用済み。
	const submission = useAnswerSubmission(`${answered ? 'answered' : 'open'}:${interactionId ?? ''}`);
	const locked = isSubmissionLocked(submission.state);
	const error = submission.state.phase === 'idle' ? submission.state.error : undefined;
	const interactive = !answered && readOnly !== true && interactionId !== undefined;
	const disabled = !interactive || locked || refreshing === true;
	const composerFreeText = onRequestFreeText !== undefined;
	const current = messages[step];
	const options = current?.options ?? [];
	const multiSelect = current?.multiSelect === true;
	/** TUI上の形（質問の並び順）。回答をキー列に直すのに要る（agentQuestionKeys.ts）。 */
	const questions: AgentQuestionShape[] = messages.map(m => ({ optionCount: m.options?.length ?? 0, multiSelect: m.multiSelect === true, hasPreview: questionHasPreview(m) }));
	const answeredCount = answers.filter(a => a !== undefined).length;
	const allAnswered = answeredCount === messages.length;
	// コンポーザーからの回答は後から非同期に届くので、その時点の最新の回答を読むために控える。
	const answersRef = useRef(answers);
	answersRef.current = answers;
	// 同じく、選択肢の数・再取得中かも送る時点の最新の値で読む（依頼した時点の値を閉じ込めない）。
	const latestRef = useRef({ messages, refreshing });
	latestRef.current = { messages, refreshing };
	useEffect(() => {
		setAnswers(previous => messages.map((_, index) => previous[index]));
		setFreeTexts(previous => messages.map((_, index) => previous[index] ?? ''));
		setStep(previous => Math.min(previous, Math.max(0, messages.length - 1)));
	}, [messages.length]);

	const setAnswer = (index: number, answer: QuestionGroupAnswer | undefined) => {
		setAnswers(prev => prev.map((v, i) => (i === index ? answer : v)));
	};
	/** 回答したら未回答の次の質問へ自動で進む（最後まで回答済みなら動かない）。 */
	const advance = (from: number, nextAnswers: (QuestionGroupAnswer | undefined)[]) => {
		const count = latestRef.current.messages.length;
		for (let i = 1; i <= count; i++) {
			const candidate = (from + i) % count;
			if (nextAnswers[candidate] === undefined) {
				setStep(candidate);
				return;
			}
		}
	};
	const currentAnswer = answers[step];
	const toggledIndices = currentAnswer?.kind === 'multi' ? currentAnswer.indices : [];
	const stepRequestId = (index: number) => `${interactionId ?? ''}:${index}`;
	const otherSelected = composerFreeText && freeTextActiveId === stepRequestId(step);

	const requestFreeText = () => {
		if (interactionId === undefined || onRequestFreeText === undefined || current === undefined) {
			return;
		}
		haptic('tick');
		const index = step;
		onRequestFreeText({
			id: stepRequestId(index),
			prompt: current.text,
			// 複数質問はここでは送らない。この問いの回答として控え、全問揃ってから一括で送る。
			submit: text => {
				const latest = latestRef.current;
				if (latest.refreshing === true) {
					return Promise.resolve({ status: 'rejected', message: REFRESHING_MESSAGE });
				}
				const optionCount = latest.messages[index]?.options?.length ?? 0;
				const nextAnswers = answersRef.current.map((v, i) => (i === index ? { kind: 'text' as const, optionCount, text } : v));
				setAnswers(nextAnswers);
				advance(index, nextAnswers);
				return Promise.resolve({ status: 'accepted' });
			},
		});
	};

	const submitAll = () => {
		if (interactionId === undefined) { return; }
		haptic('commit');
		const picked = answers.filter((a): a is QuestionGroupAnswer => a !== undefined);
		// 複数ステップ・自由入力つきの回答がPCで正しく再生されているかは、送った側の
		// 形と結果を並べないと分からない。件数と種別だけを残す（本文は載せない）。
		void submission.run(() => startMobileSpan('agentQuestion', 'submit-group', () =>
			onSubmit(interactionId, questions, picked)
				.then(result => {
					// 拒否の理由コードはPC側の span に出るので、ここでは結果だけ。
					// message は画面へ出す文言なので載せない。
					setMobileSpanAttributes({ safe_status: result.status });
					return result;
				}), {
			safe_question_count: messages.length,
			safe_answer_count: picked.length,
			safe_option_counts: questions.map(q => q.optionCount).join(','),
			safe_multi_select_count: questions.filter(q => q.multiSelect).length,
			safe_free_text_count: picked.filter(a => a.kind === 'text').length,
		}));
	};

	return (
		<View style={[styles.questionCard, answered && styles.questionCardAnswered]}>
			<View style={styles.questionHeader}>
				<Ionicons name="help-circle" size={16} color={answered || readOnly === true ? colors.textDim : colors.red} />
				<Text style={styles.questionChip}>複数の質問（全{messages.length}問）</Text>
				{answered ? <Text style={styles.questionAnswered}>回答済み</Text> : null}
			</View>
			{/* 質問切り替えタブ（横並び）。回答済みはチェック付きで示す */}
			<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stepTabs}>
				{messages.map((m, i) => (
					<Pressable
						key={i}
						style={[styles.stepTab, i === step && styles.stepTabActive, answers[i] !== undefined && styles.stepTabAnswered]}
						accessibilityRole="tab"
						accessibilityState={{ selected: i === step, disabled }}
						disabled={disabled}
						onPress={() => { haptic('tick'); setStep(i); }}
					>
						<Text style={[styles.stepTabText, i === step && styles.stepTabTextActive]}>
							{answers[i] !== undefined ? '✓ ' : ''}{m.header ?? `Q${i + 1}`}
						</Text>
					</Pressable>
				))}
			</ScrollView>
			{current ? <Text style={styles.questionText} selectable>{current.text}</Text> : null}
			{multiSelect ? <Text style={styles.questionChip}>複数選択可</Text> : null}
			{options.map((option, i) => {
				const selected = multiSelect ? toggledIndices.includes(i) : currentAnswer?.kind === 'option' && currentAnswer.index === i;
				return (
					<Pressable
						key={i}
						style={[styles.questionOption, selected && styles.questionOptionSelected, disabled && styles.questionOptionDisabled]}
						disabled={disabled}
						accessibilityRole="button"
						accessibilityState={{ selected, disabled }}
						onPress={() => {
							haptic('tick');
							if (otherSelected) {
								onRequestFreeText?.(undefined);
							}
							// 選択肢で答えたら自由入力欄は空に戻す。両方が残っていると、本文が見えているのに
							// 回答は選択肢、という食い違った表示になる（回答として送れるのはどちらか一方だけ）。
							setFreeTexts(prev => prev.map((v, j) => (j === step ? '' : v)));
							if (multiSelect) {
								const next = toggledIndices.includes(i) ? toggledIndices.filter(v => v !== i) : [...toggledIndices, i].sort((a, b) => a - b);
								setAnswer(step, next.length > 0 ? { kind: 'multi', indices: next } : undefined);
							} else {
								const nextAnswers = answers.map((v, j) => (j === step ? { kind: 'option' as const, index: i } : v));
								setAnswers(nextAnswers);
								advance(step, nextAnswers);
							}
						}}
					>
						<Text style={styles.questionOptionLabel}>{multiSelect ? (selected ? '☑' : '☐') : `${i + 1}.`} {option.label}</Text>
						{option.description ? <Text style={styles.questionOptionDesc} numberOfLines={3}>{option.description}</Text> : null}
					</Pressable>
				);
			})}
			{composerFreeText && interactive ? (
				<Pressable
					style={[styles.questionOption, (otherSelected || currentAnswer?.kind === 'text') && styles.questionOptionSelected, disabled && styles.questionOptionDisabled]}
					disabled={disabled}
					accessibilityRole="button"
					accessibilityState={{ selected: otherSelected || currentAnswer?.kind === 'text', disabled }}
					accessibilityHint="下の入力欄が、この質問への回答の入力に切り替わります"
					onPress={requestFreeText}
				>
					<Text style={styles.questionOptionLabel}>その他（入力して回答）</Text>
					{currentAnswer?.kind === 'text' ? <Text style={styles.questionOptionDesc} numberOfLines={3}>{currentAnswer.text}</Text> : null}
				</Pressable>
			) : null}
			{!composerFreeText && !disabled ? (
				<TextInput
					style={styles.questionFreeInput}
					value={freeTexts[step] ?? ''}
					onChangeText={text => {
						setFreeTexts(prev => prev.map((v, i) => (i === step ? text : v)));
						const trimmed = text.trim();
						if (trimmed.length > 0) {
							setAnswer(step, { kind: 'text', optionCount: options.length, text: trimmed });
						} else if (answers[step]?.kind === 'text') {
							// 空に戻したときに取り消すのは、この欄で入れた回答だけ。選択肢で答えたあとに
							// ここを一度触って消すと選択まで無かったことになり、送信ボタンが再び死んでいた。
							setAnswer(step, undefined);
						}
					}}
					placeholder="自由に入力して回答…"
					placeholderTextColor={colors.textDim}
					autoCapitalize="none"
					autoCorrect={false}
					onFocus={() => prepareHaptic('commit')}
				/>
			) : null}
			{locked ? (
				<AnswerSubmissionStatus state={submission.state} onRetry={submission.retry} onReselect={submission.reset} />
			) : interactive ? (
				<Button
					label={`回答を送信（${answeredCount}/${messages.length}）`}
					variant="primary"
					disabled={!allAnswered || refreshing === true}
					onPress={submitAll}
				/>
			) : null}
			{!disabled && otherSelected ? <Text style={styles.hint}>下の入力欄に回答を入力して送信してください</Text> : null}
			{!disabled ? <Text style={styles.hint}>すべての質問に回答してから送信されます（1問ずつは送信されません）</Text> : null}
			{!answered && readOnly !== true && interactionId === undefined ? <Text style={styles.hint}>この質問グループはターミナルタブで回答してください</Text> : null}
			{!answered && readOnly === true ? <Text style={styles.hint}>{NO_LONGER_WAITING_MESSAGE}</Text> : null}
			{error !== undefined ? <Text style={styles.questionError}>{error}</Text> : null}
		</View>
	);
}, (prev, next) =>
	prev.answered === next.answered
	&& prev.refreshing === next.refreshing
	&& prev.onSubmit === next.onSubmit
	&& prev.onRequestFreeText === next.onRequestFreeText
	&& prev.freeTextActiveId === next.freeTextActiveId
	&& prev.readOnly === next.readOnly
	// messages は rows 再計算のたびに作り直される配列なので、要素の同一性で比較する。
	&& prev.messages.length === next.messages.length
	&& prev.messages.every((m, i) => m === next.messages[i]));

const styles = StyleSheet.create({
	questionCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.card, ...squircle, padding: 14, gap: 8 },
	questionCardAnswered: { borderColor: colors.border, backgroundColor: colors.surface, opacity: 0.75 },
	questionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	questionChip: { color: colors.text, fontSize: type.caption, fontWeight: '600', backgroundColor: colors.surface2, borderRadius: radius.key, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
	questionAnswered: { color: colors.textDim, fontSize: type.caption, marginLeft: 'auto' },
	questionText: { color: colors.text, fontSize: type.body, lineHeight: 20, fontWeight: '600' },
	questionOption: { minHeight: HIT_SIZE, justifyContent: 'center', backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: radius.card, ...squircle, paddingHorizontal: 13, paddingVertical: 11, gap: 3 },
	questionOptionSelected: { borderColor: colors.accent, backgroundColor: colors.accentWash },
	questionOptionDisabled: { opacity: 0.6 },
	questionOptionLabel: { color: colors.text, fontSize: type.meta, fontWeight: '600' },
	questionOptionDesc: { color: colors.textDim, fontSize: type.caption, lineHeight: 15 },
	questionFreeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	questionFreeInput: { flex: 1, backgroundColor: colors.surface2, borderRadius: radius.control, ...squircle, borderWidth: 1, borderColor: colors.border, color: colors.text, fontSize: type.meta, paddingHorizontal: 13, paddingVertical: 10 },
	questionFreeSend: { backgroundColor: colors.primary, borderRadius: radius.control, ...squircle, width: HIT_SIZE, height: HIT_SIZE, alignItems: 'center', justifyContent: 'center' },
	confirmBtnDisabled: { opacity: 0.4 },
	hint: { color: colors.textDim, fontSize: type.badge },
	questionError: { color: colors.red, fontSize: type.caption, lineHeight: 15 },
	stepTabs: { flexDirection: 'row', gap: 6 },
	stepTab: { minHeight: HIT_SIZE, justifyContent: 'center', backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, ...squircle, paddingHorizontal: 11, paddingVertical: 5 },
	stepTabActive: { borderColor: colors.accent, backgroundColor: colors.accentWash },
	stepTabAnswered: { borderColor: colors.accent2 },
	stepTabText: { color: colors.textDim, fontSize: type.caption, fontWeight: '600' },
	stepTabTextActive: { color: colors.text },
});
