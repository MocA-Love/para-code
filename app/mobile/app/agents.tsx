// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CircleCheck } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, usePcAgentSources, type PcAgentSource } from '../src/appState.js';
import { Segments } from '../src/features/code/codeParts.js';
import {
	AGENTS_ACROSS_STATES, agentsAcrossStateLabel, createAgentsAcrossBuilder, idleHeaderLabel, parseAgentsAcrossState, unconnectedNote,
	type AgentsAcrossLiveSection, type AgentsAcrossState, type AgentsAcrossUnconnectedSection,
} from '../src/features/home/agentsAcrossPcs.js';
import { useLastSession } from '../src/features/home/lastSessionStore.js';
import { AgentListRow, RowSeparator } from '../src/features/pc/agentListRow.js';
import { openSession } from '../src/features/pc/openSession.js';
import { spaceColor } from '../src/features/pc/spaceColor.js';
import { startStatusSinceTracking } from '../src/features/pc/statusSinceStore.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useContentColumnStyle } from '../src/ipad/useContentColumn.js';
import { firstParam, routes } from '../src/routes.js';
import { alpha, colors, radius, space, type } from '../src/theme.js';
import { useNow } from '../src/time.js';
import { EmptyState, Screen, ScreenHeader, connectionColor } from '../src/ui/index.js';

// 行の経過時間の元（状態が変わった時刻）を見張る（ホーム・PC の画面と同じ。何度呼んでも1回だけ）。
startStatusSinceTracking();

type SourceTerminal = PcAgentSource['terminals'][number];

/**
 * 全 PC 横断のエージェントの一覧（`/agents?state=waiting|running`）。ホームの「要対応」「実行中」のカードを
 * 押した先で、上の切り替えで要対応と実行中を行き来する。
 *
 * 段は PC ごと（見ている PC が先頭）。行は PC の画面と同じ部品（`AgentListRow`）で、押すとそのセッションを開く
 * （別の PC なら、ルートの画面がその PC に切り替えてから開く。`openSession`）。つながっていない PC は段の見出しを
 * 薄く出し、前回の一覧の件数を添える。組み立ては `agentsAcrossPcs.ts` の純関数。
 *
 * iPad の広い幅でも全面のスタック（2列になるのは `/pc/[pcId]/…` だけ）。本文は `useContentColumnStyle()` の列に収める。
 * 要対応 ⇄ 実行中の切り替えは同じ一覧の中身の入れ替えで、ツリーの形は変えない。
 */
export default function AgentsScreen() {
	const params = useLocalSearchParams<{ state?: string | string[] }>();
	const [state, setState] = useState<AgentsAcrossState>(() => parseAgentsAcrossState(firstParam(params.state)));
	// 同じ画面のままクエリだけ変わったとき（ホームへ戻らずに別のカードから開き直したとき）も合わせる。
	const requested = firstParam(params.state);
	useEffect(() => {
		setState(parseAgentsAcrossState(requested));
	}, [requested]);
	const { pcs, activePcId } = useAppStore(useShallow(s => ({ pcs: s.pcs, activePcId: s.activePcId })));
	const sources = usePcAgentSources(s => s.byPc);
	const lastSession = useLastSession(s => s.value);
	const now = useNow();
	const insets = useStableInsets();
	const column = useContentColumnStyle();

	// 段は PC ごとに使い回す（変わっていない PC の段は同じオブジェクトになり、LiveSection の memo が効く）。
	const build = useMemo(() => createAgentsAcrossBuilder<SourceTerminal>(), []);
	const list = useMemo(() => build({ pcs, sources, activePcId, state }), [build, pcs, sources, activePcId, state]);
	const hasRows = list.sections.some(section => section.kind === 'live');
	const segments = AGENTS_ACROSS_STATES.map(key => ({ key, label: `${agentsAcrossStateLabel(key)} ${list.counts[key]}` }));

	return (
		<Screen>
			<ScreenHeader title="エージェント" variant="settings" surface="panel">
				{/* iPad の広い幅では、切り替えも本文と同じ列の幅に収める（iPhone では column は undefined）。 */}
				<View style={column}>
					<Segments items={segments} value={state} onChange={setState} />
				</View>
			</ScreenHeader>
			<ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xl + space.lg }, column]}>
				{hasRows ? null : (
					<EmptyState
						icon={CircleCheck}
						title={state === 'waiting' ? '要対応のエージェントはいません' : '実行中のエージェントはいません'}
						body={state === 'waiting' ? 'つながっている PC で、許可や質問の答えを待っているエージェントはありません。' : 'つながっている PC で、いま作業しているエージェントはありません。'}
						style={styles.empty}
					/>
				)}
				{list.sections.map(section => (section.kind === 'live' ? (
					<LiveSection
						key={section.pcId}
						section={section}
						currentKey={lastSession?.pcId === section.pcId ? lastSession.terminalKey : undefined}
						now={now}
					/>
				) : (
					<UnconnectedSection key={section.pcId} section={section} state={state} now={now} />
				)))}
			</ScrollView>
		</Screen>
	);
}

/** つながっている PC の段（見出しと行）。 */
const LiveSection = memo(function LiveSection({ section, currentKey, now }: {
	section: AgentsAcrossLiveSection<SourceTerminal>;
	currentKey: string | undefined;
	now: number;
}) {
	const router = useRouter();
	const { pcId } = section;
	const open = (terminalKey: string) => {
		const row = section.rows.find(candidate => candidate.terminal.terminalKey === terminalKey);
		if (row === undefined) {
			return;
		}
		const owner = row.space;
		if (owner === undefined) {
			// スペースが解決できない（届いていない）間は、その PC の画面を開く。
			router.push(routes.pc(pcId));
			return;
		}
		openSession(router, {
			pcId,
			spaceId: owner.id,
			spaceName: owner.name,
			color: spaceColor(owner),
			terminalKey,
			title: row.terminal.title,
			...(owner.branch !== undefined ? { branch: owner.branch } : {}),
		});
	};
	// 行は memo で止めるので、渡す関数の参照は固定する（中身は最新の段を見る）。
	const openRef = useRef(open);
	openRef.current = open;
	const onOpen = useCallback((terminalKey: string) => openRef.current(terminalKey), []);
	return (
		<View>
			<View style={styles.header} accessible accessibilityRole="header" accessibilityLabel={`${section.name} ${section.rows.length}件`}>
				<View style={[styles.dot, { backgroundColor: connectionColor('connected') }]} />
				<Text style={styles.headerTitle} numberOfLines={1}>{section.name}</Text>
				<Text style={styles.headerCount}>{section.rows.length}</Text>
			</View>
			{section.rows.map((row, index) => (
				<Fragment key={row.terminal.terminalKey}>
					{index > 0 ? <RowSeparator /> : null}
					<AgentListRow
						terminalKey={row.terminal.terminalKey}
						title={row.terminal.title}
						agent={row.terminal.agent === true}
						agentStatus={row.terminal.agentStatus}
						spaceName={row.space?.name}
						spaceColor={row.space !== undefined ? spaceColor(row.space) : spaceColor({ id: row.terminal.terminalKey })}
						branch={row.space?.branch}
						hideSpace={false}
						pinned={false}
						current={row.terminal.terminalKey === currentKey}
						now={now}
						onOpen={onOpen}
						otherPc={!section.active}
					/>
				</Fragment>
			))}
		</View>
	);
});

/** 行を出せない PC の段（薄い見出しと、理由・前回の件数の1文）。 */
function UnconnectedSection({ section, state, now }: { section: AgentsAcrossUnconnectedSection; state: AgentsAcrossState; now: number }) {
	const note = unconnectedNote(section, state, now);
	const label = idleHeaderLabel(section);
	return (
		<View style={styles.faded} accessible accessibilityLabel={`${section.name}、${label}。${note}`}>
			<View style={styles.header}>
				<View style={[styles.dot, { backgroundColor: connectionColor(section.reason === 'connecting' ? 'connecting' : section.reason === 'loading' ? 'connected' : 'offline') }]} />
				<Text style={styles.headerTitle} numberOfLines={1}>{section.name}</Text>
				<Text style={styles.headerCount} numberOfLines={1}>{label}</Text>
			</View>
			<Text style={styles.note}>{note}</Text>
		</View>
	);
}

const DOT_SIZE = 6;

const styles = StyleSheet.create({
	body: {
		paddingTop: space.xs,
	},
	empty: {
		paddingVertical: space.xl * 2,
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs + 2,
		paddingTop: space.md,
		paddingBottom: space.xs,
		paddingHorizontal: space.lg,
	},
	dot: {
		width: DOT_SIZE,
		height: DOT_SIZE,
		borderRadius: radius.pill,
	},
	headerTitle: {
		flexShrink: 1,
		fontSize: type.caption,
		fontWeight: '600',
		letterSpacing: 0.5,
		color: colors.textDim,
	},
	headerCount: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	faded: {
		opacity: alpha.strong,
	},
	note: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
		paddingHorizontal: space.lg,
		paddingBottom: space.sm,
	},
});
