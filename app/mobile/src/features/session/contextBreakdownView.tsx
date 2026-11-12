// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import {
	contextBreakdownDisplay,
	contextCategoryLines,
	contextHeadline,
	contextRowLabel,
	formatShare,
	parseContextBreakdownReply,
	shownRows,
	type ContextFetchState,
	type ContextLoadedState,
	type ContextRow,
} from '../../agentContextBreakdown.js';
import { formatTokens } from '../../agentSessionStatus.js';
import { useAppStore } from '../../appState.js';
import { formatRelativeTime } from '../../time.js';
import { colors, radius, space, type } from '../../theme.js';
import { monitorStyles } from './monitorDrawer.js';

/** PC の内訳の要求を待つ上限（PC は保存したものを読むだけなので短くてよい）。 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Claude Code のカテゴリの名前 → 帯と点の色。知らない名前は灰色。 */
const CATEGORY_COLORS: Readonly<Record<string, string>> = {
	'Messages': colors.purple,
	'Memory files': colors.claude,
	'MCP tools': colors.blue,
	'MCP server instructions': colors.green,
	'Skills': colors.yellow,
	'Custom agents': colors.emerald,
};

function categoryColor(name: string): string {
	return CATEGORY_COLORS[name] ?? colors.textDim;
}

/**
 * セッションのシートの「コンテキスト」から進む内訳（q.html Q565 案 A）。開いたとき・作業中から止まったとき
 * （`refreshKey`）に PC へ 1 回聞く。PC は同梱の Claude Mod が応答の終わりごとに取って保存した最後の 1 件を返す。
 * 取れないときは理由を灰色で書く（Codex・まだ無い・PC が分からない）。取り直しの間は前の内訳を残して見出しの右に
 * 「更新中」を出し、取り直しに失敗したら前の内訳を残して見出しの下に理由を 1 行足す。幅は与えられた分に収まる（シートの中）。
 */
export function ContextBreakdownView({ terminalKey, refreshKey }: { terminalKey: string | undefined; refreshKey: string }) {
	const requestAgentReply = useAppStore(state => state.requestAgentReply);
	const [fetchState, setFetchState] = useState<ContextFetchState>({ kind: 'loading', terminalKey });
	const [loaded, setLoaded] = useState<ContextLoadedState | undefined>(undefined);
	useEffect(() => {
		if (terminalKey === undefined) {
			setFetchState({ kind: 'failed', terminalKey, message: '内訳を取得できません' });
			return undefined;
		}
		let cancelled = false;
		setFetchState({ kind: 'loading', terminalKey });
		requestAgentReply(terminalKey, { t: 'context-breakdown' }, 'context-breakdown', REQUEST_TIMEOUT_MS).then(
			reply => {
				if (cancelled) {
					return;
				}
				const parsed = parseContextBreakdownReply(reply);
				if (parsed.kind === 'ok') {
					setLoaded({ terminalKey, reply: parsed });
					setFetchState({ kind: 'done', terminalKey });
				} else {
					setFetchState({ kind: 'failed', terminalKey, message: parsed.message });
				}
			},
			(error: unknown) => {
				if (!cancelled) {
					setFetchState({ kind: 'failed', terminalKey, message: error instanceof Error ? error.message : '内訳を取得できません' });
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [terminalKey, refreshKey, requestAgentReply]);

	const display = contextBreakdownDisplay(terminalKey, fetchState, loaded);
	if (display.kind === 'reason') {
		return <Text style={[monitorStyles.caption, styles.reason]}>{display.message}</Text>;
	}
	if (display.kind === 'spinner') {
		return (
			<View style={styles.center}>
				<ActivityIndicator color={colors.textDim} />
			</View>
		);
	}
	const { breakdown } = display.reply;
	const { counted, deferred } = contextCategoryLines(breakdown);
	const now = Date.now();
	return (
		<View>
			<View style={styles.head}>
				<Text style={styles.headline} numberOfLines={1}>{contextHeadline(breakdown)}</Text>
				{display.refreshing ? (
					<View style={styles.refreshing} accessible accessibilityLabel="内訳を更新中">
						<ActivityIndicator size="small" color={colors.textDim} style={styles.refreshingSpinner} />
						<Text style={styles.at} numberOfLines={1}>更新中</Text>
					</View>
				) : (
					<Text style={styles.at} numberOfLines={1}>{`取得: ${formatRelativeTime(Math.min(breakdown.at, now), now)}`}</Text>
				)}
			</View>
			{display.failedMessage !== undefined ? <Text style={styles.failedNote} numberOfLines={1} accessibilityLabel={`更新できませんでした（${display.failedMessage}）`}>{`更新できませんでした（${display.failedMessage}）`}</Text> : null}
			<View style={styles.bar} accessible accessibilityLabel={`コンテキストの使用率 ${breakdown.percent}%`}>
				{counted.filter(line => line.kind === 'used' || line.kind === 'buffer').map(line => (
					<View key={line.key} style={[styles.barPart, { width: `${line.share}%`, backgroundColor: line.kind === 'buffer' ? colors.borderStrong : categoryColor(line.key) }]} />
				))}
			</View>
			<Text style={monitorStyles.section}>カテゴリ</Text>
			<View style={monitorStyles.group}>
				{counted.map((line, index) => (
					<View key={line.key} style={[styles.row, index > 0 ? monitorStyles.rowDivider : undefined]} accessible accessibilityLabel={`${line.label}、${formatTokens(line.tokens)}、${formatShare(line.share)}`}>
						<View style={[styles.dot, line.kind === 'used' ? { backgroundColor: categoryColor(line.key) } : styles.dotEmpty]} />
						<Text style={[styles.rowLabel, line.kind !== 'used' ? styles.dim : undefined]} numberOfLines={1}>{line.label}</Text>
						<Text style={[styles.rowValue, line.kind !== 'used' ? styles.dim : undefined]}>{formatTokens(line.tokens)}</Text>
						<Text style={styles.rowShare}>{formatShare(line.share)}</Text>
					</View>
				))}
			</View>
			{deferred.length > 0 ? (
				<>
					<Text style={monitorStyles.section}>必要なときに読み込む（使用率に数えない）</Text>
					<View style={monitorStyles.group}>
						{deferred.map((line, index) => (
							<View key={line.key} style={[styles.row, index > 0 ? monitorStyles.rowDivider : undefined]}>
								<Text style={[styles.rowLabel, styles.dim]} numberOfLines={1}>{line.label}</Text>
								<Text style={[styles.rowValue, styles.dim]}>{formatTokens(line.tokens)}</Text>
							</View>
						))}
					</View>
				</>
			) : null}
			<RowsSection title="メモリファイル" rows={breakdown.memoryFiles} section="memory" />
			<RowsSection title="MCP サーバー" rows={breakdown.mcpServers} section="mcp" />
			<RowsSection title="カスタムエージェント" rows={breakdown.agents} section="agent" />
			<RowsSection title="スキル" rows={breakdown.skills} section="skill" />
			<Text style={[monitorStyles.caption, styles.foot]}>応答が終わるたびに PC が取り直します</Text>
		</View>
	);
}

function RowsSection({ title, rows, section }: { title: string; rows: readonly ContextRow[]; section: 'memory' | 'mcp' | 'agent' | 'skill' }) {
	if (rows.length === 0) {
		return null;
	}
	const { shown, rest } = shownRows(rows);
	return (
		<>
			<Text style={monitorStyles.section}>{title}</Text>
			<View style={monitorStyles.group}>
				{shown.map((row, index) => (
					<View key={`${row.name}:${index}`} style={[styles.row, index > 0 ? monitorStyles.rowDivider : undefined]} accessible accessibilityLabel={`${contextRowLabel(row, section)}、${formatTokens(row.tokens)}`}>
						<Text style={[styles.rowLabel, section === 'memory' ? styles.path : undefined]} numberOfLines={1} ellipsizeMode="middle">{contextRowLabel(row, section)}</Text>
						<Text style={styles.rowValue}>{formatTokens(row.tokens)}</Text>
					</View>
				))}
				{rest > 0 ? (
					<View style={[styles.row, monitorStyles.rowDivider]}>
						<Text style={[styles.rowLabel, styles.dim]}>{`ほか ${rest} 件`}</Text>
					</View>
				) : null}
			</View>
		</>
	);
}

const styles = StyleSheet.create({
	center: {
		paddingVertical: space.xl,
		alignItems: 'center',
	},
	reason: {
		paddingTop: space.md,
	},
	head: {
		flexDirection: 'row',
		alignItems: 'baseline',
		justifyContent: 'space-between',
		gap: space.md,
		paddingHorizontal: space.xs,
	},
	headline: {
		flexShrink: 1,
		fontSize: type.large,
		fontWeight: '700',
		color: colors.text,
		fontVariant: ['tabular-nums'],
	},
	at: {
		flexShrink: 0,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	refreshing: {
		flexShrink: 0,
		flexDirection: 'row',
		// 見出しの行は baseline でそろえる。ここも baseline にして「更新中」の字を基準にし、スピナーだけ縦の中央に置く
		// （最初の子のスピナーが基準になると、はみ出した native の部品の下端に合わせて字が浮く）。
		alignItems: 'baseline',
		gap: 6,
	},
	refreshingSpinner: {
		alignSelf: 'center',
		width: 12,
		height: 12,
		transform: [{ scale: 0.6 }],
	},
	failedNote: {
		marginTop: 6,
		marginHorizontal: space.xs,
		fontSize: type.meta,
		color: colors.amber,
	},
	bar: {
		flexDirection: 'row',
		height: 8,
		borderRadius: radius.pill,
		overflow: 'hidden',
		backgroundColor: colors.border,
		marginTop: space.sm,
		marginHorizontal: space.xs,
	},
	barPart: {
		height: '100%',
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minHeight: 40,
		paddingHorizontal: 14,
		paddingVertical: 6,
	},
	dot: {
		width: 8,
		height: 8,
		borderRadius: radius.pill,
	},
	dotEmpty: {
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.borderStrong,
	},
	rowLabel: {
		flex: 1,
		minWidth: 0,
		fontSize: type.label,
		color: colors.text,
	},
	path: {
		fontSize: type.meta,
	},
	rowValue: {
		flexShrink: 0,
		fontSize: type.label,
		color: colors.text,
		fontVariant: ['tabular-nums'],
	},
	rowShare: {
		flexShrink: 0,
		width: 52,
		textAlign: 'right',
		fontSize: type.meta,
		color: colors.textMuted,
		fontVariant: ['tabular-nums'],
	},
	dim: {
		color: colors.textMuted,
	},
	foot: {
		paddingTop: space.md,
	},
});
