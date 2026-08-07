// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Stack } from 'expo-router';
import { colors } from '../../src/theme.js';

/**
 * 設定まわりの**ネストしたスタック**。
 *
 * 設定そのものはルート側でモーダルとして出し（`app/_layout.tsx` の `(settings)`）、
 * その中の移動はこのスタックが水平pushで行う。LINEの設定と同じで、
 * 「モーダルを1枚開いて、その中を深く潜っていく」形になる。
 *
 * **ルート側の Stack に直接並べて `presentation: 'card'` を付けても、この形にはならない。**
 * react-native-screens の `RNSScreenStack.mm` の `updateContainer` は、`Push` の画面を
 * 手前にモーダルがあっても必ずベースのナビゲーションコントローラへ積む。つまりモーダルの
 * 裏に隠れて何も起きなくなる（実際に一度そうしてしまった）。押し先を「モーダルの中」に
 * するには、こうしてモーダルの内側に別のスタックを持たせるしかない。
 *
 * `(settings)` は括弧付きなのでURLには現れない。`/settings` `/ccusage` などの
 * パスはこれまでと変わらず、呼び出し側の `router.push` も直さなくてよい。
 */
export default function SettingsStackLayout() {
	return (
		<Stack
			screenOptions={{
				headerShown: false,
				animation: 'slide_from_right',
				contentStyle: { backgroundColor: colors.bg },
			}}
		/>
	);
}
