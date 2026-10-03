// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CircleHelp } from 'lucide-react-native';
import { formatQuestionPreview, previewNeedsFullView, PREVIEW_INLINE_MAX_LINES, QUESTION_NOTES_LIMIT, type PreviewLine } from '../../agentQuestionMod.js';
import { BottomSheet } from '../../components/bottomSheet.js';
import { haptic } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { HIT_SIZE, colors, radius, space, type } from '../../theme.js';
import { Button, Icon, useThemeColors } from '../../ui/index.js';
import { useChatIconSize, useChatStyles } from '../../ui/chatTextScale.js';
import { cardStyles as baseCardStyles } from './answerCardStyles.js';
import { usePinnedCardScroll } from './pinnedCard.js';

/** 「質問に答えずに話す」などの文字のボタンの当たり判定（文字の高さ 17 → 44）。 */
const LINK_SLOP = { top: 14, bottom: 14, left: 0, right: 8 };

/**
 * 選択肢の preview（AskUserQuestion の `preview`）。TUI と同じく等幅・細い枠・折り返し無しで描き、横にはみ出す分は
 * 横にスクロールする（罫線の図を崩さない）。見出しの `#` とコードフェンスの記号は外す。
 * 長いもの（{@link PREVIEW_INLINE_MAX_LINES} 行を超える）は先頭だけを出し、全画面のシートで全体を読める。
 */
export function QuestionPreviewBox({ text, title }: { text: string; title: string }) {
	const styles = useChatStyles(baseStyles);
	const [fullOpen, setFullOpen] = useState(false);
	const lines = formatQuestionPreview(text);
	const long = previewNeedsFullView(lines);
	return (
		<View style={styles.previewWrap}>
			<PreviewFrame lines={long ? lines.slice(0, PREVIEW_INLINE_MAX_LINES) : lines} />
			{long ? (
				<Pressable
					onPress={() => { haptic('tick'); setFullOpen(true); }}
					hitSlop={LINK_SLOP}
					accessibilityRole="button"
					accessibilityLabel="プレビューを全画面で見る"
				>
					<Text style={styles.moreLink}>{`全体を見る（${lines.length}行）`}</Text>
				</Pressable>
			) : null}
			<BottomSheet visible={fullOpen} onClose={() => setFullOpen(false)} title={title} fullHeight>
				<ScrollView contentContainerStyle={styles.sheetContent}>
					<PreviewFrame lines={lines} />
				</ScrollView>
			</BottomSheet>
		</View>
	);
}

function PreviewFrame({ lines }: { lines: readonly PreviewLine[] }) {
	const styles = useChatStyles(baseStyles);
	return (
		<View style={styles.frame}>
			<ScrollView horizontal showsHorizontalScrollIndicator nestedScrollEnabled contentContainerStyle={styles.frameContent}>
				<Text style={styles.mono} selectable>
					{lines.length === 0 ? ' ' : lines.map((line, index) => (
						<Text key={index} style={line.heading ? styles.heading : undefined}>{`${line.text}${index < lines.length - 1 ? '\n' : ''}`}</Text>
					))}
				</Text>
			</ScrollView>
		</View>
	);
}

/** キーボードが出きってから入力欄をカードの中で見える位置へ送るまでの待ち（キーボードの動きは約 250ms）。 */
const REVEAL_AFTER_KEYBOARD_MS = 300;

/**
 * 質問へのメモ（TUI の「Notes: press n to add notes」）。質問ごとに 1 つで、他の選択肢へ移っても残る。
 * 押すとその場で書ける入力欄になる。キーボードが出たら、カードのスクロールの中で入力欄が見える位置まで送る。
 */
export function QuestionNotesLine({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
	const styles = useChatStyles(baseStyles);
	const [editing, setEditing] = useState(false);
	const cardScroll = usePinnedCardScroll();
	const editRef = useRef<View>(null);
	const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(revealTimer.current), []);
	const reveal = () => {
		clearTimeout(revealTimer.current);
		revealTimer.current = setTimeout(() => cardScroll.reveal(editRef.current), REVEAL_AFTER_KEYBOARD_MS);
	};
	if (editing && !disabled) {
		return (
			<View ref={editRef} collapsable={false} style={styles.notesEdit}>
				<Text style={styles.notesLabel}>この質問へのメモ（選んだ答えに添えて送ります。選ばずにメモだけでも送れます）</Text>
				<TextInput
					style={styles.notesInput}
					value={value}
					onChangeText={onChange}
					onFocus={reveal}
					onBlur={() => setEditing(false)}
					placeholder="例: 文言は短めにしてほしい"
					placeholderTextColor={colors.textMuted}
					multiline
					autoFocus
					maxLength={QUESTION_NOTES_LIMIT}
					accessibilityLabel="この質問へのメモ"
				/>
			</View>
		);
	}
	return (
		<Pressable
			onPress={() => { haptic('tick'); setEditing(true); }}
			disabled={disabled}
			style={({ pressed }) => [styles.notesLine, pressed ? styles.pressed : undefined]}
			accessibilityRole="button"
			accessibilityLabel={value.trim().length > 0 ? `メモ: ${value}` : 'メモを追加'}
		>
			<Text style={styles.notesText} numberOfLines={2}>
				<Text style={styles.notesKey}>メモ: </Text>
				{value.trim().length > 0 ? <Text style={styles.notesValue}>{value}</Text> : 'タップして追加'}
			</Text>
		</Pressable>
	);
}

/** 「質問に答えずに話す」（TUI の「Chat about this」）。押すとカードが 1 行に縮み、下の入力欄が取り下げの入力になる。 */
export function ChatAboutQuestionLink({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
	const cardStyles = useChatStyles(baseCardStyles);
	const styles = useChatStyles(baseStyles);
	return (
		<Pressable
			onPress={() => { haptic('tick'); onPress(); }}
			disabled={disabled}
			hitSlop={LINK_SLOP}
			style={({ pressed }) => [styles.chatLink, pressed ? styles.pressed : undefined, disabled ? styles.disabled : undefined]}
			accessibilityRole="button"
			accessibilityHint="質問を取り下げて、下の入力欄から伝えたいことを送れます"
		>
			<Text style={[cardStyles.link, styles.mutedLink]}>質問に答えずに話す</Text>
		</Pressable>
	);
}

/**
 * 「質問に答えずに話す」を押したあとのカード（1 行）。「取り下げる」は何も書かずに取り下げ（エージェントは何を確かめたいかを
 * 聞き返す）、「やめる」は回答に戻る。
 */
export function WithdrawingQuestionCard({ count, disabled, onWithdraw, onCancel, children }: {
	count: number;
	disabled: boolean;
	onWithdraw: () => void;
	onCancel: () => void;
	/** 送信の状態・失敗の表示。 */
	children?: ReactNode;
}) {
	const theme = useThemeColors();
	const cardStyles = useChatStyles(baseCardStyles);
	const styles = useChatStyles(baseStyles);
	const headIconSize = useChatIconSize(15);
	return (
		<View style={cardStyles.card}>
			<View style={styles.compact}>
				<Icon icon={CircleHelp} size={headIconSize} color={theme.accent} strokeWidth={2.2} />
				<Text style={styles.compactText} numberOfLines={1}>{`${count}つの質問 ・ 答えずに話しています`}</Text>
				<Button label="取り下げる" variant="ghost" size="sm" disabled={disabled} onPress={() => { haptic('commit'); onWithdraw(); }} />
				<Button label="やめる" variant="ghost" size="sm" disabled={disabled} onPress={() => { haptic('move'); onCancel(); }} />
			</View>
			{children}
		</View>
	);
}

const baseStyles = StyleSheet.create({
	previewWrap: {
		gap: space.xs,
	},
	frame: {
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		borderRadius: radius.control,
		backgroundColor: colors.bg,
		overflow: 'hidden',
	},
	frameContent: {
		paddingHorizontal: 10,
		paddingVertical: space.sm,
	},
	mono: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.text,
	},
	heading: {
		fontWeight: '700',
	},
	moreLink: {
		alignSelf: 'flex-start',
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.accent,
	},
	sheetContent: {
		padding: space.lg,
	},
	notesLine: {
		minHeight: HIT_SIZE,
		justifyContent: 'center',
	},
	notesText: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
	},
	notesKey: {
		fontWeight: '700',
		color: colors.textDim,
	},
	notesValue: {
		color: colors.text,
	},
	notesEdit: {
		gap: space.xs,
	},
	notesLabel: {
		fontSize: type.caption,
		lineHeight: 15,
		color: colors.textMuted,
	},
	notesInput: {
		minHeight: 64,
		maxHeight: 140,
		paddingHorizontal: 10,
		paddingVertical: space.sm,
		fontSize: type.body,
		color: colors.text,
		backgroundColor: colors.bg,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		borderRadius: radius.control,
		textAlignVertical: 'top',
	},
	chatLink: {
		alignSelf: 'flex-start',
		paddingVertical: space.xs,
	},
	mutedLink: {
		color: colors.textDim,
	},
	compact: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
	},
	compactText: {
		flex: 1,
		minWidth: 0,
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	pressed: {
		opacity: 0.6,
	},
	disabled: {
		opacity: 0.5,
	},
});
