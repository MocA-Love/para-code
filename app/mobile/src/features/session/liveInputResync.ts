// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ライブ入力で PC に届かなかった打鍵の後始末（Q144 A）。
 *
 * ライブ入力の打鍵はアウトボックスへ積まずに送り、つながっていなければ捨てる（再接続のときにまとめて再送すると、
 * そのときの別のプロンプトで実行されるため）。入力欄は「PC の行に送った文字」を覚えて差分を送るので、捨てた打鍵が
 * あると PC の行とずれる（⌫ が PC にある別の文字を消す）。捨てた打鍵があれば、つながっているときにすぐ、
 * つながっていなければつながり直したときに、入力欄を空から作り直させる。打った文字は送り直さない。
 */
export class LiveInputResync {
	private dropped = false;
	private ready = false;

	constructor(private readonly rebuild: () => void) { }

	/** 打鍵を送った結果（PC へ送れたか）。 */
	settle(accepted: boolean): void {
		if (accepted) {
			return;
		}
		this.dropped = true;
		this.flush();
	}

	/** PC へ打鍵を送れる状態か（接続・PC の在席・通信の取り決め）が変わった。 */
	setReady(ready: boolean): void {
		this.ready = ready;
		this.flush();
	}

	private flush(): void {
		if (this.dropped && this.ready) {
			this.dropped = false;
			this.rebuild();
		}
	}
}
