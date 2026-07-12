// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { DarkTheme, Stack, ThemeProvider, useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Notifications from 'expo-notifications';
import { useAppStore } from '../src/appState.js';
import { AuthGate } from '../src/components/authGate.js';
import { OverlayHost } from '../src/components/overlayHost.js';
import { startLiveActivitySync } from '../src/liveActivitySync.js';
import { colors } from '../src/theme.js';

/** notify通知(platform.tsのpresentLocalNotification)が積むペイロード形状。 */
interface NotificationDeepLinkData {
	ws?: string;
	terminalId?: number;
	agentToken?: string;
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
export default function RootLayout() {
	const router = useRouter();
	const init = useAppStore(s => s.init);
	const setSelectedWs = useAppStore(s => s.setSelectedWs);
	const setSelectedTerminalId = useAppStore(s => s.setSelectedTerminalId);
	const [unlocked, setUnlocked] = useState(false);
	// tryNavigateから常に最新値を読むためのref（tryNavigate自体をunlockedに依存させると
	// 参照が変わるたびにリスナーeffectを再登録することになり、stale closure対策として
	// 依存を空にした場合に「登録時点のunlocked」を永久キャプチャしてしまうため）。
	const unlockedRef = useRef(false);
	const pendingRef = useRef<NotificationDeepLinkData | undefined>(undefined);

	useEffect(() => {
		void init();
		startLiveActivitySync();
	}, [init]);

	const tryNavigate = useCallback(() => {
		const target = pendingRef.current;
		if (!unlockedRef.current || !target) {
			return;
		}
		pendingRef.current = undefined;
		// setSelectedWs は selectedTerminalId をリセットするため、この順序を厳守する。
		if (target.ws) {
			setSelectedWs(target.ws);
		}
		if (target.terminalId !== undefined) {
			setSelectedTerminalId(target.terminalId);
		}
		router.push('/agent');
	}, [router, setSelectedWs, setSelectedTerminalId]);

	useEffect(() => {
		unlockedRef.current = unlocked;
		tryNavigate();
	}, [unlocked, tryNavigate]);

	useEffect(() => {
		const sub = Notifications.addNotificationResponseReceivedListener(response => {
			pendingRef.current = response.notification.request.content.data as NotificationDeepLinkData;
			tryNavigate();
		});
		// コールドスタート（通知タップでアプリが起動された）対応
		void Notifications.getLastNotificationResponseAsync().then(response => {
			if (response) {
				pendingRef.current = response.notification.request.content.data as NotificationDeepLinkData;
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
					<Stack screenOptions={{ headerStyle: { backgroundColor: colors.panel }, headerTintColor: colors.text, contentStyle: { backgroundColor: colors.bg } }}>
						<Stack.Screen name="(tabs)" options={{ headerShown: false }} />
						<Stack.Screen name="pair" options={{ title: 'Para Code と接続', presentation: 'modal' }} />
						{/* エージェント詳細。ホームの一覧・通知タップから開く（旧エージェントタブの後継） */}
						<Stack.Screen name="agent" options={{ headerShown: false }} />
						<Stack.Screen name="agent-activity" options={{ headerShown: false, animation: 'slide_from_right' }} />
						<Stack.Screen name="agent-activity-detail" options={{ headerShown: false, animation: 'slide_from_right' }} />
						{/* 通知一覧。ベルからのズーム遷移（Link.AppleZoom）で開くため独自ヘッダーを使う */}
						<Stack.Screen name="notifications" options={{ headerShown: false }} />
						{/* 設定。ワークスペースドロワーの設定アイコンから開く */}
						<Stack.Screen name="settings" options={{ headerShown: false, presentation: 'modal' }} />
						{/* Ccusage ダッシュボード。設定画面の項目から開く（設定のmodalと区別するため水平pushにする） */}
						<Stack.Screen name="ccusage" options={{ headerShown: false, animation: 'slide_from_right' }} />
						{/* ブラウザ（para-browserミラー）。エージェント詳細ヘッダーのボタンから開く（旧ブラウザタブの後継） */}
						<Stack.Screen name="browser" options={{ headerShown: false, animation: 'slide_from_right' }} />
					</Stack>
					{/* glass対応メニュー/ダイアログの描画先（overlayHost.tsx参照）。
					    再ロック時にロック画面より上へ残らないよう、AuthGateの内側に置く */}
					<OverlayHost />
				</AuthGate>
			</ThemeProvider>
		</GestureHandlerRootView>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1 },
});
