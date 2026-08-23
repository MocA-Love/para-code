// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ParaPlusMenuButton, type ParaPlusMenuItem } from '../../modules/para-plus-menu/index.js';
import { GlassSurface } from './glassSurface.js';
import { colors, mono, radius, squircle } from '../theme.js';
import { hapticSelection } from '../haptics.js';
import {
	COMPACT_TERMINAL_MENU_WIDTH,
	decodeTerminalCompactMenuAction,
	TERMINAL_CREATE_ACTION_ID,
	TERMINAL_PICK_PREFIX,
	TERMINAL_PRESETS_ACTION_ID,
} from './terminalHeaderBehavior.js';

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
			id: `${TERMINAL_PICK_PREFIX}${entry.terminalKey}`,
			title: `${entry.index}: ${entry.title}`,
			// 色は付けられないので形で示す。何も無い＝手が空いている。
			systemImage: entry.waiting ? 'questionmark.circle' : entry.working ? 'play.circle' : '',
			selected: entry.terminalKey === activeKey,
		})),
		{ id: TERMINAL_CREATE_ACTION_ID, title: '新しいターミナル', systemImage: 'plus', startsSection: true },
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
				if (id.startsWith(TERMINAL_PICK_PREFIX)) {
					onSelect(id.slice(TERMINAL_PICK_PREFIX.length));
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

export function TerminalCompactMenu({ entries, activeKey, onSelect, onOpenPresets, onCreate }: {
	entries: readonly TerminalPickerEntry[];
	activeKey: string | undefined;
	onSelect: (terminalKey: string) => void;
	onOpenPresets: () => void;
	onCreate: () => void;
}) {
	if (ParaPlusMenuButton === undefined) {
		return null;
	}

	const items: ParaPlusMenuItem[] = [];
	if (entries.length > 0) {
		items.push({
			id: 'terminals',
			title: 'ターミナルを切り替える',
			systemImage: 'terminal',
			children: entries.map(entry => ({
				id: `${TERMINAL_PICK_PREFIX}${entry.terminalKey}`,
				title: `${entry.index}: ${entry.title}`,
				systemImage: entry.waiting ? 'questionmark.circle' : entry.working ? 'play.circle' : '',
				selected: entry.terminalKey === activeKey,
			})),
		});
	}
	items.push(
		{ id: TERMINAL_PRESETS_ACTION_ID, title: 'コマンドプリセット', systemImage: 'bolt', startsSection: true },
		{ id: TERMINAL_CREATE_ACTION_ID, title: '新しいターミナル', systemImage: 'plus' },
	);

	return (
		<ParaPlusMenuButton
			style={styles.compactMenu}
			symbol="ellipsis.circle"
			items={items}
			accessibilityTitle="ターミナル操作"
			onSelect={event => {
				const action = decodeTerminalCompactMenuAction(event.nativeEvent.id);
				if (action?.kind === 'terminal') {
					hapticSelection();
					onSelect(action.terminalKey);
				} else if (action?.kind === 'presets') {
					hapticSelection();
					onOpenPresets();
				} else if (action?.kind === 'create') {
					onCreate();
				}
			}}
		/>
	);
}

export function TerminalFallbackBand({ entries, activeKey, onSelect }: {
	entries: readonly TerminalPickerEntry[];
	activeKey: string | undefined;
	onSelect: (terminalKey: string) => void;
}) {
	return (
		<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fallbackTabContent} keyboardShouldPersistTaps="always">
			{entries.map(entry => {
				const active = entry.terminalKey === activeKey;
				const state = entry.waiting ? '応答待ち' : entry.working ? '実行中' : '待機中';
				const body = (
					<Pressable
						style={styles.fallbackTabHit}
						onPress={() => { hapticSelection(); onSelect(entry.terminalKey); }}
						accessibilityRole="button"
						accessibilityLabel={`ターミナル ${entry.index}: ${entry.title}、${state}`}
						accessibilityState={{ selected: active }}
					>
						{entry.waiting
							? <View style={styles.fallbackDotWaiting} />
							: entry.working ? <View style={styles.fallbackDotWorking} /> : null}
						<Text style={[styles.fallbackTabText, active && styles.fallbackTabTextActive]} numberOfLines={1}>{entry.index}: {entry.title}</Text>
					</Pressable>
				);
				return active
					? <View key={entry.terminalKey} style={[styles.fallbackTabChip, styles.fallbackTabChipActive]}>{body}</View>
					: <GlassSurface key={entry.terminalKey} style={styles.fallbackTabChip} interactive>{body}</GlassSurface>;
			})}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	compactMenu: {
		width: COMPACT_TERMINAL_MENU_WIDTH,
		height: COMPACT_TERMINAL_MENU_WIDTH,
	},
	// **`flex` に頼らず自分の大きさを持つこと。** 以前はヘッダー層の「左右の間に伸びる島」の
	// 中に居たので親が幅と高さをくれたが、いまはOS標準のバーの項目として置かれる。
	// バー項目の親は中身なりの大きさなので、`flex: 1` だと 0×0 に潰れて見えなくなる
	// （実機で確認済み: 中央に置いたときは名前が1文字まで削られた）。
	hit: { height: 32 },
	// ネイティブのボタンは最前面に居るので、こちらは見た目だけ（タッチは通さない）。
	body: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 32 },
	dot: { width: 7, height: 7, borderRadius: 4 },
	dotWaiting: { backgroundColor: colors.red },
	dotWorking: { backgroundColor: colors.green },
	index: { color: colors.textDim, fontSize: 11, fontFamily: mono.ios },
	// 上限で止める。長い端末名でバーの右側が押し出されると、左の島が削られる。
	name: { flexShrink: 1, minWidth: 0, maxWidth: 104, color: colors.text, fontSize: 14, fontWeight: '700', letterSpacing: -0.2 },
	fallbackTabContent: { gap: 7, alignItems: 'center' },
	fallbackTabChip: { height: 44, borderRadius: radius.pill, ...squircle, maxWidth: 200 },
	fallbackTabChipActive: { backgroundColor: 'rgba(9,175,217,0.30)', borderWidth: 1, borderColor: 'rgba(9,175,217,0.5)' },
	fallbackTabHit: { flex: 1, minWidth: 44, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13 },
	fallbackTabText: { color: colors.text, fontSize: 11.5, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	fallbackTabTextActive: { color: '#bfeeff', fontWeight: '700' },
	fallbackDotWaiting: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.red },
	fallbackDotWorking: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
});
