// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, CircleHelp, Globe, SquareChevronRight, Users } from 'lucide-react-native';
import { buildTimelineSteps, describeStep, formatToolName, type AgentTimelineStep } from '../../agentToolMeta.js';
import { IOBlock } from '../../components/agentIoBlock.js';
import { ThinkingBody, ToolImageCards, ToolStepBody } from '../../components/agentToolBodies.js';
import { MarkdownText } from '../../components/markdownText.js';
import { hapticSelection } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import type { AgentChatMessage } from '../../store.js';
import { colors, radius, space, squircle, type } from '../../theme.js';
import { useChatIconSize, useChatStyles } from '../../ui/chatTextScale.js';
import { Icon, useThemeColors } from '../../ui/index.js';
import type { ChatRow } from './chatRows.js';

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
			return <HistoryQuestionRow text={row.m.text} answered={row.answered} />;
		case 'questionGroup':
			return <HistoryQuestionRow text={row.msgs[0]?.text ?? ''} count={row.msgs.length} answered={row.answered} />;
	}
});

function MessageRow({ message, terminalKey }: { message: AgentChatMessage; terminalKey: string }) {
	const hasImages = (message.images?.length ?? 0) > 0;
	const hasText = message.text.trim().length > 0;
	// 自分の発言の吹き出しは設定 → 色の「自分の発言と送信」。
	const theme = useThemeColors();
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
	if (message.role === 'user') {
		return (
			<View style={[styles.row, styles.userRow]}>
				<View style={[styles.bubble, { backgroundColor: theme.bubble }]}>
					{hasText ? <Text style={[styles.bubbleText, { color: theme.onBubble }]} selectable>{message.text}</Text> : null}
					{hasImages ? <ToolImageCards result={message} terminalKey={terminalKey} /> : null}
				</View>
			</View>
		);
	}
	return (
		<View style={styles.row}>
			{hasText ? <MarkdownText text={message.text} /> : null}
			{hasImages ? <ToolImageCards result={message} terminalKey={terminalKey} /> : null}
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
				onPress={() => { hapticSelection(); setOpen(!expanded); }}
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
				onPress={() => { hapticSelection(); setOpen(value => !value); }}
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
				onPress={() => { hapticSelection(); setOpen(value => !value); }}
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
 * 会話に残る質問（回答済み、または PC がもう待っていないもの）。いま待っている質問は
 * コンポーザーの上のカードに出すので、ここは履歴として1行で示すだけ。
 */
function HistoryQuestionRow({ text, count, answered }: { text: string; count?: number; answered: boolean }) {
	const styles = useChatStyles(baseStyles);
	const iconSize = useChatIconSize(12);
	return (
		<View style={styles.sysline}>
			<Icon icon={CircleHelp} size={iconSize} color={colors.textMuted} />
			<Text style={styles.syslineText} numberOfLines={2}>
				{`${count !== undefined ? `${count}つの質問: ` : ''}${text}`}
				<Text style={styles.syslineNote}>{answered ? '　回答済み' : '　PC で回答済み、または対象外になりました'}</Text>
			</Text>
		</View>
	);
}

const baseStyles = StyleSheet.create({
	row: {
		paddingHorizontal: space.lg,
		paddingVertical: space.sm,
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
});
