// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ターミナルの出力購読（`attachTerminal` / `detachTerminal`）を、画面の側で数えて持つ。
 *
 * 同じターミナルのセッションが2枚積まれる（通知から同じタブを開き直したなど）と、上の画面を閉じたときの
 * detach が PC 側の購読を丸ごと解き、下の画面の出力が止まる。ストアの attach は再同期（新しい epoch で
 * 取り直す）にも使っていて数え方を足せないので、画面のペインが持つ分だけをここで数える:
 *  - 持つたびに attach する（すでに誰かが持っていても、新しい epoch で取り直すだけで無害。いまの挙動と同じ）
 *  - 最後の1つが手放したときだけ detach する
 * エージェントの会話（`attachAgent`）はストアが参照カウントを持っているので対象外。
 */
export interface TerminalAttachments {
	/** 持つ。戻り値を呼ぶと手放す（2回呼んでも1回分）。 */
	hold(terminalKey: string): () => void;
	/** いま持たれている数（テスト用）。 */
	count(terminalKey: string): number;
}

export function createTerminalAttachments(attach: (terminalKey: string) => void, detach: (terminalKey: string) => void): TerminalAttachments {
	const counts = new Map<string, number>();
	return {
		hold(terminalKey) {
			counts.set(terminalKey, (counts.get(terminalKey) ?? 0) + 1);
			attach(terminalKey);
			let released = false;
			return () => {
				if (released) {
					return;
				}
				released = true;
				const next = (counts.get(terminalKey) ?? 1) - 1;
				if (next > 0) {
					counts.set(terminalKey, next);
					return;
				}
				counts.delete(terminalKey);
				detach(terminalKey);
			};
		},
		count(terminalKey) {
			return counts.get(terminalKey) ?? 0;
		},
	};
}
