// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentQuestionShape } from '../agentQuestionKeys.js';
import type { QuestionGroupAnswer } from '../hooks/useAgentActions.js';
import type { AgentChatMessage, AgentMessageSendResult } from '../store.js';
import { colors } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';
import { setMobileSpanAttributes, startMobileSpan } from '../sentry.js';

/**
 * 質問カード（Claude Code の AskUserQuestion 等）。
 *  - 単一選択: 選択肢タップで即回答
 *  - 複数選択(multiSelect): タップでトグルし、「決定」で回答
 *  - 自由入力: カード内の入力欄からTUIの「Other」（常に選択肢の末尾に存在）経由で回答
 * どれもTUIのキー操作へ翻訳して送る（規則は agentQuestionKeys.ts）。
 * 同じ toolUseId の tool_result が届いたら回答済み表示になる。
 * agent.tsx（TUIチャット画面）とホーム画面のアテンションカードの両方から使う。
 */
export function QuestionCard({ message, answered, refreshing, onAnswer, onMulti, onFreeText }: {
	message: AgentChatMessage;
	answered: boolean;
	/** 再取得の応答待ち。表示は残したまま操作だけ止める（回答済みとは別の状態）。 */
	refreshing?: boolean;
	onAnswer: (interactionId: string, question: AgentQuestionShape, optionIndex: number) => Promise<AgentMessageSendResult>;
	onMulti: (interactionId: string, question: AgentQuestionShape, indices: number[]) => Promise<AgentMessageSendResult>;
	onFreeText: (interactionId: string, question: AgentQuestionShape, text: string) => Promise<AgentMessageSendResult>;
}) {
	// 二度押し防止のローカル状態（tool_result が届くまでの間）
	const [selected, setSelected] = useState<number | undefined>(undefined);
	const [toggled, setToggled] = useState<Set<number>>(new Set());
	const [freeText, setFreeText] = useState('');
	const [submitted, setSubmitted] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const multiSelect = message.multiSelect === true;
	const options = message.options ?? [];
	/** TUI上の形。回答をキー列に直すのに要る（agentQuestionKeys.ts）。 */
	const question: AgentQuestionShape = { optionCount: options.length, multiSelect };
	const interactionId = message.questionGroup ?? message.toolUseId;
	// PC側で回答された（answered）か、対象が入れ替わったら直前の失敗表示は用済み。
	useEffect(() => { setError(undefined); }, [answered, interactionId]);
	const disabled = answered || submitted || refreshing === true || interactionId === undefined;
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
	const submit = (kind: 'option' | 'multi' | 'text', action: () => Promise<AgentMessageSendResult>) => {
		setSubmitted(true);
		setError(undefined);
		const retry = setTimeout(() => setSubmitted(false), 15_000);
		void startMobileSpan('agentQuestion', 'submit-single', () => action().then(result => {
			setMobileSpanAttributes({ safe_status: result.status });
			if (result.status !== 'rejected') {
				return; // accepted / consumed（TUIへ貼り付け済み）は失敗ではない
			}
			clearTimeout(retry);
			setSubmitted(false);
			setError(result.message ?? '回答を送信できませんでした');
		}), {
			safe_answer_kind: kind,
			safe_option_count: options.length,
			safe_multi_select: multiSelect,
		});
	};
	return (
		<View style={[styles.questionCard, answered && styles.questionCardAnswered]}>
			<View style={styles.questionHeader}>
				<Ionicons name="help-circle" size={16} color={answered ? colors.textDim : colors.accent2} />
				{message.header ? <Text style={styles.questionChip}>{message.header}</Text> : null}
				{multiSelect ? <Text style={styles.questionChip}>複数選択可</Text> : null}
				{answered ? <Text style={styles.questionAnswered}>回答済み</Text> : null}
			</View>
			<Text style={styles.questionText} selectable>{message.text}</Text>
			{options.map((option, i) => (
				<Pressable
					key={i}
					style={[styles.questionOption, (multiSelect ? isToggled(i) : selected === i) && styles.questionOptionSelected, disabled && styles.questionOptionDisabled]}
					disabled={disabled}
					accessibilityRole="button"
					accessibilityState={{ selected: multiSelect ? isToggled(i) : selected === i, disabled }}
					onPress={() => {
						hapticSelection();
						if (multiSelect) {
							toggle(i);
						} else {
							setSelected(i);
							if (interactionId !== undefined) {
								submit('option', () => onAnswer(interactionId, question, i));
							}
						}
					}}
				>
					<Text style={styles.questionOptionLabel}>{multiSelect ? (isToggled(i) ? '☑' : '☐') : `${i + 1}.`} {option.label}</Text>
					{option.description ? <Text style={styles.questionOptionDesc} numberOfLines={3}>{option.description}</Text> : null}
				</Pressable>
			))}
			{multiSelect && !disabled ? (
				<Pressable
					style={[styles.questionConfirmBtn, toggled.size === 0 && styles.confirmBtnDisabled]}
					disabled={toggled.size === 0 || interactionId === undefined}
					accessibilityRole="button"
					accessibilityState={{ disabled: toggled.size === 0 || interactionId === undefined }}
					onPress={() => { if (interactionId !== undefined) { hapticImpact('medium'); submit('multi', () => onMulti(interactionId, question, [...toggled].sort((a, b) => a - b))); } }}
				>
					<Text style={styles.confirmBtnText}>決定（{toggled.size}件）</Text>
				</Pressable>
			) : null}
			{!disabled ? (
				<View style={styles.questionFreeRow}>
					<TextInput
						style={styles.questionFreeInput}
						value={freeText}
						onChangeText={setFreeText}
						placeholder="自由に入力して回答…"
						placeholderTextColor={colors.textDim}
						autoCapitalize="none"
						autoCorrect={false}
						onFocus={() => hapticSelection()}
					/>
					<Pressable
						style={[styles.questionFreeSend, freeText.trim().length === 0 && styles.confirmBtnDisabled]}
						disabled={freeText.trim().length === 0 || interactionId === undefined}
						accessibilityRole="button"
						accessibilityState={{ disabled: freeText.trim().length === 0 || interactionId === undefined }}
						onPress={() => { if (interactionId !== undefined) { hapticImpact('medium'); submit('text', () => onFreeText(interactionId, question, freeText.trim())); } }}
						accessibilityLabel="自由入力で回答"
					>
						<Ionicons name="arrow-up" size={16} color="#fff" />
					</Pressable>
				</View>
			) : null}
			{!answered && options.length === 0 ? (
				<Text style={styles.hint}>選択肢を取得できませんでした。TUI側と番号がずれる可能性があるため、ターミナルタブでの回答が確実です</Text>
			) : null}
			{!answered && interactionId === undefined ? <Text style={styles.hint}>この質問はモバイルから安全に回答できません。ターミナルタブで回答してください</Text> : null}
			{!answered && refreshing === true ? <Text style={styles.hint}>最新の内容を取得しています。届くまで回答できません</Text> : null}
			{error !== undefined ? <Text style={styles.questionError}>{error}</Text> : null}
			{!disabled && options.length > 0 ? <Text style={styles.hint}>{multiSelect ? 'タップで選択し「決定」で回答します' : 'タップで回答します'}</Text> : null}
		</View>
	);
}

/**
 * 複数質問グループ（AskUserQuestion の questions が2つ以上）のステップ式カード。
 * 質問は上部の横並びタブで切り替え、回答はローカルに溜めて**全問揃ってから一括送信**する。
 * TUIでは1問ごとのEnterがフォーム全体をSubmitしてしまうため、1問ずつの即時注入はしない
 * （送信キー列の組み立ては useAgentActions.answerQuestionGroup 側）。
 */
export function QuestionGroupCard({ messages, answered, refreshing, onSubmit }: {
	/** 同一 questionGroup の質問（questionIndex 順）。 */
	messages: AgentChatMessage[];
	answered: boolean;
	/** 再取得の応答待ち。表示は残したまま操作だけ止める（回答済みとは別の状態）。 */
	refreshing?: boolean;
	onSubmit: (interactionId: string, questions: readonly AgentQuestionShape[], answers: QuestionGroupAnswer[]) => Promise<AgentMessageSendResult>;
}) {
	const [step, setStep] = useState(0);
	const [answers, setAnswers] = useState<(QuestionGroupAnswer | undefined)[]>(() => messages.map(() => undefined));
	const [freeTexts, setFreeTexts] = useState<string[]>(() => messages.map(() => ''));
	const [submitted, setSubmitted] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const interactionId = messages[0]?.questionGroup ?? messages[0]?.toolUseId;
	// PC側で回答された（answered）か、対象が入れ替わったら直前の失敗表示は用済み。
	useEffect(() => { setError(undefined); }, [answered, interactionId]);
	const disabled = answered || submitted || refreshing === true || interactionId === undefined;
	const current = messages[step];
	const options = current?.options ?? [];
	const multiSelect = current?.multiSelect === true;
	/** TUI上の形（質問の並び順）。回答をキー列に直すのに要る（agentQuestionKeys.ts）。 */
	const questions: AgentQuestionShape[] = messages.map(m => ({ optionCount: m.options?.length ?? 0, multiSelect: m.multiSelect === true }));
	const answeredCount = answers.filter(a => a !== undefined).length;
	const allAnswered = answeredCount === messages.length;
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
		for (let i = 1; i <= messages.length; i++) {
			const candidate = (from + i) % messages.length;
			if (nextAnswers[candidate] === undefined) {
				setStep(candidate);
				return;
			}
		}
	};
	const currentAnswer = answers[step];
	const toggledIndices = currentAnswer?.kind === 'multi' ? currentAnswer.indices : [];

	return (
		<View style={[styles.questionCard, answered && styles.questionCardAnswered]}>
			<View style={styles.questionHeader}>
				<Ionicons name="help-circle" size={16} color={answered ? colors.textDim : colors.accent2} />
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
						onPress={() => { hapticSelection(); setStep(i); }}
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
							hapticSelection();
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
			{!disabled ? (
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
					onFocus={() => hapticSelection()}
				/>
			) : null}
			{!disabled ? (
				<Pressable
					style={[styles.questionConfirmBtn, !allAnswered && styles.confirmBtnDisabled]}
					disabled={!allAnswered || interactionId === undefined}
					accessibilityRole="button"
					accessibilityState={{ disabled: !allAnswered || interactionId === undefined }}
					onPress={() => {
						if (interactionId === undefined) { return; }
						hapticImpact('medium');
						setSubmitted(true);
						setError(undefined);
						const retry = setTimeout(() => setSubmitted(false), 15_000);
						const picked = answers.filter((a): a is QuestionGroupAnswer => a !== undefined);
						// 複数ステップ・自由入力つきの回答がPCで正しく再生されているかは、送った側の
						// 形と結果を並べないと分からない。件数と種別だけを残す（本文は載せない）。
						void startMobileSpan('agentQuestion', 'submit-group', () =>
							onSubmit(interactionId, questions, picked)
								.then(result => {
									// 拒否の理由コードはPC側の span に出るので、ここでは結果だけ。
									// message は画面へ出す文言なので載せない。
									setMobileSpanAttributes({ safe_status: result.status });
									if (result.status !== 'rejected') {
										return; // accepted / consumed は失敗ではない
									}
									clearTimeout(retry);
									setSubmitted(false);
									setError(result.message ?? '回答を送信できませんでした');
								}), {
							safe_question_count: messages.length,
							safe_answer_count: picked.length,
							safe_option_counts: questions.map(q => q.optionCount).join(','),
							safe_multi_select_count: questions.filter(q => q.multiSelect).length,
							safe_free_text_count: picked.filter(a => a.kind === 'text').length,
						});
					}}
				>
					<Text style={styles.confirmBtnText}>回答を送信（{answeredCount}/{messages.length}）</Text>
				</Pressable>
			) : null}
			{!disabled ? <Text style={styles.hint}>すべての質問に回答してから送信されます（1問ずつは送信されません）</Text> : null}
			{!answered && interactionId === undefined ? <Text style={styles.hint}>この質問グループはターミナルタブで回答してください</Text> : null}
			{error !== undefined ? <Text style={styles.questionError}>{error}</Text> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	questionCard: { backgroundColor: 'rgba(9,175,217,.10)', borderWidth: 1, borderColor: colors.accent2, borderRadius: 16, padding: 14, gap: 8 },
	questionCardAnswered: { borderColor: colors.border, backgroundColor: colors.surface, opacity: 0.75 },
	questionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	questionChip: { color: colors.text, fontSize: 11, fontWeight: '600', backgroundColor: colors.surface2, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
	questionAnswered: { color: colors.textDim, fontSize: 11, marginLeft: 'auto' },
	questionText: { color: colors.text, fontSize: 13, lineHeight: 19, fontWeight: '600' },
	questionOption: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 11, gap: 3 },
	questionOptionSelected: { borderColor: colors.accent, backgroundColor: colors.accentWash },
	questionOptionDisabled: { opacity: 0.6 },
	questionOptionLabel: { color: colors.text, fontSize: 12.5, fontWeight: '600' },
	questionOptionDesc: { color: colors.textDim, fontSize: 11, lineHeight: 15 },
	questionConfirmBtn: { backgroundColor: colors.accent2, borderRadius: 12, paddingVertical: 10, alignItems: 'center' },
	questionFreeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	questionFreeInput: { flex: 1, backgroundColor: colors.surface2, borderRadius: 12, borderWidth: 1, borderColor: colors.border, color: colors.text, fontSize: 12.5, paddingHorizontal: 13, paddingVertical: 10 },
	questionFreeSend: { backgroundColor: colors.accent2, borderRadius: 12, width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
	confirmBtnDisabled: { opacity: 0.4 },
	confirmBtnText: { color: '#fff', fontSize: 12.5, fontWeight: '700' },
	hint: { color: colors.textDim, fontSize: 10 },
	questionError: { color: colors.red, fontSize: 11, lineHeight: 15 },
	stepTabs: { flexDirection: 'row', gap: 6 },
	stepTab: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5 },
	stepTabActive: { borderColor: colors.accent, backgroundColor: colors.accentWash },
	stepTabAnswered: { borderColor: colors.accent2 },
	stepTabText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
	stepTabTextActive: { color: colors.text },
});
