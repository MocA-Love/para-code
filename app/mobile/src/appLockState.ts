// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ロック中かを React の外（Alert のボタンの処理・送信待ちの送り出し・トーストのタイマー）から読むための場所。
 * 値を入れるのは `AuthGate`（`components/authGate.tsx`）だけ。React の中では `useAppLocked()`（`appLock.ts`）を使う。
 *
 * 既定は false（`AuthGate` の外＝テストなどではロックしていない扱い）。アプリでは `AuthGate` が最初の描画の
 * 直後に true を入れ、最初の解除までは中身を描かないので、それより前に読まれることは無い。
 */

type LockListener = (locked: boolean) => void;

let locked = false;
const listeners = new Set<LockListener>();

/** いまロック中か（認証の最中も含む）。 */
export function isAppLockedNow(): boolean {
	return locked;
}

/** ロックの状態を変える（`AuthGate` だけが呼ぶ）。変わったときだけ知らせる。 */
export function setAppLockedNow(next: boolean): void {
	if (next === locked) {
		return;
	}
	locked = next;
	for (const listener of [...listeners]) {
		listener(next);
	}
}

/** ロックの状態が変わったら呼ばれる。戻り値で購読をやめる。 */
export function onAppLockChange(listener: LockListener): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}
