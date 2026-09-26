// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIsFocused, useRouter } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
// 一覧のScrollViewはRNGH版を使う。RN版は子孫へのタッチ配送を遅らせるため、行に付けた
// スワイプが指の動き出しを取りこぼして反応しない（祖先側のドロワーだけが効く状態になる）。
import { GestureDetector, ScrollView } from 'react-native-gesture-handler';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting, pinKeyForTerminal } from '../../src/store.js';
import { countAttentionAgents, isAttentionAgent } from '../../src/attentionCount.js';
import { ConnectionGate, PairingRequiredNotice } from '../../src/components/connectionGate.js';
import { VoiceNotificationControl } from '../../src/components/voiceNotificationControl.js';
import { useWsHeader, useEffectiveWs, useOpenDrawerPan, wsColor } from '../../src/components/wsDrawer.js';
import { AttentionStack, type AttentionStackItem } from '../../src/components/attentionStack.js';
import {
	ATTENTION_VISIBLE_LIMIT, CLOSED_ATTENTION, reconcileAttention, sortWaiting, toggleAttention, visibleWaiting,
	type AttentionOpenState,
} from '../../src/components/attentionStackBehavior.js';
import { HomeAgentActionsMenu, type HomeAgentMenuTarget } from '../../src/components/homeAgentActionsMenu.js';
import { type AgentRowData, type AgentRowRect } from '../../src/components/agentRow.js';
import { HomeAgentRow, type HomeAgentRowHandlers } from '../../src/components/homeAgentRow.js';
import { closeOpenedSwipeRow } from '../../src/components/swipeRow.js';
import { AgentStatusPopover, type AgentStatusPopoverTarget } from '../../src/components/agentStatusPopover.js';
import { GlassSurface } from '../../src/components/glassSurface.js';
import { useParaHeaderHeight } from '../../src/paraHeader.js';
import { useAgentActions, useAgentChatSubscription } from '../../src/hooks/useAgentActions.js';
import { useIsRegularWidth } from '../../src/hooks/useSizeClass.js';
import { useTabBarSpacer } from '../../src/hooks/useTabBarSpacer.js';
import { Ionicons } from '@expo/vector-icons';
import { HIT_SIZE, colors, radius, space, squircle, status, type } from '../../src/theme.js';
import { SectionHeader } from '../../src/components/sectionHeader.js';
import { EmptyState } from '../../src/components/emptyState.js';
import { hapticImpact, hapticSelection } from '../../src/haptics.js';
import { createAgentLatestEntryToken } from '../../src/agentNavigation.js';
import { arrangeHomeRows, groupRowsByStatus, idleSectionView, type HomeStatusSection } from '../../src/homeSort.js';
import { HomeSortSheet } from '../../src/components/homeListControls.js';
import { HOME_CREATE_FAB_SIZE, HomeCreateFab } from '../../src/components/homePlusMenu.js';
import {
	dispatchHomeHeaderMenuAction,
	homeHeaderLayout,
	type HomeHeaderMenuAction,
	type HomePlusMenuAction,
} from '../../src/components/homeHeaderMenuBehavior.js';
import { useHomeHeaderActions } from '../../src/components/homeHeaderActions.js';
import { WorktreeCreateSheet } from '../../src/components/worktreeCreateSheet.js';
import { listColumnsFor } from '../../src/ipad/ipadLayout.js';

/**
 * エージェント行の並べ方。1列のときは行をそのまま返し（iPhoneと同じツリー）、
 * iPadの広い幅で2列に入るときだけ折り返しのグリッドで包む。
 */
function renderAgentRows(nodes: readonly ReactElement[], columns: 1 | 2) {
	if (columns === 1) {
		return nodes;
	}
	return (
		<View style={styles.grid}>
			{nodes.map(node => <View key={node.key} style={styles.gridCell}>{node}</View>)}
		</View>
	);
}

/** ステータス順の一覧の段の見出し（呼び名は theme.status に揃える）。 */
const SECTION_LABEL: Record<HomeStatusSection<unknown>['key'], string> = {
	working: status.running.label,
	review: status.review.label,
	idle: status.idle.label,
};

/** アーカイブの取り消しバーを出しておく時間。読んでから指を運ぶ余裕を取る。 */
const UNDO_ARCHIVE_MS = 6_000;

/**
 * 押すと段を開閉する見出し（既定で畳む「待機」に使う）。見出しの書式は `SectionHeader` のまま、
 * 当たり判定だけ44pt以上にする。
 */
function CollapsibleSectionHeader({ title, count, first, open, onToggle }: {
	title: string;
	count: number;
	first: boolean;
	open: boolean;
	onToggle: () => void;
}) {
	return (
		<Pressable
			style={styles.sectionToggle}
			onPress={onToggle}
			accessibilityRole="button"
			accessibilityState={{ expanded: open }}
			accessibilityLabel={`${title} ${count}件`}
		>
			<SectionHeader
				title={title}
				count={count}
				first={first}
				right={<Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={13} color={colors.textDim} />}
			/>
		</Pressable>
	);
}

/**
 * ホーム画面（mock.html 案A準拠のリデザイン）。旧デザインの「接続中のPC」カードと
 * ワークスペース別グループ表示を廃止し、全ワークスペース横断のエージェント一覧に
 * 再定義した（PCステータス・接続管理はワークスペースドロワーへ移設）。
 * 要対応のエージェントは最上部の要対応スタックに全件を積み、開いた1件にその場で
 * 回答できる（積んだぶんは下の一覧からは外す）。
 *
 * 並びがステータス順（既定）のときは、一覧を状態の見出しで区切った1本にする:
 * 要対応（スタック）→ 実行中 → 未確認 → 待機。待機は既定で畳み、見出しを押すと開く
 * （畳んでいてもピン留めの行は出す。段が待機だけのときは開いて出す）。
 * 他の並び（スペース順・名前順・追加順）は見出しなしの一覧のまま。
 *
 * ドロワーで特定のワークスペースを選択している間（homeShowAllWorkspaces=false）は、
 * 一覧をそのワークスペース（＋配下のworktree）だけに絞り込む。**要対応だけは絞り込まない**
 * （件数をタブのバッジと揃えるため。理由は `attentionCount.ts`）。ドロワー上部の
 * 「すべて表示」を選ぶとこれまで通り全ワークスペース横断の一覧に戻る。
 *
 * 新規作成（エージェントの起動・ワークツリー・メモ）の入口は、iPhone では画面右下の＋、
 * iPad ではヘッダーの＋。
 */
export default function HomeScreen() {
	const router = useRouter();
	const { paired, ready, notifications, createTerminal, homeShowAllWorkspaces, homePreferences, setHomePreferences, setSelectedWs, setSelectedTerminalKey, pinnedKeys, renameTerminal, togglePin, closeTerminal, ackAgentStatus, archivedKeys, setArchived } = useAppStore(useShallow(s => ({
		paired: s.paired, ready: s.ready, notifications: s.notifications,
		createTerminal: s.createTerminal,
		homeShowAllWorkspaces: s.homeShowAllWorkspaces,
		homePreferences: s.homePreferences, setHomePreferences: s.setHomePreferences,
		setSelectedWs: s.setSelectedWs, setSelectedTerminalKey: s.setSelectedTerminalKey,
		pinnedKeys: s.pinnedKeys, renameTerminal: s.renameTerminal, togglePin: s.togglePin, closeTerminal: s.closeTerminal,
		ackAgentStatus: s.ackAgentStatus, archivedKeys: s.archivedKeys, setArchived: s.setArchived,
	})));
	// **`s.workspace` 本体を購読しない。** 本体は10Hz再送のたびに新参照になるため、本体を
	// 買うと画面関数と非memo部（arrangeHomeRows 等）がそのたび再実行していた。必要なのは
	// この3つだけで、いずれも workspaceIdentity.ts の構造共有により中身不変なら参照が
	// 据え置かれるため、個別に受ければ再送では止まる。
	const terminals = useAppStore(s => s.workspace?.terminals);
	const workspaces = useAppStore(s => s.workspace?.workspaces);
	const activeWs = useAppStore(s => s.workspace?.activeWs);
	const effectiveWs = useEffectiveWs();
	// 長押し・行の ⋯ で開くアクションメニュー（名前を変更/ピン留め/確認済み/アーカイブ/削除）の表示状態。
	// rect/rowData は「リフト&ディム」で対象行を前面へ浮かせるクローン描画に使う
	// （上部スタックの行から開いたときは持たないため、その場合はクローン無しでメニューだけ出す）。
	const [menu, setMenu] = useState<{ target: HomeAgentMenuTarget; anchor: { x: number; y: number }; rect?: AgentRowRect; rowData?: AgentRowData } | undefined>(undefined);
	// ステータス順の「待機」の段を利用者が開閉したか（undefined は既定のまま）。既定で畳む（手の空いた
	// エージェントは眺める対象ではなく、並べると動いているものが画面の下へ押し出される）。
	// 段が「待機」だけのときの既定の開閉と、畳んでもピン留めは見せる規則は homeSort.ts の idleSectionView。
	const [idleOpenOverride, setIdleOpenOverride] = useState<boolean | undefined>(undefined);
	// 各行の実ビューへの参照。長押し時に measureInWindow でウィンドウ座標を取得するために持つ。
	const rowRefs = useRef(new Map<string, View>());
	// 並び替えシートの開閉。コンポーネント側に持たせると、一覧が0件になった瞬間に
	// アンマウントされてシートが勝手に閉じるため画面側で持つ。
	const [sortSheetOpen, setSortSheetOpen] = useState(false);
	// ヘッダーの＋から生えるメニューと、そこから開くワークツリー作成シート。
	const [worktreeSheetOpen, setWorktreeSheetOpen] = useState(false);
	const [voiceSheetOpen, setVoiceSheetOpen] = useState(false);
	// ステータスバッジタップで開くポップオーバー（「確認済みにする」）の表示状態。
	const [statusPopover, setStatusPopover] = useState<{ target: AgentStatusPopoverTarget; anchor: { x: number; y: number } } | undefined>(undefined);
	// ヘッダー＋ボタンで開く「新しいエージェントを起動」シートの表示状態。

	const tabBarSpacer = useTabBarSpacer();
	const regular = useIsRegularWidth();
	const homeHeader = useMemo(() => homeHeaderLayout(regular ? 'regular' : 'compact'), [regular]);
	const voiceActive = useAppStore(state => state.voiceNotifications.desired);
	// 一覧を何列で並べるか。ウィンドウ幅ではなく実際の一覧の幅で決める
	// （左のサイドバーぶん狭いので、ウィンドウ幅で決めると2列に入らない幅でも2列にしてしまう）。
	const [listWidth, setListWidth] = useState(0);
	const headerHeight = useParaHeaderHeight();
	const columns = regular ? listColumnsFor(listWidth) : 1;
	// 同じジェスチャをソース管理・ファイルタブでも使う（wsDrawer.tsx の useOpenDrawerPan）。
	const openDrawerPan = useOpenDrawerPan();
	// 絞り込み中は選択中ワークスペース（selectedWs）＋その配下のworktreeだけを対象にする。
	// selectedWsは他タブや通知タップ・エージェント遷移でも更新される全画面共有の値なので、
	// それらの操作でワークスペースが切り替わった後にホームへ戻ると、絞り込み先も追従する
	// （ヘッダーのチップ色・ドロワーのアクティブ行と一貫させるための意図的な挙動）。
	// **参照を安定させる。** ここが毎レンダー新しい `Set` だと、これを依存に持つ `listable` の
	// memo が毎回外れ、その下流（＋メニュー・ヘッダーの仕様）まで全部作り直しに
	// なる。先に文字列のキーを作り、それが変わったときだけ `Set` を組む。
	const scopeKey = !homeShowAllWorkspaces && effectiveWs !== undefined
		? [effectiveWs.id, ...(workspaces ?? []).filter(w => w.parent === effectiveWs.id).map(w => w.id)].join('\n')
		: undefined;
	const scopeIds = useMemo(
		() => (scopeKey === undefined ? undefined : new Set(scopeKey.split('\n'))),
		[scopeKey]);
	// 以下の derive は memo 済みの行へ渡る値の出どころなので、参照を安定させておく。
	// state 側で中身の参照が据え置かれる（workspaceIdentity.ts）ため、PCから同じ内容が
	// 再送された場合はここも丸ごと据え置かれ、行の memo が実際に効くようになる。
	const wsById = useMemo(() => new Map((workspaces ?? []).map(w => [w.id, w])), [workspaces]);
	/** ws未タグのターミナルはPC側アクティブワークスペース所属として扱う（ホーム全体で共通のフォールバック順）。 */
	const resolveWs = useCallback((t: { ws?: string }) =>
		(t.ws !== undefined ? wsById.get(t.ws) : undefined)
		?? (activeWs !== undefined ? wsById.get(activeWs) : undefined)
		?? workspaces?.[0],
		[wsById, activeWs, workspaces]);
	const inScope = useCallback((t: { ws?: string }) => {
		if (scopeIds === undefined) {
			return true;
		}
		const ws = resolveWs(t);
		return ws !== undefined && scopeIds.has(ws.id);
	}, [scopeIds, resolveWs]);

	// 要対応のターミナル。全件を上部のスタックに積み、開いた1件だけ中身を購読する。
	// 同時に複数へ attach しないのは、フックが1ターミナル単位であることと、閉じた行に中身が
	// 要らないため。選び方は件数と同じ `isAttentionAgent`（エージェントCLIが動いた実績のある
	// ターミナルだけ。プレーンなターミナルが状態を拾って最上部に居座るのを防ぐ）。
	//
	// **ドロワーのスペースの絞り込みは掛けない。** 見出しの件数をタブのバッジ・ドロワーの統計と
	// 同じ数（`countAttentionAgents`）にするため、スタックの中身もそれに揃える
	// （理由は `attentionCount.ts`）。
	const waitingTerminals = useMemo(
		() => sortWaiting((terminals ?? []).filter(isAttentionAgent)),
		[terminals]);
	const attentionCount = countAttentionAgents(terminals);
	const waitingKeys = waitingTerminals.map(t => t.terminalKey);
	// 「見たことがある」の記録。スタックが絞り込みを掛けなくなったので、並べる顔ぶれと同じでよい。
	const knownWaitingKeys = waitingKeys;
	const [attention, setAttention] = useState<AttentionOpenState>(CLOSED_ATTENTION);
	const [attentionExpanded, setAttentionExpanded] = useState(false);
	// 顔ぶれの変化に合わせた開閉は描画に即反映したいので、レンダー中に解決してから状態へ書き戻す
	// （reconcileAttention は変化が無ければ同じ参照を返すため、ここで更新が繰り返されることはない）。
	const openState = reconcileAttention(attention, waitingKeys, knownWaitingKeys);
	useEffect(() => {
		if (openState !== attention) {
			setAttention(openState);
		}
	}, [openState, attention]);
	// 書き戻し前のタップでも必ず解決済みの状態から遷移させる（自動で開いた直後に畳もうとした
	// タップが、まだ古い state を見て「開く」に化けるのを防ぐ）。
	const waitingKeysRef = useRef({ keys: waitingKeys, known: knownWaitingKeys });
	waitingKeysRef.current = { keys: waitingKeys, known: knownWaitingKeys };
	const toggleAttentionRow = (terminalKey: string) => {
		hapticSelection();
		setAttention(current => toggleAttention(
			reconcileAttention(current, waitingKeysRef.current.keys, waitingKeysRef.current.known),
			terminalKey,
		));
	};
	// 件数が上限以下に戻ったら「他N件を表示」も畳み直す（次に増えたとき勝手に全件出さない）。
	useEffect(() => {
		if (waitingKeys.length <= ATTENTION_VISIBLE_LIMIT) {
			setAttentionExpanded(false);
		}
	}, [waitingKeys.length]);
	// 開く行が変わったら、その行のチャットを取り直してから描く。detach してもスナップショットは
	// 残るため、これが無いと「前に開いたときの質問・承認」が現在の内容として一瞬出てしまう
	// （古い承認カードを押すと、回答APIを持たない旧PCへは生のキーが飛んでしまう）。
	//
	// ホームが前面にあるときだけ走らせる。refreshAgent は会話を消さなくなった（古い印を付けて
	// 操作だけ止め、PCの応答で解ける）が、それでも背面で走らせると、詳細画面を読んでいる最中に
	// 承認カードが一時的に押せなくなる。前面のときだけに絞る理由は残っている。
	// またこの effect は useAgentChatSubscription より**前**に置くこと。detach → refresh → attach
	// の順になり、attach 要求が1通で済む（後ろに置くと refresh 側からも attach が飛ぶ）。
	const homeFocused = useIsFocused();
	const refreshAgent = useAppStore(s => s.refreshAgent);
	useEffect(() => {
		if (homeFocused && openState.openKey !== undefined) {
			refreshAgent(openState.openKey);
		}
	}, [homeFocused, openState.openKey, refreshAgent]);
	const openChat = useAgentChatSubscription(openState.openKey);
	const openActions = useAgentActions(openState.openKey, openChat?.agent);
	const visibleWaitingTerminals = useMemo(
		() => visibleWaiting(waitingTerminals, openState.openKey, attentionExpanded),
		[waitingTerminals, openState.openKey, attentionExpanded]);
	const stackItems = useMemo<AttentionStackItem[]>(() => visibleWaitingTerminals.map(t => {
		const ws = resolveWs(t);
		return {
			terminalKey: t.terminalKey,
			title: t.title,
			wsName: ws?.name ?? '—',
			wsColor: ws ? wsColor(ws) : colors.accent,
			branch: ws?.branch,
			pinned: pinnedKeys.has(pinKeyForTerminal(t)),
			agentStatus: t.agentStatus === 'permission' ? 'permission' : 'question',
		};
	}), [visibleWaitingTerminals, resolveWs, pinnedKeys]);

	/** アーカイブ直後の「元に戻す」。数秒で自然に消える。 */
	const [undoArchive, setUndoArchive] = useState<{ key: string; title: string } | undefined>(undefined);
	const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => { if (undoTimer.current !== undefined) { clearTimeout(undoTimer.current); } }, []);
	const archive = useCallback((terminalKey: string, title: string) => {
		setArchived(pinKeyForTerminal({ terminalKey }), true);
		setUndoArchive({ key: pinKeyForTerminal({ terminalKey }), title });
		if (undoTimer.current !== undefined) {
			clearTimeout(undoTimer.current);
		}
		undoTimer.current = setTimeout(() => { undoTimer.current = undefined; setUndoArchive(undefined); }, UNDO_ARCHIVE_MS);
	}, [setArchived]);

	/** 削除は取り返しがつかないので、スワイプから直に消さず一度だけ聞く。 */
	const confirmDelete = useCallback((terminalKey: string, title: string) => {
		Alert.alert('エージェントを削除', `「${title}」を削除します。PCのターミナルごと閉じられます。`, [
			{ text: 'キャンセル', style: 'cancel' },
			{ text: '削除', style: 'destructive', onPress: () => closeTerminal(terminalKey) },
		]);
	}, [closeTerminal]);

	/**
	 * エージェントタブへ遷移する。setSelectedWsがselectedTerminalKeyをリセットするため、この順序を厳守する。
	 * 行へ安定した参照で渡すため useCallback にしてあり、フックなので早期returnより前に置く。
	 */
	const openAgent = useCallback((wsId: string, terminalKey: string) => {
		hapticSelection();
		setSelectedWs(wsId);
		setSelectedTerminalKey(terminalKey);
		router.push({ pathname: '/agent', params: { latest: createAgentLatestEntryToken() } });
	}, [router, setSelectedWs, setSelectedTerminalKey]);

	/**
	 * 行から呼ぶ操作をひとまとめにして参照を固定する。行は memo 済みなので、ここが毎レンダー
	 * 新品になると比較が必ず落ちて memo が素通りする（1つでも不安定な関数があると同じこと）。
	 */
	const rowHandlers = useMemo<HomeAgentRowHandlers>(() => ({
		registerRef: (terminalKey, node) => {
			if (node) {
				rowRefs.current.set(terminalKey, node);
			} else {
				rowRefs.current.delete(terminalKey);
			}
		},
		onOpen: (wsId, terminalKey) => {
			if (wsId !== undefined) {
				openAgent(wsId, terminalKey);
			}
		},
		onLongPress: (terminalKey, title, pinned, rowData, anchor) => {
			const target: HomeAgentMenuTarget = { terminalKey, title, pinned, origin: 'list' };
			const node = rowRefs.current.get(terminalKey);
			if (node) {
				// ウィンドウ座標を取得してから、その位置に浮かせたクローンとメニューを開く。
				node.measureInWindow((x, y, width, height) => setMenu({ target, anchor, rect: { x, y, width, height }, rowData }));
			} else {
				setMenu({ target, anchor, rowData });
			}
		},
		onStatusPress: (terminalKey, anchor) => setStatusPopover({ target: { terminalKey, status: 'review' }, anchor }),
		onAck: ackAgentStatus,
		onArchive: archive,
		onDelete: confirmDelete,
	}), [openAgent, ackAgentStatus, archive, confirmDelete]);

	// ══ ここから下はフック（`useMemo`/`useCallback`/`useWsHeader`）を含む ══
	// **早期returnより前に置くこと。** 下に置くと `ready && !paired` が切り替わった瞬間に
	// フックの本数が変わり、React が「Rendered fewer/more hooks than expected」で落ちる
	// （新規インストール直後の起動・ペアリング完了・最後のPCのペアリング解除で必ず踏む）。
	// エージェント一覧。絞り込み中は選択中ワークスペース分だけに絞る。エージェントCLIが
	// 動いた実績のあるターミナルだけを載せる（プレーンなターミナルを開いただけで
	// ホームに行が増えないように）。
	// 応答待ちは上部のスタックが受け持つので、ここには載せない（同じ行を上下に二度出さない）。
	// **memo する。** この配列はヘッダーの仕様（＋メニューの対象件数）へ
	// 流れるので、毎レンダー新しいと下流の `useCallback`/`useMemo` が全部無効になり、
	// PCからのstate再送（最大10Hz）ごとにヘッダー層へ書き込みが走る。
	const listable = useMemo(
		() => (terminals ?? []).filter(t => t.agent === true && inScope(t) && !archivedKeys.has(pinKeyForTerminal(t)) && !isAgentWaiting(t.agentStatus)),
		// `inScope` 自体が useCallback で安定しているので、依存はそれを直接書けば足りる
		// （以前はここに `inScope` の依存を手で写していたため、向こうに条件を1つ足すと
		// この一覧だけ古い判定を使い続ける、という気付きにくい壊れ方をする形だった）。
		//
		// なお `workspace.terminals` は、中身が同じなら再送のたびに**同じ参照が据え置かれる**
		// （`workspaceIdentity.ts` の構造共有）。以前は毎回新品になっていたため、エージェントが
		// 走っている間の再送（最大10Hz）でここが通り抜けていた。今は中身が本当に変わったときだけ通る。
		[terminals, inScope, archivedKeys]);
	// 「すべて確認済みにする」の対象。既読の概念があるのはレビュー待ちだけで、実行中や
	// アイドルには確認するものが無い。応答待ちは回答して解消するものなので含めない。
	const reviewable = useMemo(() => listable.filter(t => t.agentStatus === 'review'), [listable]);

	// アーカイブ入口は、しまってあるものが1件でもある時だけ出す（常設だと空のボタンが並ぶ）。
	const archivedCount = (terminals ?? []).filter(t => t.agent === true && archivedKeys.has(pinKeyForTerminal(t))).length;

	/**
	 * ヘッダーの＋メニューで選んだ項目の行き先。
	 *
	 * **参照を安定させる。** ヘッダーは常設の層へ仕様として登録するので、毎レンダー新しい
	 * 関数を渡すとPCからのstate再送（最大10Hz）のたびに層へ書き込みが走る。
	 */
	const onPlusMenuSelect = useCallback((action: HomePlusMenuAction) => {
		switch (action) {
			case 'launch-claude':
				router.push({ pathname: '/agent-launch', params: { agent: 'claude' } });
				return;
			case 'launch-codex':
				router.push({ pathname: '/agent-launch', params: { agent: 'codex' } });
				return;
			case 'new-terminal':
				createTerminal(effectiveWs?.id);
				return;
			case 'new-worktree':
				setWorktreeSheetOpen(true);
				return;
			case 'space-note':
				if (effectiveWs !== undefined) {
					router.push({ pathname: '/space-note', params: { ws: effectiveWs.id } });
				}
				return;
			case 'sort':
				setSortSheetOpen(true);
				return;
			case 'ack-all':
				for (const t of reviewable) {
					ackAgentStatus(t.terminalKey);
				}
				return;
		}
	}, [router, createTerminal, effectiveWs, reviewable, ackAgentStatus]);
	const openArchive = useCallback(() => {
		hapticImpact('light');
		router.push('/archive');
	}, [router]);
	const openNotifications = useCallback(() => {
		hapticImpact('light');
		router.push('/notifications');
	}, [router]);
	const onHeaderMenuSelect = useCallback((action: HomeHeaderMenuAction) => {
		dispatchHomeHeaderMenuAction(action, {
			onArchive: openArchive,
			onVoiceNotifications: () => setVoiceSheetOpen(true),
			onNotifications: openNotifications,
			onPlusMenuSelect,
		});
	}, [onPlusMenuSelect, openArchive, openNotifications]);

	// 右のピルの中身。**器（1枚のガラスのピル）はヘッダー層が持つ**ので、ここは中身だけを渡す。
	// 並びは「たまに使う → よく使う」で、＋を右端に置く。メニューはその＋から生えるので、
	// 右端でないと開く場所と押した場所がずれる。状態を持つボタン（音声・通知・＋）は
	// データにできないので `node` で差し込む。
	// iPhone ではベル（未読の質問通知の件数付き）と `…` の2つ、iPad ではこれまでの4つ。
	const actions = useHomeHeaderActions({
		header: homeHeader,
		archivedCount,
		voiceActive,
		ackCount: reviewable.length,
		hasSpace: effectiveWs !== undefined,
		notifications,
		onArchive: openArchive,
		onNotifications: openNotifications,
		onSelect: onHeaderMenuSelect,
	});

	useWsHeader({
		allWorkspaces: homeShowAllWorkspaces,
		// 一覧は広い画面で2列に広がるので、ヘッダーも同じく画面幅いっぱいに合わせる。
		wide: true,
		actions,
	});

	if (ready && !paired) {
		return <PairingRequiredNotice onStart={() => router.push('/pair')} />;
	}

	// 並び順はユーザーが選べる（判定は homeSort.ts、設定は端末に保存される）。
	// スペース順の基準はドロワーのワークスペース一覧と同じ並びにする。所属の解決は
	// resolveWs を通す（ws未タグをPC側アクティブスペース所属として扱う共通の規則。
	// ここを飛ばすと、行に出ているスペース名と並び順がずれる）。
	const spaceIndex = new Map((workspaces ?? []).map((w, index) => [w.id, index]));
	const rows = arrangeHomeRows(listable, homePreferences, {
		spaceIndexOf: t => { const ws = resolveWs(t); return ws !== undefined ? spaceIndex.get(ws.id) : undefined; },
		isPinned: t => pinnedKeys.has(pinKeyForTerminal(t)),
	});
	// ステータス順のときだけ、状態の見出しで区切る。
	const sectioned = homePreferences.sort === 'status';
	const sections = sectioned ? groupRowsByStatus(rows) : [];
	// 要対応の見出し。ステータス順では他の段と同じく常に付ける。他の並びでは1件だけのときは
	// 付けない（赤い枠のカードが1枚あるだけで何を待っているかは分かり、本文がヘッダーの
	// 直下から始まるほうがよい。複数あるときだけ「ここまでが要対応」の塊として示す）。
	const attentionHeader = attentionCount > 0 && (sectioned || attentionCount > 1);
	// iPhone は新規作成の入口を右下の＋に置く（iPad はヘッダーの＋）。
	const showFab = homeHeader.kind === 'compact-menu';
	const fabBottom = tabBarSpacer + space.md;
	const noWorkspaces = (workspaces?.length ?? 0) === 0;
	const createHint = showFab ? '右下の＋' : '右上の＋';

	const renderRow = (t: (typeof rows)[number]) => {
		const ws = resolveWs(t);
		return (
			<HomeAgentRow
				key={t.terminalKey}
				terminalKey={t.terminalKey}
				wsId={ws?.id}
				title={t.title}
				wsName={ws?.name ?? '—'}
				wsColor={ws ? wsColor(ws) : colors.accent}
				branch={ws?.branch}
				pinned={pinnedKeys.has(pinKeyForTerminal(t))}
				agentStatus={t.agentStatus}
				handlers={rowHandlers}
				// 長押しメニューが開いている行はスワイプを止める。メニュー成立後に指が
				// 横へずれると、背面の行だけが動いて浮かせたクローンとズレるため。
				locked={menu?.target.terminalKey === t.terminalKey}
			/>
		);
	};

	return (
		<ConnectionGate><GestureDetector gesture={openDrawerPan}><View style={styles.screen}>
			{/* スクロールし始めたら開きっぱなしのスワイプ行を畳む。開いたままのアクションカードは
			    「押し忘れ」であり、その近くを狙ったタップがカードの即時実行を踏み得る。 */}
			<ScrollView
				style={styles.scroll}
				contentContainerStyle={[styles.content, {
					paddingTop: headerHeight,
					// 右下の＋の下へ最後の行が潜らないよう、そのぶん下を空ける。
					paddingBottom: showFab ? fabBottom + HOME_CREATE_FAB_SIZE + space.md : tabBarSpacer,
				}]}
				onScrollBeginDrag={closeOpenedSwipeRow}
				// 幅の測定はiPad幅のときだけ。iPhoneでは列数が常に1なので測る必要が無く、
				// onLayoutを付けるとマウント時に無駄な再描画が1回増える。
				onLayout={regular ? e => setListWidth(e.nativeEvent.layout.width) : undefined}
			>
				{/* 要対応の見出し。件数はタブのバッジ・ドロワーの統計と同じ数え方（attentionCount.ts）。
				    スタック側は見出しを持たないので二重にならない。 */}
				{attentionHeader ? <SectionHeader title={status.attention.label} count={attentionCount} first /> : null}
				<AttentionStack
					items={stackItems}
					openKey={openState.openKey}
					onToggle={toggleAttentionRow}
					onLongPress={(item, anchor) => {
						hapticImpact('medium');
						setMenu({ target: { terminalKey: item.terminalKey, title: item.title, pinned: item.pinned, origin: 'attention' }, anchor });
					}}
					hiddenCount={waitingTerminals.length - stackItems.length}
					onShowAll={() => { hapticSelection(); setAttentionExpanded(true); }}
					chat={openChat}
					actions={openActions}
					onOpenAgent={terminalKey => {
						const terminal = waitingTerminals.find(t => t.terminalKey === terminalKey);
						const ws = terminal ? resolveWs(terminal) : undefined;
						if (ws) {
							openAgent(ws.id, terminalKey);
						}
					}}
					// 見出しで区切る一覧では、次の見出しが上の余白を持つ。
					style={sectioned ? styles.stackInSections : undefined}
				/>

				{/* 「エージェント — <スペース名>」の見出しは置かない。いま何を見ているかは
				    ヘッダーの島（スペース名）が既に示しており、同じことをもう一度言うと本文の
				    始まりがそのぶん下がるだけになる。 */}
				{sectioned
					? sections.map((section, index) => {
						const first = !attentionHeader && index === 0;
						const title = SECTION_LABEL[section.key];
						if (section.key === 'idle') {
							const idleView = idleSectionView(sections, section.rows, idleOpenOverride, t => pinnedKeys.has(pinKeyForTerminal(t)));
							return (
								<View key={section.key}>
									<CollapsibleSectionHeader
										title={title}
										count={section.rows.length}
										first={first}
										open={idleView.open}
										onToggle={() => { hapticSelection(); setIdleOpenOverride(!idleView.open); }}
									/>
									{/* 畳んでいてもピン留めの行は出す。 */}
									{idleView.visibleRows.length > 0 ? renderAgentRows(idleView.visibleRows.map(renderRow), columns) : null}
								</View>
							);
						}
						return (
							<View key={section.key}>
								<SectionHeader title={title} count={section.rows.length} first={first} />
								{renderAgentRows(section.rows.map(renderRow), columns)}
							</View>
						);
					})
					: renderAgentRows(rows.map(renderRow), columns)}
				{/* 空のときの案内は1つだけ出す。ワークスペースが届いていない間は、エージェントが
				    無いことより先にそちらが原因なので、取得中の案内だけにする。 */}
				{noWorkspaces ? (
					<EmptyState
						title="ワークスペース情報を取得中…"
						message="PCの Para Code でリポジトリを登録すると表示されます。"
					/>
				) : listable.length === 0 && waitingTerminals.length === 0 ? (
					<EmptyState
						title={homeShowAllWorkspaces || effectiveWs === undefined
							? 'エージェントはまだありません'
							: `${effectiveWs.name} のエージェントはまだありません`}
						message={homeShowAllWorkspaces || effectiveWs === undefined
							? `${createHint}から Claude・Codex を起動すると、ここに表示されます。`
							: `${createHint}から起動できます。ドロワー上部の「すべて表示」で他のワークスペースも確認できます。`}
					/>
				) : null}
			</ScrollView>
			{undoArchive !== undefined ? (
				<View
					style={[
						styles.undoWrap,
						// iPhone は右下の＋の左に並べ、＋と縦の中心を揃える（重ねない）。
						showFab
							? { bottom: fabBottom + (HOME_CREATE_FAB_SIZE - HIT_SIZE) / 2, right: 16 + HOME_CREATE_FAB_SIZE + space.sm }
							: { bottom: tabBarSpacer + 10 },
					]}
					pointerEvents="box-none"
				>
					<GlassSurface style={styles.undoGlass} />
					<Text style={styles.undoText} numberOfLines={1}>「{undoArchive.title}」をアーカイブしました</Text>
					<Pressable
						style={styles.undoAction}
						onPress={() => { hapticSelection(); setArchived(undoArchive.key, false); setUndoArchive(undefined); }}
						accessibilityRole="button"
					>
						<Text style={styles.undoActionText}>元に戻す</Text>
					</Pressable>
				</View>
			) : null}
			{showFab ? (
				<View style={[styles.fabWrap, { bottom: fabBottom }]} pointerEvents="box-none">
					<HomeCreateFab hasSpace={effectiveWs !== undefined} onSelect={onPlusMenuSelect} />
				</View>
			) : null}
			<HomeAgentActionsMenu
				target={menu?.target}
				anchor={menu?.anchor}
				rect={menu?.rect}
				rowData={menu?.rowData}
				onClose={() => setMenu(undefined)}
				onRename={(terminalKey, title) => renameTerminal(terminalKey, title)}
				onTogglePin={terminalKey => {
					const terminal = terminals?.find(term => term.terminalKey === terminalKey);
					if (terminal) {
						togglePin(pinKeyForTerminal(terminal));
					}
				}}
				onAck={terminalKey => ackAgentStatus(terminalKey)}
				onArchive={archive}
				onDelete={terminalKey => closeTerminal(terminalKey)}
			/>
			<AgentStatusPopover
				target={statusPopover?.target}
				anchor={statusPopover?.anchor}
				onClose={() => setStatusPopover(undefined)}
				onAck={terminalKey => ackAgentStatus(terminalKey)}
			/>
			<WorktreeCreateSheet visible={worktreeSheetOpen} onClose={() => setWorktreeSheetOpen(false)} />
			{homeHeader.kind === 'compact-menu' ? (
				<VoiceNotificationControl visible={voiceSheetOpen} onClose={() => setVoiceSheetOpen(false)} />
			) : null}
			<HomeSortSheet
				visible={sortSheetOpen}
				preferences={homePreferences}
				onChange={setHomePreferences}
				onClose={() => setSortSheetOpen(false)}
			/>
		</View></GestureDetector></ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	scroll: { flex: 1 },
	// 上下の余白は使う側がヘッダー高さ・タブバー高さから決めるので、ここでは持たない。
	content: { paddingHorizontal: 16 },
	// 見出しで区切る一覧では、スタックの下の余白は次の見出しが持つ。
	stackInSections: { marginBottom: 0 },
	// 開閉できる見出し。書式は SectionHeader のまま、押せる高さだけ44pt以上にする。
	sectionToggle: { minHeight: HIT_SIZE, justifyContent: 'flex-end' },
	// 右下の＋の置き場所（タブバーの上、右端）。
	fabWrap: { position: 'absolute', right: 16 },
	// アーカイブ直後の「元に戻す」（タブバーの上のLiquid Glass）。高さは「元に戻す」の当たり判定（44pt）が決める。
	undoWrap: {
		position: 'absolute', left: 16, right: 16, flexDirection: 'row', alignItems: 'center', gap: 10,
		borderRadius: radius.card, ...squircle, paddingLeft: 14, paddingRight: 4,
	},
	undoGlass: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: radius.card, ...squircle },
	undoText: { color: colors.text, fontSize: type.meta, flex: 1 },
	undoAction: { minHeight: HIT_SIZE, justifyContent: 'center', paddingHorizontal: 10 },
	undoActionText: { color: colors.accent, fontSize: type.meta, fontWeight: '700' },
	// iPadの広い幅でエージェント行を2列に並べるときだけ使う折り返しグリッド。
	// 各セルの左右に隙間を作るため、グリッド側を負のマージンで相殺する。
	grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5 },
	gridCell: { width: '50%', paddingHorizontal: 5 },
});
