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
import { ParaToastHost } from '../src/components/paraToast.js';
import { ParaHeaderLayer } from '../src/components/paraHeaderLayer.js';
import { WsDrawerLayout } from '../src/components/wsDrawer.js';
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
					{/* ワークスペースドロワーはここで1回だけ包む。**`Stack` と常設のヘッダー層を
					    まとめて**包むのが要点——開いたときにどくのは「画面の中身」だけでなく
					    ヘッダーも含めた全部でないと、浮いているヘッダーがドロワーの上に残る
					    （X等と同じで、スライドするのは画面まるごと）。
					    タブ以外の画面では錠が掛かる（左端スワイプは「戻る」に使う）。 */}
					<WsDrawerLayout>
					{/* 設定まわり（設定・使用量各種・PC詳細・更新履歴・ターミナル設定）は
					    `app/(settings)/` のネストしたスタックにまとめてある。ここではその入口を
					    モーダルとして1つ出すだけで、中の移動は向こうのスタックが水平pushで行う。

					    **子画面をここへ直接並べて `presentation: 'card'` を付けてはいけない。**
					    react-native-screens の `RNSScreenStack.mm` の `updateContainer` は、
					    `Push` の画面を手前にモーダルがあっても必ずベースのナビゲーション
					    コントローラへ積む。設定モーダルの裏に隠れて何も起きなくなる。
					    expo-router が「モーダル以降は全部モーダル扱い」に伝播させているのも、
					    モーダルの上に積むための意図的な仕様であって回避対象ではない。 */}
					{/* ヘッダーの地色は画面ごとに決める。**既定に任せてはいけない**——iOSの標準の
					    ダークグレー（#1c1c1e相当）になり、本文の #050506 との境目が帯として見える
					    （実機で確認済み）。バー項目のガラスはバーの地色とは別なので、地色を
					    本文と揃えてもモーフも器も失われない。 */}
					<Stack screenOptions={{ headerTintColor: colors.text, contentStyle: { backgroundColor: colors.bg } }}>
						{/* タブのバーは**フォーカスされているタブが書き込む**（`useWsHeader`）。
						    ここでは伏せておき、画面が中身を登録したときに出す——順番が逆だと、
						    まだ中身の無いバーが1フレーム見える。 */}
						<Stack.Screen name="(tabs)" options={{ headerShown: false, headerStyle: { backgroundColor: colors.bg }, headerShadowVisible: false }} />
						<Stack.Screen name="pair" options={{ title: 'Para Code と接続', presentation: 'modal', headerStyle: { backgroundColor: colors.panel } }} />
						{/* エージェント詳細。ホームの一覧・通知タップから開く（旧エージェントタブの後継）。
						    **バーはOS標準に任せる**（画面が `useNativeScreenHeader` で登録する）。
						    **ここを `headerShown: false` にしてはいけない。** 中身を入れるのは画面側なので
						    「まだ中身の無いバーが1フレーム見える」のを避けたくなるが、伏せるとホームの島が
						    丸い戻るボタンへ変わる動きが**出る回と出ない回に分かれる**。
						    `react-native-screens` の `RNSScreenStackHeaderConfig.mm` は、バーを出すときに
						    `animated && ... && !wasHidden` でしか `animateAlongsideTransition` に乗せない
						    ——直前にバーが隠れていた遷移は「共有されたバーが無い」と見なし、アニメーション
						    ブロックを一切走らせない。ここで伏せると push の瞬間に一度バーが隠れるので、
						    画面側が `headerShown: true` を書くのが遷移の開始に間に合わなかった回だけ
						    モーフが死ぬ、というレースになる。
						    バーは最初から出しておき、中身だけを画面が差し替える。地色は本文と同じなので、
						    中身が入るまでの1フレームは「何も無い上端」に見えるだけで目立たない。 */}
						<Stack.Screen name="agent" options={{ headerShown: true, title: '', headerStyle: { backgroundColor: colors.bg }, headerShadowVisible: false }} />
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
						{/* ブラウザ（para-browserミラー）。エージェント詳細ヘッダーのボタンから開く（旧ブラウザタブの後継）。
						    バーはOS標準に任せる（画面が `NativeScreenHeader` で中身を登録する）。
						    **`animation` は既定のままにする。** `slide_from_right` は
						    `RNSScreenStackAnimator` の自前アニメーションで、UIKit標準の push ではないため
						    ナビゲーションバーの項目が連動しない（＝バー項目の変化がモーフしない）。
						    見た目はどちらも右からのスライドなので、標準に任せて連動を取る。
						    `headerShown: false` にしないのは agent と同じ理由（上の説明を読むこと）。 */}
						<Stack.Screen name="browser" options={{ headerShown: true, title: '', headerStyle: { backgroundColor: colors.bg }, headerShadowVisible: false }} />
						{/* アーカイブ一覧。ホームヘッダーの箱アイコンから開く */}
						<Stack.Screen name="archive" options={{ headerShown: false, animation: 'slide_from_right' }} />
					</Stack>
					{/* **全画面で共有する唯一のヘッダー。** 各画面は `useParaHeader()` で仕様を
					    書き込むだけで、Viewはここのものが使い回される——だから遷移でガラスの器が
					    生き残り、枠の変化が融合になる（src/paraHeader.ts 参照）。
					    `Stack` の後ろに置くことで前面に出る。ネイティブのモーダル（設定・
					    ペアリング）はこの層より前面に presented されるので覆われない。 */}
					<ParaHeaderLayer />
					</WsDrawerLayout>
					</IpadShell>
					{/* glass対応メニュー/ダイアログの描画先（overlayHost.tsx参照）。
					    再ロック時にロック画面より上へ残らないよう、AuthGateの内側に置く */}
					<OverlayHost />
					{/* 更新後の初回起動でだけ出るお知らせ。ロック中に出ないようAuthGateの内側に置く */}
					<UpdateSheetHost />
					{/* 一時的なお知らせ（PC切替・起動完了）を出す唯一の場所。**ドロワーの外**に置く
					    ——通知バナーは画面の状態と関係なく最前面に浮くものなので、ドロワーと一緒に
					    どく必要がない。継続する状態（再接続中・オフライン）はここではなく島の中で
					    示す（src/offlineNotice.ts）。ロック中に出さないようAuthGateの内側に置く */}
					<ParaToastHost />
				</AuthGate>
			</ThemeProvider>
		</GestureHandlerRootView>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1 },
});

export default Sentry.wrap(RootLayout);
