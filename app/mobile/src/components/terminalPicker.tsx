// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ParaPlusMenuButton, type ParaPlusMenuItem } from '../../modules/para-plus-menu/index.js';
import { colors, mono } from '../theme.js';
import { hapticSelection } from '../haptics.js';

/**
 * ターミナルタブの「ターミナル名 ▾」。**切り替えのメニューはOSに出させる。**
 *
 * 以前は横スクロールのチップ列を常設していた。畳んだ理由は2つ:
 *  - エージェント詳細画面が［‹］［タイトルの島］［🌐］の3つの島なのに、こちらは
 *    島＋チップ列＋枠付きの箱で、同じアプリの同じ役割の画面に見えなかった
 *  - チップ列は横スクロールなので、ドロワーを開くスワイプと指の向きがぶつかっていた
 *    （この画面だけ全域スワイプを巻けていない理由がこれ）
 *
 * 島ぜんぶがネイティブの `UIButton` の当たり判定になっていて（`symbol=""` で画像を消し、
 * 見た目はここのRNの子が描く）、押すと標準の `UIMenu` が開く。ボタン→メニューのモーフ・
 * ばね・押し込みの手応えはOSが描くので、こちらは項目を渡すだけ。
 *
 * **失ったもの**: チップ列は各ターミナルの応答待ち（赤）／実行中（緑）を常に見せていた。
 * 畳むと開くまで気づけないので、
 *  - 島の右上に赤い点を出す（**他の**ターミナルに応答待ちがあるとき。器側の `badge`）
 *  - 島の中に色付きのドットを出す（**いま見ている**ターミナルの応答待ち／実行中）
 *  - メニューの各項目に状態の記号を付ける（`?`＝応答待ち、`▶`＝実行中）
 * の3つで補っている。メニューの記号に色は付けられない（`systemImage` は単色）ので形で示し、
 * かつ選択中の項目は✓が記号を置き換えるため、アクティブな端末の状態は島の中で見せる。
 */

export interface TerminalPickerEntry {
	readonly terminalKey: string;
	readonly title: string;
	/** 1始まりの並び順（チップ列の「1:」「2:」と同じ数字）。 */
	readonly index: number;
	readonly waiting: boolean;
	readonly working: boolean;
}

/** メニューが返す識別子。ターミナルの選択だけ `pick:` を前置して区別する。 */
const PICK_PREFIX = 'pick:';

/** ネイティブの標準メニューを使えるか。使えないビルドでは呼び出し側がチップ列に戻す。 */
export const terminalPickerIsNative = ParaPlusMenuButton !== undefined;

export function TerminalPicker({ entries, activeKey, onSelect, onCreate }: {
	entries: readonly TerminalPickerEntry[];
	activeKey: string | undefined;
	onSelect: (terminalKey: string) => void;
	onCreate: () => void;
}) {
	const active = entries.find(entry => entry.terminalKey === activeKey);
	const state = active?.waiting === true ? '応答待ち' : active?.working === true ? '実行中' : undefined;
	const label = active !== undefined
		? `ターミナル ${active.index}: ${active.title}${state !== undefined ? `、${state}` : ''}。切り替える`
		: 'ターミナルなし。作成する';

	if (ParaPlusMenuButton === undefined) {
		return null;
	}

	const items: ParaPlusMenuItem[] = [
		...entries.map(entry => ({
			id: `${PICK_PREFIX}${entry.terminalKey}`,
			title: `${entry.index}: ${entry.title}`,
			// 色は付けられないので形で示す。何も無い＝手が空いている。
			systemImage: entry.waiting ? 'questionmark.circle' : entry.working ? 'play.circle' : '',
			selected: entry.terminalKey === activeKey,
		})),
		{ id: 'new-terminal', title: '新しいターミナル', systemImage: 'plus', startsSection: true },
	];

	return (
		<ParaPlusMenuButton
			style={styles.hit}
			// 画像は出さない。見た目は下のRNの子が描く（タップはネイティブのボタンが受ける）。
			symbol=""
			items={items}
			accessibilityTitle={label}
			onSelect={event => {
				hapticSelection();
				const id = event.nativeEvent.id;
				if (id.startsWith(PICK_PREFIX)) {
					onSelect(id.slice(PICK_PREFIX.length));
					return;
				}
				onCreate();
			}}
		>
			<View style={styles.body} pointerEvents="none">
				{/* **いま見ているターミナル自身の状態はここに出す。** メニューの中では
				    選択中の項目に✓が付き、UIKitはそれで記号を置き換えるので、アクティブな
				    端末の応答待ち／実行中はメニューを開いても読めない。 */}
				{active?.waiting === true ? <View style={[styles.dot, styles.dotWaiting]} />
					: active?.working === true ? <View style={[styles.dot, styles.dotWorking]} /> : null}
				<Text style={styles.index}>{active !== undefined ? `${active.index}:` : ''}</Text>
				<Text style={styles.name} numberOfLines={1}>{active?.title ?? 'ターミナルなし'}</Text>
				<Ionicons name="chevron-down" size={11} color={colors.textDim} />
			</View>
		</ParaPlusMenuButton>
	);
}

const styles = StyleSheet.create({
	hit: { flex: 1 },
	// ネイティブのボタンは最前面に居るので、こちらは見た目だけ（タッチは通さない）。
	body: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14 },
	dot: { width: 7, height: 7, borderRadius: 4 },
	dotWaiting: { backgroundColor: colors.red },
	dotWorking: { backgroundColor: colors.green },
	index: { color: colors.textDim, fontSize: 11, fontFamily: mono.ios },
	name: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14, fontWeight: '700', letterSpacing: -0.2 },
});
