// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * アプリが裏（background）に回っていないか。`inactive`（通知センターを引き下げた等の短い中断）は
 * 前にいるものとして扱う（接続もそのまま保つので、表示を止めると一瞬ちらつくだけになる）。
 *
 * W2-34 で裏に回っても接続を保つようになり、前面に戻っても接続が張り直されない。PC は裏に回った時点で
 * ブラウザミラーを止めるので、画面側はこれを見て前に戻ったときに張り直す。
 */
export function useAppInFront(): boolean {
	const [inFront, setInFront] = useState(() => AppState.currentState !== 'background');
	useEffect(() => {
		const subscription = AppState.addEventListener('change', state => setInFront(state !== 'background'));
		return () => subscription.remove();
	}, []);
	return inFront;
}
