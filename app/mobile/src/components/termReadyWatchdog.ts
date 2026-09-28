// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ターミナルの WebView が「準備完了」を返さないまま固まるのを見張る（Orca の
 * terminal-webview-ready-watchdog と同じ考え方）。
 *
 * WebView の中の script が準備完了を送る前に止まると（バンドルの読み込み失敗、橋渡しが立ち上がらない等）、
 * エラーもネイティブの通知も来ない。以前はそのまま何も言わずに真っ黒のままだった。
 *
 * - 見張りを置いてから 15 秒以内に準備完了が来なければ、1 回だけ読み直す
 * - 読み直してもまた 15 秒来なければ、失敗として知らせる（画面はエラーと［再試行］を出す）
 * - アプリが裏に回っている間は WebView が止まっていて当然なので、判定を先送りする
 */

/** 準備完了を待つ時間（ms）。 */
export const TERM_READY_WATCHDOG_MS = 15_000;

export interface TermReadyWatchdogHost {
	/** アプリが前面にあるか。裏に回っている間は判定しない。 */
	isForeground(): boolean;
	/** 読み直す（見張りが 1 回目の時間切れで呼ぶ）。 */
	reload(): void;
	/** 読み直しても準備完了が来なかった。 */
	fail(): void;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface TermReadyWatchdog {
	/** 読み込みを始めた（初回・プロセスが落ちて読み直したとき）。見張りを置き直す（dispose の後でも付け直せる）。 */
	arm(): void;
	/** 準備完了が来た。見張りを外し、次の読み込みでは自動の読み直しをまた 1 回使えるようにする。 */
	ready(): void;
	/** 利用者が［再試行］を押した。読み直し、次の時間切れではすぐ失敗として知らせる。 */
	retry(): void;
	/** 見張りを外す（画面を外したとき）。 */
	dispose(): void;
}

export function createTermReadyWatchdog(host: TermReadyWatchdogHost, timeoutMs: number = TERM_READY_WATCHDOG_MS): TermReadyWatchdog {
	let timer: unknown;
	let reloaded = false;
	let disposed = false;

	const cancel = () => {
		if (timer !== undefined) {
			host.clearTimeout(timer);
			timer = undefined;
		}
	};
	const schedule = () => {
		cancel();
		if (disposed) {
			return;
		}
		timer = host.setTimeout(fire, timeoutMs);
	};
	function fire(): void {
		timer = undefined;
		if (disposed) {
			return;
		}
		if (!host.isForeground()) {
			schedule();
			return;
		}
		if (!reloaded) {
			reloaded = true;
			host.reload();
			schedule();
			return;
		}
		host.fail();
	}

	return {
		arm() {
			// StrictMode の開発ビルドは effect を外してから付け直すので、dispose の後の arm で見張りを戻す。
			disposed = false;
			schedule();
		},
		ready() {
			cancel();
			reloaded = false;
		},
		retry() {
			reloaded = true;
			host.reload();
			schedule();
		},
		dispose() {
			disposed = true;
			cancel();
		},
	};
}
