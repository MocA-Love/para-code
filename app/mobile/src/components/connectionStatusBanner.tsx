// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePathname } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { colors } from '../theme.js';
import { useStableInsets } from '../hooks/useStableInsets.js';

/**
 * OS標準バーが**本文をその下から始める**（不透明バー、`translucent` でない
 * `headerShown: true`）画面のパス集合。こういう画面ではシーン原点が既にバー下端なので、
 * バナー位置は「バー直下 + 8」基準になる——`insets.top + 52` のままだと insets.top 分が
 * 二重加算になり、一覧1行目へ覆いかぶさる。
 *
 * translucent（agent）や自前ヘッダー（agent-activity 系・archive 等）はシーン原点が
 * 画面上端のため従来位置が正しい。**新規に不透明バーのスタック画面を足したらここにも加える**
 * （root `_layout.tsx` の `Stack.Screen` 設定と隣接して管理するのが理想だが、バナー自身が
 * 判定を持つ方が「位置の正しさ」と同じ場所で完結する）。
 */
const OPAQUE_BAR_PATHS = new Set([
	// タブ4画面（(tabs) 配下。OSバーは wsDrawer が getParent().setOptions で出す）
	'/', '/index', '/terminal', '/scm', '/files',
	// ブラウザ
	'/browser',
	// 設定モーダル配下（(settings)/_layout.tsx で headerShown: true）
	'/settings', '/changelog', '/system', '/github-usage', '/ratelimit', '/rtk', '/ccusage',
	'/pc-detail', '/presets', '/terminal-settings', '/morph-lab', '/morph-native', '/morph-native-detail',
]);

/**
 * 「結果が分からない操作の記録がある」ことを伝えるバナー。
 *
 * **接続の状態（再接続中・オフライン）はここでは出さない。**それは一時的なお知らせなので、
 * 上端のカプセル（{@link ParaToastHost}）へ集約した。ここに残しているのは
 * <b>ユーザーの操作を待つもの</b>だけ——「確認して破棄」を押さないと先に進まないので、
 * トーストにして時間やスワイプで消えると、消えた瞬間に操作の機会ごと失われる。
 * だから居座るバナーのまま置いておく。
 *
 * 位置はヘッダーの行のすぐ下（`insets.top + 52`）。上端のカプセルは重なって出るので、
 * 一過性のお知らせが出ているあいだだけ数pt重なるが、どちらも短命なので割り切る。
 */
export function ConnectionStatusBanner() {
	const insets = useStableInsets();
	const pathname = usePathname();
	// 不透明バーの画面ではシーン原点が既にバー下端なので、バナーはバー直下に置く。
	const belowOpaqueBar = OPAQUE_BAR_PATHS.has(pathname);
	// workspace 本体ではなく、表示に使う値だけを購読する（常時マウントされるため、
	// 本体を購読するとこのバナーが再構築される）。
	const { issue, unknownCount, discardUnknown } = useAppStore(useShallow(s => ({
		issue: s.terminalOperationIssue,
		unknownCount: s.unknownTerminalOperationCount,
		discardUnknown: s.discardUnknownTerminalOperations,
	})));

	if (issue === undefined) {
		return null;
	}

	return (
		<View style={[styles.stack, { top: belowOpaqueBar ? 8 : insets.top + 52 }]} pointerEvents="box-none">
			<View style={styles.unknown} accessibilityLiveRegion="polite">
				<Ionicons name="warning-outline" size={15} color={colors.orange} />
				<Text style={styles.text}>{issue}</Text>
				{unknownCount > 0 ? (
					<Pressable accessibilityRole="button" style={styles.action} onPress={() => Alert.alert(
						'結果不明の操作記録を破棄',
						'PC側の状態を確認しましたか？ 記録を破棄してもPC上の操作は取り消されず、自動再実行もされません。',
						[{ text: 'キャンセル', style: 'cancel' }, { text: '記録を破棄', style: 'destructive', onPress: () => { void discardUnknown(); } }],
					)}><Text style={styles.actionText}>確認して破棄</Text></Pressable>
				) : null}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	stack: { position: 'absolute', left: 12, right: 12, gap: 6, zIndex: 100 },
	unknown: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(245,158,11,.35)', backgroundColor: 'rgba(24,24,27,.96)', paddingHorizontal: 10, paddingVertical: 8 },
	text: { flex: 1, color: colors.text, fontSize: 11, lineHeight: 15 },
	action: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 7, backgroundColor: colors.surface },
	actionText: { color: colors.accent, fontSize: 11, fontWeight: '700' },
});
