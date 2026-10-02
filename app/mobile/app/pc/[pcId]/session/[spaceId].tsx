// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { ChevronRight, Ellipsis, Folder, GitBranch, NotebookPen, PanelLeftOpen, SquareTerminal, Unplug } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { nextAttentionAgent } from '../../../../src/agentConversationUx.js';
import { launchAgentInBackground } from '../../../../src/agentLaunch.js';
import { AGENT_RESUME_CAPABILITY } from '../../../../src/agentSessions.js';
import { createAgentLatestEntryToken } from '../../../../src/agentNavigation.js';
import { useAppStore } from '../../../../src/appState.js';
import { BrowserPanel } from '../../../../src/components/browserPanel.js';
import { useBrowserFullscreen } from '../../../../src/features/browser/browserFullscreenStore.js';
import { hitSlopToMinimum } from '../../../../src/components/hitSlop.js';
import { ProviderLogo } from '../../../../src/components/providerLogo.js';
import { AgentChatPane } from '../../../../src/features/session/agentChatPane.js';
import { QuickCommandsDrawer } from '../../../../src/features/session/quickCommandsDrawer.js';
import { moreActions, newTabActions, tabMenuActions, tabMenuMessage } from '../../../../src/features/session/sessionMenus.js';
import { SessionTabStrip } from '../../../../src/features/session/sessionTabStrip.js';
import { activeTabKey, buildSessionTabs, tabAfterClose, type SessionTabItem } from '../../../../src/features/session/sessionTabs.js';
import { otherSessionView } from '../../../../src/features/session/sessionViewMode.js';
import { TerminalPane } from '../../../../src/features/session/terminalPane.js';
import { useSessionView, useSessionViewReady } from '../../../../src/features/session/useSessionView.js';
import { hapticSelection } from '../../../../src/haptics.js';
import { useKeyboardCoverage } from '../../../../src/hooks/useKeyboardVisible.js';
import { usePcCapability } from '../../../../src/hooks/usePcCapability.js';
import { useIsRegularWidth } from '../../../../src/hooks/useSizeClass.js';
import { ColumnResizeHandle } from '../../../../src/ipad/columnResizeHandle.js';
import { useDetailColumnKey, useDetailColumnOpen } from '../../../../src/ipad/detailColumn.js';
import { canDockPanel, dockWidthFor } from '../../../../src/ipad/ipadLayout.js';
import { useIpadLayout } from '../../../../src/ipad/ipadLayoutStore.js';
import { SessionDock } from '../../../../src/ipad/sessionDock.js';
import { useShortcutSlot } from '../../../../src/ipad/shortcutRegistry.js';
import { stepIndex, type DockPanel } from '../../../../src/ipad/shortcuts.js';
import { useSessionRoute } from '../../../../src/hooks/useRouteTargets.js';
import { useStableInsets } from '../../../../src/hooks/useStableInsets.js';
import { useLastSession } from '../../../../src/features/home/lastSessionStore.js';
import { activityMenuHint, hasAgentActivity } from '../../../../src/features/activity/activityModel.js';
import { spaceColor } from '../../../../src/features/pc/spaceColor.js';
import { sessionTabToPin, type SpaceTerminal } from '../../../../src/navigationTargets.js';
import { encodeSessionTab, routes, type RouteHref, type SessionTab } from '../../../../src/routes.js';
import { colors } from '../../../../src/theme.js';
import { PAIRING_REJECTED_LABEL, isPairingRejected } from '../../../../src/pcStatus.js';
import {
	ActionSheet,
	ConfirmDrawer,
	EmptyState,
	HeaderButton,
	HeaderMetaText,
	Icon,
	Screen,
	ScreenHeader,
	StatusDot,
	TextInputDrawer,
	connectionKind,
	connectionLabel,
} from '../../../../src/ui/index.js';

/** 新しいタブ（＋・クイックコマンド）を待つ時間。これを過ぎたら自動では移らない。 */
const NEW_TAB_WAIT_MS = 30_000;
/** 状態の行（12pt）の見た目の高さ。押せるとき（再接続）は当たり判定を 44 に広げる。 */
const META_HEIGHT = 16;

/**
 * セッション（`/pc/[pcId]/session/[spaceId]?tab=…&latest=…`。Orca の MobileSessionRouteScreen）。
 *
 * 上に自前のヘッダー（戻る・スペース名と状態の行・ファイル・ソース管理・⋯）とタブの列、下に選んだタブの中身:
 *  - エージェントのタブ: 会話表示（既定）かターミナル表示。切り替えはタブの長押しから（`useSessionView`）
 *  - ターミナルのタブ: xterm とコマンドドック
 *  - ブラウザのタブ: PC の para-browser の写し（既存の BrowserPanel）
 * タブの切り替えはクエリ（`tab`）の差し替えで行い、戻る履歴は増やさない。
 *
 * iPad の2列で画面の幅が 640pt 以上あれば、ソース管理・ファイル・メモを右にドックする（足りなければ押し進める）。
 * ドックの幅は左の縁をドラッグして変える。外付けキーボードのショートカット（⌘1〜9・⌘[ ⌘]・⌘K・⌥⌘1〜3）の
 * 受け口もここに置く。
 */
export default function SessionScreen() {
	const router = useRouter();
	// 終わった会話を開き直せる PC か（W2-29）。
	const historySupported = usePcCapability(AGENT_RESUME_CAPABILITY);
	const route = useSessionRoute();
	const { pcId, spaceId, pc, space, terminals, tab, latest, requestedTab } = route;
	const focused = useIsFocused();
	// 通知や他の画面から直接入った場合も、ホームの「再開」カードがこのセッションを指すようにする
	// （一覧から開いたときは openSession も記録するが、同じ値の上書きになるだけ）。
	// 依存は原始値だけにする（space・terminal のオブジェクトは PC からの再送で毎回作り直される）。
	const recordTerminalKey = tab.status === 'terminal' ? tab.terminal.terminalKey : undefined;
	const recordTerminalTitle = tab.status === 'terminal' ? tab.terminal.title : undefined;
	const recordSpaceName = space?.name;
	const recordBranch = space?.branch;
	const recordColor = space !== undefined ? spaceColor(space) : undefined;
	useEffect(() => {
		if (!focused || pcId === undefined || spaceId === undefined || recordSpaceName === undefined) {
			return;
		}
		useLastSession.getState().record({
			pcId,
			spaceId,
			title: recordTerminalTitle ?? recordSpaceName,
			spaceName: recordSpaceName,
			...(recordColor !== undefined ? { color: recordColor } : {}),
			...(recordTerminalKey !== undefined ? { terminalKey: recordTerminalKey } : {}),
			...(recordBranch !== undefined ? { branch: recordBranch } : {}),
		});
	}, [focused, pcId, spaceId, recordTerminalKey, recordTerminalTitle, recordSpaceName, recordBranch, recordColor]);
	const insets = useStableInsets();
	const keyboardCover = useKeyboardCoverage();
	const keyboardVisible = keyboardCover > 0;
	const bottomInset = keyboardVisible ? 0 : insets.bottom;
	const { connection, pcOnline, pairingRejected, connectRelay, createTerminal, renameTerminal, closeTerminal, setSelectedTerminalKey, terminalPrefs, setTerminalPref } = useAppStore(useShallow(s => ({
		connection: s.connection,
		pairingRejected: s.pairingRejected,
		pcOnline: s.pcOnline,
		connectRelay: s.connectRelay,
		createTerminal: s.createTerminal,
		renameTerminal: s.renameTerminal,
		closeTerminal: s.closeTerminal,
		setSelectedTerminalKey: s.setSelectedTerminalKey,
		terminalPrefs: s.terminalPrefs,
		setTerminalPref: s.setTerminalPref,
	})));

	const items = useMemo(() => buildSessionTabs(terminals), [terminals]);
	const currentKey = activeTabKey(tab);
	const current = tab.status === 'terminal' ? tab.terminal : undefined;
	const { view } = useSessionView(pcId, current?.terminalKey);
	// 開き方の設定を読み終えるまでペインを出さない（会話表示 → ターミナル表示の作り直しを避ける）。
	const viewReady = useSessionViewReady();
	const showChat = current !== undefined && current.agent === true && view === 'chat';

	const openTab = (next: SessionTab | undefined, options: { latest?: boolean } = {}) => {
		if (next?.kind === 'terminal') {
			// 旧来の部品やストアの操作（通知の抑止など）が既定の対象にしている選択も合わせる。
			setSelectedTerminalKey(next.terminalKey);
		}
		router.setParams({ tab: next !== undefined ? encodeSessionTab(next) : '', ...(options.latest === true ? { latest: createAgentLatestEntryToken() } : {}) });
	};

	// 指定なしで開いたら、既定で開いたタブをクエリへ固定する（別のエージェントが許可待ちになっても勝手に移らない）。
	const workspaceComplete = useAppStore(s => s.workspace?.complete === true);
	const pinKey = focused ? sessionTabToPin(requestedTab, tab, workspaceComplete)?.terminalKey : undefined;
	useEffect(() => {
		if (pinKey !== undefined) {
			openTab({ kind: 'terminal', terminalKey: pinKey });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 固定する鍵が決まったときだけ
	}, [pinKey]);

	// ＋やクイックコマンドで作ったターミナルは、現れたらそのタブへ移る（どの鍵になるかは PC が決める）。
	const awaitingRef = useRef<{ readonly known: ReadonlySet<string>; readonly until: number } | undefined>(undefined);
	const awaitNewTab = () => {
		awaitingRef.current = { known: new Set(terminals.map(terminal => terminal.terminalKey)), until: Date.now() + NEW_TAB_WAIT_MS };
	};
	useEffect(() => {
		const awaiting = awaitingRef.current;
		if (awaiting === undefined) {
			return;
		}
		if (Date.now() > awaiting.until) {
			awaitingRef.current = undefined;
			return;
		}
		const created = terminals.find(terminal => !awaiting.known.has(terminal.terminalKey));
		if (created !== undefined) {
			awaitingRef.current = undefined;
			openTab({ kind: 'terminal', terminalKey: created.terminalKey }, { latest: true });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 増えたときだけ見る
	}, [terminals]);

	// 他の要対応（このスペースの外も含む）。⋯ の中から次の1件を開く。
	const attention = useAppStore(useShallow(s => {
		const result = nextAttentionAgent(s.workspace?.terminals, current?.terminalKey);
		return { count: result.count, nextKey: result.next?.terminalKey, nextWs: result.next?.ws ?? s.workspace?.activeWs };
	}));
	const goNextAttention = () => {
		if (attention.nextKey === undefined || pcId === undefined) {
			return;
		}
		const nextTab: SessionTab = { kind: 'terminal', terminalKey: attention.nextKey };
		if (attention.nextWs === undefined || attention.nextWs === spaceId) {
			openTab(nextTab, { latest: true });
			return;
		}
		setSelectedTerminalKey(attention.nextKey);
		router.replace(routes.session(pcId, attention.nextWs, { tab: nextTab, latest: createAgentLatestEntryToken() }));
	};

	// ⋯ の「サブエージェント」: 開いているエージェントのタブに記録があるときだけ出す。文字列だけを選ぶ
	// （会話の中身は更新のたびに作り直されるので、そのまま購読しない）。
	const activityKey = current?.agent === true ? current.terminalKey : undefined;
	const activityHint = useAppStore(s => {
		const activity = activityKey !== undefined ? s.agentChats.get(activityKey)?.activity : undefined;
		return hasAgentActivity(activity) ? activityMenuHint(activity) : undefined;
	});
	const openActivity = () => {
		if (pcId === undefined || spaceId === undefined || activityKey === undefined) {
			return;
		}
		router.push(routes.activity(pcId, spaceId, activityKey, useAppStore.getState().agentChats.get(activityKey)?.epoch));
	};

	// シート。次のシートを開く・画面を移るのは閉じ切ってから（ActionSheet が onAfterClose で走らせる）。
	const [menuItem, setMenuItem] = useState<SessionTabItem | undefined>(undefined);
	const [menuOpen, setMenuOpen] = useState(false);
	// 名前の変更・閉じる確認は、表示フラグと対象を分ける。ConfirmDrawer は閉じる動きの後に onConfirm を
	// 呼ぶので、対象は閉じた後も持ち続ける（`features/pc/rowActions.tsx` の held と同じ形）。
	const [renaming, setRenaming] = useState<SpaceTerminal | undefined>(undefined);
	const [renameOpen, setRenameOpen] = useState(false);
	const [closing, setClosing] = useState<SpaceTerminal | undefined>(undefined);
	const [closeOpen, setCloseOpen] = useState(false);
	const [newOpen, setNewOpen] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const [quickOpen, setQuickOpen] = useState(false);

	// 右のドック（iPad の2列で、この画面が 640pt 以上あるとき）。
	const regular = useIsRegularWidth();
	const [bodyWidth, setBodyWidth] = useState(0);
	const dockable = canDockPanel(regular, bodyWidth);
	const [dockPanel, setDockPanel] = useState<DockPanel | undefined>(undefined);
	if (dockPanel !== undefined && bodyWidth > 0 && !dockable) {
		// 左の列を広げた・向きを変えたなどで足りなくなったら閉じる（Orca と同じ）。
		setDockPanel(undefined);
	}
	const savedDockWidth = useIpadLayout(s => s.dockWidth);
	const setDockWidth = useIpadLayout(s => s.setDockWidth);
	const commitWidths = useIpadLayout(s => s.commit);
	const dockWidth = dockWidthFor(savedDockWidth, bodyWidth);
	const dockDragStart = useRef(dockWidth);
	const openPanel = (panel: DockPanel) => {
		if (pcId === undefined || spaceId === undefined) {
			return;
		}
		hapticSelection();
		if (dockable) {
			setDockPanel(current => (current === panel ? undefined : panel));
			return;
		}
		router.push(panel === 'scm' ? routes.sourceControl(pcId, spaceId) : panel === 'files' ? routes.files(pcId, spaceId) : routes.note(pcId, spaceId));
	};
	// ドックから差分・ファイルへ進むときはドックを閉じる（詳細の列で押し進める決まり）。戻ってきたら同じドックを
	// 開き直す（ファイルの一覧の開いていたフォルダや位置は `fileTreeStore.ts` に退避してあるので、そのまま戻る）。
	const reopenDock = useRef<DockPanel | undefined>(undefined);
	const dockNavigate = (href: RouteHref) => {
		reopenDock.current = dockPanel;
		setDockPanel(undefined);
		router.push(href);
	};
	useEffect(() => {
		if (!focused || reopenDock.current === undefined) {
			return;
		}
		const panel = reopenDock.current;
		reopenDock.current = undefined;
		if (dockable) {
			setDockPanel(panel);
		}
	}, [focused, dockable]);
	// 2列で左の列を隠しているときは、見出しの左端に戻すボタンを出す（⌘\ でも戻せる）。
	const sidebarCollapsed = useAppStore(s => s.sidebarCollapsed);
	// 自分のいる器の詳細の列だけを見る（PC の画面が2枚積まれていても、下の画面の様子に引きずられない）。
	const detailOwned = useDetailColumnOpen(useDetailColumnKey());
	const sidebarHidden = sidebarCollapsed && regular && detailOwned;
	const setSidebarCollapsed = useAppStore(s => s.setSidebarCollapsed);

	// 外付けキーボード。前面にいるときだけ受ける（詳細の列の下に隠れたセッションは受けない）。
	const routeReady = route.status !== 'unknown' && route.spaceStatus !== 'missing';
	useShortcutSlot('session', focused && routeReady ? {
		tabCount: items.length,
		selectTab: index => {
			const item = items[index];
			if (item !== undefined) {
				hapticSelection();
				openTab(item.tab);
			}
		},
		stepTab: delta => {
			const next = items[stepIndex(items.findIndex(item => item.key === currentKey), items.length, delta)];
			if (next !== undefined) {
				hapticSelection();
				openTab(next.tab);
			}
		},
		openQuick: () => setQuickOpen(true),
		openPanel,
	} : undefined);
	useShortcutSlot('escape', focused && dockPanel !== undefined ? { escape: () => setDockPanel(undefined) } : undefined);

	// ブラウザの全画面（ブラウザのタブを開いている間だけ効かせる）。
	const browserFullscreen = useBrowserFullscreen(s => s.fullscreen) && tab.status === 'browser';

	const kind = pc !== undefined ? connectionKind(connection, pcOnline) : 'offline';
	// 資格を拒まれた PC は再接続では直らない。見出しの行から再ペアリングへ案内する（判定は pcStatus.ts）。
	const rejected = isPairingRejected({ connection, pcOnline, pairingRejected });
	const meta = kind === 'connected'
		? <><StatusDot kind={kind} /><HeaderMetaText>{`${terminals.length} タブ · ${pc?.name ?? ''}`}</HeaderMetaText></>
		: rejected ? (
			<Pressable
				style={styles.metaButton}
				hitSlop={hitSlopToMinimum(META_HEIGHT)}
				onPress={() => { hapticSelection(); router.push(routes.pair()); }}
				accessibilityRole="button"
				accessibilityLabel={`${PAIRING_REJECTED_LABEL}。押すとペアリングし直す画面を開きます`}
			>
				{/* 狭い iPhone でも切れないよう文言は短く、押せることは右の山括弧で示す。点は他の場所と同じ赤 */}
				<View style={styles.rejectedDot} />
				<HeaderMetaText>{PAIRING_REJECTED_LABEL}</HeaderMetaText>
				<Icon icon={ChevronRight} size={META_HEIGHT - 2} color={colors.red} />
			</Pressable>
		)
		: kind === 'offline' ? (
			<Pressable
				style={styles.metaButton}
				hitSlop={hitSlopToMinimum(META_HEIGHT)}
				onPress={() => { hapticSelection(); connectRelay(); }}
				accessibilityRole="button"
				accessibilityLabel="切断中。押すと再接続します"
			>
				<StatusDot kind={kind} />
				<HeaderMetaText>{`${connectionLabel(kind)} · タップで再接続`}</HeaderMetaText>
			</Pressable>
		) : <><StatusDot kind={kind} /><HeaderMetaText>{`${connectionLabel(kind)} · ${pc?.name ?? ''}`}</HeaderMetaText></>;

	const spaceLabel = space?.name ?? 'このスペース';
	const body = (() => {
		if (route.status === 'unknown') {
			return <EmptyState icon={Unplug} title="PC が見つかりません" body="ペアリングを解除した PC のスペースかもしれません。" />;
		}
		if (route.spaceStatus === 'missing') {
			return <EmptyState title="スペースが見つかりません" body="PC で閉じられたか、別の PC のスペースかもしれません。" />;
		}
		switch (tab.status) {
			case 'loading':
				return <View style={styles.center}><ActivityIndicator color={colors.textDim} /></View>;
			case 'missing':
				return historySupported && pcId !== undefined && spaceId !== undefined
					// 閉じたエージェントの会話は「過去の会話」から開き直して続きを頼める（W2-29）。
					? <EmptyState title="このタブは閉じられました" body="PC 側で閉じられたか、終了したターミナルです。エージェントの会話は「過去の会話」から続きを頼めます。" action={{ label: '過去の会話を開く', onPress: () => router.push(routes.agentHistory(pcId, spaceId)) }} />
					: <EmptyState title="このタブは閉じられました" body="PC 側で閉じられたか、終了したターミナルです。" action={{ label: 'ほかのタブを開く', onPress: () => openTab(undefined) }} />;
			case 'empty':
				return <EmptyState icon={SquareTerminal} title="ターミナルがありません" body="＋ からターミナルかエージェントを開けます。" action={{ label: 'ターミナルを開く', onPress: () => { awaitNewTab(); createTerminal(spaceId); } }} />;
			case 'browser':
				return (
					<View style={styles.fill}>
						<BrowserPanel
							active={focused}
							preferredToken={terminals.find(terminal => terminal.agentToken !== undefined)?.agentToken}
							{...(space !== undefined ? { scope: { windowId: space.windowId, ws: space.sourceId }, spaceName: space.name } : {})}
						/>
					</View>
				);
			case 'terminal':
				if (!viewReady && tab.terminal.agent === true) {
					return <View style={styles.center}><ActivityIndicator color={colors.textDim} /></View>;
				}
				return showChat
					? <AgentChatPane key={tab.terminal.terminalKey} terminal={tab.terminal} latest={latest} active={focused} bottomInset={bottomInset} />
					: <TerminalPane key={tab.terminal.terminalKey} terminal={tab.terminal} active={focused} keyboardVisible={keyboardVisible} bottomInset={bottomInset} />;
		}
	})();

	return (
		<Screen style={{ paddingBottom: keyboardCover }}>
			{/* ブラウザの全画面の間は、見出しとタブの列を高さ 0 で隠す（木の形は変えない。browserFullscreen.ts）。 */}
			<View
				style={browserFullscreen ? styles.headerHidden : undefined}
				// 高さ 0 で隠している間は、VoiceOver からも外す（見えないボタンを読み上げない・選べない）。
				accessibilityElementsHidden={browserFullscreen}
				importantForAccessibility={browserFullscreen ? 'no-hide-descendants' : 'auto'}
			>
			<ScreenHeader
				variant="session"
				surface="panel"
				title={space?.name ?? 'セッション'}
				backLabel="スペースの一覧へ戻る"
				meta={meta}
				{...(sidebarHidden ? {
					leading: (
						<HeaderButton
							icon={PanelLeftOpen}
							label="サイドバーを出す"
							round
							onPress={() => { hapticSelection(); setSidebarCollapsed(false); }}
						/>
					),
				} : {})}
				right={pcId !== undefined && spaceId !== undefined ? (
					<>
						{/* メモは iPhone では ⋯ の中。iPad の2列では見出しに出す（ドックの3つを並べる）。 */}
						{regular ? (
							<HeaderButton icon={NotebookPen} label="メモ" badge={space?.note?.open} badgeTone="neutral" active={dockPanel === 'note'} onPress={() => openPanel('note')} />
						) : null}
						<HeaderButton icon={Folder} label="ファイル" active={dockPanel === 'files'} onPress={() => openPanel('files')} />
						<HeaderButton icon={GitBranch} label="ソース管理" active={dockPanel === 'scm'} onPress={() => openPanel('scm')} />
						<HeaderButton icon={Ellipsis} label="その他の操作" badge={attention.count} onPress={() => setMoreOpen(true)} />
					</>
				) : undefined}
			>
				{route.status !== 'unknown' && route.spaceStatus !== 'missing' ? (
					<SessionTabStrip
						items={items}
						activeKey={currentKey}
						onSelect={item => openTab(item.tab)}
						onLongPress={item => {
							if (item.kind === 'terminal') {
								setMenuItem(item);
								setMenuOpen(true);
							}
						}}
						onNew={() => setNewOpen(true)}
						onQuick={() => setQuickOpen(true)}
					/>
				) : null}
			</ScreenHeader>
			</View>
			<View style={styles.row} onLayout={event => setBodyWidth(event.nativeEvent.layout.width)}>
				<View style={styles.main}>{body}</View>
				{/* ドックの枠は常に置き、幅で出し入れする（本文の位置を変えないため）。 */}
				<View style={[styles.dock, dockPanel !== undefined ? [styles.dockOpen, { width: dockWidth }] : undefined]}>
					{dockPanel !== undefined && pcId !== undefined && spaceId !== undefined ? (
						<SessionDock
							key={dockPanel}
							panel={dockPanel}
							target={{ pcId, spaceId }}
							dock={{ close: () => setDockPanel(undefined), navigate: dockNavigate }}
						/>
					) : null}
				</View>
				{dockPanel !== undefined ? (
					<ColumnResizeHandle
						x={bodyWidth - dockWidth}
						label="ドックの幅"
						onStart={() => { dockDragStart.current = dockWidth; }}
						onMove={dx => setDockWidth(dockDragStart.current - dx)}
						onEnd={commitWidths}
						onStep={delta => { setDockWidth(dockWidth - delta); commitWidths(); }}
					/>
				) : null}
			</View>

			{menuItem !== undefined ? (
				<TabMenu
					visible={menuOpen}
					item={menuItem}
					pcId={pcId}
					phoneWidth={terminalPrefs.matchPcWidth}
					onToggleWidth={() => setTerminalPref('matchPcWidth', !terminalPrefs.matchPcWidth)}
					onShow={() => openTab(menuItem.tab)}
					onRename={terminal => { setRenaming(terminal); setRenameOpen(true); }}
					onCloseTerminal={terminal => { setClosing(terminal); setCloseOpen(true); }}
					onClose={() => setMenuOpen(false)}
				/>
			) : null}
			<TextInputDrawer
				visible={renameOpen}
				title="ターミナルの名前を変更"
				defaultValue={renaming?.title ?? ''}
				onSubmit={name => { if (renaming !== undefined) { renameTerminal(renaming.terminalKey, name); } }}
				onClose={() => setRenameOpen(false)}
			/>
			<ConfirmDrawer
				visible={closeOpen}
				title={`「${closing?.title ?? ''}」を閉じますか？`}
				message="PC の Para Code でも閉じます。この操作は取り消せません。"
				confirmLabel="閉じる"
				onConfirm={() => {
					if (closing === undefined) {
						return;
					}
					const closingKey = encodeSessionTab({ kind: 'terminal', terminalKey: closing.terminalKey });
					if (closingKey === currentKey) {
						openTab(tabAfterClose(items, closingKey, currentKey));
					}
					closeTerminal(closing.terminalKey);
				}}
				onClose={() => setCloseOpen(false)}
			/>
			<ActionSheet
				visible={newOpen}
				title="新しいタブ"
				actions={newTabActions({
					claudeLeading: <ProviderLogo provider="claude" size={16} />,
					codexLeading: <ProviderLogo provider="codex" size={16} />,
					onTerminal: () => { awaitNewTab(); createTerminal(spaceId); },
					onAgent: agent => {
						if (spaceId === undefined) {
							return;
						}
						awaitNewTab();
						launchAgentInBackground({
							agentLabel: agent === 'claude' ? 'Claude' : 'Codex',
							subtitle: space?.branch !== undefined ? `${spaceLabel} · ${space.branch}` : spaceLabel,
							agent,
							ws: spaceId,
						});
					},
					onBrowser: () => openTab({ kind: 'browser' }),
				})}
				onClose={() => setNewOpen(false)}
			/>
			<ActionSheet
				visible={moreOpen}
				title={spaceLabel}
				message={space?.branch}
				actions={moreActions({
					attentionCount: attention.count,
					onNextAttention: goNextAttention,
					onReview: () => { if (pcId !== undefined && spaceId !== undefined) { router.push(routes.review(pcId, spaceId)); } },
					noteOpen: space?.note?.open ?? 0,
					onNote: () => openPanel('note'),
					...(activityHint !== undefined ? { activityHint, onActivity: openActivity } : {}),
					...(historySupported && pcId !== undefined && spaceId !== undefined ? { onHistory: () => router.push(routes.agentHistory(pcId, spaceId)) } : {}),
				})}
				onClose={() => setMoreOpen(false)}
			/>
			<QuickCommandsDrawer
				visible={quickOpen}
				ws={spaceId}
				wsLabel={spaceLabel}
				onRan={awaitNewTab}
				onClose={() => setQuickOpen(false)}
			/>
		</Screen>
	);
}

/** タブの長押しメニュー。表示の切り替えは長押ししたタブのもの（開いているタブとは限らない）。 */
function TabMenu({ visible, item, pcId, phoneWidth, onToggleWidth, onShow, onRename, onCloseTerminal, onClose }: {
	visible: boolean;
	item: SessionTabItem;
	pcId: string | undefined;
	phoneWidth: boolean;
	onToggleWidth: () => void;
	/** 表示を切り替えたあと、そのタブを開く。 */
	onShow: () => void;
	onRename: (terminal: SpaceTerminal) => void;
	onCloseTerminal: (terminal: SpaceTerminal) => void;
	onClose: () => void;
}) {
	const terminal = item.kind === 'terminal' ? item.terminal : undefined;
	const { view, setView } = useSessionView(pcId, terminal?.terminalKey);
	const agent = item.kind === 'terminal' && item.agent;
	return (
		<ActionSheet
			visible={visible}
			title={item.title}
			message={tabMenuMessage(item, agent ? view : undefined)}
			actions={tabMenuActions(item, {
				view: agent ? view : undefined,
				phoneWidth,
				onToggleView: () => { setView(otherSessionView(view)); onShow(); },
				onToggleWidth,
				onRename: () => { if (terminal !== undefined) { onRename(terminal); } },
				onClose: () => { if (terminal !== undefined) { onCloseTerminal(terminal); } },
			})}
			onClose={onClose}
		/>
	);
}

const styles = StyleSheet.create({
	fill: {
		flex: 1,
	},
	headerHidden: {
		height: 0,
		overflow: 'hidden',
	},
	row: {
		flex: 1,
		flexDirection: 'row',
	},
	main: {
		flex: 1,
		minWidth: 0,
	},
	dock: {
		width: 0,
		overflow: 'hidden',
	},
	dockOpen: {
		borderLeftWidth: 1,
		borderLeftColor: colors.border,
	},
	center: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
	},
	metaButton: {
		flexDirection: 'row',
		alignItems: 'center',
		minHeight: META_HEIGHT,
	},
	rejectedDot: {
		width: 8,
		height: 8,
		borderRadius: 4,
		marginRight: 5,
		backgroundColor: colors.red,
	},
});
