// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createContext, useContext, useEffect, useRef } from 'react';

/**
 * ロック中かを配る context。`AuthGate`（`components/authGate.tsx`）が値を入れる。
 *
 * ロック中もアプリの画面は木に残る（ロック画面が上に重なって覆うだけ）。そのため、ロック画面より上へ
 * 出てしまうもの（RN の `Modal`）と、ロック中に動いてほしくないもの（外付けキーボードのショートカット、
 * トースト、更新のお知らせ、送信待ちの送り出し）は、ここを読んで自分で止める。
 *
 * **新しく RN の `Modal` を置くときは、`useCloseOnAppLock` か `useAppLocked` を読み、`visible` を
 * `lockedModalVisible` で落とすこと**（`appLockPolicy.test.ts` が `<Modal` と呼び出しの数を突き合わせる）。
 * Alert は `paraAlert.ts` を使う（`Alert.alert` を直接呼ばない）。
 */
export const AppLockContext = createContext(false);

/** ロック中か（認証の最中も含む）。`AuthGate` の外では常に false。 */
export function useAppLocked(): boolean {
	return useContext(AppLockContext);
}

/**
 * ロックされたときに開いていれば `close` を 1 回呼ぶ（シートは閉じる。中の選びかけは捨ててよい）。
 * 返り値はロック中か。`Modal` の `visible` はこれで落とす（`lockedModalVisible`）。親が閉じるのを
 * 待たずに隠すため。
 */
export function useCloseOnAppLock(open: boolean, close: () => void): boolean {
	const locked = useAppLocked();
	const closeRef = useRef(close);
	closeRef.current = close;
	useEffect(() => {
		if (locked && open) {
			closeRef.current();
		}
	}, [locked, open]);
	return locked;
}
