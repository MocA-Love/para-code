// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, ChevronRight, CircleHelp, FoldVertical, Globe, Info, ScrollText, SquareChevronRight, Users } from 'lucide-react-native';
import { buildTimelineSteps, describeStep, formatToolName, type AgentTimelineStep } from '../../agentToolMeta.js';
import { attachmentImagesDuplicate, attachmentImagesMatch } from '../../attachments/attachmentFetchPolicy.js';
import { useAttachmentSizes } from '../../attachments/attachmentImages.js';
import { parseAttachmentMessage } from '../../attachments/attachmentText.js';
import { IOBlock } from '../../components/agentIoBlock.js';
import { MessageAttachmentChips } from '../../components/attachmentChips.js';
import { ThinkingBody, ToolImageCards, ToolStepBody } from '../../components/agentToolBodies.js';
import { MarkdownText } from '../../components/markdownText.js';
import { haptic } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { useAppStore } from '../../appState.js';
import type { AgentChatMessage } from '../../store.js';
import { alpha, colors, radius, space, squircle, tint, type } from '../../theme.js';
import { useChatIconSize, useChatStyles } from '../../ui/chatTextScale.js';
import { BottomDrawer, Button, DrawerTitle, Icon, useThemeColors } from '../../ui/index.js';
import type { QuestionOutcome } from '../../agentQuestionMod.js';
import { AdvisorChatRowView } from './advisorRow.js';
import { WorkflowCardRowView } from './workflowCard.js';
import { TeamCardRowView } from './teamCard.js';
import type { ChatRow } from './chatRows.js';
import { questionRowOutcome } from './questionOutcomes.js';
import { SubagentCardRowView, SubagentResumeLink } from './subagentCard.js';

/** ツールの行は見た目 28。当たり判定は上下に 8 ずつ広げて 44 にする。 */
const LINE_SLOP = { top: 8, bottom: 8, left: 0, right: 0 };

/**
 * 会話表示の行（Orca の MobileNativeChatMessage / MobileNativeChatToolRun。モックの `.mrow`）。
 *  - 人の発言: 右寄せの白い吹き出し（17pt）
 *  - エージェントの発言: 地の文（既存の MarkdownText）
 *  - ツール実行: 等幅の要約「N× 名前」の1行。押すと各ステップの行が開き、ステップを押すと中身
 *    （入力と結果の全文。既存の agentToolBodies）が開く
 */
export const ChatRowView = memo(function ChatRowView({ row, terminalKey, allToolsOpen }: {
	row: ChatRow;
	terminalKey: string;
	/** 「ツール」ですべてのツール実行を開いているか（個別に開閉したものはそちらが勝つ）。 */
	allToolsOpen: boolean;
}) {
	switch (row.type) {
		case 'msg':
			return <MessageRow message={row.m} terminalKey={terminalKey} />;
		case 'group':
			return <ToolRunRow msgs={row.msgs} terminalKey={terminalKey} allOpen={allToolsOpen} />;
		case 'web':
			return <WebSearchRow msgs={row.msgs} terminalKey={terminalKey} />;
		case 'question':
			return <HistoryQuestionRow text={row.m.text} answered={row.answered} outcome={questionRowOutcome(row)} />;
		case 'questionGroup':
			return <HistoryQuestionRow text={row.msgs[0]?.text ?? ''} count={row.msgs.length} answered={row.answered} outcome={questionRowOutcome(row)} />;
		case 'agents':
			return <SubagentCardRowView row={row} terminalKey={terminalKey} />;
		case 'advisor':
			return <AdvisorChatRowView row={row} terminalKey={terminalKey} />;
		case 'workflow':
			return <WorkflowCardRowView row={row} terminalKey={terminalKey} />;
		case 'team':
			return <TeamCardRowView row={row} terminalKey={terminalKey} />;
	}
});

function MessageRow({ message, terminalKey }: { message: AgentChatMessage; terminalKey: string }) {
	const hasImages = (message.images?.length ?? 0) > 0;
	const hasText = message.text.trim().length > 0;
	const styles = useChatStyles(baseStyles);
	const peerIconSize = useChatIconSize(12);
	if (message.kind === 'peer_message') {
		return (
			<View style={styles.row}>
				<View style={styles.peerHead}>
					<Icon icon={Users} size={peerIconSize} color={colors.textMuted} />
					<Text style={styles.peerLabel}>{`Claude teammate${message.peerName !== undefined ? ` · ${message.peerName}` : ''}`}</Text>
				</View>
				{message.peerSummary !== undefined ? <Text style={styles.peerSummary}>{message.peerSummary}</Text> : null}
				<MarkdownText text={message.text} />
			</View>
		);
	}
	if (message.notice === true) {
		// コンテキストの圧縮は、区切り線と畳んだ要約のカードにする（古い PC は送らない）
		if (message.noticeSource === 'compaction') {
			return <CompactionDivider message={message} />;
		}
		if (message.noticeSource === 'compact-summary') {
			return <CompactSummaryCard message={message} terminalKey={terminalKey} />;
		}
		return <NoticeRow text={message.text} source={message.noticeSource} />;
	}
	if (message.role === 'user') {
		return <UserMessageRow message={message} terminalKey={terminalKey} />;
	}
	return (
		<View style={styles.row}>
			{hasText ? <MarkdownText text={message.text} /> : null}
			{hasImages ? <ToolImageCards result={message} terminalKey={terminalKey} /> : null}
		</View>
	);
}

/**
 * 人の発言の吹き出し。モバイルから添付した画像のパスは隠し、本文の前に札（「画像 1」〜）を並べてから
 * 改行して本文を出す（案 C2）。transcript の画像のブロックが札と同じ枚数なら下の画像のカードは出さない（同じ画像を
 * 2 度出さない）。そのブロックを札の中身の代わりに使うのは、1 枚ずつ大きさも一致したときだけ。
 */
function UserMessageRow({ message, terminalKey }: { message: AgentChatMessage; terminalKey: string }) {
	// 自分の発言の吹き出しは設定 → 色の「自分の発言と送信」。
	const theme = useThemeColors();
	const styles = useChatStyles(baseStyles);
	const parsed = useMemo(() => parseAttachmentMessage(message.text), [message.text]);
	const images = message.images ?? [];
	const names = useMemo(() => parsed.attachments.map(attachment => attachment.name), [parsed.attachments]);
	const sizes = useAttachmentSizes(names);
	// 下の画像のカードは、札と枚数が同じなら隠す（同じ画像を 2 度出さない）
	const hideImageCards = attachmentImagesDuplicate(parsed.attachments.length, images.length);
	// transcript の画像のブロックを札の中身に当てるのは、1 枚ずつの大きさまで一致したときだけ（取り違えた画像を出さない）
	const imagesMatched = attachmentImagesMatch(sizes, images);
	const fallback = useMemo(
		() => imagesMatched ? { terminalKey, rev: message.rev, images } : undefined,
		// eslint-disable-next-line react-hooks/exhaustive-deps -- images は message と一緒に替わる
		[imagesMatched, terminalKey, message.rev, message.images],
	);
	const hasText = parsed.body.trim().length > 0;
	return (
		<View style={[styles.row, styles.userRow]}>
			<View style={[styles.bubble, { backgroundColor: theme.bubble }]}>
				{parsed.attachments.length > 0 ? (
					<MessageAttachmentChips attachments={parsed.attachments} terminalKey={terminalKey} fallback={fallback} onBubble={theme.onBubble} />
				) : null}
				{hasText ? <Text style={[styles.bubbleText, { color: theme.onBubble }]} selectable>{parsed.body}</Text> : null}
				{images.length > 0 && !hideImageCards ? <ToolImageCards result={message} terminalKey={terminalKey} /> : null}
			</View>
		</View>
	);
}

/** ツール実行のまとまり（モックの `.toolrun`）。 */
const ToolRunRow = memo(function ToolRunRow({ msgs, terminalKey, allOpen }: { msgs: AgentChatMessage[]; terminalKey: string; allOpen: boolean }) {
	const [open, setOpen] = useState<boolean | undefined>(undefined);
	const styles = useChatStyles(baseStyles);
	const iconSize = useChatIconSize(15);
	const expanded = open ?? allOpen;
	const steps = buildTimelineSteps(msgs);
	const names: string[] = [];
	for (const step of steps) {
		const name = describeStep(step).label;
		if (!names.includes(name)) {
			names.push(name);
		}
	}
	return (
		<View style={styles.row}>
			<Pressable
				style={styles.runHead}
				hitSlop={LINE_SLOP}
				onPress={() => { haptic('move'); setOpen(!expanded); }}
				accessibilityRole="button"
				accessibilityState={{ expanded }}
				accessibilityLabel={`ツール実行 ${steps.length}件（${names.join('、')}）`}
			>
				<Icon icon={expanded ? ChevronDown : SquareChevronRight} size={iconSize} color={colors.textMuted} />
				<Text style={styles.runCount}>{`${steps.length}×`}</Text>
				<Text style={styles.runLabel} numberOfLines={1}>{names.join(', ')}</Text>
			</Pressable>
			{expanded ? (
				<View style={styles.runBody}>
					{steps.map(step => <ToolLine key={step.key} step={step} terminalKey={terminalKey} />)}
				</View>
			) : null}
		</View>
	);
}, (prev, next) =>
	prev.terminalKey === next.terminalKey
	&& prev.allOpen === next.allOpen
	&& prev.msgs.length === next.msgs.length
	&& prev.msgs.every((m, i) => m === next.msgs[i]));

/** ツール実行の1行（モックの `.tline`: 名前 13/600 と引数の要約 12、等幅）。 */
function ToolLine({ step, terminalKey }: { step: AgentTimelineStep; terminalKey: string }) {
	const [open, setOpen] = useState(false);
	const styles = useChatStyles(baseStyles);
	const iconSize = useChatIconSize(15);
	const description = describeStep(step);
	const failed = description.tone === 'error';
	return (
		<View>
			<Pressable
				style={styles.line}
				hitSlop={LINE_SLOP}
				onPress={() => { haptic('move'); setOpen(value => !value); }}
				accessibilityRole="button"
				accessibilityState={{ expanded: open }}
				accessibilityLabel={`${description.label}の詳細を${open ? '閉じる' : '開く'}`}
			>
				<Icon icon={open ? ChevronDown : SquareChevronRight} size={iconSize} color={colors.textMuted} />
				<Text style={[styles.lineName, failed ? styles.lineFailed : undefined]}>{description.label}{description.namespace ?? ''}</Text>
				{description.arg !== undefined && description.arg.length > 0
					? <Text style={styles.linePreview} numberOfLines={1}>{description.arg}</Text>
					: null}
			</Pressable>
			{open ? (
				<View style={styles.lineDetail}>
					{step.use?.tool === 'SendMessage' ? <SubagentResumeLink step={step} terminalKey={terminalKey} /> : null}
					{step.kind === 'thinking' && step.thinking !== undefined
						? <ThinkingBody message={step.thinking} terminalKey={terminalKey} />
						: <ToolStepBody step={step} terminalKey={terminalKey} />}
				</View>
			) : null}
		</View>
	);
}

/** Web 検索（開始と結果）。ツール実行と同じ等幅の1行で、開くと結果を出す。 */
function WebSearchRow({ msgs, terminalKey }: { msgs: AgentChatMessage[]; terminalKey: string }) {
	const [open, setOpen] = useState(false);
	const styles = useChatStyles(baseStyles);
	const iconSize = useChatIconSize(15);
	const use = msgs.find(message => message.kind === 'tool_use');
	const results = msgs.filter(message => message.kind === 'tool_result');
	const failed = results.some(message => message.text.startsWith('Web検索に失敗しました'));
	const label = failed ? 'Web検索に失敗' : results.length > 0 ? 'Web検索' : 'Web を検索中';
	return (
		<View style={styles.row}>
			<Pressable
				style={styles.runHead}
				hitSlop={LINE_SLOP}
				disabled={results.length === 0}
				onPress={() => { haptic('move'); setOpen(value => !value); }}
				accessibilityRole="button"
				accessibilityState={{ expanded: open, disabled: results.length === 0 }}
			>
				<Icon icon={Globe} size={iconSize} color={colors.textMuted} />
				<Text style={[styles.lineName, failed ? styles.lineFailed : undefined]}>{label}</Text>
				<Text style={styles.linePreview} numberOfLines={1}>{use?.text ?? formatToolName('web_search')}</Text>
			</Pressable>
			{open ? (
				<View style={styles.runBody}>
					{results.map(message => <IOBlock key={message.rev} label="検索結果" message={message} terminalKey={terminalKey} lines />)}
				</View>
			) : null}
		</View>
	);
}

/**
 * Para Code からの知らせ（送った発言がエージェントへ届かなかった等）。エージェントの発言と取り違えないよう、
 * 履歴の質問と同じ灰色の小さな 1 行で出す。
 */
function NoticeRow({ text, source }: { text: string; source?: string }) {
	const styles = useChatStyles(baseStyles);
	const iconSize = useChatIconSize(12);
	return (
		<View style={styles.sysline} accessible accessibilityRole="text" accessibilityLabel={source === 'command' ? `コマンドの出力: ${text}` : `Para Code からの知らせ: ${text}`}>
			<Icon icon={Info} size={iconSize} color={colors.textMuted} />
			<Text style={styles.syslineText} selectable>{text}</Text>
		</View>
	);
}

/** トークン数を短く（168,412 → 168k）。 */
function shortTokens(count: number): string {
	return count >= 1000 ? `${Math.round(count / 1000).toLocaleString('en-US')}k` : String(count);
}

/**
 * コンテキストを圧縮した区切り（モックの A6-1 と A6-3 の軽い版）。線の中に手動・自動と、取れたときだけトークンの減り方を出す。
 * 色は圧縮の色（colors.purple）。
 */
function CompactionDivider({ message }: { message: AgentChatMessage }) {
	const styles = useChatStyles(baseStyles);
	const iconSize = useChatIconSize(13);
	const info = message.compaction;
	const label = info?.trigger === 'auto' ? '自動でコンテキストを圧縮しました' : info?.trigger === 'manual' ? 'コンテキストを圧縮しました（手動）' : 'コンテキストを圧縮しました';
	const tokens = info?.tokensBefore !== undefined && info.tokensAfter !== undefined ? info : undefined;
	const spoken = tokens !== undefined
		? `${label}。${tokens.tokensBefore!.toLocaleString('en-US')} トークンから ${tokens.tokensAfter!.toLocaleString('en-US')} トークンへ${info?.trigger === 'auto' ? '。上限に近づいたため' : ''}`
		: label;
	return (
		<View style={styles.compactRow} accessible accessibilityRole="text" accessibilityLabel={spoken}>
			<View style={styles.compactLine} />
			<View style={styles.compactLabel}>
				<Icon icon={FoldVertical} size={iconSize} color={colors.purple} />
				<Text style={styles.compactText} numberOfLines={2}>{label}</Text>
				{tokens !== undefined ? <Text style={styles.compactTokens}>{`${shortTokens(tokens.tokensBefore!)} → ${shortTokens(tokens.tokensAfter!)}`}</Text> : null}
			</View>
			<View style={styles.compactLine} />
		</View>
	);
}

/**
 * 圧縮で作られた要約（モックの A6-1）。既定は畳み、開くと先頭の 5 行と「全文を読む」（全文はシートで、PC から取り寄せる）。
 * 自分の発言の吹き出しにはしない（今までは最大 6,000 字の吹き出しになっていた）。
 */
function CompactSummaryCard({ message, terminalKey }: { message: AgentChatMessage; terminalKey: string }) {
	const styles = useChatStyles(baseStyles);
	const iconSize = useChatIconSize(14);
	const [open, setOpen] = useState(false);
	const [sheetOpen, setSheetOpen] = useState(false);
	const chars = message.compaction?.summaryChars ?? message.text.length;
	// 「約 4,800 字」（100 字単位）
	const charsLabel = `約 ${(Math.max(100, Math.round(chars / 100) * 100)).toLocaleString('en-US')} 字`;
	return (
		<View style={styles.row}>
			<View style={styles.summaryCard}>
				<Pressable
					style={styles.summaryHead}
					onPress={() => { haptic('move'); setOpen(value => !value); }}
					accessibilityRole="button"
					accessibilityState={{ expanded: open }}
					accessibilityLabel={`それまでの会話の要約、${charsLabel}。${open ? '畳む' : '開く'}`}
				>
					<Icon icon={ScrollText} size={iconSize} color={colors.purple} />
					<Text style={styles.summaryTitle} numberOfLines={1}>それまでの会話の要約</Text>
					<Text style={styles.summaryMeta}>{charsLabel}</Text>
					<Icon icon={open ? ChevronDown : ChevronRight} size={iconSize} color={colors.textMuted} />
				</Pressable>
				{open ? (
					<View style={styles.summaryBody}>
						<Text style={styles.summaryPreview} numberOfLines={5} selectable>{message.text}</Text>
						<Button label="全文を読む" variant="ghost" size="sm" onPress={() => { haptic('move'); setSheetOpen(true); }} />
					</View>
				) : null}
			</View>
			<CompactSummarySheet visible={sheetOpen} message={message} terminalKey={terminalKey} onClose={() => setSheetOpen(false)} />
		</View>
	);
}

/** 要約の全文のシート。PC で切り詰めた要約は開いたときに取り寄せ、取れなければ先頭だけを出す。 */
function CompactSummarySheet({ visible, message, terminalKey, onClose }: { visible: boolean; message: AgentChatMessage; terminalKey: string; onClose: () => void }) {
	const styles = useChatStyles(baseStyles);
	const requestFull = useAppStore(state => state.requestAgentToolFullText);
	const [full, setFull] = useState<{ readonly rev: number; readonly text?: string; readonly failed?: boolean } | undefined>(undefined);
	useEffect(() => {
		if (!visible || message.truncated !== true || full?.rev === message.rev) {
			return;
		}
		let alive = true;
		setFull({ rev: message.rev });
		requestFull(terminalKey, message.rev).then(
			text => { if (alive) { setFull({ rev: message.rev, text }); } },
			() => { if (alive) { setFull({ rev: message.rev, failed: true }); } },
		);
		return () => { alive = false; };
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 取り寄せは開いたときに 1 回だけ
	}, [visible, message.rev, message.truncated, terminalKey]);
	const loading = message.truncated === true && full?.rev === message.rev && full.text === undefined && full.failed !== true;
	const text = full?.rev === message.rev && full.text !== undefined ? full.text : message.text;
	return (
		<BottomDrawer visible={visible} onClose={onClose} accessibilityLabel="それまでの会話の要約">
			<DrawerTitle title="それまでの会話の要約" />
			{loading ? <ActivityIndicator color={colors.textDim} /> : null}
			{full?.rev === message.rev && full.failed === true ? <Text style={styles.summaryMeta}>全文を取得できなかったため、先頭だけを表示しています</Text> : null}
			<Text style={styles.summaryFull} selectable>{text}</Text>
		</BottomDrawer>
	);
}

/**
 * 会話に残る質問（回答済み、または PC がもう待っていないもの）。いま待っている質問は
 * コンポーザーの上のカードに出すので、ここは履歴として1行で示すだけ。
 */
function HistoryQuestionRow({ text, count, answered, outcome }: { text: string; count?: number; answered: boolean; outcome?: QuestionOutcome }) {
	const styles = useChatStyles(baseStyles);
	const iconSize = useChatIconSize(12);
	const theme = useThemeColors();
	const note = outcome?.kind === 'withdrawnWithMessage' ? '　取り下げ（メッセージで返信）'
		: outcome?.kind === 'withdrawn' ? '　取り下げ'
			: answered ? '　回答済み' : '　PC で回答済み、または対象外になりました';
	const line = (
		<View style={styles.sysline}>
			<Icon icon={CircleHelp} size={iconSize} color={colors.textMuted} />
			<Text style={styles.syslineText} numberOfLines={2}>
				{`${count !== undefined ? `${count}つの質問: ` : ''}${text}`}
				<Text style={styles.syslineNote}>{note}</Text>
			</Text>
		</View>
	);
	if (outcome?.kind !== 'withdrawnWithMessage') {
		return line;
	}
	// 「質問に答えずに話す」で送ったメッセージは、自分の発言として質問の行の上に出す（transcript ではツールの結果に入っている）
	return (
		<View>
			<View style={[styles.row, styles.withdrawnRow]}>
				<Text style={styles.withdrawnCaption}>質問を取り下げて送信</Text>
				<View style={[styles.bubble, { backgroundColor: theme.bubble }]}>
					<Text style={[styles.bubbleText, { color: theme.onBubble }]} selectable>{outcome.text}</Text>
				</View>
			</View>
			{line}
		</View>
	);
}

const baseStyles = StyleSheet.create({
	row: {
		paddingHorizontal: space.lg,
		paddingVertical: space.sm,
	},
	withdrawnRow: {
		alignItems: 'flex-end',
		gap: space.xs,
	},
	withdrawnCaption: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	userRow: {
		flexDirection: 'row',
		justifyContent: 'flex-end',
	},
	bubble: {
		maxWidth: 520,
		flexShrink: 1,
		paddingHorizontal: space.md,
		paddingVertical: space.sm,
		borderRadius: radius.composer,
		...squircle,
		backgroundColor: colors.text,
		gap: space.sm,
	},
	bubbleText: {
		fontSize: type.chat,
		lineHeight: 23,
		fontWeight: '500',
		color: colors.bg,
	},
	peerHead: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		marginBottom: space.xs,
	},
	peerLabel: {
		fontSize: type.caption,
		fontWeight: '600',
		color: colors.textMuted,
	},
	peerSummary: {
		marginBottom: space.xs,
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.text,
	},
	runHead: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minHeight: 28,
		paddingVertical: 3,
	},
	runCount: {
		fontFamily: monoFamily,
		fontSize: type.meta,
		fontWeight: '700',
		color: colors.green,
	},
	runLabel: {
		flex: 1,
		minWidth: 0,
		fontFamily: monoFamily,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	runBody: {
		marginTop: space.xs,
		paddingLeft: space.sm,
		borderLeftWidth: 2,
		borderLeftColor: colors.border,
	},
	line: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minHeight: 28,
		paddingVertical: 3,
	},
	lineName: {
		fontFamily: monoFamily,
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
	},
	lineFailed: {
		color: colors.red,
	},
	linePreview: {
		flex: 1,
		minWidth: 0,
		fontFamily: monoFamily,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	lineDetail: {
		paddingLeft: space.lg,
		paddingBottom: space.xs,
	},
	sysline: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		paddingHorizontal: space.lg,
		paddingVertical: space.xs,
	},
	syslineText: {
		flex: 1,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	syslineNote: {
		color: colors.textMuted,
	},
	compactRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingHorizontal: space.lg,
		paddingVertical: space.md,
	},
	compactLine: {
		flex: 1,
		height: StyleSheet.hairlineWidth,
		backgroundColor: tint(colors.purple, alpha.line),
	},
	compactLabel: {
		flexShrink: 1,
		flexDirection: 'row',
		alignItems: 'center',
		flexWrap: 'wrap',
		gap: space.xs,
	},
	compactText: {
		flexShrink: 1,
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.purple,
	},
	compactTokens: {
		fontFamily: monoFamily,
		fontSize: type.caption,
		color: colors.textMuted,
	},
	summaryCard: {
		borderRadius: radius.card,
		...squircle,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: tint(colors.purple, alpha.line),
		backgroundColor: tint(colors.purple, alpha.wash),
		overflow: 'hidden',
	},
	summaryHead: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minHeight: 44,
		paddingHorizontal: space.md,
	},
	summaryTitle: {
		flexShrink: 1,
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.text,
	},
	summaryMeta: {
		flex: 1,
		fontSize: type.caption,
		color: colors.textMuted,
	},
	summaryBody: {
		gap: space.xs,
		paddingHorizontal: space.md,
		paddingBottom: space.sm,
		alignItems: 'flex-start',
	},
	summaryPreview: {
		fontSize: type.meta,
		lineHeight: 18,
		color: colors.textDim,
	},
	summaryFull: {
		fontSize: type.body,
		lineHeight: 21,
		color: colors.text,
	},
});
