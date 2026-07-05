// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { useAppStore } from '../src/appState.js';
import { colors } from '../src/theme.js';

/** ルートレイアウト。起動時にコントローラを初期化し、タブ群とペアリングモーダルを持つ。 */
export default function RootLayout() {
	const init = useAppStore(s => s.init);
	useEffect(() => {
		void init();
	}, [init]);

	return (
		<Stack screenOptions={{ headerStyle: { backgroundColor: colors.panel }, headerTintColor: colors.text, contentStyle: { backgroundColor: colors.bg } }}>
			<Stack.Screen name="(tabs)" options={{ headerShown: false }} />
			<Stack.Screen name="pair" options={{ title: 'Para Code と接続', presentation: 'modal' }} />
		</Stack>
	);
}
