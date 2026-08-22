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
import { ConnectionGate, PairingRequiredNotice } from '../../src/components/connectionGate.js';
import { NotificationsButton } from '../../src/components/notificationsSheet.js';
import { VoiceNotificationControl } from '../../src/components/voiceNotificationControl.js';
import { useWsHeader, useEffectiveWs, useOpenDrawerPan, wsColor } from '../../src/components/wsDrawer.js';
import { AttentionStack, type AttentionStackItem } from '../../src/components/attentionStack.js';
import {
	ATTENTION_VISIBLE_LIMIT, CLOSED_ATTENTION, reconcileAttention, sortWaiting, toggleAttention, visibleWaiting,
	type AttentionOpenState,
} from '../../src/components/attentionStackBehavior.js';
import { TerminalActionsMenu, type TerminalActionsMenuTarget } from '../../src/components/terminalActionsMenu.js';
import { type AgentRowData, type AgentRowRect } from '../../src/components/agentRow.js';
import { HomeAgentRow, type HomeAgentRowHandlers } from '../../src/components/homeAgentRow.js';
import { AgentStatusPopover, type AgentStatusPopoverTarget } from '../../src/components/agentStatusPopover.js';
import { GlassSurface } from '../../src/components/glassSurface.js';
import { useParaHeaderHeight, type ParaHeaderIcon } from '../../src/paraHeader.js';
import { useAgentActions, useAgentChatSubscription } from '../../src/hooks/useAgentActions.js';
import { useIsRegularWidth } from '../../src/hooks/useSizeClass.js';
import { useTabBarSpacer } from '../../src/hooks/useTabBarSpacer.js';
import { colors, squircle } from '../../src/theme.js';
import { hapticImpact, hapticSelection } from '../../src/haptics.js';
import { createAgentLatestEntryToken } from '../../src/agentNavigation.js';
import { arrangeHomeRows } from '../../src/homeSort.js';
import { HomeFilterChips, HomeSortSheet } from '../../src/components/homeListControls.js';
import { HomePlusMenuButton, type HomePlusMenuAction } from '../../src/components/homePlusMenu.js';
import { WorktreeCreateSheet } from '../../src/components/worktreeCreateSheet.js';
import { listColumnsFor, CONTENT_MAX_WIDTH } from '../../src/ipad/ipadLayout.js';

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

/**
 * ホーム画面（mock.html 案A準拠のリデザイン）。旧デザインの「接続中のPC」カードと
 * ワークスペース別グループ表示を廃止し、全ワークスペース横断のエージェント一覧に
 * 再定義した（PCステータス・接続管理はワークスペースドロワーへ移設）。
 * 応答待ちのエージェントは最上部の「応答待ち」スタックに全件を積み、開いた1件にその場で
 * 回答できる（積んだぶんは下の一覧からは外す）。
 *
 * ドロワーで特定のワークスペースを選択している間（homeShowAllWorkspaces=false）は、
 * 一覧をそのワークスペース（＋配下のworktree）だけに絞り込む。ドロワー上部の
 * 「すべて表示」を選ぶとこれまで通り全ワークスペース横断の一覧に戻る。
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
	// 長押しで開くアクションメニュー（名前を変更/ピン留め/削除）の表示状態。
	// rect/rowData は「リフト&ディム」で対象行を前面へ浮かせるクローン描画に使う
	// （上部スタックの行から開いたときは持たないため、その場合はクローン無しでメニューだけ出す）。
	const [menu, setMenu] = useState<{ target: TerminalActionsMenuTarget; anchor: { x: number; y: number }; rect?: AgentRowRect; rowData?: AgentRowData } | undefined>(undefined);
	// 各行の実ビューへの参照。長押し時に measureInWindow でウィンドウ座標を取得するために持つ。
	const rowRefs = useRef(new Map<string, View>());
	// 並び替えシートの開閉。コンポーネント側に持たせると、一覧が0件になった瞬間に
	// アンマウントされてシートが勝手に閉じるため画面側で持つ。
	const [sortSheetOpen, setSortSheetOpen] = useState(false);
	// ヘッダーの＋から生えるメニューと、そこから開くワークツリー作成シート。
	const [worktreeSheetOpen, setWorktreeSheetOpen] = useState(false);
	// ステータスバッジタップで開くポップオーバー（「確認済みにする」）の表示状態。
	const [statusPopover, setStatusPopover] = useState<{ target: AgentStatusPopoverTarget; anchor: { x: number; y: number } } | undefined>(undefined);
	// ヘッダー＋ボタンで開く「新しいエージェントを起動」シートの表示状態。

	const tabBarSpacer = useTabBarSpacer();
	const regular = useIsRegularWidth();
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
	// memo が毎回外れ、その下流（＋メニュー・絞り込みチップ・ヘッダーの仕様）まで全部作り直しに
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

	// 応答待ちのターミナル（絞り込み中は対象外のワークスペース分は無視する）。全件を上部の
	// スタックに積み、開いた1件だけ中身を購読する。同時に複数へ attach しないのは、
	// フックが1ターミナル単位であることと、閉じた行に中身が要らないため。
	// 一覧と同じく、エージェントCLIが動いた実績のあるターミナルだけを対象にする
	// （プレーンなターミナルが状態を拾って最上部に居座るのを防ぐ）。
	const waitingTerminals = useMemo(
		() => sortWaiting((terminals ?? []).filter(t => t.agent === true && isAgentWaiting(t.agentStatus) && inScope(t))),
		[terminals, inScope]);
	const waitingKeys = waitingTerminals.map(t => t.terminalKey);
	// 「見たことがある」の記録は絞り込みの外側で取る（ドロワーで表示範囲を往復しただけで
	// 記録が消え、自分で畳んだ1件が開き直るのを防ぐ）。
	const knownWaitingKeys = (terminals ?? []).filter(t => t.agent === true && isAgentWaiting(t.agentStatus)).map(t => t.terminalKey);
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
		undoTimer.current = setTimeout(() => { undoTimer.current = undefined; setUndoArchive(undefined); }, 4_000);
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
			const target = { terminalKey, title, pinned };
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
	// **memo する。** この配列はヘッダーの仕様（絞り込みチップの帯・＋メニューの対象件数）へ
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

	// 右のピルの中身。**器（1枚のガラスのピル）はヘッダー層が持つ**ので、ここは中身だけを渡す。
	// 並びは「たまに使う → よく使う」で、＋を右端に置く。メニューはその＋から生えるので、
	// 右端でないと開く場所と押した場所がずれる。状態を持つボタン（音声・通知・＋）は
	// データにできないので `node` で差し込む。
	const actions = useMemo<ParaHeaderIcon[]>(() => [
		...(archivedCount > 0 ? [{
			key: 'archive',
			icon: 'file-tray-full-outline' as const,
			label: `アーカイブ ${archivedCount}件を見る`,
			onPress: () => { hapticImpact('light'); router.push('/archive'); },
		}] : []),
		{ key: 'voice', label: '音声通知', node: <VoiceNotificationControl /> },
		{ key: 'notifications', label: '通知', node: <NotificationsButton notifications={notifications} /> },
		// ＋はネイティブのボタン。メニューの提示ごとOSに任せてあるので、開閉のstateは
		// こちらで持たない（homePlusMenu.tsx 参照）。
		{
			key: 'plus', label: '作成と表示のメニュー',
			node: <HomePlusMenuButton ackCount={reviewable.length} hasSpace={effectiveWs !== undefined} onSelect={onPlusMenuSelect} />,
		},
	], [archivedCount, router, notifications, reviewable.length, effectiveWs, onPlusMenuSelect]);

	// 絞り込みチップ。要素も memo で安定させる（同じ理由）。
	//
	// **ヘッダーではなく本文側の「上に張り付いた帯」として置く。** 以前はヘッダー層の一部
	// （帯）として描いていたが、ヘッダーをOS標準のナビゲーションバーへ移す方針になったため
	// ——ネイティブのバーにチップの列は入らない。見た目は変えず、絶対配置でバーのすぐ下に
	// 固定し、一覧はその下を流れる（スクロールで消えると「何で絞られているか」が分からなくなる）。
	const filterBand = useMemo(() => (listable.length > 0
		? <HomeFilterChips preferences={homePreferences} onChange={setHomePreferences} rows={listable} />
		: undefined), [listable, homePreferences, setHomePreferences]);
	// 張り付いた帯の実測高さ。一覧の頭をこのぶん空ける。
	const [bandHeight, setBandHeight] = useState(0);

	useWsHeader({
		allWorkspaces: homeShowAllWorkspaces,
		// 一覧は広い画面で2列に広がるので、ヘッダーも同じく画面幅いっぱいに合わせる。
		wide: true,
		actions,
	});

	if (ready && !paired) {
		return <PairingRequiredNotice onStart={() => router.push('/pair')} />;
	}

	// 並び順・絞り込みはユーザーが選べる（判定は homeSort.ts、設定は端末に保存される）。
	// スペース順の基準はドロワーのワークスペース一覧と同じ並びにする。所属の解決は
	// resolveWs を通す（ws未タグをPC側アクティブスペース所属として扱う共通の規則。
	// ここを飛ばすと、行に出ているスペース名と並び順がずれる）。
	const spaceIndex = new Map((workspaces ?? []).map((w, index) => [w.id, index]));
	const rows = arrangeHomeRows(listable, homePreferences, {
		spaceIndexOf: t => { const ws = resolveWs(t); return ws !== undefined ? spaceIndex.get(ws.id) : undefined; },
		isPinned: t => pinnedKeys.has(pinKeyForTerminal(t)),
	});


	return (
		<ConnectionGate><GestureDetector gesture={openDrawerPan}><View style={styles.screen}>
			<ScrollView
				style={styles.scroll}
				contentContainerStyle={[styles.content, { paddingTop: headerHeight + bandHeight, paddingBottom: tabBarSpacer }]}
				// 幅の測定はiPad幅のときだけ。iPhoneでは列数が常に1なので測る必要が無く、
				// onLayoutを付けるとマウント時に無駄な再描画が1回増える。
				onLayout={regular ? e => setListWidth(e.nativeEvent.layout.width) : undefined}
			>
				<AttentionStack
					items={stackItems}
					total={waitingTerminals.length}
					openKey={openState.openKey}
					onToggle={toggleAttentionRow}
					onLongPress={(item, anchor) => {
						hapticImpact('medium');
						setMenu({ target: { terminalKey: item.terminalKey, title: item.title, pinned: item.pinned }, anchor });
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
				/>

				{/* 「エージェント — <スペース名>」の見出しは置かない。いま何を見ているかは
				    ヘッダーの島（スペース名）と絞り込みチップが既に示しており、同じことを
				    3段目でもう一度言うと本文の始まりがそのぶん下がるだけになる。
				    絞り込みチップも本文ではなくヘッダーの帯（WsHeader の below）にある。 */}
				{renderAgentRows(rows.map(t => {
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
						/>
					);
				}), columns)}
				{rows.length === 0 && listable.length > 0 ? (
					<Text style={styles.dimSmall}>絞り込みに合うエージェントがありません。上のチップで絞り込みを外してください。</Text>
				) : null}
				{listable.length === 0 && waitingTerminals.length === 0 ? (
					<Text style={styles.dimSmall}>
						{homeShowAllWorkspaces || effectiveWs === undefined
							? 'エージェントはまだありません。ターミナルタブでターミナルを作成し、claude / codex を起動すると表示されます。'
							: `${effectiveWs.name} のエージェントはまだありません。ドロワー上部の「すべて表示」で他のワークスペースも確認できます。`}
					</Text>
				) : null}
				{(workspaces?.length ?? 0) === 0 ? (
					<Text style={styles.dimSmall}>ワークスペース情報を取得中… PCの Para Code でリポジトリを登録すると表示されます。</Text>
				) : null}
			</ScrollView>
			{/* 上に張り付いた絞り込みチップ。ScrollViewより後に置いて前面に出す。
			    高さは実測して一覧の頭を空ける（チップの数で折り返して高さが変わるため）。 */}
			{filterBand === undefined ? null : (
				<View
					style={[styles.pinnedBand, { top: headerHeight }, regular && styles.pinnedBandWide]}
					pointerEvents="box-none"
					onLayout={event => setBandHeight(Math.round(event.nativeEvent.layout.height))}
				>
					{filterBand}
				</View>
			)}
			{undoArchive !== undefined ? (
				<View style={[styles.undoWrap, { bottom: tabBarSpacer + 10 }]} pointerEvents="box-none">
					<GlassSurface style={styles.undoGlass} />
					<Text style={styles.undoText} numberOfLines={1}>「{undoArchive.title}」をアーカイブしました</Text>
					<Pressable
						hitSlop={8}
						onPress={() => { hapticSelection(); setArchived(undoArchive.key, false); setUndoArchive(undefined); }}
						accessibilityRole="button"
					>
						<Text style={styles.undoAction}>元に戻す</Text>
					</Pressable>
				</View>
			) : null}
			<TerminalActionsMenu
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
				onDelete={terminalKey => closeTerminal(terminalKey)}
			/>
			<AgentStatusPopover
				target={statusPopover?.target}
				anchor={statusPopover?.anchor}
				onClose={() => setStatusPopover(undefined)}
				onAck={terminalKey => ackAgentStatus(terminalKey)}
			/>
			<WorktreeCreateSheet visible={worktreeSheetOpen} onClose={() => setWorktreeSheetOpen(false)} />
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
	// 上に張り付いた絞り込みチップ。ヘッダーのすぐ下に据えて、一覧はこの下を流れる。
	// 左右の余白と下の余白は、以前ヘッダー層の帯が持っていた値をそのまま引き継いでいる。
	pinnedBand: { position: 'absolute', left: 0, right: 0, paddingHorizontal: 16, paddingBottom: 12 },
	// iPad: 本文カラムと左端を揃える（一覧が2列に広がっても帯だけ画面幅にならないように）。
	pinnedBandWide: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
	dimSmall: { color: colors.textDim, fontSize: 12, marginTop: 4, lineHeight: 18 },
	// アーカイブ直後の「元に戻す」（タブバーの上のLiquid Glass）
	undoWrap: {
		position: 'absolute', left: 16, right: 16, flexDirection: 'row', alignItems: 'center', gap: 10,
		borderRadius: 16, ...squircle, paddingVertical: 11, paddingHorizontal: 14,
	},
	undoGlass: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 16, ...squircle },
	undoText: { color: colors.text, fontSize: 12, flex: 1 },
	undoAction: { color: colors.accent, fontSize: 12.5, fontWeight: '700' },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', marginTop: 6, marginBottom: 8, letterSpacing: 0.5 },
	// iPadの広い幅でエージェント行を2列に並べるときだけ使う折り返しグリッド。
	// 各セルの左右に隙間を作るため、グリッド側を負のマージンで相殺する。
	grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5 },
	gridCell: { width: '50%', paddingHorizontal: 5 },
});
