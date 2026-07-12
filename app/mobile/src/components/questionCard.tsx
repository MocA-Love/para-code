// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { QuestionGroupAnswer } from '../hooks/useAgentActions.js';
import type { AgentChatMessage } from '../store.js';
import { colors } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';

/**
 * 質問カード（Claude Code の AskUserQuestion 等）。
 *  - 単一選択: 選択肢タップで番号+EnterをPTYへ注入して即回答
 *  - 複数選択(multiSelect): タップでトグル（番号+スペース注入）し、「決定」でEnter注入
 *  - 自由入力: カード内の入力欄からTUIの「Other」（常に選択肢の末尾に存在）経由で回答
 * 同じ toolUseId の tool_result が届いたら回答済み表示になる。
 * agent.tsx（TUIチャット画面）とホーム画面のアテンションカードの両方から使う。
 */
export function QuestionCard({ message, answered, onAnswer, onMulti, onFreeText }: {
	message: AgentChatMessage;
	answered: boolean;
	onAnswer: (interactionId: string, optionIndex: number) => Promise<boolean>;
	onMulti: (interactionId: string, indices: number[]) => Promise<boolean>;
	onFreeText: (interactionId: string, optionCount: number, text: string) => Promise<boolean>;
}) {
	// 二度押し防止のローカル状態（tool_result が届くまでの間）
	const [selected, setSelected] = useState<number | undefined>(undefined);
	const [toggled, setToggled] = useState<Set<number>>(new Set());
	const [freeText, setFreeText] = useState('');
	const [submitted, setSubmitted] = useState(false);
	const multiSelect = message.multiSelect === true;
	const options = message.options ?? [];
	const interactionId = message.questionGroup ?? message.toolUseId;
	const disabled = answered || submitted;
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
	const submit = (action: () => Promise<boolean>) => {
		setSubmitted(true);
		void action().then(accepted => { if (!accepted) { setSubmitted(false); } });
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
					onPress={() => {
						hapticSelection();
						if (multiSelect) {
							toggle(i);
						} else {
							setSelected(i);
							if (interactionId !== undefined) {
								submit(() => onAnswer(interactionId, i));
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
					disabled={toggled.size === 0}
					onPress={() => { if (interactionId !== undefined) { hapticImpact('medium'); submit(() => onMulti(interactionId, [...toggled].sort((a, b) => a - b))); } }}
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
						disabled={freeText.trim().length === 0}
						onPress={() => { if (interactionId !== undefined) { hapticImpact('medium'); submit(() => onFreeText(interactionId, options.length, freeText.trim())); } }}
						accessibilityLabel="自由入力で回答"
					>
						<Ionicons name="arrow-up" size={16} color="#fff" />
					</Pressable>
				</View>
			) : null}
			{!answered && options.length === 0 ? (
				<Text style={styles.hint}>選択肢を取得できませんでした。TUI側と番号がずれる可能性があるため、ターミナルタブでの回答が確実です</Text>
			) : null}
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
export function QuestionGroupCard({ messages, answered, onSubmit }: {
	/** 同一 questionGroup の質問（questionIndex 順）。 */
	messages: AgentChatMessage[];
	answered: boolean;
	onSubmit: (interactionId: string, answers: QuestionGroupAnswer[]) => Promise<boolean>;
}) {
	const [step, setStep] = useState(0);
	const [answers, setAnswers] = useState<(QuestionGroupAnswer | undefined)[]>(() => messages.map(() => undefined));
	const [freeTexts, setFreeTexts] = useState<string[]>(() => messages.map(() => ''));
	const [submitted, setSubmitted] = useState(false);
	const disabled = answered || submitted;
	const current = messages[step];
	const options = current?.options ?? [];
	const multiSelect = current?.multiSelect === true;
	const answeredCount = answers.filter(a => a !== undefined).length;
	const allAnswered = answeredCount === messages.length;
	const interactionId = messages[0]?.questionGroup ?? messages[0]?.toolUseId;

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
						onPress={() => {
							hapticSelection();
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
						setAnswer(step, text.trim().length > 0 ? { kind: 'text', optionCount: options.length, text: text.trim() } : undefined);
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
					disabled={!allAnswered}
					onPress={() => {
						if (interactionId === undefined) { return; }
						hapticImpact('medium');
						setSubmitted(true);
						void onSubmit(interactionId, answers.filter((a): a is QuestionGroupAnswer => a !== undefined))
							.then(accepted => { if (!accepted) { setSubmitted(false); } });
					}}
				>
					<Text style={styles.confirmBtnText}>回答を送信（{answeredCount}/{messages.length}）</Text>
				</Pressable>
			) : null}
			{!disabled ? <Text style={styles.hint}>すべての質問に回答してから送信されます（1問ずつは送信されません）</Text> : null}
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
	stepTabs: { flexDirection: 'row', gap: 6 },
	stepTab: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5 },
	stepTabActive: { borderColor: colors.accent, backgroundColor: colors.accentWash },
	stepTabAnswered: { borderColor: colors.accent2 },
	stepTabText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
	stepTabTextActive: { color: colors.text },
});
