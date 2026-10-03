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
/** 最後にロックが解けた時刻（AuthGate の解除。通知のボタンが「預けた後の解除」を待つのに使う）。 */
let lastUnlockedAt: number | undefined;
const reauthListeners = new Set<() => void>();

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
	if (!next) {
		lastUnlockedAt = Date.now();
	}
	for (const listener of [...listeners]) {
		listener(next);
	}
}

/** 最後にロックが解けた時刻（まだ一度も解けていなければ undefined）。 */
export function appLastUnlockedAt(): number | undefined {
	return lastUnlockedAt;
}

/**
 * 解除し直しを頼む（通知のボタンで許可・拒否・返信を送る前に、Face ID を通すため）。`AuthGate` が受け、
 * 解除済みならもう一度認証する（再認証の猶予の間でも）。
 */
export function requestAppReauthentication(): void {
	for (const listener of [...reauthListeners]) {
		listener();
	}
}

/** 解除し直しの依頼を受ける（`AuthGate` だけが使う）。戻り値で購読をやめる。 */
export function onAppReauthenticationRequest(listener: () => void): () => void {
	reauthListeners.add(listener);
	return () => { reauthListeners.delete(listener); };
}

/** ロックの状態が変わったら呼ばれる。戻り値で購読をやめる。 */
export function onAppLockChange(listener: LockListener): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}
