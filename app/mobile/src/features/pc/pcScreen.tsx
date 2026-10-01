// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Fragment, useCallback, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useIsFocused, useNavigation, useRouter } from 'expo-router';
import { Layers, SlidersHorizontal } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../appState.js';
import { unreadQuestionNotificationCount } from '../../components/notificationCount.js';
import { batteryLine, pcConnectionLine } from '../home/homeSummary.js';
import { useLastSession } from '../home/lastSessionStore.js';
import { LaunchDrawer, type LaunchPreset } from '../launch/launchDrawer.js';
import { AgentListRow, EmptySpaceRow, RowSeparator } from './agentListRow.js';
import { ArchiveDrawer } from './archiveDrawer.js';
import { LastKnownPcList } from './lastKnownPcList.js';
import { FilterDrawer } from './filterDrawer.js';
import { openSession } from './openSession.js';
import { usePcRouteId } from './pcRouteContext.js';
import { FilterChip, ModeButton, PcHeader, PcSearchBar, ToolbarRight } from './pcHeader.js';
import {
	EMPTY_PC_LIST_FILTER,
	PC_LIST_GROUP_OPTIONS,
	PC_LIST_SORT_OPTIONS,
	archivedTerminals,
	buildPcList,
	filterCount,
	kindLabel,
	groupShortLabel,
	resolveTerminalSpace,
	sortShortLabel,
	withSort,
	type PcListFilter,
	type PcListGroup,
} from './pcList.js';
import { EMPTY_PC_LIST_VIEW_OF_PC, effectivePcListFilter, pcListViewOf } from './pcListView.js';
import { EMPTY_PC_LIST_TRANSIENT, ensurePcListViewLoaded, usePcListView } from './pcListViewStore.js';
import { FAB_SIZE, LaunchFab, PcOfflineState, PcUpdateRequiredState, SectionToggle } from './pcListParts.js';
import { RowActions, type RowActionTarget } from './rowActions.js';
import { spaceColor } from './spaceColor.js';
import { startStatusSinceTracking } from './statusSinceStore.js';
import type { HomeSortKey } from '../../homeSort.js';
import { hapticSelection } from '../../haptics.js';
import { useRoutePc } from '../../hooks/useRouteTargets.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../ipad/useContentColumn.js';
import { useShortcutSlot } from '../../ipad/shortcutRegistry.js';
import { stepKey } from '../../ipad/shortcuts.js';
import { useParaToast } from '../../paraToast.js';
import { isPairingRejected, shouldShowBattery } from '../../pcStatus.js';
import { QueuedSendsBanner } from '../session/queuedSends.js';
import { routes } from '../../routes.js';
import type { WorkspaceState } from '../../store.js';
import { space } from '../../theme.js';
import { formatRelativeTime, useNow } from '../../time.js';
import { EmptyState, PickerDrawer, Screen, connectionKind } from '../../ui/index.js';

// 行の経過時間の元（状態が変わった時刻）を早めに見張り始める（ホームと同じ。何度呼んでも1回だけ）。
startStatusSinceTracking();
// 一覧の表示条件（絞り込み・グループ・畳んだ段）の保存値を早めに読んでおく（何度呼んでも1回だけ）。
ensurePcListViewLoaded();

type Terminal = WorkspaceState['terminals'][number];
type Space = WorkspaceState['workspaces'][number];

const NO_TERMINALS: Terminal[] = [];
const NO_SPACES: Space[] = [];

type Sheet = 'filter' | 'sort' | 'group' | 'archive' | 'launch';

/**
 * PC の画面（`/pc/[pcId]`。Orca の host-screen、モックの「PC の画面（スペース一覧）」）。
 *
 *  - 2段のヘッダー: 戻る・状態の点と PC 名・再接続 ／ 絞り込み・並び順・グループ・アーカイブ・使用量・通知・検索
 *  - 一覧: 既定はスペースごとの段で、段の中は「エージェントの状態」順（要対応 → 実行中 → 未確認 → 待機）。
 *    行を押すとそのセッション、長押しと ⋯ で操作のシート。**要対応にはここでは答えない**（押すとセッションへ）
 *  - 右下の白い ＋ でエージェントを起動
 *  - つながっていない PC は「デスクトップに届きません」と再接続
 *
 * 一覧の組み立て（絞り込み・並び・グループ）は `src/features/pc/pcList.ts` の純関数。
 *
 * 置き場所は2つ（`placement`）:
 *  - `page`: 1列（iPhone、狭い iPad）。詳細の列の根（`app/pc/[pcId]/index.tsx`）に全面で出し、行を押すと押し進む
 *  - `column`: iPad の2列の左の列（`app/pc/[pcId]/_layout.tsx`）。行を押すと右の列の中身を入れ替える
 */
export function PcScreen({ placement, onCollapse }: {
	placement: 'page' | 'column';
	/** 渡すと見出しに「サイドバーを隠す」を出す（2列でセッションを開いているとき）。 */
	onCollapse?: () => void;
}) {
	const router = useRouter();
	// 左の列（`column`）はルートの Stack の画面（`pc/[pcId]`）の中にあるので、ここでの navigation は PC の画面ごと
	// 閉じる向きになる。1列（`page`）では詳細の列の根なので、戻ると親（ルートの Stack）へ伝わって同じく閉じる。
	// `router.back()` を使わないのは、2列で右にセッションが開いていると、そちらを閉じてしまうため。
	const navigation = useNavigation();
	const focused = useIsFocused();
	const insets = useStableInsets();
	const column = useContentColumnStyle();
	const now = useNow();
	const { pcId, pc, status } = useRoutePc(usePcRouteId());
	const active = status === 'active';
	// **`s.workspace` 本体は購読しない**（PC からの再送のたびに作り直される）。必要な部分だけを選ぶ。
	const terminals = useAppStore(s => (active ? s.workspace?.terminals ?? NO_TERMINALS : NO_TERMINALS));
	const spaces = useAppStore(s => (active ? s.workspace?.workspaces ?? NO_SPACES : NO_SPACES));
	const activeWs = useAppStore(s => (active ? s.workspace?.activeWs : undefined));
	const loaded = useAppStore(s => active && s.workspace !== undefined);
	const { archivedKeys, pinnedKeys, preferences, setPreferences, notifications, setArchived, connectRelay } = useAppStore(useShallow(s => ({
		archivedKeys: s.archivedKeys, pinnedKeys: s.pinnedKeys, preferences: s.homePreferences, setPreferences: s.setHomePreferences,
		notifications: s.notifications, setArchived: s.setArchived, connectRelay: s.connectRelay,
	})));
	const lastTerminalKey = useLastSession(s => (s.value?.pcId === pcId ? s.value?.terminalKey : undefined));
	const toast = useParaToast(s => s.show);

	// 一覧の表示条件は画面の外（`pcListViewStore.ts`）に置く。アプリを終了しても残し、iPad の2列 ⇄ 1列で
	// この画面が作り直されても消さないため。
	const group = usePcListView(s => s.saved.group);
	const view = usePcListView(s => (pcId !== undefined ? pcListViewOf(s.saved, pcId) : EMPTY_PC_LIST_VIEW_OF_PC));
	const { query, searching } = usePcListView(s => (pcId !== undefined ? s.transient[pcId] : undefined) ?? EMPTY_PC_LIST_TRANSIENT);
	const { setGroup, setListFilter, setListQuery, setListSearching, toggleListSection } = usePcListView(useShallow(s => ({
		setGroup: s.setGroup, setListFilter: s.setFilter, setListQuery: s.setQuery, setListSearching: s.setSearching, toggleListSection: s.toggleSection,
	})));
	const filter = effectivePcListFilter(view, query, spaces.map(candidate => candidate.id));
	const collapsed = new Set(view.collapsed);
	const setFilter = (next: Pick<PcListFilter, 'kind' | 'states' | 'spaces'>) => {
		if (pcId !== undefined) {
			setListFilter(pcId, next);
		}
	};
	const [sheet, setSheet] = useState<Sheet | undefined>(undefined);
	const [menuKey, setMenuKey] = useState<string | undefined>(undefined);
	// 検索欄をこの画面で開いたか（開いたときだけ入力欄に合わせる。作り直しで開いたままのときは合わせない）。
	const [openedSearchHere, setOpenedSearchHere] = useState(false);

	const kind = pc !== undefined ? connectionKind(pc.connection, pc.pcOnline) : 'offline';
	// 資格を拒まれた PC は、1〜15分おきの確認の間だけ「接続しています…」になる。そこで一覧や
	// 読み込み中の表示へ揺れないよう、繋がるまでは再ペアリングの案内に固定する。
	const rejected = pc !== undefined && isPairingRejected(pc);
	// 版が合わない PC（W2-17）。再接続しても直らないので、どちらを更新するかの案内に固定する。
	const updateRequired = pc?.updateRequired;
	// 一時的に再接続している間は一覧を消さない（行が点滅すると押し間違える）。
	const showList = active && loaded && !rejected && updateRequired === undefined && (kind === 'connected' || kind === 'connecting');
	const sections = buildPcList({ terminals, spaces, activeWs, archivedKeys, pinnedKeys, preferences, group, filter });
	const archived = archivedTerminals(terminals, archivedKeys);
	const unread = unreadQuestionNotificationCount(notifications);
	const detail = [
		pcConnectionLine(kind, pc?.lastOnlineAt, now, rejected, updateRequired),
		pc !== undefined && shouldShowBattery(pc) && pc.battery !== undefined ? batteryLine(pc.battery) : undefined,
	].filter((part): part is string => part !== undefined).join(' · ');

	const spaceOf = (terminal: Terminal) => resolveTerminalSpace(terminal, spaces, activeWs);
	const openTerminal = (terminalKey: string) => {
		const terminal = terminals.find(candidate => candidate.terminalKey === terminalKey);
		const owner = terminal !== undefined ? spaceOf(terminal) : undefined;
		if (pcId === undefined || terminal === undefined || owner === undefined) {
			return;
		}
		openSession(router, {
			pcId,
			spaceId: owner.id,
			spaceName: owner.name,
			color: spaceColor(owner),
			terminalKey,
			title: terminal.title,
			...(owner.branch !== undefined ? { branch: owner.branch } : {}),
		});
	};
	// 行は memo で止めるので、渡す関数の参照は固定する（中身は最新の一覧を見る）。
	const openTerminalRef = useRef(openTerminal);
	openTerminalRef.current = openTerminal;
	const onOpenRow = useCallback((terminalKey: string) => openTerminalRef.current(terminalKey), []);
	const openSpace = (target: Space) => {
		if (pcId === undefined) {
			return;
		}
		openSession(router, { pcId, spaceId: target.id, spaceName: target.name, color: spaceColor(target), ...(target.branch !== undefined ? { branch: target.branch } : {}) });
	};
	const reconnect = () => {
		hapticSelection();
		connectRelay();
		toast({ key: 'pc-reconnect', text: `${pc?.name ?? 'PC'} に再接続しています…`, icon: 'refresh-outline', tone: 'info' }, 2_500);
	};
	const toggleSection = (key: string) => {
		if (pcId !== undefined) {
			toggleListSection(pcId, key);
		}
	};

	const menuTerminal = menuKey !== undefined ? terminals.find(candidate => candidate.terminalKey === menuKey) : undefined;
	const menuSpace = menuTerminal !== undefined ? spaceOf(menuTerminal) : undefined;
	const menuTarget: RowActionTarget | undefined = menuTerminal !== undefined ? {
		terminalKey: menuTerminal.terminalKey,
		title: menuTerminal.title,
		agent: menuTerminal.agent === true,
		agentStatus: menuTerminal.agentStatus,
		pinned: pinnedKeys.has(menuTerminal.terminalKey),
		spaceId: menuSpace?.id,
		spaceName: menuSpace?.name,
		branch: menuSpace?.branch,
	} : undefined;
	// 絞り込みでスペースを1つだけ選んでいれば、そこへ起動する形でシートを開く。
	const onlySpace = filter.spaces.length === 1 ? filter.spaces[0] : undefined;
	const launchPreset: LaunchPreset | undefined = onlySpace !== undefined ? { kind: 'space', spaceId: onlySpace } : undefined;

	// 外付けキーボード: ⌥⌘↑↓ で一覧の前後のエージェントを開く、⌘N で起動のシート。
	const orderedKeys = sections.flatMap(section => (collapsed.has(section.key) ? [] : section.rows.map(row => row.terminal.terminalKey)));
	const canLaunch = showList && kind === 'connected';
	useShortcutSlot('list', focused && showList ? {
		stepAgent: delta => {
			const next = stepKey(orderedKeys, lastTerminalKey, delta);
			if (next !== undefined) {
				openTerminal(next);
			}
		},
	} : undefined);
	useShortcutSlot('launch', focused && canLaunch ? { launch: () => setSheet('launch') } : undefined);
	const leave = () => {
		if (navigation.canGoBack()) {
			navigation.goBack();
		} else {
			router.replace('/');
		}
	};

	const renderBody = () => {
		if (status === 'unknown') {
			return <EmptyState title="この PC は見つかりません" body="ペアリングを解除した PC かもしれません。" />;
		}
		if (!showList) {
			if (updateRequired !== undefined) {
				return <PcUpdateRequiredState name={pc?.name ?? 'PC'} target={updateRequired} onRecheck={reconnect} />;
			}
			const connectingNow = kind === 'connecting' || status === 'inactive' || (active && !loaded && kind === 'connected');
			// 前回の一覧があれば、つながるまでそれを読み取り専用で出す（W2-25）。資格を拒まれた PC には出さない。
			if (!rejected && pc?.lastKnown !== undefined) {
				return <LastKnownPcList snapshot={pc.lastKnown} now={now} connecting={connectingNow} onReconnect={reconnect} />;
			}
			if (!rejected && connectingNow) {
				return <EmptyState title="接続しています…" body={`${pc?.name ?? 'PC'} の状態を読み込んでいます。`} />;
			}
			return (
				<PcOfflineState
					name={pc?.name ?? 'PC'}
					lastOnline={pc?.lastOnlineAt !== undefined ? formatRelativeTime(pc.lastOnlineAt, now) : undefined}
					onReconnect={reconnect}
					pairingRejected={rejected}
					onRepair={() => { hapticSelection(); router.push(routes.pair()); }}
				/>
			);
		}
		if (spaces.length === 0 && terminals.length === 0) {
			return <EmptyState title="スペースはまだありません" body="PC の Para Code でフォルダやリポジトリを開くと、ここに表示されます。右下の ＋ から新しいスペースも作れます。" />;
		}
		if (sections.length === 0) {
			return (
				<EmptyState
					title="該当するエージェントがありません"
					body="検索語や絞り込みを変えてください。"
					action={{
						label: '絞り込みをクリア',
						onPress: () => {
							setFilter(EMPTY_PC_LIST_FILTER);
							if (pcId !== undefined) {
								setListQuery(pcId, '');
							}
						},
					}}
				/>
			);
		}
		return (
			<ScrollView
				contentContainerStyle={[{ paddingBottom: insets.bottom + space.xl + FAB_SIZE + space.lg }, column]}
				keyboardShouldPersistTaps="handled"
				keyboardDismissMode="on-drag"
			>
				{sections.map(section => {
					const isCollapsed = collapsed.has(section.key);
					const hideSpace = section.kind === 'space';
					return (
						<View key={section.key}>
							{section.title !== undefined ? (
								<SectionToggle
									title={section.title}
									count={section.rows.length}
									collapsed={isCollapsed}
									onToggle={() => toggleSection(section.key)}
									{...(section.kind === 'pinned' ? { icon: 'pin' as const } : {})}
									{...(section.space !== undefined ? { icon: 'folder' as const, iconColor: spaceColor(section.space) } : {})}
									{...(section.bucket !== undefined ? { bucket: section.bucket } : {})}
								/>
							) : null}
							{isCollapsed ? null : section.emptySpace === true && section.space !== undefined ? (
								<EmptySpaceRow onPress={() => { const target = spaces.find(candidate => candidate.id === section.space?.id); if (target !== undefined) { openSpace(target); } }} />
							) : section.rows.map((row, index) => (
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
										hideSpace={hideSpace}
										pinned={row.pinned}
										current={row.terminal.terminalKey === lastTerminalKey}
										now={now}
										onOpen={onOpenRow}
										onMenu={setMenuKey}
									/>
								</Fragment>
							))}
						</View>
					);
				})}
			</ScrollView>
		);
	};

	return (
		<Screen>
			<PcHeader
				name={pc?.name ?? 'PC'}
				kind={kind}
				detail={detail}
				{...(kind !== 'connected' && status !== 'unknown' && !rejected ? { onReconnect: reconnect } : {})}
				pairingRejected={rejected}
				onBack={leave}
				{...(placement === 'column' && onCollapse !== undefined ? { onCollapse } : {})}
				toolbar={(
					<>
						<FilterChip count={filterCount(filter)} kind={kindLabel(filter.kind)} onPress={() => { hapticSelection(); setSheet('filter'); }} />
						<ModeButton kind="sort" label={sortShortLabel(preferences.sort)} onPress={() => { hapticSelection(); setSheet('sort'); }} />
						<ModeButton kind="group" label={groupShortLabel(group)} onPress={() => { hapticSelection(); setSheet('group'); }} />
						<ToolbarRight
							archivedCount={archived.length}
							unread={unread}
							searching={searching}
							usageDisabled={kind !== 'connected'}
							onArchive={() => { hapticSelection(); setSheet('archive'); }}
							onUsage={() => { hapticSelection(); router.push(routes.settings('usage')); }}
							onNotifications={() => { hapticSelection(); router.push(routes.notifications()); }}
							onToggleSearch={() => {
								hapticSelection();
								if (pcId !== undefined) {
									setOpenedSearchHere(!searching);
									setListSearching(pcId, !searching);
								}
							}}
						/>
					</>
				)}
				{...(searching ? { search: <PcSearchBar value={query} onChange={next => { if (pcId !== undefined) { setListQuery(pcId, next); } }} autoFocus={openedSearchHere} /> } : {})}
			/>
			{/* PC に届かない間に預かったエージェントへの送信（W2-29）。確かめが要るものもここから開ける */}
			<QueuedSendsBanner pcId={pcId} />
			<View style={styles.body}>{renderBody()}</View>
			<LaunchFab disabled={!canLaunch} onPress={() => setSheet('launch')} />
			<FilterDrawer
				visible={sheet === 'filter'}
				filter={filter}
				spaces={spaces}
				onChange={setFilter}
				onClose={() => setSheet(undefined)}
			/>
			<PickerDrawer<HomeSortKey>
				visible={sheet === 'sort'}
				title="並び順"
				options={PC_LIST_SORT_OPTIONS.map(option => ({ value: option.value, label: option.label, hint: option.hint, icon: SlidersHorizontal }))}
				selected={preferences.sort}
				onSelect={value => setPreferences(withSort(preferences, value))}
				onClose={() => setSheet(undefined)}
			/>
			<PickerDrawer<PcListGroup>
				visible={sheet === 'group'}
				title="グループ"
				options={PC_LIST_GROUP_OPTIONS.map(option => ({ value: option.value, label: option.label, icon: Layers }))}
				selected={group}
				onSelect={setGroup}
				onClose={() => setSheet(undefined)}
			/>
			<ArchiveDrawer
				visible={sheet === 'archive'}
				rows={archived.map(terminal => {
					const owner = spaceOf(terminal);
					return { terminalKey: terminal.terminalKey, title: terminal.title, agentStatus: terminal.agentStatus, spaceName: owner?.name, branch: owner?.branch };
				})}
				onRestore={key => setArchived(key, false)}
				onOpen={openTerminal}
				onClose={() => setSheet(undefined)}
			/>
			<LaunchDrawer visible={sheet === 'launch'} {...(launchPreset !== undefined ? { preset: launchPreset } : {})} onClose={() => setSheet(undefined)} />
			<RowActions pcId={pcId} target={menuTarget} onClose={() => setMenuKey(undefined)} />
		</Screen>
	);
}

const styles = StyleSheet.create({
	body: {
		flex: 1,
	},
});
