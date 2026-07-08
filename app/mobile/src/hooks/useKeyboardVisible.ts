// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { Dimensions, Keyboard, KeyboardEvent, Platform } from 'react-native';

/**
 * キーボードが「実際に画面下部を覆っているか」を返すフック。キーボード表示中は
 * 入力バーの下余白（SafeArea + タブバー分）が不要になるため、余白の切り替えに使う。
 *
 * willShow/willHide のbooleanではなくキーボードの実フレームで判定する。
 * ハードウェアキーボード接続時（シミュレータの ⌘K 含む）は willShow が
 * アクセサリバーだけの小さいフレームで発火し、boolean判定だと「表示中」扱いに
 * なって余白が8pxへ縮み、入力バーがタブバーへ食い込むため。
 */
export function useKeyboardVisible(): boolean {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		if (Platform.OS === 'ios') {
			// iOSは表示/非表示/フレーム変化のすべてで発火する changeFrame を使う。
			// frame変化を伴わない非表示経路（バックグラウンド遷移等）で true に張り付かないよう
			// willHide でも明示的に false へ倒す（二重化）。
			const change = Keyboard.addListener('keyboardWillChangeFrame', (e: KeyboardEvent) => {
				const screenH = Dimensions.get('window').height;
				const covered = screenH - e.endCoordinates.screenY;
				// 80px以下（アクセサリバーのみ・画面外）は「覆っていない」扱い
				setVisible(covered > 80);
			});
			const hide = Keyboard.addListener('keyboardWillHide', () => setVisible(false));
			return () => {
				change.remove();
				hide.remove();
			};
		}
		const show = Keyboard.addListener('keyboardDidShow', () => setVisible(true));
		const hide = Keyboard.addListener('keyboardDidHide', () => setVisible(false));
		return () => {
			show.remove();
			hide.remove();
		};
	}, []);
	return visible;
}
