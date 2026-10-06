// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Text as SvgText } from 'react-native-svg';
import { useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, X } from 'lucide-react-native';
import type { AgentMonitor } from '../../agentMonitors.js';
import type { AgentShell, AgentShellsAccess, BackgroundTab } from '../../agentShells.js';
import {
	cacheRowLabel,
	cacheTimeState,
	cacheTimeValue,
	contextValue,
	hitMissValue,
	nextSessionRingChange,
	pullRequestValue,
	sessionRingModel,
	type AgentSessionStatus,
	type RingTone,
	type SessionSheetValue,
} from '../../agentSessionStatus.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { haptic } from '../../haptics.js';
import { routes } from '../../routes.js';
import { colors, space, type } from '../../theme.js';
import { BottomDrawer, Icon, iconSize } from '../../ui/index.js';
import { useCodeSpace } from '../code/useCodeSpace.js';
import { usePullRequest } from '../code/usePullRequest.js';
import { SegmentSwitch, ShellDetail, ShellList } from './backgroundPill.js';
import { MonitorListContent, monitorStyles } from './monitorDrawer.js';

/** 輪の見た目の大きさ（モデルのピルと同じ 28）。当たり判定は 44 に広げる。 */
const RING_SIZE = 28;
const RING_SLOP = hitSlopToMinimum(RING_SIZE);
const RING_RADIUS = 10.5;
const RING_STROKE = 2.6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
/** 見出しの閉じる・戻るボタン（モデルのシートと同じ）。 */
const NAV_SIZE = 36;

const TONE: Record<RingTone, string> = {
	idle: colors.textDim,
	warn: colors.yellow,
	danger: colors.red,
};

/**
 * コンポーザーの「セッションの輪」（`mobile-statusline-mock.html` の入口 E2）と、押すと開くシート（案 A）。
 * PC が `agent.session-status.v1` を広告しているときだけ、「裏で動いているもの」のピルの代わりに出す。
 *
 * - 輪は常に出す（普段は灰色）。弧はコンテキストの使用率、右上の点はキャッシュの注意、中の数字は動いているシェルと Monitor
 * - シートは上から「このセッション」（キャッシュの残り時間・hit / miss・コンテキスト・PR）と「動いているもの」（今のピルの
 *   シートと同じ一覧。シェルの行から同じシートの中で詳細へ進み、出力の末尾と停止を出す）
 * - 幅は 28pt で縮めない（`flexShrink: 0`）。モデルのピルの側が縮む
 */
export function SessionRing({ terminalKey, status, working, monitors, shells, shellsAccess }: {
	terminalKey: string | undefined;
	status: AgentSessionStatus | undefined;
	working: boolean;
	monitors: readonly AgentMonitor[] | undefined;
	shells: readonly AgentShell[] | undefined;
	shellsAccess: AgentShellsAccess | undefined;
}) {
	const [open, setOpen] = useState(false);
	const [tab, setTab] = useState<BackgroundTab>('shells');
	const [detailId, setDetailId] = useState<string | undefined>(undefined);
	const now = useSessionClock(status, working, open);
	const ring = sessionRingModel(status, monitors, shells, now, working);
	const detail = detailId !== undefined ? shells?.find(shell => shell.id === detailId) : undefined;
	const close = () => setOpen(false);
	return (
		<>
			<Pressable
				style={({ pressed }) => [styles.ring, pressed ? styles.pressed : undefined]}
				hitSlop={RING_SLOP}
				onPress={() => {
					haptic('move');
					const runningShells = (shells ?? []).some(shell => shell.status === 'running');
					setTab(runningShells || (monitors ?? []).length === 0 ? 'shells' : 'monitors');
					setDetailId(undefined);
					setOpen(true);
				}}
				accessibilityRole="button"
				accessibilityLabel={ring.accessibilityLabel}
			>
				<Svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
					<Circle cx={14} cy={14} r={RING_RADIUS} fill="none" stroke={colors.borderStrong} strokeWidth={RING_STROKE} />
					{ring.percent > 0 ? (
						<Circle
							cx={14}
							cy={14}
							r={RING_RADIUS}
							fill="none"
							stroke={TONE[ring.arcTone]}
							strokeWidth={RING_STROKE}
							strokeDasharray={`${RING_LENGTH * ring.percent / 100} ${RING_LENGTH}`}
							strokeLinecap="round"
							transform="rotate(-90 14 14)"
						/>
					) : null}
					{ring.running > 0 ? (
						<SvgText x={14} y={17.6} textAnchor="middle" fontSize={10} fontWeight="700" fill={colors.yellow}>{ring.running > 99 ? '99+' : String(ring.running)}</SvgText>
					) : null}
					{ring.dot !== undefined ? (
						<Circle cx={23.5} cy={4.5} r={3.6} fill={ring.dot === 'danger' ? colors.red : colors.yellow} stroke={colors.panel} strokeWidth={1.5} />
					) : null}
				</Svg>
			</Pressable>
			<BottomDrawer visible={open} onClose={close} onAfterClose={() => setDetailId(undefined)} accessibilityLabel="セッションの状態と裏で動いているもの">
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
					<Text style={styles.headTitle} accessibilityRole="header" numberOfLines={1}>{detail !== undefined ? 'シェル' : 'セッション'}</Text>
					<View style={styles.nav} />
				</View>
				{detail !== undefined && terminalKey !== undefined ? (
					<ShellDetail terminalKey={terminalKey} shell={detail} access={shellsAccess} now={now} visible={open} />
				) : (
					<>
						<Text style={[monitorStyles.section, styles.firstSection]}>このセッション</Text>
						<SessionSection status={status} working={working} now={now} open={open} onNavigate={close} />
						<Text style={monitorStyles.section}>動いているもの</Text>
						<RunningSection terminalKey={terminalKey} monitors={monitors} shells={shells} shellsAccess={shellsAccess} tab={tab} onTab={setTab} now={now} open={open} onOpenShell={id => { haptic('move'); setDetailId(id); }} />
					</>
				)}
			</BottomDrawer>
		</>
	);
}

/**
 * 描き直しの時計。シートを開いている間は毎秒、閉じている間は輪の見た目が変わる時刻（キャッシュが間際になる・切れる）に
 * 1 回だけ進める。
 */
function useSessionClock(status: AgentSessionStatus | undefined, working: boolean, open: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	const nextChange = open ? undefined : nextSessionRingChange(status, now, working);
	useEffect(() => {
		setNow(Date.now());
		if (open) {
			const timer = setInterval(() => setNow(Date.now()), 1_000);
			return () => clearInterval(timer);
		}
		return undefined;
	}, [open, status, working]);
	useEffect(() => {
		if (nextChange === undefined) {
			return undefined;
		}
		const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextChange - Date.now()) + 50);
		return () => clearTimeout(timer);
	}, [nextChange]);
	return now;
}

/** 「このセッション」の節（キャッシュの残り時間・hit / miss・コンテキスト・PR）。取れない行も消さずに理由を灰色で出す。 */
function SessionSection({ status, working, now, open, onNavigate }: { status: AgentSessionStatus | undefined; working: boolean; now: number; open: boolean; onNavigate: () => void }) {
	const router = useRouter();
	const space = useCodeSpace();
	// PR は開いている間だけ取りに行く（スペースのソース管理と同じ経路。SSH のスペースは接続先の gh で調べる）
	const pullRequest = usePullRequest(space, open);
	const pr = pullRequestValue(pullRequest.view, pullRequest.enabled, pullRequest.error);
	const { pcId, spaceId } = space;
	const openPullRequest = pullRequest.view?.kind === 'pr' && pcId !== undefined && spaceId !== undefined
		? () => {
			const href = routes.sourceControl(pcId, spaceId);
			haptic('move');
			onNavigate();
			router.push(href);
		}
		: undefined;
	return (
		<View style={monitorStyles.group}>
			<SheetRow label={cacheRowLabel(status)} value={cacheTimeValue(cacheTimeState(status, now, working))} />
			<SheetRow divider label="hit / miss" value={hitMissValue(status)} />
			<SheetRow divider label="コンテキスト" value={contextValue(status)} />
			<SheetRow divider label="プルリクエスト" value={pr} onPress={openPullRequest} />
		</View>
	);
}

/** 「動いているもの」の節（今の「裏で動いているもの」のシートと同じ一覧）。 */
function RunningSection({ terminalKey, monitors, shells, shellsAccess, tab, onTab, now, open, onOpenShell }: {
	terminalKey: string | undefined;
	monitors: readonly AgentMonitor[] | undefined;
	shells: readonly AgentShell[] | undefined;
	shellsAccess: AgentShellsAccess | undefined;
	tab: BackgroundTab;
	onTab: (tab: BackgroundTab) => void;
	now: number;
	open: boolean;
	onOpenShell: (id: string) => void;
}) {
	const hasShells = (shells ?? []).length > 0;
	const hasMonitors = (monitors ?? []).length > 0;
	if (!hasShells && !hasMonitors) {
		return <Text style={monitorStyles.caption}>裏で動いているものはありません</Text>;
	}
	const both = hasShells && hasMonitors;
	const shownTab: BackgroundTab = both ? tab : hasShells ? 'shells' : 'monitors';
	return (
		<>
			{both ? (
				<SegmentSwitch
					value={shownTab}
					options={[{ value: 'shells', label: `シェル ${shells?.length ?? 0}` }, { value: 'monitors', label: `Monitor ${monitors?.length ?? 0}` }]}
					onChange={onTab}
				/>
			) : null}
			{shownTab === 'shells'
				? <ShellList terminalKey={terminalKey} shells={shells} access={shellsAccess} now={now} visible={open} onOpen={onOpenShell} />
				: <MonitorListContent monitors={monitors} now={now} />}
		</>
	);
}

function SheetRow({ label, value, divider = false, onPress }: { label: string; value: SessionSheetValue; divider?: boolean; onPress?: (() => void) | undefined }) {
	const color = value.tone === 'danger' ? colors.red : value.tone === 'warn' ? colors.yellow : value.dim === true ? colors.textMuted : colors.text;
	const body = (
		<>
			<Text style={styles.rowLabel} numberOfLines={1}>{label}</Text>
			<Text style={[styles.rowValue, { color }]} numberOfLines={2}>{value.text}</Text>
			{onPress !== undefined ? <Icon icon={ChevronRight} size={iconSize.sm} color={colors.textMuted} /> : null}
		</>
	);
	return onPress !== undefined ? (
		<Pressable
			style={({ pressed }) => [styles.row, divider ? monitorStyles.rowDivider : undefined, pressed ? styles.pressed : undefined]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={`${label}、${value.text}。押すとソース管理を開きます`}
		>
			{body}
		</Pressable>
	) : (
		<View style={[styles.row, divider ? monitorStyles.rowDivider : undefined]} accessible accessibilityLabel={`${label}、${value.text}`}>
			{body}
		</View>
	);
}

const styles = StyleSheet.create({
	ring: {
		width: RING_SIZE,
		height: RING_SIZE,
		flexShrink: 0,
		alignItems: 'center',
		justifyContent: 'center',
	},
	pressed: {
		opacity: 0.7,
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
	firstSection: {
		marginTop: 0,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.md,
		minHeight: 44,
		paddingHorizontal: 14,
		paddingVertical: space.sm,
	},
	rowLabel: {
		flexShrink: 0,
		maxWidth: 140,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	rowValue: {
		flex: 1,
		minWidth: 0,
		textAlign: 'right',
		fontSize: type.body,
		fontVariant: ['tabular-nums'],
	},
});
