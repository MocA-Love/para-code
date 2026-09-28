// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Check, MessageSquare, Send, Sparkles, Trash2, X } from 'lucide-react-native';
import { hapticSelection } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import type { WorktreeAgentDef } from '../../store.js';
import { colors, radius, space, type } from '../../theme.js';
import { BottomDrawer, Button, DrawerTitle, HeaderButton, Icon, iconSize, useThemeColors } from '../../ui/index.js';
import { REVIEW_NOTE_BODY_MAX, sendTargetStatusLabel, type ReviewNote, type ReviewSendTarget } from './reviewNotes.js';
import { splitPath } from './scmModel.js';

/**
 * 差分の行へのメモの部品（Orca W2-28 の MobileDiffReviewLine のメモ・Comment の入力・Send のシート）。
 * メモは PC に保存し、iPhone と iPad で同じものを見る。送ったメモは「送信済み」として残す（Q120 A）。
 */

/** 差分の行のすぐ下に出すメモ。押すと書き直せる。 */
export function NoteBubble({ note, stale = false, onPress }: { note: ReviewNote; stale?: boolean; onPress: (note: ReviewNote) => void }) {
	return (
		<Pressable
			onPress={() => { hapticSelection(); onPress(note); }}
			style={({ pressed }) => [styles.bubble, stale ? styles.bubbleStale : undefined, pressed ? styles.pressed : undefined]}
			accessibilityRole="button"
			accessibilityLabel={`メモ: ${note.body}${note.sentAt !== undefined ? '（送信済み）' : ''}${stale ? '（古いメモ）' : ''}`}
			accessibilityHint="書き直すか消せます"
		>
			<Icon icon={MessageSquare} size={iconSize.sm} color={stale ? colors.textMuted : colors.accent} />
			<View style={styles.bubbleCol}>
				<Text style={[styles.bubbleText, stale ? styles.bubbleTextStale : undefined]}>{note.body}</Text>
				{note.sentAt !== undefined || stale ? (
					<Text style={styles.bubbleMeta}>{[stale ? `古いメモ · ${note.line} 行目に書いたもの` : undefined, note.sentAt !== undefined ? '送信済み' : undefined].filter(Boolean).join(' · ')}</Text>
				) : null}
			</View>
		</Pressable>
	);
}

/** 差分の中に行が見つからないメモ（差分の上にまとめて出す）。 */
export function StaleNotes({ notes, onPress }: { notes: readonly ReviewNote[]; onPress: (note: ReviewNote) => void }) {
	if (notes.length === 0) {
		return null;
	}
	return (
		<View style={styles.stale}>
			<Text style={styles.staleTitle}>{`古いメモ ${notes.length} 件（行が変わったか、差分から外れました）`}</Text>
			{notes.map(note => <NoteBubble key={note.id} note={note} stale onPress={onPress} />)}
		</View>
	);
}

/** メモを書く・書き直すシートに渡すもの。 */
export type NoteComposerTarget =
	| { readonly mode: 'add'; readonly path: string; readonly line: number; readonly lineText: string }
	| { readonly mode: 'edit'; readonly note: ReviewNote };

/**
 * メモを書く・書き直すシート（どの幅でも下から出す。iPad の広い幅では BottomDrawer が幅を絞る）。
 * 開くと入力欄にフォーカスし、キーボードの上にシートが持ち上がる。
 */
export function NoteComposer({ target, busy, onSubmit, onDelete, onClose }: {
	target: NoteComposerTarget | undefined;
	busy: boolean;
	onSubmit: (body: string) => void;
	onDelete: (note: ReviewNote) => void;
	onClose: () => void;
}) {
	const theme = useThemeColors();
	const [value, setValue] = useState('');
	const [shown, setShown] = useState<NoteComposerTarget | undefined>(undefined);
	// 開いた瞬間（別の行を開き直したときも）に入力を初期値へ戻す
	if (target !== undefined && target !== shown) {
		setShown(target);
		setValue(target.mode === 'edit' ? target.note.body : '');
	}
	const current = target ?? shown;
	const line = current === undefined ? undefined : current.mode === 'add' ? { path: current.path, line: current.line, text: current.lineText } : { path: current.note.path, line: current.note.line, text: current.note.lineText };
	const trimmed = value.trim();
	return (
		<BottomDrawer visible={target !== undefined} onClose={onClose} accessibilityLabel="メモ">
			<DrawerTitle title={current?.mode === 'edit' ? 'メモを書き直す' : 'メモを書く'} />
			{line !== undefined ? (
				<View style={styles.anchor}>
					<Text style={styles.anchorPath} numberOfLines={1}>{`${splitPath(line.path).name}:${line.line}`}</Text>
					<Text style={styles.anchorText} numberOfLines={2}>{line.text.trim().length > 0 ? line.text : ' '}</Text>
				</View>
			) : null}
			<TextInput
				style={styles.input}
				value={value}
				onChangeText={setValue}
				placeholder="直してほしいこと・気になること"
				placeholderTextColor={colors.textMuted}
				selectionColor={theme.accent}
				autoFocus
				multiline
				maxLength={REVIEW_NOTE_BODY_MAX}
				keyboardAppearance="dark"
				accessibilityLabel="メモの本文"
			/>
			{current?.mode === 'edit' && current.note.sentAt !== undefined ? <Text style={styles.hint}>書き直すと未送信に戻り、もう一度送れます。</Text> : null}
			<View style={styles.buttons}>
				{current?.mode === 'edit' ? (
					<Button label="消す" icon={Trash2} variant="danger" onPress={() => onDelete(current.note)} disabled={busy} style={styles.button} />
				) : (
					<Button label="キャンセル" variant="secondary" onPress={onClose} style={styles.button} />
				)}
				<Button label="保存" onPress={() => onSubmit(trimmed)} disabled={trimmed.length === 0 || busy} loading={busy} style={styles.button} />
			</View>
		</BottomDrawer>
	);
}

/**
 * メモの一覧と送信（iPad は右から、iPhone は下から出すシートの中身）。送っていないメモを選んでおき、
 * そのスペースで入力を待っているエージェントへ送るか、新しいエージェントを起動して送る。
 */
export function ReviewNotesPanel({ notes, selected, onToggle, onOpenNote, targets, agents, busy, onSend, onLaunch, onClear, onClose }: {
	notes: readonly ReviewNote[];
	selected: ReadonlySet<string>;
	onToggle: (id: string) => void;
	onOpenNote: (note: ReviewNote) => void;
	targets: readonly ReviewSendTarget[];
	/** 新しく起動できるエージェント（PC の定義。読めていなければ空）。 */
	agents: readonly WorktreeAgentDef[];
	busy: boolean;
	onSend: (target: ReviewSendTarget) => void;
	onLaunch: (agent: WorktreeAgentDef) => void;
	onClear: () => void;
	onClose: () => void;
}) {
	const [choosing, setChoosing] = useState(false);
	const sentCount = notes.filter(note => note.sentAt !== undefined).length;
	const canSend = selected.size > 0 && !busy;
	return (
		<View>
			<View style={styles.listHead}>
				<Text style={styles.listTitle} accessibilityRole="header">{choosing ? '送り先' : 'メモ'}</Text>
				<Text style={styles.listCount}>{choosing ? `${selected.size} 件を送る` : `${notes.length} 件`}</Text>
				<HeaderButton icon={X} label="閉じる" onPress={onClose} />
			</View>
			{choosing ? (
				<View style={styles.group}>
					{targets.length === 0 ? <Text style={styles.empty}>このスペースで動いているエージェントはありません。</Text> : null}
					{targets.map(target => (
						<Pressable
							key={target.terminalKey}
							onPress={() => { hapticSelection(); onSend(target); }}
							disabled={!target.ready || busy}
							style={({ pressed }) => [styles.row, pressed ? styles.rowOn : undefined, !target.ready ? styles.off : undefined]}
							accessibilityRole="button"
							accessibilityState={{ disabled: !target.ready || busy }}
							accessibilityLabel={`${target.title}（${sendTargetStatusLabel(target)}）へ送る`}
						>
							<Icon icon={Send} size={iconSize.md} color={colors.textDim} />
							<View style={styles.rowCol}>
								<Text style={styles.rowTitle} numberOfLines={1}>{target.title}</Text>
								<Text style={styles.rowSub} numberOfLines={1}>{sendTargetStatusLabel(target)}</Text>
							</View>
						</Pressable>
					))}
					{agents.map(agent => (
						<Pressable
							key={agent.id}
							onPress={() => { hapticSelection(); onLaunch(agent); }}
							disabled={busy}
							style={({ pressed }) => [styles.row, pressed ? styles.rowOn : undefined]}
							accessibilityRole="button"
							accessibilityLabel={`新しい ${agent.label} を起動して送る`}
						>
							<Icon icon={Sparkles} size={iconSize.md} color={colors.textDim} />
							<View style={styles.rowCol}>
								<Text style={styles.rowTitle} numberOfLines={1}>{`新しい ${agent.label} で送る`}</Text>
								<Text style={styles.rowSub} numberOfLines={1}>このスペースで起動してメモを渡します</Text>
							</View>
						</Pressable>
					))}
					<Button label="戻る" variant="secondary" onPress={() => setChoosing(false)} style={styles.back} />
				</View>
			) : (
				<>
					{notes.length === 0 ? (
						<Text style={styles.empty}>差分の行を長押しするとメモを書けます。</Text>
					) : (
						<View style={styles.group}>
							{notes.map((note, index) => {
								const on = selected.has(note.id);
								return (
									<View key={note.id}>
										{index > 0 ? <View style={styles.separator} /> : null}
										<View style={styles.row}>
											<Pressable
												onPress={() => { hapticSelection(); onToggle(note.id); }}
												hitSlop={8}
												style={[styles.check, on ? styles.checkOn : undefined]}
												accessibilityRole="checkbox"
												accessibilityState={{ checked: on }}
												accessibilityLabel="送るメモに選ぶ"
											>
												{on ? <Icon icon={Check} size={iconSize.sm} color={colors.bg} strokeWidth={2.6} /> : null}
											</Pressable>
											<Pressable onPress={() => onOpenNote(note)} style={styles.rowCol} accessibilityRole="button" accessibilityLabel={`${note.path} ${note.line} 行目のメモ: ${note.body}`}>
												<Text style={styles.rowTitle} numberOfLines={2}>{note.body}</Text>
												<Text style={styles.rowSub} numberOfLines={1}>{`${splitPath(note.path).name}:${note.line}${note.sentAt !== undefined ? ' · 送信済み' : ''}`}</Text>
											</Pressable>
										</View>
									</View>
								);
							})}
						</View>
					)}
					<View style={styles.actions}>
						<Button label={`選んだ ${selected.size} 件を送る`} icon={Send} onPress={() => setChoosing(true)} disabled={!canSend} />
						<Button label="送信済みと古いメモを消す" variant="secondary" onPress={onClear} disabled={busy || notes.length === 0} loading={busy} />
						{sentCount > 0 ? <Text style={styles.hint}>{`送信済み ${sentCount} 件は、何を頼んだか見返せるよう残しています。`}</Text> : null}
					</View>
				</>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	bubble: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: space.sm,
		marginLeft: 56,
		marginRight: space.md,
		marginVertical: space.xs,
		paddingVertical: space.sm,
		paddingHorizontal: space.md,
		borderRadius: radius.button,
		backgroundColor: colors.panel,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
	},
	bubbleStale: {
		marginLeft: space.md,
	},
	bubbleCol: {
		flex: 1,
		minWidth: 0,
	},
	bubbleText: {
		fontSize: type.label,
		color: colors.text,
	},
	bubbleTextStale: {
		color: colors.textDim,
	},
	bubbleMeta: {
		fontSize: type.caption,
		color: colors.textMuted,
		marginTop: 2,
	},
	pressed: {
		opacity: 0.75,
	},
	stale: {
		paddingTop: space.sm,
		paddingBottom: space.sm,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
	},
	staleTitle: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.textMuted,
		paddingHorizontal: space.lg,
		paddingBottom: space.xs,
	},
	anchor: {
		backgroundColor: colors.raised,
		borderRadius: radius.button,
		paddingHorizontal: space.md,
		paddingVertical: space.sm,
		marginBottom: space.sm,
	},
	anchorPath: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	anchorText: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		color: colors.text,
		marginTop: 2,
	},
	input: {
		minHeight: 96,
		maxHeight: 220,
		backgroundColor: colors.raised,
		color: colors.text,
		borderRadius: radius.input,
		borderWidth: 1,
		borderColor: colors.border,
		paddingHorizontal: space.md,
		paddingTop: space.sm + 2,
		paddingBottom: space.sm + 2,
		fontSize: type.input,
		textAlignVertical: 'top',
	},
	hint: {
		fontSize: type.meta,
		color: colors.textMuted,
		paddingHorizontal: space.xs,
		marginTop: space.sm,
	},
	buttons: {
		flexDirection: 'row',
		gap: space.sm,
		marginTop: space.lg,
	},
	button: {
		flex: 1,
	},
	listHead: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingHorizontal: space.xs,
		paddingBottom: space.md,
	},
	listTitle: {
		flex: 1,
		fontSize: type.heading,
		fontWeight: '700',
		color: colors.text,
	},
	listCount: {
		fontSize: type.meta,
		color: colors.textMuted,
	},
	group: {
		backgroundColor: colors.panel,
		borderRadius: radius.group,
		overflow: 'hidden',
	},
	separator: {
		height: StyleSheet.hairlineWidth,
		backgroundColor: colors.border,
		marginHorizontal: space.md,
	},
	row: {
		minHeight: 52,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm + 2,
		paddingVertical: space.sm + 2,
		paddingHorizontal: space.md,
	},
	rowOn: {
		backgroundColor: colors.raised,
	},
	off: {
		opacity: 0.45,
	},
	rowCol: {
		flex: 1,
		minWidth: 0,
	},
	rowTitle: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
	},
	rowSub: {
		fontSize: type.caption,
		color: colors.textMuted,
		marginTop: 2,
	},
	check: {
		width: 22,
		height: 22,
		borderRadius: 11,
		borderWidth: 1.5,
		borderColor: colors.textMuted,
		alignItems: 'center',
		justifyContent: 'center',
	},
	checkOn: {
		backgroundColor: colors.accent,
		borderColor: colors.accent,
	},
	empty: {
		fontSize: type.body,
		color: colors.textDim,
		textAlign: 'center',
		paddingVertical: space.xl,
		paddingHorizontal: space.md,
	},
	actions: {
		gap: space.sm,
		marginTop: space.lg,
	},
	back: {
		margin: space.md,
	},
});
