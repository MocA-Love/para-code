// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { useAppStore } from '../src/appState.js';

/** ルートレイアウト。起動時にコントローラを初期化する。 */
export default function RootLayout() {
	const init = useAppStore(s => s.init);
	useEffect(() => {
		void init();
	}, [init]);

	return (
		<Stack screenOptions={{ headerStyle: { backgroundColor: '#161b22' }, headerTintColor: '#cccccc', contentStyle: { backgroundColor: '#0d1117' } }}>
			<Stack.Screen name="index" options={{ title: 'Para Code Mobile' }} />
			<Stack.Screen name="pair" options={{ title: 'デバイスを接続', presentation: 'modal' }} />
			<Stack.Screen name="terminal" options={{ title: 'ターミナル' }} />
		</Stack>
	);
}
