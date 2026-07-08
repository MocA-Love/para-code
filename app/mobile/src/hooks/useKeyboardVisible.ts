// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * キーボードの表示状態を返すフック。キーボード表示中は入力バーの下余白
 * （SafeArea + タブバー分）が不要になるため、余白の切り替えに使う。
 */
export function useKeyboardVisible(): boolean {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
		const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
		const show = Keyboard.addListener(showEvent, () => setVisible(true));
		const hide = Keyboard.addListener(hideEvent, () => setVisible(false));
		return () => {
			show.remove();
			hide.remove();
		};
	}, []);
	return visible;
}
