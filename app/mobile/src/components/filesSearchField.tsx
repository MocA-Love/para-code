// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useFilesSearch } from '../filesSearch.js';
import { useFilesLive } from '../filesLive.js';
import { HIT_SIZE, colors, radius, squircle, type } from '../theme.js';
import { haptic } from '../haptics.js';

/**
 * 検索欄。**本文の上に絶対配置で張り付ける**（`app/(tabs)/files.tsx`）。
 *
 * 元々は本文の先頭に `searchOpen ? <View> : null` で出していて、下まで読むと欄が画面の外へ
 * 消えていた。そこで常設ヘッダー層の「帯」へ移し、島の下から滑り出す形にした。さらに
 * ヘッダーをOS標準のナビゲーションバーへ移した時点で帯を置く場所が無くなったため
 * （ネイティブのバーにはバー項目しか入らない）、いまは本文側で上端に固定している。
 * 「スクロールしても消えない」は保たれているが、**滑り出す動きは失われた**（あれは層が
 * 付けていた）。動きが要るならこの欄自身に持たせること。
 *
 * 入力は uncontrolled（`value` を渡さない）。ストアへは `onChangeText` で流すだけにして、
 * 再レンダーで未確定のIME文字列へ書き戻さない（space-note.tsx / glassComposer.tsx と同じ流儀）。
 */
export function FilesSearchField({ onClose }: { onClose: () => void }) {
	// 切断中は編集させない（打ち替えても検索は走らないので、古い結果に新しい条件が付いて
	// 見えてしまう）。判定は一覧側と同じ `useFilesLive()` を使う。
	const live = useFilesLive();
	// **`query` は購読しない。** ここは uncontrolled（`defaultValue`）で、購読すると打鍵ごとに
	// `defaultValue` が変わって実質 controlled になり、IMEの未確定文字列へ書き戻す経路が開く。
	const { mode, focusRequested, clearedAt, setQuery, setMode, consumeFocus } = useFilesSearch(useShallow(s => ({
		mode: s.mode, focusRequested: s.focusRequested, clearedAt: s.clearedAt,
		setQuery: s.setQuery, setMode: s.setMode, consumeFocus: s.consumeFocus,
	})));
	const inputRef = useRef<TextInput>(null);
	// 初期値はマウント時に1回だけ読む（タブを行き来して作り直されたときに前の入力が戻る）。
	const initialQuery = useRef(useFilesSearch.getState().query).current;

	// **`autoFocus` は使わない。** 帯はタブを移るだけでもアンマウントされるので、
	// `autoFocus` だと戻ってきた瞬間に勝手にキーボードが立ち上がる。
	// 「ユーザーが開いた」ときだけ当てる（要求は一度で消費する）。
	useEffect(() => {
		if (!focusRequested) {
			return;
		}
		// **消費するのはタイマーの中で。** 先頭で `consumeFocus()` を呼ぶと `focusRequested` が
		// false になり、それを購読しているこの欄が再レンダー → 依存が変わって**この effect の
		// cleanup が 40ms を待たずにタイマーを消す**（＝フォーカスが一度も当たらない）。
		// 発火後の cleanup は既に走ったタイマーへの `clearTimeout` なので無害。
		const timer = setTimeout(() => {
			inputRef.current?.focus();
			consumeFocus();
		}, 40);
		return () => clearTimeout(timer);
	}, [focusRequested, consumeFocus]);

	// 外から条件を捨てられたとき（ワークスペース切り替え等）は、表示中の文字も消す。
	// uncontrolled なので、ストアを空にしただけでは欄に残る。
	const firstClear = useRef(clearedAt);
	useEffect(() => {
		if (clearedAt !== firstClear.current) {
			inputRef.current?.clear();
		}
	}, [clearedAt]);

	return (
		<View style={styles.box}>
			<Ionicons name="search-outline" size={14} color={colors.textDim} />
			<TextInput
				ref={inputRef}
				style={styles.input}
				defaultValue={initialQuery}
				onChangeText={setQuery}
				editable={live}
				placeholder={mode === 'name' ? 'ファイル名で検索（全階層）…' : 'テキストで検索（全文）…'}
				placeholderTextColor={colors.textDim}
				autoCapitalize="none"
				autoCorrect={false}
				returnKeyType="search"
				accessibilityLabel="検索条件"
			/>
			{(['name', 'text'] as const).map(candidate => (
				// 押せる範囲（44pt 四方）と見た目のチップを分ける。欄の高さ（44pt）いっぱいを押せる。
				<Pressable
					key={candidate}
					disabled={!live}
					style={styles.modeHit}
					onPress={() => { haptic('tick'); setMode(candidate); }}
					accessibilityRole="button"
					accessibilityState={{ selected: mode === candidate, disabled: !live }}
					accessibilityLabel={candidate === 'name' ? 'ファイル名で検索' : '内容で検索'}
				>
					<View style={[styles.modeChip, mode === candidate && styles.modeChipActive]}>
						<Text style={[styles.modeText, mode === candidate && styles.modeTextActive]}>{candidate === 'name' ? '名前' : '内容'}</Text>
					</View>
				</Pressable>
			))}
			<Pressable
				style={styles.close}
				onPress={() => { haptic('move'); onClose(); }}
				accessibilityRole="button"
				accessibilityLabel="検索を閉じる"
			>
				<Ionicons name="close" size={15} color={colors.textDim} />
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	// 中のチップと閉じるが 44pt の当たり判定を持つので、欄の高さも 44pt（＋枠線）になる。
	// 右端は閉じるの当たり判定が欄の縁まで届くよう余白を持たない。
	box: { flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: colors.panel, borderRadius: radius.control, ...squircle, borderWidth: 1, borderColor: colors.border, paddingLeft: 12 },
	input: { flex: 1, color: colors.text, fontSize: type.body, paddingVertical: 9, marginLeft: 6 },
	close: { width: HIT_SIZE, height: HIT_SIZE, alignItems: 'center', justifyContent: 'center' },
	modeHit: { minWidth: HIT_SIZE, height: HIT_SIZE, alignItems: 'center', justifyContent: 'center' },
	modeChip: { borderRadius: radius.pill, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 9, paddingVertical: 4 },
	modeChipActive: { borderColor: colors.accent2, backgroundColor: colors.accentWash },
	modeText: { color: colors.textDim, fontSize: type.caption },
	modeTextActive: { color: colors.text, fontWeight: '600' },
});
