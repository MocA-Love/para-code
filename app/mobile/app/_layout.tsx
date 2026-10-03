// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { DarkTheme, Stack, ThemeProvider, useNavigationContainerRef, useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import * as Sentry from '@sentry/react-native';
import { useAppStore } from '../src/appState.js';
import { openPcRoute } from '../src/features/pc/openPcRoute.js';
import { AuthGate } from '../src/components/authGate.js';
import { OverlayHost } from '../src/components/overlayHost.js';
import { UpdateSheetHost } from '../src/components/updateSheet.js';
import { AgentSendQueueRunner } from '../src/agentSendQueue.js';
import { NotificationActionRunner, queueNotificationAction } from '../src/notificationActionRunner.js';
import { readNotificationAction } from '../src/notificationActions.js';
import { trayDateMs } from '../src/notificationTray.js';
import { ToastHost } from '../src/ui/toast.js';
import { DevProbe } from '../src/devProbe.js';
import { DevWidthFrame } from '../src/dev/devWidthFrame.js';
import { useIpadLayout } from '../src/ipad/ipadLayoutStore.js';
import { ShortcutHost } from '../src/ipad/shortcutHost.js';
import { startLiveActivitySync } from '../src/liveActivitySync.js';
import { startWidgetSync } from '../src/widgets/widgetSync.js';
import { colors } from '../src/theme.js';
import { createAgentLatestEntryToken } from '../src/agentNavigation.js';
import { reportMobileDiagnosticError } from '../src/mobileDiagnostics.js';
import { useParaToast } from '../src/paraToast.js';
import { notificationDestination, notificationNavigationDecision, pendingNotificationWait, readNotificationDeepLink, readNotificationInteractionId, type NotificationDeepLinkData } from '../src/notificationNavigation.js';
import { loadSessionViewSettings } from '../src/features/session/useSessionView.js';
import { useQuickReplies } from '../src/features/settings/quickRepliesStore.js';
import { loadThemeColors } from '../src/features/settings/themeColorSettings.js';
import { useHapticPreference } from '../src/hapticPreference.js';

/**
 * 深いルート（通知から開いたセッションなど）をいきなり開いたときも、下にホームを敷く。
 * 戻る操作でアプリの外へ落ちずにホームへ戻れるように。
 */
export const unstable_settings = { initialRouteName: 'index' };

/**
 * このアプリは常時ダークテーマのみ（ライトモード非対応）。expo-routerの既定テーマは
 * ライト（白背景）のため、これを明示的に上書きしないと画面遷移時や初回レンダリング時に
 * ネイティブ側のデフォルト背景（白）が一瞬見えてしまう。
 */
/** 開発ビルドだけ、アプリの幅を狭めて見せる枠で包む（`src/dev/devWidthFrame.tsx`）。 */
const RootFrame = __DEV__ ? DevWidthFrame : Fragment;

const appTheme = {
	...DarkTheme,
	colors: {
		...DarkTheme.colors,
		primary: colors.accent,
		background: colors.bg,
		card: colors.panel,
		text: colors.text,
		border: colors.border,
	},
};

/**
 * ルートレイアウト。起動時にコントローラを初期化し、OS 標準の Stack だけを持つ
 * （作り直し計画の段階2。Orca と同じ「PC → スペース → セッション」の押し進む階層で、
 * ヘッダーは各画面が自前の `ScreenHeader` で描く。ルートの一覧は `src/routes.ts`）。
 *
 * OS通知（ローカル/リモート双方）のタップを、そのエージェントのスペースのセッション
 * （そのエージェントのタブ）へのディープリンクに変換する。起動直後の最初の解除の前に届いた場合は、
 * 解除まで遷移を保留する。猶予切れの再ロック中に届いたものは保留しない（下の画面で遷移し、
 * ロック画面が覆うだけ。AuthGate はロック中も画面を木に残すので、解除すると通知元の画面が見える）。
 */
function RootLayout() {
	const router = useRouter();
	const container = useNavigationContainerRef();
	const init = useAppStore(s => s.init);
	const setSelectedWs = useAppStore(s => s.setSelectedWs);
	const setSelectedTerminalKey = useAppStore(s => s.setSelectedTerminalKey);
	const [unlocked, setUnlocked] = useState(false);
	// tryNavigateから常に最新値を読むためのref（tryNavigate自体をunlockedに依存させると
	// 参照が変わるたびにリスナーeffectを再登録することになり、stale closure対策として
	// 依存を空にした場合に「登録時点のunlocked」を永久キャプチャしてしまうため）。
	// 「一度でも解除したか」を表し、再ロックでは false に戻さない。AuthGate はロック中も Stack を
	// 木に残し、ロック画面で覆うだけなので、再ロック中の遷移は下で済ませておけばよい（解除後にそのまま
	// 見える）。戻して保留にすると、解除に手間取る間に保留の期限（pendingNotificationWait）が切れて
	// 通知の画面が開かなくなる。最初の解除までは保留する（認証前に PC の切り替えなどを始めない）。
	const unlockedRef = useRef(false);
	// workspace は通知タップの遷移判定にしか使わないため、セレクタで購読せずストアの変化を
	// 直接受けて ref を更新する。ここで購読すると、PCからのstate再送（エージェント実行中は
	// 最大10Hz）のたびにナビゲーションツリー全体—Stackと全Screen、OverlayHost、
	// UpdateSheetHost—が丸ごと再構築される。
	const workspaceRef = useRef(useAppStore.getState().workspace);
	const pendingRef = useRef<NotificationDeepLinkData | undefined>(undefined);
	// 保留中の通知のために、どのPCへ自動で切り替えたか（同じ保留で二度は切り替えない）。
	const switchedForPendingRef = useRef<string | undefined>(undefined);
	// 保留中の通知の判断を始めた時刻（解除と台帳の読み込みの後の最初の判断）。待ちすぎたら保留を捨てる（`pendingNotificationWait`）。
	const pendingWaitSinceRef = useRef<number | undefined>(undefined);

	useEffect(() => {
		// 失敗は initError へ記録され、ゲートが「起動に失敗しました」と再試行を出す。未処理の拒否にはせず、
		// 診断には送る。
		void init().catch((error: unknown) => reportMobileDiagnosticError('app', 'init', error)).finally(() => Sentry.appLoaded());
		startLiveActivitySync();
		// ホーム画面・ロック画面のウィジェットへ要約を書き出す（前面の間と、バックグラウンドへ移るとき）。
		startWidgetSync();
		// セッションの開き方（会話表示かターミナル表示か）は、セッション画面を開く前に読み終えておく。
		loadSessionViewSettings();
		// 設定 → 色で変えた色は、最初の画面を描くときから当てる。
		void loadThemeColors();
		// 会話画面を開いた瞬間にクイック返信の行が遅れて出ないよう、起動時に読んでおく。
		useQuickReplies.getState().load();
		// iPad の2列の幅（左の列・ドック）。最初に2列を描くときに保存した幅で出す。
		useIpadLayout.getState().load();
		// 触覚フィードバックのオン / オフ（読み終えるまでは既定のオン）。
		void useHapticPreference.getState().load();
	}, [init]);

	const tryNavigate = useCallback(() => {
		const target = pendingRef.current;
		if (!unlockedRef.current || !target) {
			return;
		}
		const store = useAppStore.getState();
		// 通知タップで起動した場合、ここは台帳の読み込み前に一度走る。PCが1台も見えていない
		// うちに判断すると、正当な通知まで「知らないPC」として捨ててしまう。
		if (!store.ready) {
			return;
		}
		// 保留が長すぎたら、どの分かれ道より先に捨てる。この関数はストアが変わったときにしか呼ばれないので、
		// PC が長く繋がらずに後で全体が届くと、ここで捨てない限りその瞬間に古い通知の先へ飛んでしまう。
		const wait = pendingNotificationWait(pendingWaitSinceRef.current, Date.now());
		if (wait.expired) {
			pendingRef.current = undefined;
			pendingWaitSinceRef.current = undefined;
			// 通知の PC へ切り替えた後に、自分で別の PC へ戻していたなら、つながらなかったせいではない。
			const leftTargetPc = target.pcId !== undefined && target.pcId !== store.activePcId && switchedForPendingRef.current === target.pcId;
			useParaToast.getState().show({ key: 'notification-tap-expired', text: '通知の画面は開きませんでした', sub: leftTargetPc ? '通知の PC から別の PC へ切り替えたためです' : 'PC の状態が届くまでに時間がかかったためです', icon: 'time-outline', tone: 'info' }, 3_000);
			return;
		}
		pendingWaitSinceRef.current = wait.waitingSince;
		if (target.pcId !== undefined && target.pcId !== store.activePcId) {
			// 台帳に無いPC（ペアリングを解除した後に届いたプッシュ）の通知は捨てる。
			// いま見ているPCの一覧に対して遷移先を探すと、別のPCの話で画面が動く。
			if (!store.pcs.some(pc => pc.id === target.pcId)) {
				pendingRef.current = undefined;
				return;
			}
			// 別のPCから届いた通知なら、まずそのPCへ切り替える。切り替えるとワークスペースが
			// 差し替わるので、その変化を受けてこの関数がもう一度呼ばれ、続きの遷移が走る。
			//
			// 切り替えを試すのは1回だけにする。対象のターミナルが現れるまで保留は残るので、
			// 毎回撃つと「ユーザーが手で別のPCへ戻す → 通知のPCへ引き戻される」を繰り返し、
			// 告知の『戻る』が効かなくなる。
			if (switchedForPendingRef.current === target.pcId) {
				return;
			}
			switchedForPendingRef.current = target.pcId;
			store.switchPcWithReturn(target.pcId);
			return;
		}
		const currentWorkspace = workspaceRef.current;
		const decision = notificationNavigationDecision(currentWorkspace, target.terminalKey);
		if (decision === 'wait') {
			return;
		}
		if (decision === 'missing' || currentWorkspace === undefined || target.terminalKey === undefined) {
			pendingRef.current = undefined;
			return;
		}
		pendingRef.current = undefined;
		const pcId = target.pcId ?? store.activePcId;
		if (pcId === undefined) {
			return;
		}
		const destination = notificationDestination(currentWorkspace, pcId, target.terminalKey, target.ws, createAgentLatestEntryToken());
		// 行き先はルートのクエリで伝えるが、旧来の部品やストアの操作が既定の対象にしている
		// 選択も合わせておく。setSelectedWs は selectedTerminalKey をリセットするため、この順序を厳守する。
		if (destination.spaceId !== undefined) {
			setSelectedWs(destination.spaceId);
		}
		setSelectedTerminalKey(target.terminalKey);
		// PC の中を開いているなら、その中で開く（同じ PC の器は増やさない。`openPcRoute`）。
		openPcRoute(router, container, destination.href, 'focus');
	}, [router, container, setSelectedWs, setSelectedTerminalKey]);

	useEffect(() => {
		unlockedRef.current = unlocked;
		tryNavigate();
	}, [unlocked, tryNavigate]);

	// 保留中の遷移は「対象のターミナルがstateに現れるまで待つ」ので、workspaceの変化を
	// 取りこぼすと通知タップが永久に保留になる。再描画を伴わない購読でそれを拾う。
	// 台帳の読み込み完了（ready）とPCの切り替えも契機にする。通知タップで起動したときは
	// workspaceより先にこれらが決まるため、見ていないと最初の1回を取りこぼす。
	useEffect(() => {
		const initial = useAppStore.getState();
		workspaceRef.current = initial.workspace;
		let ready = initial.ready;
		let activePcId = initial.activePcId;
		tryNavigate();
		return useAppStore.subscribe(state => {
			if (state.workspace === workspaceRef.current && state.ready === ready && state.activePcId === activePcId) {
				return;
			}
			workspaceRef.current = state.workspace;
			ready = state.ready;
			activePcId = state.activePcId;
			tryNavigate();
		});
	}, [tryNavigate]);

	useEffect(() => {
		const handleResponse = (response: Notifications.NotificationResponse) => {
			// プッシュは中身が trigger.payload、ローカル通知は content.data にある（readNotificationDeepLink）。
			const link = readNotificationDeepLink(response.notification.request);
			pendingRef.current = link;
			switchedForPendingRef.current = undefined;
			pendingWaitSinceRef.current = undefined;
			// 通知のボタン（許可・拒否・返信）は、遷移と同じ通知の先へ、アプリのロックが解けてから送る
			// （notificationActionRunner.ts）。ロックされたまま裏で送ることはしない。
			const action = readNotificationAction(response.actionIdentifier, response.userText);
			const pcId = link?.pcId ?? useAppStore.getState().activePcId;
			if (action !== undefined && link?.terminalKey !== undefined && pcId !== undefined) {
				const interactionId = readNotificationInteractionId(response.notification.request);
				queueNotificationAction(`${response.notification.request.identifier}\n${response.actionIdentifier}`, {
					pcId, terminalKey: link.terminalKey, request: action,
					at: Number.isFinite(response.notification.date) ? trayDateMs(response.notification.date) : Date.now(),
					queuedAt: Date.now(),
					...(interactionId !== undefined ? { interactionId } : {}),
				});
			}
			// 受け取った応答は消す（次の起動で getLastNotificationResponseAsync から同じボタンの操作をもう一度送らないように）。
			void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
			tryNavigate();
		};
		const sub = Notifications.addNotificationResponseReceivedListener(handleResponse);
		// コールドスタート（通知タップでアプリが起動された）対応。取り出したら消す（次の起動で同じボタンの操作を
		// もう一度送らないように）。
		void Notifications.getLastNotificationResponseAsync().then(response => {
			if (response) {
				handleResponse(response);
			}
		});
		return () => sub.remove();
	}, [tryNavigate]);

	const handleUnlock = useCallback(() => setUnlocked(true), []);

	return (
		// GestureHandlerRootView: 画面の中のスワイプ（行のスワイプ操作など）のネイティブジェスチャ認識に必須
		<GestureHandlerRootView style={styles.root}>
			{/* 開発ビルドだけ、表示中の画面をデバッガから読めるようにする（__DEV__ は実行中に変わらない） */}
			{__DEV__ ? <DevProbe /> : null}
			<RootFrame>
			<ThemeProvider value={appTheme}>
				<AuthGate onUnlock={handleUnlock}>
					{/* OS 標準の Stack だけ。**OS のナビゲーションバーは出さない**——各画面が
					    `src/ui/screenHeader.tsx` の自前ヘッダー（戻る 36pt の円＋タイトル）を描く。
					    画面ごとの登録（Stack.Screen）は置かず、段階3〜6の担当が画面のファイルを
					    足すだけで並ぶようにしている。シートは画面の中の BottomDrawer で出す
					    （`presentation: 'modal'` の画面は作らない）。 */}
					<Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
					{/* 旧来の部品が使うメニュー/ダイアログの描画先（overlayHost.tsx参照）。
					    ロック画面の下の層に描くため、AuthGateの内側に置く */}
					<OverlayHost />
					{/* 更新後の初回起動でだけ出るお知らせ。ロック中は出さない（useAppLocked を読む） */}
					<UpdateSheetHost />
					{/* PC に届かない間に預かったエージェントへの送信を、つながったら送る（W2-29）。何も描かない。
					    ロック中は送らない（useAppLocked を読む） */}
					<AgentSendQueueRunner />
					{/* 通知のボタン（許可・拒否・返信）を、ロックが解けてから送る。何も描かない（useAppLocked を読む） */}
					<NotificationActionRunner />
					{/* 一時的なお知らせ（PC切替・起動完了）を出す唯一の場所。ロック中は出さない（useAppLocked を読む） */}
					<ToastHost />
					{/* iPad の外付けキーボードのショートカット。ロック中は効かない（useAppLocked を読む） */}
					<ShortcutHost />
				</AuthGate>
			</ThemeProvider>
			</RootFrame>
		</GestureHandlerRootView>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1 },
});

export default Sentry.wrap(RootLayout);
