// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Check, CircleHelp, Square, SquareCheck } from 'lucide-react-native';
import type { AgentQuestionShape } from '../../agentQuestionKeys.js';
import {
	attachQuestionNotes, partialQuestionAnswers, questionHasPreview, questionTakesNotes, showOtherOption, type AskQuestionFeatures,
} from '../../agentQuestionMod.js';
import { isSubmissionLocked } from '../../components/answerSubmission.js';
import type { QuestionFreeTextRequest } from '../../components/questionCard.js';
import { haptic } from '../../haptics.js';
import type { QuestionGroupAnswer } from '../../hooks/useAgentActions.js';
import { useAnswerSubmission } from '../../hooks/useAnswerSubmission.js';
import { useIsRegularWidth } from '../../hooks/useSizeClass.js';
import { questionPreviewSplit } from '../../ipad/ipadLayout.js';
import { setMobileSpanAttributes, startMobileSpan } from '../../sentry.js';
import type { AgentChatMessage, AgentMessageSendResult } from '../../store.js';
import { colors, radius, space, type } from '../../theme.js';
import { Button, Icon, iconSize, useThemeColors } from '../../ui/index.js';
import { useChatIconSize, useChatStyles } from '../../ui/chatTextScale.js';
import { cardStyles as baseCardStyles } from './answerCardStyles.js';
import { ChatAboutQuestionLink, QuestionNotesLine, QuestionPreviewBox, WithdrawingQuestionCard } from './askPreview.js';
import { SubmissionStatus } from './submissionStatus.js';

/**
 * 質問を切り替える丸いタブの当たり判定（見た目 36、上下 4 ずつ。スクロールの内側に収まる）。
 * タブの最小の高さ 36 とスクロールの上下の余白 4 は、会話の文字サイズで変えない（縮めると 44 を割るため。
 * 文字を大きくしたときはタブが中身に合わせて伸びる）。
 */
const STEP_SLOP = { top: 4, bottom: 4, left: 0, right: 0 };

const REFRESHING_MESSAGE = '最新の内容を取得しています。届くまで回答できません';

type SubmitAnswers = (interactionId: string, questions: readonly AgentQuestionShape[], answers: QuestionGroupAnswer[]) => Promise<AgentMessageSendResult>;
type ClarifyQuestions = (interactionId: string, response: string | undefined, answers: readonly (QuestionGroupAnswer | null)[]) => Promise<AgentMessageSendResult>;

/** 「質問に答えずに話す」の依頼の ID（その他の回答の依頼と分ける）。 */
export function clarifyRequestId(interactionId: string): string {
	return `${interactionId}:clarify`;
}

/**
 * 質問に答えるカード（Orca の MobileNativeChatAsk。モックの質問の `.pcard`）。
 *
 * 送る内容と送り方は旧カード（`components/questionCard.tsx`）と同じ:
 *  - 選択肢を選んでから「回答する」で送る（押しただけでは送らない。誤タップで取り消せないため）
 *  - 複数選択はタップで切り替えて「回答する」
 *  - 「その他（入力して回答）」は下のコンポーザーを回答入力に切り替える（`onRequestFreeText`）
 * preview のある質問は、選んだ選択肢の真下（広い幅では右）に TUI と同じ枠の preview を出す。PC の mod が待っているときは
 * メモと「質問に答えずに話す」も出す（`features`。`agentQuestionMod.ts`）。
 */
export function AskCard({ message, refreshing, features, onSubmit, onClarify, onRequestFreeText, freeTextActive, clarifying }: {
	message: AgentChatMessage;
	refreshing: boolean;
	features: AskQuestionFeatures;
	onSubmit: SubmitAnswers;
	onClarify: ClarifyQuestions;
	onRequestFreeText: (request: QuestionFreeTextRequest | undefined) => void;
	/** 下の入力欄がこの質問の「その他」の回答の入力になっているか。 */
	freeTextActive: boolean;
	/** 下の入力欄が「質問に答えずに話す」の入力になっているか。 */
	clarifying: boolean;
}) {
	const theme = useThemeColors();
	const cardStyles = useChatStyles(baseCardStyles);
	const styles = useChatStyles(baseStyles);
	const headIconSize = useChatIconSize(15);
	const [selected, setSelected] = useState<number | undefined>(undefined);
	const [toggled, setToggled] = useState<ReadonlySet<number>>(new Set());
	const [notes, setNotes] = useState('');
	const multiSelect = message.multiSelect === true;
	const options = message.options ?? [];
	const question: AgentQuestionShape = { optionCount: options.length, multiSelect, hasPreview: questionHasPreview(message) };
	const interactionId = message.questionGroup ?? message.toolUseId;
	const submission = useAnswerSubmission(`open:${interactionId ?? ''}`);
	const locked = isSubmissionLocked(submission.state);
	const error = submission.state.phase === 'idle' ? submission.state.error : undefined;
	const interactive = interactionId !== undefined;
	const disabled = !interactive || locked || refreshing;
	const takesNotes = questionTakesNotes(message, features);
	const withdrawing = useWithdrawing(submission.state.phase);
	const picked: QuestionGroupAnswer | undefined = multiSelect
		? (toggled.size > 0 ? { kind: 'multi', indices: [...toggled].sort((a, b) => a - b) } : undefined)
		: (selected !== undefined ? { kind: 'option', index: selected } : undefined);
	const answer = attachQuestionNotes(picked, notes, takesNotes);
	const submit = (kind: string, action: () => Promise<AgentMessageSendResult>) =>
		submission.run(() => startMobileSpan('agentQuestion', 'submit-single', () => action().then(result => {
			setMobileSpanAttributes({ safe_status: result.status });
			return result;
		}), {
			safe_answer_kind: kind,
			safe_option_count: options.length,
			safe_multi_select: multiSelect,
			safe_has_preview: questionHasPreview(message),
		}));
	// コンポーザーからの回答は依頼したあとで非同期に届く。送る時点の最新の値で送る。
	const latestRef = useRef({ submit, onSubmit, onClarify, question, refreshing, notes, takesNotes });
	latestRef.current = { submit, onSubmit, onClarify, question, refreshing, notes, takesNotes };
	const requestFreeText = () => {
		if (interactionId === undefined) {
			return;
		}
		haptic('tick');
		setSelected(undefined);
		onRequestFreeText({
			id: interactionId,
			prompt: message.text,
			submit: text => {
				const latest = latestRef.current;
				if (latest.refreshing) {
					return Promise.resolve({ status: 'rejected', message: REFRESHING_MESSAGE });
				}
				const textAnswer = attachQuestionNotes({ kind: 'text', optionCount: latest.question.optionCount, text }, latest.notes, latest.takesNotes)!;
				return latest.submit('text', () => latestRef.current.onSubmit(interactionId, [latestRef.current.question], [textAnswer]));
			},
		});
	};
	const requestClarify = () => {
		if (interactionId === undefined) {
			return;
		}
		onRequestFreeText({
			id: clarifyRequestId(interactionId),
			mode: 'clarify',
			prompt: message.text,
			submit: text => {
				const latest = latestRef.current;
				if (latest.refreshing) {
					return Promise.resolve({ status: 'rejected', message: REFRESHING_MESSAGE });
				}
				withdrawing.start();
				return latest.submit('clarify', () => latestRef.current.onClarify(interactionId, text, []));
			},
		});
	};
	const withdraw = () => {
		if (interactionId === undefined || refreshing) {
			return;
		}
		withdrawing.start();
		const partial = partialQuestionAnswers([picked], [notes], () => takesNotes);
		void submit('clarify', () => onClarify(interactionId, undefined, partial)).then(result => {
			if (result.status !== 'rejected') {
				onRequestFreeText(undefined);
			}
		});
	};
	const pick = (index: number) => {
		haptic('tick');
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
	const confirm = () => {
		if (interactionId === undefined || answer === undefined) {
			return;
		}
		haptic('commit');
		const sending = answer;
		void submit(sending.kind, () => onSubmit(interactionId, [question], [sending]));
	};
	if (clarifying || withdrawing.active) {
		return (
			<WithdrawingQuestionCard count={1} disabled={locked || refreshing} onWithdraw={withdraw} onCancel={() => onRequestFreeText(undefined)}>
				{locked ? <SubmissionStatus state={submission.state} onRetry={submission.retry} onReselect={submission.reset} /> : null}
				{error !== undefined ? <Text style={cardStyles.error}>{error}</Text> : null}
			</WithdrawingQuestionCard>
		);
	}
	return (
		<View style={cardStyles.card}>
			<View style={cardStyles.head}>
				<Icon icon={CircleHelp} size={headIconSize} color={theme.accent} strokeWidth={2.2} />
				<Text style={cardStyles.question} selectable>{message.text}</Text>
			</View>
			{message.header !== undefined || multiSelect ? (
				<View style={styles.chips}>
					{message.header !== undefined ? <Text style={cardStyles.chip}>{message.header}</Text> : null}
					{multiSelect ? <Text style={cardStyles.chip}>複数選択可</Text> : null}
				</View>
			) : null}
			<AskOptions
				message={message}
				isSelected={index => (multiSelect ? toggled.has(index) : selected === index)}
				focusIndex={multiSelect ? undefined : selected}
				disabled={disabled}
				onPick={pick}
				notes={takesNotes ? { value: notes, onChange: setNotes } : undefined}
				notesLost={!takesNotes && questionHasPreview(message) && notes.trim().length > 0}
				other={interactive && showOtherOption(message, features) ? (
					<OptionButton
						label="その他（入力して回答）"
						selected={freeTextActive}
						disabled={disabled}
						hint="下の入力欄が、この質問への回答の入力に切り替わります"
						onPress={requestFreeText}
					/>
				) : undefined}
			/>
			{locked ? (
				<SubmissionStatus state={submission.state} onRetry={submission.retry} onReselect={submission.reset} />
			) : interactive && options.length > 0 && !freeTextActive ? (
				<Button
					label={multiSelect && toggled.size > 0 ? `回答する（${toggled.size}件）` : '回答する'}
					disabled={answer === undefined || refreshing}
					onPress={confirm}
				/>
			) : null}
			{features.chat && interactive && !locked ? <ChatAboutQuestionLink disabled={disabled} onPress={requestClarify} /> : null}
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
export function AskGroupCard({ messages, refreshing, features, onSubmit, onClarify, onRequestFreeText, freeTextActiveId, clarifying }: {
	messages: AgentChatMessage[];
	refreshing: boolean;
	features: AskQuestionFeatures;
	onSubmit: SubmitAnswers;
	onClarify: ClarifyQuestions;
	onRequestFreeText: (request: QuestionFreeTextRequest | undefined) => void;
	freeTextActiveId: string | undefined;
	/** 下の入力欄が「質問に答えずに話す」の入力になっているか。 */
	clarifying: boolean;
}) {
	const theme = useThemeColors();
	const cardStyles = useChatStyles(baseCardStyles);
	const styles = useChatStyles(baseStyles);
	const headIconSize = useChatIconSize(15);
	const checkIconSize = useChatIconSize(iconSize.xs);
	const [step, setStep] = useState(0);
	const [answers, setAnswers] = useState<(QuestionGroupAnswer | undefined)[]>(() => messages.map(() => undefined));
	// メモは質問ごとに 1 つ（TUI と同じ。他の選択肢へ移っても残る）
	const [notes, setNotes] = useState<string[]>(() => messages.map(() => ''));
	const interactionId = messages[0]?.questionGroup ?? messages[0]?.toolUseId;
	const submission = useAnswerSubmission(`open:${interactionId ?? ''}`);
	const locked = isSubmissionLocked(submission.state);
	const error = submission.state.phase === 'idle' ? submission.state.error : undefined;
	const interactive = interactionId !== undefined;
	const disabled = !interactive || locked || refreshing;
	const withdrawing = useWithdrawing(submission.state.phase);
	const current = messages[step];
	const options = current?.options ?? [];
	const multiSelect = current?.multiSelect === true;
	const questions: AgentQuestionShape[] = messages.map(m => ({ optionCount: m.options?.length ?? 0, multiSelect: m.multiSelect === true, hasPreview: questionHasPreview(m) }));
	const takesNotes = (index: number) => {
		const m = messages[index];
		return m !== undefined && questionTakesNotes(m, features);
	};
	const finalAnswers = messages.map((_, index) => attachQuestionNotes(answers[index], notes[index] ?? '', takesNotes(index)));
	const answeredCount = finalAnswers.filter(answer => answer !== undefined).length;
	const allAnswered = answeredCount === messages.length;
	const answersRef = useRef(answers);
	answersRef.current = answers;
	const latestRef = useRef({ messages, refreshing, onClarify, submit: submission.run });
	latestRef.current = { messages, refreshing, onClarify, submit: submission.run };
	useEffect(() => {
		setAnswers(previous => messages.map((_, index) => previous[index]));
		setNotes(previous => messages.map((_, index) => previous[index] ?? ''));
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
		haptic('tick');
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
	const requestClarify = () => {
		if (interactionId === undefined) {
			return;
		}
		onRequestFreeText({
			id: clarifyRequestId(interactionId),
			mode: 'clarify',
			prompt: `${messages.length}つの質問`,
			submit: text => {
				const latest = latestRef.current;
				if (latest.refreshing) {
					return Promise.resolve({ status: 'rejected', message: REFRESHING_MESSAGE });
				}
				withdrawing.start();
				return latest.submit(() => latestRef.current.onClarify(interactionId, text, []));
			},
		});
	};
	const withdraw = () => {
		if (interactionId === undefined || refreshing) {
			return;
		}
		withdrawing.start();
		const partial = partialQuestionAnswers(answers, notes, takesNotes);
		void submission.run(() => onClarify(interactionId, undefined, partial)).then(result => {
			if (result.status !== 'rejected') {
				onRequestFreeText(undefined);
			}
		});
	};
	const pick = (optionIndex: number) => {
		haptic('tick');
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
			// preview のある質問は選んだ選択肢の preview を見てもらうため、次の質問へは進まない（TUI と同じ）
			if (current === undefined || !questionHasPreview(current)) {
				advance(step, next);
			}
		}
	};
	const submitAll = () => {
		if (interactionId === undefined || !allAnswered) {
			return;
		}
		haptic('commit');
		const picked = finalAnswers.filter((answer): answer is QuestionGroupAnswer => answer !== undefined);
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
			safe_preview_count: messages.filter(questionHasPreview).length,
			safe_notes_count: picked.filter(answer => answer.notes !== undefined).length,
		}));
	};
	if (clarifying || withdrawing.active) {
		return (
			<WithdrawingQuestionCard count={messages.length} disabled={locked || refreshing} onWithdraw={withdraw} onCancel={() => onRequestFreeText(undefined)}>
				{locked ? <SubmissionStatus state={submission.state} onRetry={submission.retry} onReselect={submission.reset} /> : null}
				{error !== undefined ? <Text style={cardStyles.error}>{error}</Text> : null}
			</WithdrawingQuestionCard>
		);
	}
	return (
		<View style={cardStyles.card}>
			<View style={cardStyles.head}>
				<Icon icon={CircleHelp} size={headIconSize} color={theme.accent} strokeWidth={2.2} />
				<Text style={cardStyles.title}>{`${messages.length}つの質問`}</Text>
			</View>
			<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={baseStyles.steps} keyboardShouldPersistTaps="handled">
				{messages.map((m, index) => (
					<Pressable
						key={index}
						disabled={disabled}
						onPress={() => { haptic('tick'); setStep(index); }}
						hitSlop={STEP_SLOP}
						style={[styles.step, index === step ? { borderColor: theme.accent, backgroundColor: theme.accentWash } : undefined]}
						accessibilityRole="tab"
						accessibilityState={{ selected: index === step, disabled }}
					>
						{finalAnswers[index] !== undefined ? <Icon icon={Check} size={checkIconSize} color={colors.green} /> : null}
						<Text style={[styles.stepText, index === step ? styles.stepTextOn : undefined]} numberOfLines={1}>{m.header ?? `Q${index + 1}`}</Text>
					</Pressable>
				))}
			</ScrollView>
			{current !== undefined ? <Text style={cardStyles.question} selectable>{current.text}</Text> : null}
			{multiSelect ? <View style={styles.chips}><Text style={cardStyles.chip}>複数選択可</Text></View> : null}
			{current !== undefined ? (
				<AskOptions
					message={current}
					isSelected={index => (multiSelect ? toggledIndices.includes(index) : currentAnswer?.kind === 'option' && currentAnswer.index === index)}
					focusIndex={currentAnswer?.kind === 'option' ? currentAnswer.index : undefined}
					disabled={disabled}
					onPick={pick}
					notes={takesNotes(step) ? { value: notes[step] ?? '', onChange: value => setNotes(previous => previous.map((item, i) => (i === step ? value : item))) } : undefined}
					notesLost={!takesNotes(step) && questionHasPreview(current) && (notes[step] ?? '').trim().length > 0}
					other={interactive && showOtherOption(current, features) ? (
						<OptionButton
							label="その他（入力して回答）"
							description={currentAnswer?.kind === 'text' ? currentAnswer.text : undefined}
							selected={otherSelected || currentAnswer?.kind === 'text'}
							disabled={disabled}
							hint="下の入力欄が、この質問への回答の入力に切り替わります"
							onPress={requestFreeText}
						/>
					) : undefined}
				/>
			) : null}
			{locked ? (
				<SubmissionStatus state={submission.state} onRetry={submission.retry} onReselect={submission.reset} />
			) : interactive ? (
				<Button label={`回答を送信（${answeredCount}/${messages.length}）`} disabled={!allAnswered || refreshing} onPress={submitAll} />
			) : null}
			{features.chat && interactive && !locked ? <ChatAboutQuestionLink disabled={disabled} onPress={requestClarify} /> : null}
			{!disabled && otherSelected ? <Text style={cardStyles.hint}>下の入力欄に回答を入力して送信してください</Text> : null}
			{!disabled ? <Text style={cardStyles.hint}>すべての質問に回答してから送信されます（1問ずつは送信されません）</Text> : null}
			{!interactive ? <Text style={cardStyles.hint}>この質問はターミナル表示で回答してください</Text> : null}
			{interactive && refreshing ? <Text style={cardStyles.hint}>{REFRESHING_MESSAGE}</Text> : null}
			{error !== undefined ? <Text style={cardStyles.error}>{error}</Text> : null}
		</View>
	);
}

/**
 * 「質問に答えずに話す」を送ってから結果が出るまで、カードを 1 行のままにしておく印。断られたら（送信の状態が `idle` に戻ったら）
 * 外して、元のカードで失敗を見せる。
 */
function useWithdrawing(phase: string): { readonly active: boolean; start(): void } {
	const [active, setActive] = useState(false);
	useEffect(() => {
		if (phase === 'idle') {
			setActive(false);
		}
	}, [phase]);
	return { active, start: () => setActive(true) };
}

/**
 * 選択肢の並び。preview のある質問では、選んだ選択肢の真下に TUI と同じ枠の preview とメモの行を出す。
 * iPad の 2 列でカードが十分に広いとき（`questionPreviewSplit`。カードの実際の幅で決める）は左に選択肢、右に preview を並べる。
 *
 * 並べ方・選んだ選択肢が変わってもツリーの形は変えない（ボタンやメモの入力欄を作り直さないため。CLAUDE.md の iPad の規則）。
 * いつも「選択肢と『その他』の並び → preview とメモ」の 2 つを置き、preview とメモの位置は style で決める:
 *  - 狭い幅で選んでいる: 選んだ選択肢の下に preview とメモの高さぶんの余白を空け、そこへ浮かせる
 *  - 狭い幅で選んでいない: 並びの後ろ（メモの行だけ）
 *  - 左右に並べる: 右へ浮かせる
 */
function AskOptions({ message, isSelected, focusIndex, disabled, onPick, other, notes, notesLost }: {
	message: AgentChatMessage;
	isSelected: (index: number) => boolean;
	/** 選んでいる選択肢（単一選択）。その preview を出す。 */
	focusIndex: number | undefined;
	disabled: boolean;
	onPick: (index: number) => void;
	/** 「その他（入力して回答）」の行（出さないときは undefined）。 */
	other: ReactNode | undefined;
	/** メモ（preview のある質問で、PC の mod が待っているときだけ）。 */
	notes: { readonly value: string; readonly onChange: (value: string) => void } | undefined;
	/** メモを書いたあとで mod が待つのをやめた（キー注入では送れない）。メモの値は残す。 */
	notesLost: boolean;
}) {
	const cardStyles = useChatStyles(baseCardStyles);
	const styles = useChatStyles(baseStyles);
	const regular = useIsRegularWidth();
	const [width, setWidth] = useState(0);
	const [panelHeight, setPanelHeight] = useState(0);
	const [rows, setRows] = useState<readonly ({ readonly y: number; readonly height: number } | undefined)[]>([]);
	const options = message.options ?? [];
	const multiSelect = message.multiSelect === true;
	const hasPreview = questionHasPreview(message);
	const split = hasPreview && questionPreviewSplit(regular, width);
	const shownIndex = split ? (focusIndex ?? 0) : focusIndex;
	const shownOption = hasPreview && shownIndex !== undefined ? options[shownIndex] : undefined;
	const previewShown = shownOption?.preview !== undefined;
	// 狭い幅で、選んだ選択肢の真下に浮かせるか（その選択肢の位置を測れてから）
	const focusRow = !split && previewShown && focusIndex !== undefined ? rows[focusIndex] : undefined;
	const panelEmpty = !previewShown && !split && notes === undefined && !notesLost;
	const panelStyle = split
		? styles.splitPanel
		: focusRow !== undefined
			? [styles.previewIndent, styles.floatingPanel, { top: focusRow.y + focusRow.height + space.xs }]
			: styles.previewIndent;
	const setRow = (index: number, y: number, height: number) => setRows(previous => {
		const current = previous[index];
		if (current !== undefined && current.y === y && current.height === height) {
			return previous;
		}
		const next = [...previous];
		next[index] = { y, height };
		return next;
	});
	return (
		<View
			style={[styles.optionsWrap, split ? { minHeight: panelHeight } : undefined]}
			onLayout={event => setWidth(event.nativeEvent.layout.width)}
		>
			<View style={[styles.options, split ? styles.splitColumn : undefined]}>
				{options.map((option, index) => (
					<View
						key={index}
						style={focusRow !== undefined && index === focusIndex ? { marginBottom: panelHeight + space.xs } : undefined}
						onLayout={event => setRow(index, event.nativeEvent.layout.y, event.nativeEvent.layout.height)}
					>
						<OptionButton
							label={option.label}
							description={option.description}
							selected={isSelected(index)}
							multiSelect={multiSelect}
							disabled={disabled}
							onPress={() => onPick(index)}
						/>
					</View>
				))}
				{other}
			</View>
			<View
				style={[styles.previewPanel, panelStyle, panelEmpty ? styles.hidden : undefined]}
				onLayout={event => setPanelHeight(event.nativeEvent.layout.height)}
			>
				<View style={previewShown ? undefined : styles.hidden}>
					<QuestionPreviewBox text={shownOption?.preview ?? ''} title={shownOption?.label ?? ''} />
				</View>
				<Text style={[cardStyles.hint, split && !previewShown ? undefined : styles.hidden]}>この選択肢にプレビューはありません</Text>
				{notes !== undefined ? <QuestionNotesLine value={notes.value} onChange={notes.onChange} disabled={disabled} /> : null}
				{notesLost ? <Text style={cardStyles.error}>この PC ではメモを送れなくなりました（メモは残してあります）</Text> : null}
			</View>
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
	const theme = useThemeColors();
	const cardStyles = useChatStyles(baseCardStyles);
	const styles = useChatStyles(baseStyles);
	const checkboxSize = useChatIconSize(iconSize.md);
	return (
		<Pressable
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => [
				cardStyles.option,
				styles.option,
				selected ? [cardStyles.optionSelected, { borderColor: theme.accent, backgroundColor: theme.accentWash }] : undefined,
				disabled ? cardStyles.optionDisabled : undefined,
				pressed ? cardStyles.optionPressed : undefined,
			]}
			accessibilityRole="button"
			accessibilityState={{ selected, disabled }}
			accessibilityHint={hint}
		>
			{multiSelect ? <Icon icon={selected ? SquareCheck : Square} size={checkboxSize} color={selected ? theme.accent : colors.textDim} /> : null}
			<View style={styles.optionBody}>
				<Text style={cardStyles.optionLabel}>{label}</Text>
				{description !== undefined && description.length > 0 ? <Text style={cardStyles.optionDescription} numberOfLines={3}>{description}</Text> : null}
			</View>
		</Pressable>
	);
}

const baseStyles = StyleSheet.create({
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
	optionsWrap: {
		gap: space.xs,
	},
	previewPanel: {
		gap: space.xs,
	},
	previewIndent: {
		paddingLeft: space.md,
	},
	/** 左右に並べるとき: 選択肢は左の 4 割。 */
	splitColumn: {
		width: '40%',
	},
	/** 左右に並べるとき: preview とメモは右の 6 割へ浮かせる（ツリーの位置は変えない）。 */
	splitPanel: {
		position: 'absolute',
		top: 0,
		right: 0,
		width: '57%',
	},
	/** 狭い幅: 選んだ選択肢の下に空けた余白へ浮かせる（top は測った位置）。 */
	floatingPanel: {
		position: 'absolute',
		left: 0,
		right: 0,
	},
	hidden: {
		display: 'none',
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
