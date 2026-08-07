// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { DarkTheme, Stack, ThemeProvider, useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import * as Sentry from '@sentry/react-native';
import { useAppStore } from '../src/appState.js';
import { AuthGate } from '../src/components/authGate.js';
import { OverlayHost } from '../src/components/overlayHost.js';
import { UpdateSheetHost } from '../src/components/updateSheet.js';
import { PcSwitchNotice } from '../src/components/pcSwitcher.js';
import { IpadShell } from '../src/ipad/ipadShell.js';
import { startLiveActivitySync } from '../src/liveActivitySync.js';
import { colors } from '../src/theme.js';
import { createAgentLatestEntryToken } from '../src/agentNavigation.js';
import { notificationNavigationDecision } from '../src/notificationNavigation.js';

/**
 * notify通知(platform.tsのpresentLocalNotification)が積むペイロード形状。
 * `pcId` はどのPCから届いた通知かで、アプリ未起動時のプッシュでは通知拡張
 * (ios/NotifyExtension) が復号できた鍵の名前から補う。
 */
interface NotificationDeepLinkData {
	ws?: string;
	terminalKey?: string;
	agentToken?: string;
	pcId?: string;
}

/**
 * このアプリは常時ダークテーマのみ（ライトモード非対応）。expo-routerの既定テーマは
 * ライト（白背景）のため、これを明示的に上書きしないとNativeTabsの画面遷移時や
 * 初回レンダリング時にネイティブ側のデフォルト背景（白）が一瞬見えてしまう
 * （iOS 26ではNativeTabs.Triggerのcontentstyle.backgroundColorがコンテンツにより
 * 自動決定され上書きできないため、テーマ側で合わせる必要がある）。
 */
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
 * ルートレイアウト。起動時にコントローラを初期化し、タブ群とペアリングモーダルを持つ。
 * OS通知（ローカル/リモート双方）のタップをエージェント画面へのディープリンクに変換する。
 * AuthGateでロック中に届いた場合は解除まで遷移を保留する。
 */
function RootLayout() {
	const router = useRouter();
	const init = useAppStore(s => s.init);
	const setSelectedWs = useAppStore(s => s.setSelectedWs);
	const setSelectedTerminalKey = useAppStore(s => s.setSelectedTerminalKey);
	const [unlocked, setUnlocked] = useState(false);
	// tryNavigateから常に最新値を読むためのref（tryNavigate自体をunlockedに依存させると
	// 参照が変わるたびにリスナーeffectを再登録することになり、stale closure対策として
	// 依存を空にした場合に「登録時点のunlocked」を永久キャプチャしてしまうため）。
	const unlockedRef = useRef(false);
	// workspace は通知タップの遷移判定にしか使わないため、セレクタで購読せずストアの変化を
	// 直接受けて ref を更新する。ここで購読すると、PCからのstate再送（エージェント実行中は
	// 最大10Hz）のたびにナビゲーションツリー全体—Stackと全Screen、OverlayHost、
	// UpdateSheetHost—が丸ごと再構築される。
	const workspaceRef = useRef(useAppStore.getState().workspace);
	const pendingRef = useRef<NotificationDeepLinkData | undefined>(undefined);
	// 保留中の通知のために、どのPCへ自動で切り替えたか（同じ保留で二度は切り替えない）。
	const switchedForPendingRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		void init().finally(() => Sentry.appLoaded());
		startLiveActivitySync();
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
		// setSelectedWs は selectedTerminalKey をリセットするため、この順序を厳守する。
		if (target.ws) {
			setSelectedWs(target.ws);
		}
		setSelectedTerminalKey(target.terminalKey);
		router.push({ pathname: '/agent', params: { latest: createAgentLatestEntryToken() } });
	}, [router, setSelectedWs, setSelectedTerminalKey]);

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
		const sub = Notifications.addNotificationResponseReceivedListener(response => {
			pendingRef.current = response.notification.request.content.data as NotificationDeepLinkData;
			switchedForPendingRef.current = undefined;
			tryNavigate();
		});
		// コールドスタート（通知タップでアプリが起動された）対応
		void Notifications.getLastNotificationResponseAsync().then(response => {
			if (response) {
				pendingRef.current = response.notification.request.content.data as NotificationDeepLinkData;
				switchedForPendingRef.current = undefined;
				tryNavigate();
			}
		});
		return () => sub.remove();
	}, [tryNavigate]);

	const handleUnlock = useCallback(() => setUnlocked(true), []);

	return (
		// GestureHandlerRootView: ワークスペースドロワー（ReanimatedDrawerLayout）の
		// ネイティブジェスチャ認識に必須
		<GestureHandlerRootView style={styles.root}>
			<ThemeProvider value={appTheme}>
				<AuthGate onUnlock={handleUnlock}>
					{/* iPadの広い幅では左にワークスペースサイドバーを常設し、このスタック全体を
					    右カラムへ収める。iPhone・狭い幅では素通しで従来どおり全幅に描画される */}
					<IpadShell>
					{/* 設定まわり（設定・使用量各種・PC詳細・更新履歴・ターミナル設定）は
					    `app/(settings)/` のネストしたスタックにまとめてある。ここではその入口を
					    モーダルとして1つ出すだけで、中の移動は向こうのスタックが水平pushで行う。

					    **子画面をここへ直接並べて `presentation: 'card'` を付けてはいけない。**
					    react-native-screens の `RNSScreenStack.mm` の `updateContainer` は、
					    `Push` の画面を手前にモーダルがあっても必ずベースのナビゲーション
					    コントローラへ積む。設定モーダルの裏に隠れて何も起きなくなる。
					    expo-router が「モーダル以降は全部モーダル扱い」に伝播させているのも、
					    モーダルの上に積むための意図的な仕様であって回避対象ではない。 */}
					<Stack screenOptions={{ headerStyle: { backgroundColor: colors.panel }, headerTintColor: colors.text, contentStyle: { backgroundColor: colors.bg } }}>
						<Stack.Screen name="(tabs)" options={{ headerShown: false }} />
						<Stack.Screen name="pair" options={{ title: 'Para Code と接続', presentation: 'modal' }} />
						{/* エージェント詳細。ホームの一覧・通知タップから開く（旧エージェントタブの後継） */}
						<Stack.Screen name="agent" options={{ headerShown: false }} />
						<Stack.Screen name="agent-activity" options={{ headerShown: false, animation: 'slide_from_right' }} />
						<Stack.Screen name="agent-activity-detail" options={{ headerShown: false, animation: 'slide_from_right' }} />
						{/* 通知一覧。ベルからのズーム遷移（Link.AppleZoom）で開くため独自ヘッダーを使う */}
						<Stack.Screen name="notifications" options={{ headerShown: false }} />
						{/* スペースのメモ。ドロワーのメモボタンから同じくズーム遷移で開く */}
						<Stack.Screen name="space-note" options={{ headerShown: false }} />
						{/* エージェント起動フォーム。ホームヘッダーの＋から同じくズーム遷移で開く */}
						<Stack.Screen name="agent-launch" options={{ headerShown: false }} />
						{/* 設定まわり一式（ネストStack）。ワークスペースドロワーの設定アイコンから開く */}
						<Stack.Screen name="(settings)" options={{ headerShown: false, presentation: 'modal' }} />
						{/* ブラウザ（para-browserミラー）。エージェント詳細ヘッダーのボタンから開く（旧ブラウザタブの後継） */}
						<Stack.Screen name="browser" options={{ headerShown: false, animation: 'slide_from_right' }} />
						{/* アーカイブ一覧。ホームヘッダーの箱アイコンから開く */}
						<Stack.Screen name="archive" options={{ headerShown: false, animation: 'slide_from_right' }} />
					</Stack>
					</IpadShell>
					{/* glass対応メニュー/ダイアログの描画先（overlayHost.tsx参照）。
					    再ロック時にロック画面より上へ残らないよう、AuthGateの内側に置く */}
					<OverlayHost />
					{/* 更新後の初回起動でだけ出るお知らせ。ロック中に出ないようAuthGateの内側に置く */}
					<UpdateSheetHost />
					{/* 通知タップで別のPCへ切り替わったときの告知（ロック中に出さないよう内側に置く） */}
					<PcSwitchNotice />
				</AuthGate>
			</ThemeProvider>
		</GestureHandlerRootView>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1 },
});

export default Sentry.wrap(RootLayout);
