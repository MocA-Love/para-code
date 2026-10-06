// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react-native';
import { formatMonitorClock, nextMonitorPillChange, type AgentMonitor } from '../../agentMonitors.js';
import {
	SHELL_DETAIL_OUTPUT_LINES,
	SHELL_LIST_OUTPUT_LINES,
	backgroundPillSummary,
	isShellStoppable,
	nextShellPillChange,
	partitionShells,
	shellDurationLabel,
	shellOutputUnavailableReason,
	shellStatusLabel,
	shellStopState,
	shellTitle,
	shellTone,
	shellWhereLabel,
	type AgentShell,
	type AgentShellOutput,
	type AgentShellsAccess,
	type BackgroundTab,
	ShellOutputPoller,
} from '../../agentShells.js';
import { useAppStore } from '../../appState.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { haptic } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { paraAlert } from '../../paraAlert.js';
import { colors, radius, space, squircle, type } from '../../theme.js';
import { BottomDrawer, Button, Icon, iconSize } from '../../ui/index.js';
import { MonitorListContent, TONE_COLOR, monitorStyles } from './monitorDrawer.js';

/** ピルの見た目の高さ（モデルピルと同じ 28）。当たり判定は 44 に広げる。 */
const PILL_HEIGHT = 28;
const PILL_SLOP = hitSlopToMinimum(PILL_HEIGHT);
/** 見出しの閉じる・戻るボタン（モデルのシートと同じ）。 */
const NAV_SIZE = 36;

/**
 * コンポーザーの「裏で動いているもの」のピル（Monitor とバックグラウンドのシェルを 1 つにまとめた。
 * `background-shells-mock.html` の案 B-2）と、押すと開く一覧のシート。
 *
 * - 出すのは、実行中のものか、終わってから 1 分以内のものがあるときだけ（`backgroundPillSummary`）
 * - 両方あるときの文字は「実行中 N」（モデルのピルを切らないため）。シートの上のセグメントで Monitor とシェルを切り替える。
 *   片方しか無いときはセグメントを出さない
 * - シェルの行を押すと、同じシートの中で詳細へ進む（出力の末尾 20 行と停止）
 * - 出さないときもピルとシートは木に残し、ピルを `display: 'none'` で隠す（木の形を変えると、
 *   開いているシートが閉じる動きなしで消えるため）
 * - 幅が足りないときはモデルピル側が縮む。こちらは縮めない（`flexShrink: 0`）
 * - シートの幅は BottomDrawer が決める（iPad の広い幅では中央に寄せた幅）。中身は与えられた幅に収める
 */
export function BackgroundPill({ terminalKey, monitors, shells, shellsAccess }: {
	terminalKey: string | undefined;
	monitors: readonly AgentMonitor[] | undefined;
	shells: readonly AgentShell[] | undefined;
	shellsAccess: AgentShellsAccess | undefined;
}) {
	const [open, setOpen] = useState(false);
	const [tab, setTab] = useState<BackgroundTab>('shells');
	const [detailId, setDetailId] = useState<string | undefined>(undefined);
	const now = useBackgroundClock(monitors, shells, open);
	const summary = backgroundPillSummary(monitors, shells, now);
	const hasShells = (shells ?? []).length > 0;
	const hasMonitors = (monitors ?? []).length > 0;
	const both = hasShells && hasMonitors;
	const shownTab: BackgroundTab = both ? tab : hasShells ? 'shells' : 'monitors';
	const detail = detailId !== undefined ? shells?.find(shell => shell.id === detailId) : undefined;
	const title = detail !== undefined ? 'シェル' : both ? '裏で動いているもの' : shownTab === 'shells' ? 'シェル' : 'Monitor';
	const close = () => setOpen(false);
	return (
		<>
			<Pressable
				style={({ pressed }) => [styles.pill, summary === undefined ? styles.hidden : undefined, pressed ? styles.pressed : undefined]}
				hitSlop={PILL_SLOP}
				onPress={() => {
					haptic('move');
					setTab(summary?.tab ?? 'shells');
					setDetailId(undefined);
					setOpen(true);
				}}
				disabled={summary === undefined}
				accessibilityRole="button"
				accessibilityLabel={summary?.accessibilityLabel}
				accessibilityElementsHidden={summary === undefined}
				importantForAccessibility={summary === undefined ? 'no-hide-descendants' : 'auto'}
			>
				<View style={[monitorStyles.dot, { backgroundColor: TONE_COLOR[summary?.tone ?? 'idle'] }]} />
				<Text style={styles.pillText} numberOfLines={1}>{summary?.label ?? 'Monitor'}</Text>
				<Icon icon={ChevronDown} size={iconSize.xs} color={colors.textDim} />
			</Pressable>
			<BottomDrawer visible={open} onClose={close} onAfterClose={() => setDetailId(undefined)} accessibilityLabel="裏で動いているものの一覧">
				<View style={styles.head}>
					{detail !== undefined ? (
						<Pressable onPress={() => setDetailId(undefined)} hitSlop={hitSlopToMinimum(NAV_SIZE, NAV_SIZE)} style={styles.nav} accessibilityRole="button" accessibilityLabel="一覧に戻る">
							<Icon icon={ChevronLeft} size={iconSize.lg} color={colors.textDim} strokeWidth={2.2} />
						</Pressable>
					) : (
						<Pressable onPress={close} hitSlop={hitSlopToMinimum(NAV_SIZE, NAV_SIZE)} style={styles.nav} accessibilityRole="button" accessibilityLabel="閉じる">
							<Icon icon={X} size={iconSize.lg} color={colors.textDim} strokeWidth={2.2} />
						</Pressable>
					)}
					<Text style={styles.headTitle} accessibilityRole="header" numberOfLines={1}>{title}</Text>
					<View style={styles.nav} />
				</View>
				{detail !== undefined && terminalKey !== undefined ? (
					<ShellDetail terminalKey={terminalKey} shell={detail} access={shellsAccess} now={now} visible={open} />
				) : (
					<>
						{both ? (
							<SegmentSwitch
								value={shownTab}
								options={[{ value: 'shells', label: `シェル ${shells?.length ?? 0}` }, { value: 'monitors', label: `Monitor ${monitors?.length ?? 0}` }]}
								onChange={setTab}
							/>
						) : null}
						{shownTab === 'shells'
							? <ShellList terminalKey={terminalKey} shells={shells} access={shellsAccess} now={now} visible={open} onOpen={id => { haptic('move'); setDetailId(id); }} />
							: <MonitorListContent monitors={monitors} now={now} />}
					</>
				)}
			</BottomDrawer>
		</>
	);
}

/**
 * 描き直しの時計。シートを開いている間は経過時間のために毎秒、閉じている間は
 * 終わったものがピルから消える時刻に1回だけ進める。セッションの輪のシート（sessionRing.tsx）でも使う。
 */
export function useBackgroundClock(monitors: readonly AgentMonitor[] | undefined, shells: readonly AgentShell[] | undefined, open: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	const monitorChange = open ? undefined : nextMonitorPillChange(monitors, now);
	const shellChange = open ? undefined : nextShellPillChange(shells, now);
	const nextChange = monitorChange === undefined ? shellChange : shellChange === undefined ? monitorChange : Math.min(monitorChange, shellChange);
	useEffect(() => {
		setNow(Date.now());
		if (open) {
			const timer = setInterval(() => setNow(Date.now()), 1_000);
			return () => clearInterval(timer);
		}
		return undefined;
	}, [open, monitors, shells]);
	useEffect(() => {
		if (nextChange === undefined) {
			return undefined;
		}
		const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextChange - Date.now()) + 50);
		return () => clearTimeout(timer);
	}, [nextChange]);
	return now;
}

interface ShellOutputsState {
	readonly outputs: ReadonlyMap<string, AgentShellOutput>;
	/** 最後に受け取った時刻（手元の時計）。 */
	readonly receivedAt?: number;
	readonly error?: string;
}

/**
 * シェルの出力の末尾を PC から取り寄せる。シートを開いている間だけ、動いているものがあれば
 * 一定の間隔で取り直す（出力は PC がファイルから読むので、開いていないときは送らせない）。
 * 重ならない読み・busy の読み直しは {@link ShellOutputPoller} が持つ（組み合わせが変わるたびに作り直す）。
 */
function useShellOutputs(terminalKey: string | undefined, ids: readonly string[], lines: number, enabled: boolean, poll: boolean): ShellOutputsState {
	const request = useAppStore(state => state.requestAgentShellOutput);
	const [state, setState] = useState<ShellOutputsState>({ outputs: new Map() });
	const key = ids.join(',');
	useEffect(() => {
		if (!enabled || terminalKey === undefined || key.length === 0) {
			return undefined;
		}
		const poller = new ShellOutputPoller(() => request(terminalKey, key.split(','), lines), result => {
			if ('error' in result) {
				setState(previous => ({ ...previous, error: result.error }));
			} else {
				setState({ outputs: result.outputs, receivedAt: Date.now() });
			}
		}, poll);
		return () => poller.dispose();
	}, [request, terminalKey, key, lines, enabled, poll]);
	return state;
}

export function SegmentSwitch({ value, options, onChange }: { value: BackgroundTab; options: readonly { readonly value: BackgroundTab; readonly label: string }[]; onChange: (value: BackgroundTab) => void }) {
	return (
		<View style={styles.segment} accessibilityRole="tablist">
			{options.map(option => {
				const active = option.value === value;
				return (
					<Pressable
						key={option.value}
						style={[styles.segmentButton, active ? styles.segmentButtonActive : undefined]}
						onPress={() => { if (!active) { haptic('tick'); onChange(option.value); } }}
						accessibilityRole="tab"
						accessibilityState={{ selected: active }}
					>
						<Text style={[styles.segmentText, active ? styles.segmentTextActive : undefined]} numberOfLines={1}>{option.label}</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

export function ShellList({ terminalKey, shells, access, now, visible, onOpen }: {
	terminalKey: string | undefined;
	shells: readonly AgentShell[] | undefined;
	access: AgentShellsAccess | undefined;
	now: number;
	visible: boolean;
	onOpen: (id: string) => void;
}) {
	const { running, ended } = partitionShells(shells);
	const ids = [...running, ...ended].map(shell => shell.id).slice(0, 20);
	// 推定で終わったもの（出力の最後の印）も読み直す。次の読みで印が消えていれば PC が running に戻す
	const outputs = useShellOutputs(terminalKey, ids, SHELL_LIST_OUTPUT_LINES, visible && access?.output === true, [...running, ...ended].some(isShellStoppable));
	const row = (shell: AgentShell, index: number) => (
		<ShellRow key={shell.id} shell={shell} now={now} divider={index > 0} lastLine={outputs.outputs.get(shell.id)?.lines.at(-1)} onPress={() => onOpen(shell.id)} />
	);
	return (
		<>
			<Text style={monitorStyles.caption}>エージェントが裏で動かしているコマンドです。終わるとエージェントへ知らされます。</Text>
			{running.length === 0 && ended.length === 0 ? <Text style={monitorStyles.caption}>動かしているものはありません</Text> : null}
			{running.length > 0 ? (
				<>
					<Text style={monitorStyles.section}>実行中</Text>
					<View style={monitorStyles.group}>{running.map(row)}</View>
				</>
			) : null}
			{ended.length > 0 ? (
				<>
					<Text style={monitorStyles.section}>終了</Text>
					<View style={monitorStyles.group}>{ended.map(row)}</View>
				</>
			) : null}
		</>
	);
}

function ShellRow({ shell, now, divider, lastLine, onPress }: { shell: AgentShell; now: number; divider: boolean; lastLine: string | undefined; onPress: () => void }) {
	const tone = shellTone(shell);
	const running = shell.status === 'running';
	const right = running ? shellDurationLabel(shell, now) : shellStatusLabel(shell);
	return (
		<Pressable
			style={({ pressed }) => [monitorStyles.row, divider ? monitorStyles.rowDivider : undefined, pressed ? styles.pressed : undefined]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={`${shellTitle(shell)}、${shellStatusLabel(shell)}。押すと詳細を開きます`}
		>
			<View style={monitorStyles.rowHead}>
				<View style={[monitorStyles.dot, { backgroundColor: TONE_COLOR[tone] }]} />
				<Text style={[monitorStyles.rowTitle, styles.mono]} numberOfLines={1}>{shellTitle(shell)}</Text>
				{right !== undefined ? (
					<Text style={running ? monitorStyles.elapsed : [monitorStyles.statusLabel, { color: tone === 'idle' ? colors.textDim : TONE_COLOR[tone] }]} numberOfLines={1}>{right}</Text>
				) : null}
				<Icon icon={ChevronRight} size={iconSize.sm} color={colors.textMuted} />
			</View>
			{lastLine !== undefined && lastLine.length > 0 ? (
				<View style={monitorStyles.output}>
					<Text style={monitorStyles.outputLine} numberOfLines={1}>{lastLine}</Text>
				</View>
			) : null}
		</Pressable>
	);
}

export function ShellDetail({ terminalKey, shell, access, now, visible }: { terminalKey: string; shell: AgentShell; access: AgentShellsAccess | undefined; now: number; visible: boolean }) {
	const stopShell = useAppStore(state => state.stopAgentShell);
	const pcConnected = useAppStore(state => state.pcOnline && state.sessionProtocolReady);
	const [stopping, setStopping] = useState(false);
	const running = shell.status === 'running';
	const outputReason = shellOutputUnavailableReason(access);
	const outputs = useShellOutputs(terminalKey, [shell.id], SHELL_DETAIL_OUTPUT_LINES, visible && outputReason === undefined, isShellStoppable(shell));
	const output = outputs.outputs.get(shell.id);
	const stop = shellStopState(shell, access, pcConnected);
	const where = shellWhereLabel(access);
	const duration = shellDurationLabel(shell, now);
	const confirmStop = () => {
		haptic('warning');
		// 止めたことはエージェントへ届かない（mod の TaskStop は通知も transcript の行も残さない。2026-10-04 に Claude Code 2.1.289 で確認）
		paraAlert.alert('シェルを止めますか？', `${shellTitle(shell)} を止めます。止めたことはエージェントへ自動では知らされません。`, [
			{ text: 'キャンセル', style: 'cancel' },
			{
				text: '止める', style: 'destructive', onPress: () => {
					setStopping(true);
					stopShell(terminalKey, shell.id).then(result => {
						setStopping(false);
						if (result.status === 'accepted') {
							haptic('success');
							return;
						}
						haptic('error');
						paraAlert.alert('止められませんでした', result.message ?? 'PC の端末で /tasks を確かめてください。');
					}, () => {
						setStopping(false);
						paraAlert.alert('止められませんでした', 'PC との接続を確かめてください。');
					});
				},
			},
		]);
	};
	const outputMeta = output !== undefined && output.error === undefined
		? (output.truncated ? (outputs.receivedAt !== undefined ? `${formatMonitorClock(outputs.receivedAt)} 更新` : undefined) : `全 ${output.lines.length} 行`)
		: undefined;
	return (
		<View style={styles.detail}>
			<View style={monitorStyles.group}>
				<DetailRow label="状態" value={shellStatusLabel(shell)} color={shell.status === 'running' ? undefined : TONE_COLOR[shellTone(shell)]} />
				{duration !== undefined ? (
					<DetailRow divider label={running ? '経過' : 'かかった時間'} value={!running && shell.endedAt !== undefined ? `${duration}（${formatMonitorClock(shell.endedAt)} に終了）` : duration} />
				) : null}
				{shell.exitCode !== undefined ? <DetailRow divider label="終了コード" value={String(shell.exitCode)} /> : null}
				{shell.movedToBackground !== undefined ? <DetailRow divider label="始まり" value={shell.movedToBackground === 'timeout' ? '時間切れで裏へ回った' : 'TUI から裏へ回した'} /> : null}
				{where !== undefined ? <DetailRow divider label="場所" value={where} /> : null}
			</View>
			<Text style={monitorStyles.section}>コマンド</Text>
			<View style={styles.codeBox}>
				<Text style={styles.command} selectable>{shell.command ?? shell.description ?? shell.id}</Text>
			</View>
			<View style={styles.outputHead}>
				<Text style={[monitorStyles.section, styles.outputHeadTitle]}>{outputReason === undefined ? `出力（末尾 ${SHELL_DETAIL_OUTPUT_LINES} 行）` : '出力'}</Text>
				{outputMeta !== undefined ? <Text style={styles.outputMeta}>{outputMeta}</Text> : null}
			</View>
			{outputReason !== undefined ? (
				<Text style={styles.reason}>{outputReason}</Text>
			) : output === undefined ? (
				<Text style={styles.reason}>{outputs.error ?? '読み込んでいます'}</Text>
			) : output.error !== undefined ? (
				<Text style={styles.reason}>{output.error === 'not-found' ? '出力のファイルが見つかりません（消えたか、PC が再起動しました）。' : 'この PC からは出力を読めません。'}</Text>
			) : output.lines.length === 0 ? (
				<Text style={styles.reason}>まだ出力はありません</Text>
			) : (
				// 長い行は折り返さず、横にスクロールする（ユーザーの決定）。縦は 20 行で収まるので、シートのスクロールに任せる
				<ScrollView horizontal style={styles.outputBox} contentContainerStyle={styles.outputContent} showsHorizontalScrollIndicator>
					<View>
						{output.lines.map((line, index) => <Text key={index} style={styles.outputLine} selectable>{line.length > 0 ? line : ' '}</Text>)}
					</View>
				</ScrollView>
			)}
			{stop.kind === 'enabled' ? (
				<Button label="このシェルを止める" variant="danger" onPress={confirmStop} loading={stopping} disabled={stopping} style={styles.stop} />
			) : stop.kind === 'disabled' ? (
				<>
					<Button label="このシェルを止める" variant="danger" onPress={() => { }} disabled style={styles.stop} />
					<Text style={styles.reason}>{stop.reason}</Text>
				</>
			) : null}
		</View>
	);
}

function DetailRow({ label, value, color, divider = false }: { label: string; value: string; color?: string; divider?: boolean }) {
	return (
		<View style={[styles.detailRow, divider ? monitorStyles.rowDivider : undefined]}>
			<Text style={styles.detailLabel}>{label}</Text>
			<Text style={[styles.detailValue, color !== undefined ? { color } : undefined]}>{value}</Text>
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
	segment: {
		flexDirection: 'row',
		alignSelf: 'center',
		padding: 2,
		marginBottom: space.md,
		borderRadius: radius.control,
		...squircle,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.panel,
	},
	segmentButton: {
		minHeight: 32,
		minWidth: 96,
		paddingHorizontal: space.md,
		alignItems: 'center',
		justifyContent: 'center',
		borderRadius: radius.key,
		...squircle,
	},
	segmentButtonActive: {
		backgroundColor: colors.raised,
	},
	segmentText: {
		fontSize: type.meta,
		color: colors.textDim,
	},
	segmentTextActive: {
		color: colors.text,
		fontWeight: '600',
	},
	mono: {
		fontFamily: monoFamily,
		fontSize: type.meta,
	},
	detail: {
		gap: space.xs,
	},
	detailRow: {
		flexDirection: 'row',
		alignItems: 'baseline',
		gap: space.md,
		paddingHorizontal: 14,
		paddingVertical: space.sm,
	},
	detailLabel: {
		width: 84,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	detailValue: {
		flex: 1,
		minWidth: 0,
		fontSize: type.body,
		color: colors.text,
	},
	codeBox: {
		paddingHorizontal: space.sm,
		paddingVertical: space.sm,
		borderRadius: radius.control,
		backgroundColor: colors.codeBg,
	},
	command: {
		fontFamily: monoFamily,
		fontSize: type.caption,
		lineHeight: 16,
		color: colors.terminalFg,
	},
	outputHead: {
		flexDirection: 'row',
		alignItems: 'baseline',
		justifyContent: 'space-between',
	},
	outputHeadTitle: {
		flexShrink: 1,
	},
	outputMeta: {
		fontSize: type.caption,
		color: colors.textMuted,
		fontVariant: ['tabular-nums'],
	},
	outputBox: {
		borderRadius: radius.control,
		backgroundColor: colors.codeBg,
	},
	outputContent: {
		paddingHorizontal: space.sm,
		paddingVertical: 6,
	},
	outputLine: {
		fontFamily: monoFamily,
		fontSize: type.caption,
		lineHeight: 16,
		color: colors.terminalFg,
	},
	reason: {
		paddingHorizontal: space.xs,
		paddingVertical: space.xs,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
	},
	stop: {
		marginTop: space.md,
	},
});
