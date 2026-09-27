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
 * すでに下に積んである PC へ push したときも、その器を並べ替えずに新しい器を積む。
 *
 * **器に `getId` / `dangerouslySingular` を付けない。** 付けると、下に積んである PC へ push したときに、その器を
 * 作り直さずに最前面へ並べ替える（StackClient。「THIS ACTION IS DANGEROUS」と注記がある）。実際に、並べ替えた
 * 後で戻ると JS の状態は進むのにネイティブの画面が変わらなくなった（2026-09-27、iPad シミュレータ）。
 * 付けない代わりに、`navigate`（前面の画面と画面名が同じならルートを使い回して引数だけ差し替える）で PC の中へ
 * 入らない。アプリの中は push / replace だけを使い、起動中に OS から届くリンクは中継の画面を経由させる
 * （`src/features/links/runningPcLink.ts`）。
 */
export default function PcStackLayout() {
	return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
