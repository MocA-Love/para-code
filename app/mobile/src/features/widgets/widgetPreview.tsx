// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Check, ChevronRight, GitBranch } from 'lucide-react-native';
import type { StatusKey } from '../../theme.js';
import { colors, radius, space, type } from '../../theme.js';
import { AgentStateDot, Icon, textColorOn, useThemeColorStore, themeColorOf } from '../../ui/index.js';
import type { WidgetAgent, WidgetPc } from '../../widgets/snapshot.js';
import { resolveWidgetAccentHex, type WidgetSettings } from '../../widgets/settings.js';
import { attentionRows, listedAgents, pcMetrics, type PreviewMetric, type WidgetDesign, type WidgetPreviewSize } from './previewModel.js';

/**
 * 設定 → ウィジェットのプレビュー（React Native で描く近似）。本物は WidgetKit（Swift）で描くので、
 * 寸法（小 162・中 346×162・大 346×364）と中身の選び方だけを合わせ、細部は近似にとどめる。
 * 見本のデータは架空（`previewModel.ts`）。押せない見本なので、読み上げでは1枚の絵として扱う。
 */

/** ウィジェットの寸法（pt。iPhone 17 Pro の見積もり。モックの .wg-s / .wg-m / .wg-l）。 */
const SIZE = {
	small: { width: 162, height: 162 },
	medium: { width: 346, height: 162 },
	large: { width: 346, height: 364 },
} as const;
/** 大きな件数の文字（モックの .big は 42。段の display に寄せる）。 */
const BIG = type.display;

function stateKind(state: WidgetAgent['state']): StatusKey {
	switch (state) {
		case 'approve':
		case 'question':
		case 'error':
			return 'attention';
		case 'running':
			return 'running';
		case 'unread':
			return 'review';
		default:
			return 'idle';
	}
}

const STATE_LABEL: Readonly<Record<WidgetAgent['state'], string>> = {
	approve: '許可待ち', question: '質問', error: 'エラー', running: '実行中', unread: '未確認', idle: '待機',
};

function elapsed(agent: WidgetAgent, now: number): string | undefined {
	if (agent.since === undefined) {
		return undefined;
	}
	const minutes = Math.floor(Math.max(0, now - agent.since) / 60_000);
	return minutes < 1 ? 'いま' : minutes < 60 ? `${minutes}分` : `${Math.floor(minutes / 60)}時間`;
}

interface PreviewContext {
	readonly settings: WidgetSettings;
	readonly pc: WidgetPc;
	readonly now: number;
	readonly accent: { readonly bg: string; readonly fg: string };
}

function title(ctx: PreviewContext, agent: WidgetAgent): string {
	return ctx.settings.showNames ? agent.title : agent.kind === 'claude' ? 'Claude' : agent.kind === 'codex' ? 'Codex' : 'エージェント';
}

function spaceName(ctx: PreviewContext, id: string | undefined): string | undefined {
	const space = ctx.pc.spaces.find(item => item.id === id);
	if (space === undefined) {
		return undefined;
	}
	return ctx.settings.showNames ? space.name : 'スペース';
}

function freshness(ctx: PreviewContext): string | undefined {
	// 見本は 2 分前の状態。「古いときだけ」なら出さない。
	return ctx.settings.freshness === 'always' ? '2分前の状態' : undefined;
}

export function WidgetPreview({ design, size, settings, pc, now }: {
	design: WidgetDesign;
	size: WidgetPreviewSize;
	settings: WidgetSettings;
	pc: WidgetPc;
	now: number;
}) {
	const primary = useThemeColorStore(s => themeColorOf(s.settings, 'primary'));
	const accentHex = resolveWidgetAccentHex(settings.accent, primary) ?? colors.text;
	const ctx: PreviewContext = { settings, pc, now, accent: { bg: accentHex, fg: textColorOn(accentHex) } };
	const dims = SIZE[size];
	return (
		<View style={styles.stage} accessible accessibilityRole="image" accessibilityLabel="選んだ内容で描いたウィジェットの見本">
			<View style={[styles.widget, dims]}>
				{design === 'attention' ? <AttentionPreview ctx={ctx} size={size} /> : null}
				{design === 'agents' ? <AgentsPreview ctx={ctx} size={size} /> : null}
				{design === 'pcStatus' ? <PcPreview ctx={ctx} size={size} /> : null}
				{design === 'space' ? <SpacePreview ctx={ctx} size={size} /> : null}
			</View>
		</View>
	);
}

// --- 共通 ---------------------------------------------------------------------------

function Header({ label, right }: { label: string; right?: ReactNode }) {
	return (
		<View style={styles.header}>
			<Text style={styles.headerText} numberOfLines={1}>{label}</Text>
			<View style={styles.grow} />
			{right}
		</View>
	);
}

function Pill({ label, primary, accent, check }: { label: string; primary?: boolean; accent: PreviewContext['accent']; check?: boolean }) {
	return (
		<View style={[styles.pill, primary ? { backgroundColor: accent.bg } : undefined]}>
			{check ? <Icon icon={Check} size={10} color={colors.text} /> : null}
			<Text style={[styles.pillText, primary ? { color: accent.fg } : undefined]}>{label}</Text>
			{check ? null : <Icon icon={ChevronRight} size={10} color={primary ? accent.fg : colors.text} />}
		</View>
	);
}

function Action({ ctx, agent }: { ctx: PreviewContext; agent: WidgetAgent }) {
	const buttons = ctx.settings.attention;
	if (agent.state === 'approve' && buttons.showApprove) {
		return <Pill label="許可" primary accent={ctx.accent} />;
	}
	if (agent.state === 'question' && buttons.showAnswer) {
		return <Pill label="答える" accent={ctx.accent} />;
	}
	if (agent.state === 'unread' && buttons.showReview) {
		return <Pill label="確認済み" check accent={ctx.accent} />;
	}
	return null;
}

function BigCount({ value, unit, size = BIG }: { value: string; unit: string; size?: number }) {
	return (
		<View style={styles.bigRow}>
			<Text style={[styles.big, { fontSize: size, lineHeight: size + 2 }]}>{value}</Text>
			<Text style={styles.unit}>{unit}</Text>
		</View>
	);
}

function Foot({ left, right }: { left: string | undefined; right?: ReactNode }) {
	return (
		<View style={styles.foot}>
			<Text style={styles.muted}>{left ?? ''}</Text>
			<View style={styles.grow} />
			{right}
		</View>
	);
}

// --- A 要対応 ------------------------------------------------------------------------

function AttentionPreview({ ctx, size }: { ctx: PreviewContext; size: WidgetPreviewSize }) {
	const rows = attentionRows(ctx.pc.agents, ctx.settings);
	const count = rows.filter(agent => agent.state === 'approve' || agent.state === 'question').length;
	const first = rows[0];
	const n = (state: WidgetAgent['state']) => ctx.pc.agents.filter(agent => agent.state === state).length;
	if (size === 'small') {
		return (
			<View style={styles.fill}>
				<Header label="要対応" />
				<BigCount value={`${count}`} unit="件" />
				<View style={styles.grow} />
				{first !== undefined ? (
					<View style={styles.rowTop}>
						<AgentStateDot kind={stateKind(first.state)} />
						<View style={styles.grow}>
							<Text style={styles.title} numberOfLines={2}>{title(ctx, first)}</Text>
							<Text style={styles.meta} numberOfLines={1}>{`${STATE_LABEL[first.state]} ・ ${elapsed(first, ctx.now) ?? ''}`}</Text>
						</View>
					</View>
				) : null}
			</View>
		);
	}
	if (size === 'medium') {
		return (
			<View style={styles.columns}>
				<View style={styles.sideColumn}>
					<Header label="要対応" />
					<BigCount value={`${count}`} unit="件" />
					<Text style={styles.meta}>{`許可待ち ${n('approve')}\n質問 ${n('question')}`}</Text>
					<View style={styles.grow} />
					<Text style={styles.muted}>{freshness(ctx) ?? ''}</Text>
				</View>
				<View style={[styles.grow, styles.stackGap]}>
					{rows.slice(0, 2).map(agent => (
						<View key={agent.key} style={[styles.card, styles.cardRow, styles.grow]}>
							<AgentStateDot kind={stateKind(agent.state)} />
							<View style={styles.grow}>
								<Text style={styles.title} numberOfLines={1}>{title(ctx, agent)}</Text>
								<Text style={styles.meta} numberOfLines={1}>{`${STATE_LABEL[agent.state]} ・ ${elapsed(agent, ctx.now) ?? ''}`}</Text>
							</View>
							<Action ctx={ctx} agent={agent} />
						</View>
					))}
				</View>
			</View>
		);
	}
	const showDetail = ctx.settings.showDetail;
	return (
		<View style={styles.fill}>
			<Header label="要対応" right={<Text style={styles.muted} numberOfLines={1}>{ctx.pc.name}</Text>} />
			<View style={styles.countRow}>
				<BigCount value={`${count}`} unit="件" />
				<View style={styles.grow} />
				<Text style={styles.meta} numberOfLines={1}>{`許可待ち ${n('approve')} ・ 質問 ${n('question')} ・ 実行中 ${n('running')} ・ 未確認 ${n('unread')}`}</Text>
			</View>
			<View style={styles.listGap}>
				{rows.slice(0, showDetail ? 3 : 4).map(agent => (
					<View key={agent.key} style={styles.card}>
						<View style={styles.cardRow}>
							<AgentStateDot kind={stateKind(agent.state)} />
							<View style={styles.grow}>
								<Text style={styles.title} numberOfLines={1}>{title(ctx, agent)}</Text>
								<Text style={styles.meta} numberOfLines={1}>
									{[agent.kind === 'claude' ? 'Claude' : 'Codex', spaceName(ctx, agent.spaceId), `${STATE_LABEL[agent.state]} ・ ${elapsed(agent, ctx.now) ?? ''}`].filter(Boolean).join(' ・ ')}
								</Text>
							</View>
							<Action ctx={ctx} agent={agent} />
						</View>
						{showDetail && agent.detail !== undefined && (agent.state === 'approve' || agent.state === 'question') ? (
							<Text style={styles.detail} numberOfLines={2}>{agent.detail}</Text>
						) : null}
					</View>
				))}
			</View>
			<Foot left={freshness(ctx)} right={ctx.settings.attention.showReview ? <Pill label="すべて確認済み" check accent={ctx.accent} /> : undefined} />
		</View>
	);
}

// --- B エージェント ------------------------------------------------------------------------

function AgentLine({ ctx, agent, withSpace, withTime }: { ctx: PreviewContext; agent: WidgetAgent; withSpace?: boolean; withTime?: boolean }) {
	return (
		<View style={styles.line}>
			<AgentStateDot kind={stateKind(agent.state)} />
			<Text style={[styles.lineTitle, styles.grow]} numberOfLines={1}>{title(ctx, agent)}</Text>
			{withSpace ? <Text style={[styles.muted, styles.lineSpace]} numberOfLines={1}>{spaceName(ctx, agent.spaceId) ?? ''}</Text> : null}
			{withTime ? <Text style={[styles.meta, styles.lineTime]} numberOfLines={1}>{agent.state === 'running' ? elapsed(agent, ctx.now) ?? '' : STATE_LABEL[agent.state]}</Text> : null}
		</View>
	);
}

function AgentsPreview({ ctx, size }: { ctx: PreviewContext; size: WidgetPreviewSize }) {
	const rows = listedAgents(ctx.pc.agents, ctx.settings);
	const attention = ctx.pc.agents.filter(agent => agent.state === 'approve' || agent.state === 'question').length;
	const running = ctx.pc.agents.filter(agent => agent.state === 'running').length;
	const counts = <Text style={styles.muted} numberOfLines={1}>{`${attention > 0 ? `要対応 ${attention} ・ ` : ''}実行中 ${running}`}</Text>;
	if (size === 'small') {
		return (
			<View style={styles.fill}>
				<Header label="エージェント" />
				<View style={styles.linesTop}>{rows.slice(0, 4).map(agent => <AgentLine key={agent.key} ctx={ctx} agent={agent} />)}</View>
			</View>
		);
	}
	if (size === 'medium') {
		return (
			<View style={styles.fill}>
				<Header label={ctx.pc.name} right={counts} />
				<View style={styles.linesTop}>{rows.slice(0, 4).map(agent => <AgentLine key={agent.key} ctx={ctx} agent={agent} withSpace withTime />)}</View>
			</View>
		);
	}
	const limited = rows.slice(0, ctx.settings.agents.limit);
	const groups: { id: string; agents: WidgetAgent[] }[] = [];
	for (const agent of limited) {
		const id = agent.spaceId ?? '';
		const group = groups.find(item => item.id === id);
		if (group === undefined) {
			groups.push({ id, agents: [agent] });
		} else {
			group.agents.push(agent);
		}
	}
	return (
		<View style={styles.fill}>
			<Header label={ctx.pc.name} right={counts} />
			{groups.map(group => (
				<View key={group.id}>
					<Text style={styles.section}>{spaceName(ctx, group.id) ?? 'スペース不明'}</Text>
					{group.agents.map(agent => <AgentLine key={agent.key} ctx={ctx} agent={agent} withTime />)}
				</View>
			))}
			<Foot left={freshness(ctx)} />
		</View>
	);
}

// --- C PC の状態 -----------------------------------------------------------------------

function Bar({ percent }: { percent: number | undefined }) {
	const value = Math.min(100, Math.max(0, percent ?? 0));
	return (
		<View style={styles.bar}>
			<View style={[styles.barFill, { width: `${value}%` }]} />
		</View>
	);
}

function MetricBar({ metric }: { metric: PreviewMetric }) {
	return (
		<View style={styles.metricBar}>
			<View style={styles.line}>
				<Text style={[styles.meta, styles.grow]} numberOfLines={1}>{metric.label}</Text>
				<Text style={styles.meta} numberOfLines={1}>{metric.sub !== undefined ? `${metric.value} ・ ${metric.sub}` : metric.value}</Text>
			</View>
			{metric.percent !== undefined ? <Bar percent={metric.percent} /> : null}
		</View>
	);
}

function PcPreview({ ctx, size }: { ctx: PreviewContext; size: WidgetPreviewSize }) {
	const metrics = pcMetrics(ctx.pc, ctx.settings, ctx.now);
	if (size === 'small') {
		return (
			<View style={styles.fill}>
				<Header label={ctx.pc.name} />
				<View style={styles.tiles}>
					{metrics.slice(0, 4).map(metric => (
						<View key={metric.key} style={styles.tile}>
							<Text style={styles.meta} numberOfLines={1}>{metric.short}</Text>
							<Text style={styles.tileValue} numberOfLines={1}>{metric.value}</Text>
						</View>
					))}
				</View>
			</View>
		);
	}
	const bars = metrics.filter(metric => metric.key !== 'cost' && metric.key !== 'battery');
	const cost = metrics.find(metric => metric.key === 'cost');
	const battery = metrics.find(metric => metric.key === 'battery');
	if (size === 'medium') {
		return (
			<View style={styles.columns}>
				<View style={styles.sideColumnWide}>
					<Header label="接続中" />
					<Text style={styles.pcName} numberOfLines={1}>{ctx.pc.name}</Text>
					{battery !== undefined ? <Text style={styles.tileValue}>{battery.value}</Text> : null}
					<View style={styles.grow} />
					<Text style={styles.meta}>要対応 2 ・ 実行中 1</Text>
				</View>
				<View style={[styles.grow, styles.stackGap]}>
					{bars.slice(0, 3).map(metric => <MetricBar key={metric.key} metric={metric} />)}
				</View>
				{cost !== undefined ? (
					<View style={styles.costColumn}>
						<Text style={styles.meta}>今日のコスト</Text>
						<Text style={styles.tileValue}>{cost.value}</Text>
					</View>
				) : null}
			</View>
		);
	}
	return (
		<View style={styles.fill}>
			<Header label={ctx.pc.name} right={<Text style={styles.muted}>接続中</Text>} />
			<View style={styles.stackGapTop}>
				{metrics.map(metric => (metric.key === 'cost'
					? (
						<View key={metric.key} style={styles.line}>
							<Text style={[styles.meta, styles.grow]}>今日のコスト</Text>
							<Text style={styles.tileValue}>{metric.value}</Text>
						</View>
					)
					: <MetricBar key={metric.key} metric={metric} />))}
			</View>
			<Foot left="要対応 2 ・ 実行中 1" right={<Text style={styles.muted}>コストと上限は 9分前に取得</Text>} />
		</View>
	);
}

// --- D スペース -------------------------------------------------------------------------

function SpacePreview({ ctx, size }: { ctx: PreviewContext; size: WidgetPreviewSize }) {
	const items = ctx.settings.space;
	const space = ctx.pc.spaces[0];
	if (space === undefined) {
		return null;
	}
	const agents = ctx.pc.agents.filter(agent => agent.spaceId === space.id);
	const name = ctx.settings.showNames ? space.name : 'スペース';
	const branch = (
		<View style={styles.branch}>
			<Icon icon={GitBranch} size={11} color={colors.textDim} />
			<Text style={styles.meta} numberOfLines={1}>{space.branch ?? ''}</Text>
		</View>
	);
	const commit = space.commits?.[0];
	if (size === 'small') {
		return (
			<View style={styles.fill}>
				<Header label={name} />
				{branch}
				{items.showChanges ? <BigCount value={`${space.changes ?? 0}`} unit="変更" size={BIG} /> : null}
				<View style={styles.grow} />
				{items.showAgents ? (
					<View style={styles.line}>
						{agents.map(agent => <AgentStateDot key={agent.key} kind={stateKind(agent.state)} />)}
						<Text style={styles.meta}>{`エージェント ${agents.length}`}</Text>
					</View>
				) : null}
			</View>
		);
	}
	if (size === 'medium') {
		return (
			<View style={styles.columns}>
				<View style={styles.sideColumnWide}>
					<Header label={name} />
					{branch}
					{items.showChanges ? <BigCount value={`${space.changes ?? 0}`} unit="変更" size={BIG} /> : null}
				</View>
				<View style={styles.grow}>
					{items.showAgents ? (
						<>
							<Text style={styles.sectionFirst}>エージェント</Text>
							{agents.slice(0, 2).map(agent => <AgentLine key={agent.key} ctx={ctx} agent={agent} withTime />)}
						</>
					) : null}
					{items.showCommits && commit !== undefined ? (
						<View style={styles.commit}>
							<Text style={styles.meta}>最新 12分前</Text>
							<Text style={styles.lineTitle} numberOfLines={1}>{commit.subject}</Text>
						</View>
					) : null}
				</View>
			</View>
		);
	}
	return (
		<View style={styles.fill}>
			<Header label={name} right={<Text style={styles.muted}>{ctx.pc.name}</Text>} />
			{branch}
			{items.showAgents ? (
				<>
					<Text style={styles.section}>エージェント</Text>
					{agents.slice(0, 4).map(agent => <AgentLine key={agent.key} ctx={ctx} agent={agent} withTime />)}
				</>
			) : null}
			{items.showChanges ? (
				<>
					<Text style={styles.section}>{`変更 ${space.changes ?? 0}`}</Text>
					{(space.files ?? []).slice(0, 4).map(file => (
						<View key={file.path} style={styles.line}>
							<Text style={[styles.fileCode, { color: file.code === 'A' ? colors.add : file.code === 'D' ? colors.del : colors.textDim }]}>{file.code}</Text>
							<Text style={[styles.lineTitle, styles.grow]} numberOfLines={1}>{file.path}</Text>
						</View>
					))}
				</>
			) : null}
			{items.showCommits ? (
				<>
					<Text style={styles.section}>最近のコミット</Text>
					{(space.commits ?? []).slice(0, 2).map(item => <Text key={item.subject} style={styles.lineTitle} numberOfLines={1}>{item.subject}</Text>)}
				</>
			) : null}
			<Foot left={freshness(ctx)} right={<Pill label="差分を見る" accent={ctx.accent} />} />
		</View>
	);
}

const styles = StyleSheet.create({
	stage: {
		alignItems: 'center',
		paddingVertical: space.lg,
	},
	widget: {
		// 本物の角丸（23pt）は OS が決める。見本はトークンのいちばん大きい角丸で近似する。
		borderRadius: radius.sheet,
		borderCurve: 'continuous',
		backgroundColor: colors.bg,
		borderWidth: 1,
		borderColor: colors.border,
		padding: space.lg,
		overflow: 'hidden',
	},
	fill: {
		flex: 1,
	},
	grow: {
		flex: 1,
		minWidth: 0,
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		height: 16,
	},
	headerText: {
		fontSize: type.meta,
		fontWeight: '500',
		color: colors.textDim,
		flexShrink: 1,
	},
	bigRow: {
		flexDirection: 'row',
		alignItems: 'baseline',
		marginTop: space.sm,
	},
	big: {
		fontWeight: '600',
		color: colors.text,
		letterSpacing: -1,
	},
	unit: {
		fontSize: type.body,
		fontWeight: '500',
		color: colors.textDim,
		marginLeft: 3,
	},
	title: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
	},
	meta: {
		fontSize: type.caption,
		color: colors.textDim,
	},
	muted: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	rowTop: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: space.xs + 2,
	},
	columns: {
		flex: 1,
		flexDirection: 'row',
		gap: space.md,
	},
	sideColumn: {
		width: 88,
	},
	sideColumnWide: {
		width: 112,
		gap: 3,
	},
	costColumn: {
		width: 96,
		gap: space.xs,
		justifyContent: 'center',
	},
	stackGap: {
		gap: space.sm,
		justifyContent: 'center',
	},
	stackGapTop: {
		gap: space.sm,
		marginTop: space.md,
	},
	card: {
		backgroundColor: colors.panel,
		borderRadius: radius.group,
		paddingHorizontal: space.sm + 2,
		paddingVertical: space.sm,
	},
	cardRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	countRow: {
		flexDirection: 'row',
		alignItems: 'baseline',
		gap: space.sm,
		marginBottom: space.sm + 2,
	},
	listGap: {
		gap: space.xs + 2,
	},
	detail: {
		fontSize: type.caption,
		color: colors.text,
		backgroundColor: colors.raised,
		borderRadius: radius.button,
		paddingHorizontal: space.sm,
		paddingVertical: space.xs + 2,
		marginTop: space.xs,
	},
	pill: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 3,
		height: 26,
		paddingHorizontal: space.sm + 2,
		borderRadius: radius.pill,
		backgroundColor: colors.raised,
	},
	pillText: {
		fontSize: type.meta,
		fontWeight: '500',
		color: colors.text,
	},
	foot: {
		position: 'absolute',
		left: 0,
		right: 0,
		bottom: -2,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs + 2,
	},
	line: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minHeight: 24,
	},
	linesTop: {
		marginTop: space.xs + 2,
	},
	lineTitle: {
		fontSize: type.meta,
		fontWeight: '500',
		color: colors.text,
	},
	lineSpace: {
		maxWidth: 80,
	},
	lineTime: {
		width: 48,
		textAlign: 'right',
	},
	section: {
		fontSize: type.caption,
		fontWeight: '500',
		color: colors.textMuted,
		marginTop: space.sm + 2,
		marginBottom: space.xs,
	},
	sectionFirst: {
		fontSize: type.caption,
		fontWeight: '500',
		color: colors.textMuted,
		marginBottom: space.xs,
	},
	tiles: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.xs + 2,
		marginTop: space.sm,
	},
	tile: {
		width: 62,
		height: 50,
		backgroundColor: colors.panel,
		borderRadius: radius.group,
		paddingHorizontal: space.sm,
		paddingVertical: space.xs + 2,
		justifyContent: 'space-between',
	},
	tileValue: {
		fontSize: type.large,
		fontWeight: '600',
		color: colors.text,
		letterSpacing: -0.4,
	},
	pcName: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
		marginTop: space.xs + 2,
	},
	metricBar: {
		gap: 3,
	},
	bar: {
		height: 5,
		borderRadius: radius.pill,
		backgroundColor: colors.raised,
		overflow: 'hidden',
	},
	barFill: {
		height: '100%',
		borderRadius: radius.pill,
		backgroundColor: colors.text,
	},
	branch: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		marginTop: space.xs,
	},
	commit: {
		marginTop: space.sm,
		paddingTop: space.sm,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	fileCode: {
		width: 12,
		fontSize: type.caption,
		fontWeight: '600',
	},
});
