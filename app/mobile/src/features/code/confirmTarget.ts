// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 確認のシート（`ConfirmDrawer`）で「何に対する確認か」を持つ入れ物。
 *
 * `ConfirmDrawer` は確定を押すと先に `onClose` を呼び、シートが閉じ切った後に `onConfirm` を呼ぶ。対象を `onClose` で
 * 消す state に持つと、`onConfirm` が走る時には対象が無くなっていて要求が届かない（W2-36 の PR のマージで実際に起きた）。
 * シートの見え隠れ（`visible`）とは別に対象を持ち、閉じても対象は消さず、確定のときに取り出す。
 */
export class ConfirmTarget<T> {
	private value: T | undefined;

	/** シートを開くときに対象を持つ。 */
	hold(value: T): void {
		this.value = value;
	}

	/** 確定のときに対象を取り出す（二度目は undefined。二重に送らない）。 */
	take(): T | undefined {
		const value = this.value;
		this.value = undefined;
		return value;
	}
}
