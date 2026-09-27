// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Stack } from 'expo-router';
import { colors } from '../../src/theme.js';

/**
 * PC の器（`[pcId]/_layout.tsx`）を積む Stack。
 *
 * **別の PC の画面へ入ったときに、今の PC の器の中へ積ませないために置いている。** Expo Router は遷移先の
 * 置き場所を「今の画面と遷移先の画面名がどの階層で食い違うか」で決め、動的な引数を比べるのは画面名が
 * `[pcId]` のように括弧だけのときに限る（`findDivergentState` / `matchDynamicName`）。この入れ物が無いと
 * ルートの Stack での画面名は `pc/[pcId]` になり、`pcId` が違っても同じ画面とみなされる。そのため通知の
 * タップ・ホームの「再開」などで PC A のセッションの上から PC B のセッションを開くと、B のセッションが A の器に
 * 積まれていた（左の列は A の一覧のまま、1列で戻ると A の一覧へ戻る）。
 *
 * ここで画面名を `[pcId]` にすると、別の PC なら新しい器がこの Stack に積まれ、同じ PC なら今の器の中に積まれる。
 *
 * **器は `pcId` で見分ける（`dangerouslySingular`。id は画面名の `[pcId]` を引数の値で置き換えたもの）。**
 * 起動中に届いたリンクなどの `navigate` は、前面の画面と画面名が同じなら、そのルートを使い回して引数だけ
 * 差し替える（Expo Router の StackClient）。見分けが無いと、A の器の引数だけが B に変わり、中の Stack は
 * A のセッションのまま残った。見分けがあれば、別の PC なら新しい器を積み、すでに積んである PC ならその器を
 * 前面へ戻す。
 */
export default function PcStackLayout() {
	return (
		<Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
			<Stack.Screen name="[pcId]" dangerouslySingular />
		</Stack>
	);
}
