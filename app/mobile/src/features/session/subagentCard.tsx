// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Bot, ChevronDown, ChevronRight, SquareChevronRight } from 'lucide-react-native';
import { activityStatusColor, activityStatusKind, activityStatusLabel } from '../../agentStatus.js';
import type { AgentTimelineStep } from '../../agentToolMeta.js';
import { useAppStore } from '../../appState.js';
import { IOBlock, useFullText } from '../../components/agentIoBlock.js';
import { MarkdownText } from '../../components/markdownText.js';
import { haptic } from '../../haptics.js';
import { firstParam, routes } from '../../routes.js';
import type { AgentActivityAgent, AgentChatMessage } from '../../store.js';
import { colors, radius, space, squircle, type } from '../../theme.js';
import { useNow } from '../../time.js';
import { useChatIconSize, useChatStyles } from '../../ui/chatTextScale.js';
import { AgentStateDot, Icon, useThemeColors } from '../../ui/index.js';
import {
	formatSubagentElapsed, sameSubagentLinks, selectSubagentLink, subagentCallHint, subagentCardSummary,
	subagentReportStats, summarizeSubagentResult, type SubagentCall, type SubagentCallHint, type SubagentCardChatRow, type SubagentLink,
} from './subagentCards.js';

/** 行の右の「›」（詳細を開く）の当たり判定。行の高さいっぱい・幅 44。 */
const OPEN_WIDTH = 44;
/** 文字の入口（「一覧 ›」「開けません」）の幅。文字を大きくしても 1 行に収まるよう広げる。 */
const OPEN_TEXT_MIN_WIDTH = 64;

/**
 * 会話のサブエージェントの呼び出しと、一覧の項目の結び。一覧の項目の状態・時刻・配下の数だけを選び、
 * 前回と同じなら同じ配列を返す（会話の他の更新や、関係のない子の更新でカードを描き直さない）。
 */
function useSubagentLinks(terminalKey: string, hints: readonly SubagentCallHint[]): readonly SubagentLink[] {
	const cache = useRef<{ agents: readonly AgentActivityAgent[] | undefined; hints: readonly SubagentCallHint[]; links: readonly SubagentLink[] } | undefined>(undefined);
	return useAppStore(s => {
		const agents = s.agentChats.get(terminalKey)?.activity?.agents;
		const previous = cache.current;
		if (previous !== undefined && previous.agents === agents && previous.hints === hints) {
			return previous.links;
		}
		const next = hints.map(hint => selectSubagentLink(agents, hint));
		const links = previous !== undefined && sameSubagentLinks(previous.links, next) ? previous.links : next;
		cache.current = { agents, hints, links };
		return links;
	});
}

/** 詳細（`activity/[agentId]`）と一覧（`activity`）を開く。iPad では詳細の列に積まれる。 */
function useSubagentNavigation(terminalKey: string) {
	const router = useRouter();
	const params = useLocalSearchParams<{ pcId?: string | string[]; spaceId?: string | string[] }>();
	const pcId = firstParam(params.pcId);
	const spaceId = firstParam(params.spaceId);
	const available = pcId !== undefined && spaceId !== undefined && terminalKey.length > 0;
	const epoch = () => useAppStore.getState().agentChats.get(terminalKey)?.epoch;
	return {
		available,
		openAgent: (agentId: string) => {
			if (pcId !== undefined && spaceId !== undefined) {
				haptic('move');
				router.push(routes.activityAgent(pcId, spaceId, terminalKey, agentId, epoch()));
			}
		},
		openList: () => {
			if (pcId !== undefined && spaceId !== undefined) {
				haptic('move');
				router.push(routes.activity(pcId, spaceId, terminalKey, epoch()));
			}
		},
	};
}

/**
 * 同じターンで呼んだサブエージェントのカード（案 C）。行ごとに状態・経過・「›」（詳細へ）を出し、
 * 行を押すと結果（起動の知らせは 1 行、報告は本文）を開く。
 */
export const SubagentCardRowView = memo(function SubagentCardRowView({ row, terminalKey }: { row: SubagentCardChatRow; terminalKey: string }) {
	const styles = useChatStyles(baseStyles);
	const headIconSize = useChatIconSize(14);
	const theme = useThemeColors();
	// 切り詰められた報告の全文（行を開いて取り寄せたもの）。末尾の `agentId:` を読めるので結びの手がかりに使い直す
	const [fullTexts, setFullTexts] = useState<ReadonlyMap<string, string>>(() => new Map());
	const rememberFullText = useCallback((key: string, text: string) => {
		setFullTexts(previous => previous.get(key) === text ? previous : new Map(previous).set(key, text));
	}, []);
	const hints = useMemo(() => row.calls.map(call => subagentCallHint(call.use, call.result, fullTexts.get(call.key))), [row.calls, fullTexts]);
	const links = useSubagentLinks(terminalKey, hints);
	const navigation = useSubagentNavigation(terminalKey);
	// 経過は 1 分刻み（詳細画面と同じ）。動いている子がいるときだけ刻む
	const now = useNow(undefined, links.some(isLiveLink));
	const summary = subagentCardSummary(links);
	const listed = links.some(link => link.kind !== 'none');
	// Codex の子だけのカードは Codex の色にする（会話の他の部分と同じく Claude は橙、Codex はアクセント）
	const codex = links.some(link => link.kind === 'linked' && link.provider === 'codex') && !links.some(link => link.kind === 'linked' && link.provider !== 'codex');
	return (
		<View style={styles.row}>
			<View style={styles.card}>
				<View style={styles.head}>
					<Icon icon={Bot} size={headIconSize} color={codex ? theme.accent : colors.claude} />
					<Text style={styles.headTitle}>{`サブエージェント ${row.calls.length}件`}</Text>
					{summary.length > 0 ? <Text style={styles.headSummary} numberOfLines={1}>{summary}</Text> : null}
				</View>
				{row.calls.map((call, index) => (
					<SubagentCallRow
						key={call.key}
						call={call}
						link={links[index] ?? { kind: 'none' }}
						terminalKey={terminalKey}
						now={now}
						navigation={navigation}
						last={index === row.calls.length - 1}
						onFullText={rememberFullText}
					/>
				))}
				{listed && navigation.available ? (
					<Pressable style={styles.foot} onPress={navigation.openList} accessibilityRole="button" accessibilityLabel="サブエージェントの一覧を開く">
						<Text style={[styles.footText, { color: theme.accent }]}>一覧で見る ›</Text>
					</Pressable>
				) : null}
			</View>
		</View>
	);
}, (prev, next) =>
	prev.terminalKey === next.terminalKey
	&& prev.row.calls.length === next.row.calls.length
	&& prev.row.calls.every((call, index) => call.use === next.row.calls[index]?.use && call.result === next.row.calls[index]?.result));

type SubagentNavigation = ReturnType<typeof useSubagentNavigation>;

function isLiveLink(link: SubagentLink): boolean {
	return link.kind === 'linked' && (link.status === 'running' || link.status === 'idle');
}

/** カードの 1 行（呼び出し 1 つ）。 */
function SubagentCallRow({ call, link, terminalKey, now, navigation, last, onFullText }: {
	call: SubagentCall;
	link: SubagentLink;
	terminalKey: string;
	now: number;
	navigation: SubagentNavigation;
	last: boolean;
	onFullText: (key: string, text: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const styles = useChatStyles(baseStyles);
	const chevronSize = useChatIconSize(15);
	const title = firstLine(call.use.text) || 'サブエージェント';
	const failed = call.result?.isError === true || (link.kind === 'linked' && link.status === 'failed');
	const view = describeLink(link, failed, now);
	return (
		<View style={[styles.callBlock, last ? undefined : styles.divider]}>
			<View style={styles.callRow}>
				<Pressable
					style={styles.callMain}
					onPress={() => { haptic('move'); setOpen(value => !value); }}
					accessibilityRole="button"
					accessibilityState={{ expanded: open }}
					accessibilityLabel={`${title}、${view.status ?? ''}。結果を${open ? '閉じる' : '開く'}`}
				>
					<Icon icon={open ? ChevronDown : SquareChevronRight} size={chevronSize} color={colors.textMuted} />
					{view.dot !== undefined ? <AgentStateDot kind={view.dot} /> : null}
					<View style={styles.callBody}>
						<Text style={styles.callTitle} numberOfLines={1}>{title}</Text>
						{view.meta.length > 0 ? <Text style={[styles.callMeta, view.missing ? styles.callMissing : undefined]} numberOfLines={1}>{view.meta}</Text> : null}
					</View>
					{view.status !== undefined ? <Text style={[styles.callStatus, { color: view.statusColor }]}>{view.status}</Text> : null}
				</Pressable>
				<OpenButton link={link} navigation={navigation} title={title} />
			</View>
			{open ? <SubagentResultBody call={call} terminalKey={terminalKey} onFullText={onFullText} /> : null}
		</View>
	);
}

/**
 * 行の右の入口。一覧にあれば詳細、結びが分からない（古い PC・起動の途中）なら一覧、一覧から落ちたものは
 * 灰色で押せない。
 */
function OpenButton({ link, navigation, title }: { link: SubagentLink; navigation: SubagentNavigation; title: string }) {
	const styles = useChatStyles(baseStyles);
	const theme = useThemeColors();
	if (!navigation.available || link.kind === 'none') {
		return null;
	}
	if (link.kind === 'missing') {
		return (
			<View style={[styles.open, styles.openWide]} accessible accessibilityLabel={`${title}の詳細は開けません。この会話の記録にありません`}>
				<Text style={styles.openOff} numberOfLines={1}>開けません</Text>
			</View>
		);
	}
	const linked = link.kind === 'linked';
	return (
		<Pressable
			style={linked ? styles.open : [styles.open, styles.openWide]}
			onPress={() => (link.kind === 'linked' ? navigation.openAgent(link.id) : navigation.openList())}
			accessibilityRole="button"
			accessibilityLabel={linked ? `${title}の詳細を開く` : 'サブエージェントの一覧を開く'}
		>
			{linked ? <Icon icon={ChevronRight} color={colors.textMuted} /> : <Text style={[styles.openList, { color: theme.accent }]} numberOfLines={1}>一覧 ›</Text>}
		</Pressable>
	);
}

interface LinkView {
	readonly dot?: ReturnType<typeof activityStatusKind>;
	readonly status?: string;
	readonly statusColor?: string;
	readonly meta: string;
	readonly missing: boolean;
}

function describeLink(link: SubagentLink, failed: boolean, now: number): LinkView {
	switch (link.kind) {
		case 'linked': {
			const running = link.status === 'running' || link.status === 'idle';
			const parts = [link.label, formatSubagentElapsed(link.startedAt, running ? now : link.updatedAt, running)];
			if (link.descendants > 0) {
				// 孫以下は数と状態だけ（開くのは子の詳細画面のカードから）
				parts.push(link.descendantsRunning > 0 ? `配下 ${link.descendants}（実行中 ${link.descendantsRunning}）` : `配下 ${link.descendants}`);
			}
			return { dot: activityStatusKind(link.status), status: activityStatusLabel(link.status), statusColor: activityStatusColor(link.status), meta: parts.join(' · '), missing: false };
		}
		case 'pending':
			return { dot: 'running', status: '起動中', statusColor: activityStatusColor('running'), meta: '', missing: false };
		case 'missing':
			return { status: failed ? '失敗' : undefined, statusColor: activityStatusColor('failed'), meta: 'この会話の記録にありません', missing: true };
		default:
			return failed ? { status: '失敗', statusColor: activityStatusColor('failed'), meta: '', missing: false } : { meta: '', missing: false };
	}
}

/**
 * 行を開いたときの結果。非同期の起動は「バックグラウンドで起動しました」の 1 行にし、PC からの生の全文は
 * さらに開いたときだけ出す。同期の報告は本文を見せ、末尾の ID と使用量は「ツール N回 · 経過」にする。
 */
function SubagentResultBody({ call, terminalKey, onFullText }: { call: SubagentCall; terminalKey: string; onFullText: (key: string, text: string) => void }) {
	const styles = useChatStyles(baseStyles);
	const result = call.result;
	if (result === undefined) {
		return <View style={styles.result}><Text style={styles.pending}>結果を待っています…</Text></View>;
	}
	const summary = summarizeSubagentResult(result.text);
	if (result.isError === true) {
		return (
			<View style={styles.result}>
				<Text style={styles.error} numberOfLines={3}>{firstLine(summary.kind === 'report' ? summary.body : result.text) || '失敗しました'}</Text>
				<RawResult message={result} terminalKey={terminalKey} />
			</View>
		);
	}
	if (summary.kind === 'launched') {
		return (
			<View style={styles.result}>
				<Text style={styles.summary}>バックグラウンドで起動しました。終わると通知が届きます。</Text>
				<RawResult message={result} terminalKey={terminalKey} />
			</View>
		);
	}
	return <SubagentReport message={result} terminalKey={terminalKey} onFullText={text => onFullText(call.key, text)} />;
}

/** 子の報告（Markdown）。PC で切り詰められていれば、全文を取り寄せて同じ形で出し直す。 */
function SubagentReport({ message, terminalKey, onFullText }: { message: AgentChatMessage; terminalKey: string; onFullText: (text: string) => void }) {
	const styles = useChatStyles(baseStyles);
	const theme = useThemeColors();
	const { full, loading, error, load, available } = useFullText(message, terminalKey);
	const reportFullText = useRef(onFullText);
	reportFullText.current = onFullText;
	useEffect(() => {
		if (full !== undefined) {
			reportFullText.current(full);
		}
	}, [full]);
	const summary = summarizeSubagentResult(full ?? message.text);
	const stats = subagentReportStats(summary);
	return (
		<View style={styles.result}>
			{summary.kind === 'report' && summary.body.trim().length > 0 ? <MarkdownText text={summary.body} /> : null}
			{stats !== undefined ? <Text style={styles.stats}>{stats}</Text> : null}
			{message.truncated === true && full === undefined ? (
				<Pressable onPress={load} disabled={!available || loading} accessibilityRole="button" accessibilityLabel="報告の全文を表示">
					<Text style={[styles.more, { color: theme.accent }]}>{loading ? '全文を取得しています…' : error ?? (available ? '全文を表示' : 'PCに接続すると全文を表示できます')}</Text>
				</Pressable>
			) : null}
		</View>
	);
}

/** PC からの生の結果（折りたたみ。開けば全文とコピー）。 */
function RawResult({ message, terminalKey }: { message: AgentChatMessage; terminalKey: string }) {
	const [open, setOpen] = useState(false);
	const styles = useChatStyles(baseStyles);
	const iconSize = useChatIconSize(13);
	const lines = message.text.replace(/\n+$/, '').split('\n').length;
	return (
		<View>
			<Pressable
				style={styles.disclose}
				onPress={() => { haptic('move'); setOpen(value => !value); }}
				accessibilityRole="button"
				accessibilityState={{ expanded: open }}
			>
				<Icon icon={open ? ChevronDown : ChevronRight} size={iconSize} color={colors.textMuted} />
				<Text style={styles.discloseText}>{`PC からの生の結果（${lines}行）`}</Text>
			</Pressable>
			{open ? <IOBlock label="PC からの生の結果" message={message} terminalKey={terminalKey} lines /> : null}
		</View>
	);
}

/**
 * SendMessage（止まった子を再開する呼び出し）を開いたときに、本文の上に出す再開した子の行。
 * 結べないとき（再開ではない宛先・古い PC で手がかりが無い）は何も出さない。
 */
export function SubagentResumeLink({ step, terminalKey }: { step: AgentTimelineStep; terminalKey: string }) {
	const styles = useChatStyles(baseStyles);
	const hints = useMemo(() => [subagentCallHint(step.use, step.result)], [step.use, step.result]);
	const [link] = useSubagentLinks(terminalKey, hints);
	const navigation = useSubagentNavigation(terminalKey);
	const now = useNow(undefined, link !== undefined && isLiveLink(link));
	// 本文に再開した子の ID が無い SendMessage（チームメイトへの連絡など）は、一覧に無くても「記録なし」と言わない
	const resumed = link?.kind === 'linked' || (link?.kind === 'missing' && hints[0]?.agentId !== undefined);
	if (link === undefined || !resumed) {
		return null;
	}
	const title = link.kind === 'linked' ? `${link.label} を再開しました` : '再開しました';
	const view = describeLink(link, step.result?.isError === true, now);
	return (
		<View style={[styles.card, styles.resume]}>
			<View style={styles.callRow}>
				<View style={styles.callMain}>
					{view.dot !== undefined ? <AgentStateDot kind={view.dot} /> : null}
					<View style={styles.callBody}>
						<Text style={styles.callTitle} numberOfLines={1}>{title}</Text>
						{view.meta.length > 0 ? <Text style={[styles.callMeta, view.missing ? styles.callMissing : undefined]} numberOfLines={1}>{view.meta}</Text> : null}
					</View>
					{view.status !== undefined ? <Text style={[styles.callStatus, { color: view.statusColor }]}>{view.status}</Text> : null}
				</View>
				<OpenButton link={link} navigation={navigation} title={title} />
			</View>
		</View>
	);
}

function firstLine(text: string): string {
	return text.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? '';
}

const baseStyles = StyleSheet.create({
	row: {
		paddingHorizontal: space.lg,
		paddingVertical: space.sm,
	},
	card: {
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.borderStrong,
		backgroundColor: colors.panel,
		borderRadius: radius.card,
		...squircle,
		overflow: 'hidden',
	},
	resume: {
		marginBottom: space.sm,
	},
	head: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingHorizontal: space.md,
		paddingVertical: 9,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
	},
	headTitle: {
		fontSize: type.label,
		fontWeight: '700',
		color: colors.text,
	},
	headSummary: {
		flex: 1,
		minWidth: 0,
		fontSize: type.caption,
		color: colors.textMuted,
		textAlign: 'right',
	},
	callBlock: {},
	divider: {
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
	},
	callRow: {
		flexDirection: 'row',
		alignItems: 'stretch',
		minHeight: 46,
	},
	callMain: {
		flex: 1,
		minWidth: 0,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingLeft: space.md,
		paddingVertical: 6,
	},
	callBody: {
		flex: 1,
		minWidth: 0,
		gap: 2,
	},
	callTitle: {
		fontSize: type.label,
		color: colors.text,
	},
	callMeta: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	callMissing: {
		color: colors.textMuted,
		fontStyle: 'italic',
	},
	callStatus: {
		fontSize: type.caption,
		fontWeight: '600',
	},
	open: {
		width: OPEN_WIDTH,
		alignItems: 'center',
		justifyContent: 'center',
	},
	openWide: {
		width: undefined,
		minWidth: OPEN_TEXT_MIN_WIDTH,
		paddingHorizontal: space.sm,
	},
	openOff: {
		fontSize: type.badge,
		color: colors.textMuted,
		textAlign: 'center',
	},
	openList: {
		fontSize: type.caption,
		fontWeight: '600',
	},
	result: {
		gap: space.sm,
		paddingHorizontal: space.md,
		paddingBottom: space.md,
	},
	pending: {
		fontSize: type.meta,
		fontStyle: 'italic',
		color: colors.textDim,
	},
	summary: {
		fontSize: type.meta,
		color: colors.text,
	},
	error: {
		fontSize: type.meta,
		color: colors.red,
	},
	stats: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	more: {
		fontSize: type.meta,
		fontWeight: '600',
	},
	disclose: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		minHeight: 28,
	},
	discloseText: {
		fontSize: type.meta,
		color: colors.textMuted,
	},
	foot: {
		alignItems: 'flex-end',
		justifyContent: 'center',
		minHeight: 44,
		paddingHorizontal: space.md,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	footText: {
		fontSize: type.meta,
		fontWeight: '600',
	},
});
