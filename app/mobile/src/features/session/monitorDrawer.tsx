// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, X } from 'lucide-react-native';
import {
	formatMonitorClock,
	formatMonitorDuration,
	monitorElapsedLabel,
	monitorLimitLabel,
	monitorPillSummary,
	monitorStatusLabel,
	monitorTone,
	nextMonitorPillChange,
	partitionMonitors,
	type AgentMonitor,
	type MonitorTone,
} from '../../agentMonitors.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { haptic } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { colors, radius, space, squircle, type } from '../../theme.js';
import { BottomDrawer, Icon, iconSize } from '../../ui/index.js';

/** ピルの見た目の高さ（モデルピルと同じ 28）。当たり判定は 44 に広げる。 */
const PILL_HEIGHT = 28;
const PILL_SLOP = hitSlopToMinimum(PILL_HEIGHT);
/** 見出しの閉じるボタン（モデルのシートと同じ）。 */
const NAV_SIZE = 36;
const DOT = 6;

const TONE_COLOR: Record<MonitorTone, string> = {
	running: colors.yellow,
	done: colors.emerald,
	failed: colors.red,
	idle: colors.idle,
};

/**
 * コンポーザーの Monitor のピル（モデルピルの右。モックの案A）と、押すと開く一覧のシート。
 *
 * - 出すのは、実行中のものか、終わってから 1 分以内のものがあるときだけ（`monitorPillSummary`）
 * - 見るだけで、止める操作は置かない
 * - 出さないときもピルとシートは木に残し、ピルを `display: 'none'` で隠す（木の形を変えると、
 *   開いているシートが閉じる動きなしで消えるため）
 * - 幅が足りないときはモデルピル側が縮む。こちらは縮めない（`flexShrink: 0`）
 */
export function MonitorPill({ monitors }: { monitors: readonly AgentMonitor[] | undefined }) {
	const [open, setOpen] = useState(false);
	const now = useMonitorClock(monitors, open);
	const summary = monitorPillSummary(monitors, now);
	const { running, ended } = partitionMonitors(monitors);
	return (
		<>
			<Pressable
				style={({ pressed }) => [styles.pill, summary === undefined ? styles.hidden : undefined, pressed ? styles.pressed : undefined]}
				hitSlop={PILL_SLOP}
				onPress={() => { haptic('move'); setOpen(true); }}
				disabled={summary === undefined}
				accessibilityRole="button"
				accessibilityLabel={summary?.accessibilityLabel}
				accessibilityElementsHidden={summary === undefined}
				importantForAccessibility={summary === undefined ? 'no-hide-descendants' : 'auto'}
			>
				<View style={[styles.dot, { backgroundColor: TONE_COLOR[summary?.tone ?? 'idle'] }]} />
				<Text style={styles.pillText} numberOfLines={1}>{summary?.label ?? 'Monitor'}</Text>
				<Icon icon={ChevronDown} size={iconSize.xs} color={colors.textDim} />
			</Pressable>
			<BottomDrawer visible={open} onClose={() => setOpen(false)} accessibilityLabel="Monitor の一覧">
				<View style={styles.head}>
					<Pressable onPress={() => setOpen(false)} hitSlop={hitSlopToMinimum(NAV_SIZE, NAV_SIZE)} style={styles.nav} accessibilityRole="button" accessibilityLabel="閉じる">
						<Icon icon={X} size={iconSize.lg} color={colors.textDim} strokeWidth={2.2} />
					</Pressable>
					<Text style={styles.headTitle} accessibilityRole="header">Monitor</Text>
					<View style={styles.nav} />
				</View>
				<Text style={styles.caption}>エージェントが出力を見張っているコマンドです。出力の行が届くたびにエージェントへ知らされます。</Text>
				{running.length === 0 && ended.length === 0 ? <Text style={styles.caption}>見張っているものはありません</Text> : null}
				{running.length > 0 ? (
					<>
						<Text style={styles.section}>実行中</Text>
						<View style={styles.group}>
							{running.map((monitor, index) => <MonitorRow key={monitor.id} monitor={monitor} now={now} divider={index > 0} />)}
						</View>
					</>
				) : null}
				{ended.length > 0 ? (
					<>
						<Text style={styles.section}>終了</Text>
						<View style={styles.group}>
							{ended.map((monitor, index) => <MonitorRow key={monitor.id} monitor={monitor} now={now} divider={index > 0} />)}
						</View>
					</>
				) : null}
			</BottomDrawer>
		</>
	);
}

/**
 * 描き直しの時計。シートを開いている間は経過時間のために毎秒、閉じている間は
 * 終わったものがピルから消える時刻に1回だけ進める。
 */
function useMonitorClock(monitors: readonly AgentMonitor[] | undefined, open: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	const nextChange = open ? undefined : nextMonitorPillChange(monitors, now);
	useEffect(() => {
		setNow(Date.now());
		if (open) {
			const timer = setInterval(() => setNow(Date.now()), 1_000);
			return () => clearInterval(timer);
		}
		return undefined;
	}, [open, monitors]);
	useEffect(() => {
		if (nextChange === undefined) {
			return undefined;
		}
		const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextChange - Date.now()) + 50);
		return () => clearTimeout(timer);
	}, [nextChange]);
	return now;
}

function MonitorRow({ monitor, now, divider }: { monitor: AgentMonitor; now: number; divider: boolean }) {
	const tone = monitorTone(monitor);
	const statusLabel = monitorStatusLabel(monitor);
	const limit = monitorLimitLabel(monitor);
	const meta = monitor.status === 'running'
		? [`出力 ${monitor.eventCount} 件`, limit]
		// 起動を PC が読めなかったものは、本当の長さが分からないので終わるまでの時間を出さない。
		: [monitor.endedAt !== undefined && monitor.startUnknown !== true ? `${formatMonitorDuration(monitor.endedAt - monitor.startedAt)}で終了` : undefined, `出力 ${monitor.eventCount} 件`];
	return (
		<View style={[styles.row, divider ? styles.rowDivider : undefined]}>
			<View style={styles.rowHead}>
				<View style={[styles.dot, { backgroundColor: TONE_COLOR[tone] }]} />
				<Text style={styles.rowTitle} numberOfLines={1}>{monitor.description}</Text>
				{statusLabel !== undefined
					? <Text style={[styles.statusLabel, { color: tone === 'idle' ? colors.textDim : TONE_COLOR[tone] }]} numberOfLines={1}>{statusLabel}</Text>
					: <Text style={styles.elapsed} numberOfLines={1}>{monitorElapsedLabel(monitor, now)}</Text>}
			</View>
			{monitor.command !== undefined && monitor.status === 'running' ? (
				<Text style={styles.command} numberOfLines={1} ellipsizeMode="tail">{monitor.command.replace(/\s*\n\s*/g, ' ⏎ ')}</Text>
			) : null}
			{monitor.output.length > 0 ? (
				<View style={styles.output}>
					{monitor.output.map((line, index) => (
						<Text key={`${line.at}:${index}`} style={styles.outputLine} numberOfLines={2}>
							<Text style={styles.outputTime}>{`${formatMonitorClock(line.at)}  `}</Text>
							{line.text}
						</Text>
					))}
				</View>
			) : monitor.status === 'running' ? (
				<Text style={styles.outputEmpty}>まだ出力はありません</Text>
			) : null}
			<Text style={styles.meta} numberOfLines={1}>{meta.filter((part): part is string => part !== undefined).join(' · ')}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	pill: {
		flexDirection: 'row',
		alignItems: 'center',
		flexShrink: 0,
		gap: space.xs,
		minHeight: PILL_HEIGHT,
		paddingHorizontal: space.sm,
		paddingVertical: space.xs,
		borderRadius: radius.control,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.raised,
	},
	hidden: {
		display: 'none',
	},
	pressed: {
		opacity: 0.7,
	},
	pillText: {
		fontSize: type.meta,
		color: colors.text,
	},
	dot: {
		width: DOT,
		height: DOT,
		borderRadius: radius.pill,
	},
	head: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingBottom: space.sm,
	},
	nav: {
		width: NAV_SIZE,
		height: NAV_SIZE,
		alignItems: 'center',
		justifyContent: 'center',
	},
	headTitle: {
		flex: 1,
		textAlign: 'center',
		fontSize: type.title,
		fontWeight: '700',
		color: colors.text,
	},
	caption: {
		paddingHorizontal: space.sm,
		paddingBottom: space.md,
		textAlign: 'center',
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
	},
	section: {
		marginTop: space.md,
		marginBottom: space.sm,
		paddingHorizontal: space.xs,
		fontSize: type.caption,
		fontWeight: '600',
		color: colors.textMuted,
	},
	group: {
		borderRadius: radius.card,
		...squircle,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.raised,
		overflow: 'hidden',
	},
	row: {
		gap: 6,
		paddingHorizontal: 14,
		paddingVertical: space.md,
	},
	rowDivider: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	rowHead: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	rowTitle: {
		flex: 1,
		minWidth: 0,
		fontSize: type.body,
		fontWeight: '500',
		color: colors.text,
	},
	elapsed: {
		fontSize: type.meta,
		color: colors.textMuted,
		fontVariant: ['tabular-nums'],
	},
	statusLabel: {
		flexShrink: 0,
		fontSize: type.meta,
		fontWeight: '600',
	},
	command: {
		fontFamily: monoFamily,
		fontSize: type.caption,
		color: colors.textMuted,
	},
	output: {
		paddingHorizontal: space.sm,
		paddingVertical: 6,
		borderRadius: radius.control,
		backgroundColor: colors.codeBg,
	},
	outputLine: {
		fontFamily: monoFamily,
		fontSize: type.caption,
		lineHeight: 16,
		color: colors.terminalFg,
	},
	outputTime: {
		color: colors.textMuted,
	},
	outputEmpty: {
		fontSize: type.caption,
		fontStyle: 'italic',
		color: colors.textMuted,
	},
	meta: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
});
