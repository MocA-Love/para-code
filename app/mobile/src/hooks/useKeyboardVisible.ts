// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { Dimensions, Keyboard, KeyboardEvent, Platform } from 'react-native';
import { useIsFocused } from 'expo-router';
import { keyboardCoverage } from '../keyboardCoverage.js';

/**
 * キーボードが「実際に画面下部を覆っているか」を返すフック。キーボード表示中は
 * 入力バーの下余白（SafeArea + タブバー分）が不要になるため、余白の切り替えに使う。
 *
 * willShow/willHide のbooleanではなくキーボードの実フレームで判定する。
 * ハードウェアキーボード接続時（シミュレータの ⌘K 含む）は willShow が
 * アクセサリバーだけの小さいフレームで発火し、boolean判定だと「表示中」扱いに
 * なって余白が8pxへ縮み、入力バーがタブバーへ食い込むため。
 *
 * NativeTabsは非表示タブの画面を凍結する。凍結中に keyboardWillHide を取り逃すと
 * visible=true のまま張り付き、タブ復帰後も入力バーの余白が縮んだままになる。
 * useIsFocused でフォーカス状態を監視し、非フォーカスへ移る/フォーカスへ戻るたびに
 * false へ倒して張り付きを防ぐ（フォーカス中に実際に表示されていれば直後のイベントで
 * 再び true になる）。
 */
export function useKeyboardVisible(): boolean {
	return useKeyboardCoverage() > 0;
}

/**
 * キーボードが画面下端を覆っている**高さ**（pt）。覆っていなければ0。
 *
 * **`KeyboardAvoidingView` の代わりに使う。** あれは自分のフレームの画面上の絶対位置から
 * 「下端が何pt食われるか」を割り出すので、OS標準のナビゲーションバーの下に置かれると
 * バーの高さぶんずれ、`keyboardVerticalOffset` でその高さを渡さないと足りない量しか
 * 空けない（エージェント詳細で入力欄がキーボードに隠れた）。バーの高さを取る
 * `useHeaderHeight` は expo-router からは使えないので、こちらで「下端から何pt隠れるか」を
 * 直接測り、下余白として渡す。この値は画面上のどこに置かれていても変わらない。
 */
export function useKeyboardCoverage(): number {
	const [coverage, setCoverage] = useState(0);
	const isFocused = useIsFocused();
	useEffect(() => {
		if (!isFocused) {
			setCoverage(0);
		}
	}, [isFocused]);
	useEffect(() => {
		if (Platform.OS === 'ios') {
			// iOSは表示/非表示/フレーム変化のすべてで発火する changeFrame を使う。
			// frame変化を伴わない非表示経路（バックグラウンド遷移等）で張り付かないよう
			// willHide でも明示的に0へ倒す（二重化）。
			const change = Keyboard.addListener('keyboardWillChangeFrame', (e: KeyboardEvent) => {
				// アクセサリバーのみ・画面外に加え、iPadのフローティングキーボード
				// （下端に接していない）も「覆っていない」扱いにする。
				setCoverage(keyboardCoverage(e.endCoordinates, Dimensions.get('window').height));
			});
			const hide = Keyboard.addListener('keyboardWillHide', () => setCoverage(0));
			return () => {
				change.remove();
				hide.remove();
			};
		}
		const show = Keyboard.addListener('keyboardDidShow', (e: KeyboardEvent) => setCoverage(e.endCoordinates.height));
		const hide = Keyboard.addListener('keyboardDidHide', () => setCoverage(0));
		return () => {
			show.remove();
			hide.remove();
		};
	}, []);
	return coverage;
}
