// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentChatMessage } from '../store.js';
import { colors } from '../theme.js';

/**
 * 質問カード（Claude Code の AskUserQuestion 等）。
 *  - 単一選択: 選択肢タップで番号+EnterをPTYへ注入して即回答
 *  - 複数選択(multiSelect): タップでトグル（番号+スペース注入）し、「決定」でEnter注入
 *  - 自由入力: カード内の入力欄からTUIの「Other」（常に選択肢の末尾に存在）経由で回答
 * 同じ toolUseId の tool_result が届いたら回答済み表示になる。
 * agent.tsx（TUIチャット画面）とホーム画面のアテンションカードの両方から使う。
 */
export function QuestionCard({ message, answered, onAnswer, onToggle, onConfirm, onFreeText }: {
	message: AgentChatMessage;
	answered: boolean;
	onAnswer: (optionIndex: number) => void;
	onToggle: (optionIndex: number) => void;
	onConfirm: () => void;
	onFreeText: (optionCount: number, text: string) => void;
}) {
	// 二度押し防止のローカル状態（tool_result が届くまでの間）
	const [selected, setSelected] = useState<number | undefined>(undefined);
	const [toggled, setToggled] = useState<Set<number>>(new Set());
	const [freeText, setFreeText] = useState('');
	const [submitted, setSubmitted] = useState(false);
	const multiSelect = message.multiSelect === true;
	const options = message.options ?? [];
	const disabled = answered || submitted || (!multiSelect && selected !== undefined);
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
		onToggle(i);
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
						if (multiSelect) {
							toggle(i);
						} else {
							setSelected(i);
							onAnswer(i);
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
					onPress={() => { setSubmitted(true); onConfirm(); }}
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
					/>
					<Pressable
						style={[styles.questionFreeSend, freeText.trim().length === 0 && styles.confirmBtnDisabled]}
						disabled={freeText.trim().length === 0}
						onPress={() => { setSubmitted(true); onFreeText(options.length, freeText.trim()); }}
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
});
