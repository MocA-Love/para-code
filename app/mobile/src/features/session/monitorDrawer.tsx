// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, Text, View } from 'react-native';
import {
	formatMonitorClock,
	formatMonitorDuration,
	monitorElapsedLabel,
	monitorLimitLabel,
	monitorStatusLabel,
	monitorTone,
	partitionMonitors,
	type AgentMonitor,
	type MonitorTone,
} from '../../agentMonitors.js';
import { monoFamily } from '../../monoFont.js';
import { colors, radius, space, squircle, type } from '../../theme.js';

const DOT = 6;

/** 状態の色（点と終わり方の文字）。シェルの一覧（backgroundPill.tsx）でも使う。 */
export const TONE_COLOR: Record<MonitorTone, string> = {
	running: colors.yellow,
	done: colors.emerald,
	failed: colors.red,
	idle: colors.idle,
};

/**
 * Monitor の一覧（シートの中身）。ピルとシートの器は backgroundPill.tsx（バックグラウンドのシェルと 1 つにまとめた。
 * `background-shells-mock.html` の案 B-2）。見るだけで、止める操作は置かない。
 */
export function MonitorListContent({ monitors, now }: { monitors: readonly AgentMonitor[] | undefined; now: number }) {
	const { running, ended } = partitionMonitors(monitors);
	return (
		<>
			<Text style={monitorStyles.caption}>エージェントが出力を見張っているコマンドです。出力の行が届くたびにエージェントへ知らされます。</Text>
			{running.length === 0 && ended.length === 0 ? <Text style={monitorStyles.caption}>見張っているものはありません</Text> : null}
			{running.length > 0 ? (
				<>
					<Text style={monitorStyles.section}>実行中</Text>
					<View style={monitorStyles.group}>
						{running.map((monitor, index) => <MonitorRow key={monitor.id} monitor={monitor} now={now} divider={index > 0} />)}
					</View>
				</>
			) : null}
			{ended.length > 0 ? (
				<>
					<Text style={monitorStyles.section}>終了</Text>
					<View style={monitorStyles.group}>
						{ended.map((monitor, index) => <MonitorRow key={monitor.id} monitor={monitor} now={now} divider={index > 0} />)}
					</View>
				</>
			) : null}
		</>
	);
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
		<View style={[monitorStyles.row, divider ? monitorStyles.rowDivider : undefined]}>
			<View style={monitorStyles.rowHead}>
				<View style={[monitorStyles.dot, { backgroundColor: TONE_COLOR[tone] }]} />
				<Text style={monitorStyles.rowTitle} numberOfLines={1}>{monitor.description}</Text>
				{statusLabel !== undefined
					? <Text style={[monitorStyles.statusLabel, { color: tone === 'idle' ? colors.textDim : TONE_COLOR[tone] }]} numberOfLines={1}>{statusLabel}</Text>
					: <Text style={monitorStyles.elapsed} numberOfLines={1}>{monitorElapsedLabel(monitor, now)}</Text>}
			</View>
			{monitor.command !== undefined && monitor.status === 'running' ? (
				<Text style={monitorStyles.command} numberOfLines={1} ellipsizeMode="tail">{monitor.command.replace(/\s*\n\s*/g, ' ⏎ ')}</Text>
			) : null}
			{monitor.output.length > 0 ? (
				<View style={monitorStyles.output}>
					{monitor.output.map((line, index) => (
						<Text key={`${line.at}:${index}`} style={monitorStyles.outputLine} numberOfLines={2}>
							<Text style={monitorStyles.outputTime}>{`${formatMonitorClock(line.at)}  `}</Text>
							{line.text}
						</Text>
					))}
				</View>
			) : monitor.status === 'running' ? (
				<Text style={monitorStyles.outputEmpty}>まだ出力はありません</Text>
			) : null}
			<Text style={monitorStyles.meta} numberOfLines={1}>{meta.filter((part): part is string => part !== undefined).join(' · ')}</Text>
		</View>
	);
}

/** 点・説明・一覧の行の見た目（backgroundPill.tsx と共有する）。 */
export const monitorStyles = StyleSheet.create({
	dot: {
		width: DOT,
		height: DOT,
		borderRadius: radius.pill,
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
