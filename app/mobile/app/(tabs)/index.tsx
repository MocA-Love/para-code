// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { useIsFocused, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting, pinKeyForTerminal } from '../../src/store.js';
import { PairingRequiredNotice } from '../../src/components/connectionGate.js';
import { NotificationsButton } from '../../src/components/notificationsSheet.js';
import { WsHeader, useEffectiveWs, useWsDrawer, wsColor } from '../../src/components/wsDrawer.js';
import { AttentionCard } from '../../src/components/attentionCard.js';
import { TerminalActionsMenu, type TerminalActionsMenuTarget } from '../../src/components/terminalActionsMenu.js';
import { AgentBadge, AgentRowContent, agentRowStyles, type AgentRowData, type AgentRowRect } from '../../src/components/agentRow.js';
import { AgentStatusPopover, type AgentStatusPopoverTarget } from '../../src/components/agentStatusPopover.js';
import { useAgentActions, useAgentChatSubscription } from '../../src/hooks/useAgentActions.js';
import { useTabBarSpacer } from '../../src/hooks/useTabBarSpacer.js';
import { colors } from '../../src/theme.js';
import { hapticImpact, hapticSelection } from '../../src/haptics.js';

/**
 * ホーム画面（mock.html 案A準拠のリデザイン）。旧デザインの「接続中のPC」カードと
 * ワークスペース別グループ表示を廃止し、全ワークスペース横断のエージェント一覧に
 * 再定義した（PCステータス・接続管理はワークスペースドロワーへ移設）。
 * 応答待ちのエージェントがいる場合は最上部のアテンションカードでその場で回答できる。
 *
 * ドロワーで特定のワークスペースを選択している間（homeShowAllWorkspaces=false）は、
 * 一覧をそのワークスペース（＋配下のworktree）だけに絞り込む。ドロワー上部の
 * 「すべて表示」を選ぶとこれまで通り全ワークスペース横断の一覧に戻る。
 */
export default function HomeScreen() {
	const router = useRouter();
	const { workspace, paired, ready, notifications, homeShowAllWorkspaces, setSelectedWs, setSelectedTerminalId, pinnedKeys, renameTerminal, togglePin, closeTerminal, ackAgentStatus } = useAppStore(useShallow(s => ({
		workspace: s.workspace, paired: s.paired, ready: s.ready, notifications: s.notifications,
		homeShowAllWorkspaces: s.homeShowAllWorkspaces,
		setSelectedWs: s.setSelectedWs, setSelectedTerminalId: s.setSelectedTerminalId,
		pinnedKeys: s.pinnedKeys, renameTerminal: s.renameTerminal, togglePin: s.togglePin, closeTerminal: s.closeTerminal,
		ackAgentStatus: s.ackAgentStatus,
	})));
	const effectiveWs = useEffectiveWs();
	// 長押しで開くアクションメニュー（名前を変更/ピン留め/削除）の表示状態。
	// rect/rowData は「リフト&ディム」で対象行を前面へ浮かせるクローン描画に使う。
	const [menu, setMenu] = useState<{ target: TerminalActionsMenuTarget; anchor: { x: number; y: number }; rect?: AgentRowRect; rowData: AgentRowData } | undefined>(undefined);
	// 各行の実ビューへの参照。長押し時に measureInWindow でウィンドウ座標を取得するために持つ。
	const rowRefs = useRef(new Map<number, View>());
	// ステータスバッジタップで開くポップオーバー（「確認済みにする」）の表示状態。
	const [statusPopover, setStatusPopover] = useState<{ target: AgentStatusPopoverTarget; anchor: { x: number; y: number } } | undefined>(undefined);

	const tabBarSpacer = useTabBarSpacer();
	// ホームは横スクロール要素を持たないため、フォーカス中は画面全域の右スワイプで
	// ドロワーを開ける（X方式）。他タブへ移ったら左端エッジのみに戻す。
	const { setFullWidthSwipe } = useWsDrawer();
	const isFocused = useIsFocused();
	useEffect(() => {
		setFullWidthSwipe(isFocused);
		return () => setFullWidthSwipe(false);
	}, [isFocused, setFullWidthSwipe]);
	// 絞り込み中は選択中ワークスペース（selectedWs）＋その配下のworktreeだけを対象にする。
	// selectedWsは他タブや通知タップ・エージェント遷移でも更新される全画面共有の値なので、
	// それらの操作でワークスペースが切り替わった後にホームへ戻ると、絞り込み先も追従する
	// （ヘッダーのチップ色・ドロワーのアクティブ行と一貫させるための意図的な挙動）。
	const scopeIds = !homeShowAllWorkspaces && effectiveWs !== undefined
		? new Set([effectiveWs.id, ...(workspace?.workspaces ?? []).filter(w => w.parent === effectiveWs.id).map(w => w.id)])
		: undefined;
	const wsById = new Map((workspace?.workspaces ?? []).map(w => [w.id, w]));
	/** ws未タグのターミナルはPC側アクティブワークスペース所属として扱う（ホーム全体で共通のフォールバック順）。 */
	const resolveWs = (t: { ws?: string }) =>
		(t.ws !== undefined ? wsById.get(t.ws) : undefined)
		?? (workspace?.activeWs !== undefined ? wsById.get(workspace.activeWs) : undefined)
		?? workspace?.workspaces[0];
	const inScope = (t: { ws?: string }) => {
		if (scopeIds === undefined) {
			return true;
		}
		const ws = resolveWs(t);
		return ws !== undefined && scopeIds.has(ws.id);
	};

	// 応答待ちのターミナル（複数あれば先頭の1件をアテンションカードで扱う。絞り込み中は対象外のワークスペース分は無視する）
	const waitingTerminal = (workspace?.terminals ?? []).find(t => isAgentWaiting(t.agentStatus) && inScope(t));
	const waitingWs = waitingTerminal ? (workspace?.workspaces ?? []).find(w => w.id === waitingTerminal.ws) : undefined;
	const waitingChat = useAgentChatSubscription(waitingTerminal?.id);
	const waitingActions = useAgentActions(waitingTerminal?.id, waitingChat?.agent);

	if (ready && !paired) {
		return <PairingRequiredNotice onStart={() => router.push('/pair')} />;
	}

	/** エージェントタブへ遷移する。setSelectedWsがselectedTerminalIdをリセットするため、この順序を厳守する。 */
	const openAgent = (wsId: string, terminalId: number) => {
		hapticSelection();
		setSelectedWs(wsId);
		setSelectedTerminalId(terminalId);
		router.push('/agent');
	};
	// エージェント一覧（応答待ち → 実行中 → その他 → アイドルの順）。絞り込み中は選択中
	// ワークスペース分だけに絞る。エージェントCLIが動いた実績のあるターミナルだけを載せる
	// （プレーンなターミナルを開いただけでホームに行が増えないように）。
	const rows = (workspace?.terminals ?? []).filter(t => t.agent === true && inScope(t))
		.sort((a, b) => {
			const pinDiff = (pinnedKeys.has(pinKeyForTerminal(b)) ? 1 : 0) - (pinnedKeys.has(pinKeyForTerminal(a)) ? 1 : 0);
			return pinDiff !== 0 ? pinDiff : statusOrder(a.agentStatus) - statusOrder(b.agentStatus);
		});
	const headerSubtitle = homeShowAllWorkspaces || effectiveWs === undefined
		? 'Para Code Mobile'
		: `${effectiveWs.name}${effectiveWs.branch ? ` · ${effectiveWs.branch}` : ''}`;

	return (
		<View style={styles.screen}>
			<WsHeader
				title="ホーム"
				subtitle={headerSubtitle}
				allWorkspaces={homeShowAllWorkspaces}
				right={<NotificationsButton notifications={notifications} />}
			/>
			<ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingBottom: tabBarSpacer }]}>
				{waitingTerminal && waitingWs && (waitingTerminal.agentStatus === 'permission' || waitingTerminal.agentStatus === 'question') ? (
					<AttentionCard
						wsName={waitingWs.name}
						terminalTitle={waitingTerminal.title}
						agentStatus={waitingTerminal.agentStatus}
						chat={waitingChat}
						actions={waitingActions}
						onOpenAgent={() => openAgent(waitingWs.id, waitingTerminal.id)}
					/>
				) : null}

				<Text style={styles.sectionTitle}>
					{homeShowAllWorkspaces || effectiveWs === undefined ? 'エージェント — 全ワークスペース' : `エージェント — ${effectiveWs.name}`}
				</Text>
				{rows.map(t => {
					const ws = resolveWs(t);
					const waiting = isAgentWaiting(t.agentStatus);
					const color = ws ? wsColor(ws) : colors.accent;
					const pinned = pinnedKeys.has(pinKeyForTerminal(t));
					const rowData: AgentRowData = { title: t.title, wsName: ws?.name ?? '—', wsColor: color, branch: ws?.branch, pinned, agentStatus: t.agentStatus, waiting };
					const badge = t.agentStatus === 'review' ? (
						// レビューのみタップで「確認済みにする」ポップオーバーを開ける
						// （応答待ち/質問は回答して解消するもの、実行中/アイドルは既読の概念が無い）
						<Pressable
							hitSlop={8}
							onPress={e => {
								hapticSelection();
								setStatusPopover({
									target: { id: t.id, windowId: workspace?.windowId, status: 'review' },
									anchor: { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY },
								});
							}}
							accessibilityLabel="ステータスを確認済みにする"
						>
							<AgentBadge status={t.agentStatus} />
						</Pressable>
					) : undefined;
					return (
						<Pressable
							key={t.id}
							ref={node => { if (node) { rowRefs.current.set(t.id, node); } else { rowRefs.current.delete(t.id); } }}
							style={[agentRowStyles.container, waiting && agentRowStyles.containerWaiting]}
							onPress={() => { if (ws) { openAgent(ws.id, t.id); } }}
							onLongPress={e => {
								hapticImpact('medium');
								const target = { id: t.id, windowId: workspace?.windowId, title: t.title, pinned };
								const anchor = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
								const node = rowRefs.current.get(t.id);
								if (node) {
									// ウィンドウ座標を取得してから、その位置に浮かせたクローンとメニューを開く。
									node.measureInWindow((x, y, width, height) => setMenu({ target, anchor, rect: { x, y, width, height }, rowData }));
								} else {
									setMenu({ target, anchor, rowData });
								}
							}}
						>
							<AgentRowContent data={rowData} badge={badge} />
						</Pressable>
					);
				})}
				{rows.length === 0 ? (
					<Text style={styles.dimSmall}>
						{homeShowAllWorkspaces || effectiveWs === undefined
							? 'エージェントはまだありません。ターミナルタブでターミナルを作成し、claude / codex を起動すると表示されます。'
							: `${effectiveWs.name} のエージェントはまだありません。ドロワー上部の「すべて表示」で他のワークスペースも確認できます。`}
					</Text>
				) : null}
				{(workspace?.workspaces.length ?? 0) === 0 ? (
					<Text style={styles.dimSmall}>ワークスペース情報を取得中… PCの Para Code でリポジトリを登録すると表示されます。</Text>
				) : null}
			</ScrollView>
			<TerminalActionsMenu
				target={menu?.target}
				anchor={menu?.anchor}
				rect={menu?.rect}
				rowData={menu?.rowData}
				onClose={() => setMenu(undefined)}
				onRename={(id, title, windowId) => renameTerminal(id, title, windowId)}
				onTogglePin={id => {
					const terminal = workspace?.terminals.find(term => term.id === id);
					if (terminal) {
						togglePin(pinKeyForTerminal(terminal));
					}
				}}
				onDelete={(id, windowId) => closeTerminal(id, windowId)}
			/>
			<AgentStatusPopover
				target={statusPopover?.target}
				anchor={statusPopover?.anchor}
				onClose={() => setStatusPopover(undefined)}
				onAck={(id, windowId) => ackAgentStatus(id, windowId)}
			/>
		</View>
	);
}

function statusOrder(status: string | undefined): number {
	return status === 'permission' || status === 'question' ? 0 : status === 'working' ? 1 : status === undefined ? 3 : 2;
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	scroll: { flex: 1 },
	content: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 32 },
	dimSmall: { color: colors.textDim, fontSize: 12, marginTop: 4, lineHeight: 18 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', marginTop: 6, marginBottom: 8, letterSpacing: 0.5 },
});
