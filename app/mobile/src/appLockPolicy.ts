// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 生体認証ロック（`components/authGate.tsx`）の判定。React に依存しない純関数だけを置く。
 *
 * ロック中もアプリの画面（ルートの Stack）は木に残し、ロック画面を上に重ねて覆うだけにする。
 * 木から外すと、解除後に最初の画面から作り直され、ターミナル・入力途中の文字・iPad の詳細の列・
 * ロック前に済ませた通知の遷移が消えるため。
 */

/** 離脱後に再認証を免除する猶予時間。 */
export const REAUTH_GRACE_MS = 10 * 60 * 1000;

/** ゲートの状態。`unlocked` 以外は全てロック中（認証の最中も中身を見せない）。 */
export type AuthGateState = 'locked' | 'authenticating' | 'unlocked';

/** 前面へ戻ったときにゲートがすること。 */
export type GateForegroundAction =
	/** 何もしない（猶予内の復帰など）。 */
	| 'none'
	/** 認証を始める（猶予を過ぎた再ロック、またはロック中の復帰）。 */
	| 'authenticate'
	/** 認証の途中で離れて戻った。固着していないか少し待って確かめる。 */
	| 'watchStuck';

/** ロック中か（ロック画面で覆い、下の画面を操作させない）。 */
export function isAppLocked(state: AuthGateState): boolean {
	return state !== 'unlocked';
}

/**
 * 解除済みのまま離れた時刻 `hiddenAt` から `now` までが猶予を過ぎたか。
 * 離れた時刻を記録していない（解除されていなかった・既に再ロックした）なら false。
 */
export function shouldRelock(hiddenAt: number | undefined, now: number, graceMs: number = REAUTH_GRACE_MS): boolean {
	return hiddenAt !== undefined && now - hiddenAt > graceMs;
}

/** アプリが前面（`active`）へ戻ったときに、今の状態からすることを決める。 */
export function foregroundAction(state: AuthGateState, hiddenAt: number | undefined, now: number, graceMs: number = REAUTH_GRACE_MS): GateForegroundAction {
	switch (state) {
		case 'unlocked':
			return shouldRelock(hiddenAt, now, graceMs) ? 'authenticate' : 'none';
		case 'locked':
			return 'authenticate';
		case 'authenticating':
			return 'watchStuck';
	}
}

/**
 * RN の `Modal` に渡す `visible`。`Modal` はネイティブで最前面に出てロック画面より上に来るため、
 * ロック中は必ず落とす。
 */
export function lockedModalVisible(visible: boolean, locked: boolean): boolean {
	return visible && !locked;
}

/** ロック画面の下に残す画面（アプリの中身）の層に渡すもの。 */
export interface LockedContentProps {
	readonly pointerEvents: 'none' | 'auto';
	readonly accessibilityElementsHidden: boolean;
	readonly importantForAccessibility: 'no-hide-descendants' | 'auto';
}

/**
 * 下の層の props。ロック中は触らせず、読み上げにも出さない。木の形は変えず、props だけを切り替える。
 */
export function lockedContentProps(locked: boolean): LockedContentProps {
	return locked
		? { pointerEvents: 'none', accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' }
		: { pointerEvents: 'auto', accessibilityElementsHidden: false, importantForAccessibility: 'auto' };
}
