// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** contentSizeの伸びが止まったとみなすまでの静穏時間。 */
export const INITIAL_REVEAL_QUIET_MS = 140;
/** 静穏が訪れなくても必ず見せるまでの上限。 */
export const INITIAL_REVEAL_DEADLINE_MS = 900;

/** setTimeout/clearTimeout の注入口（テストでは即時に進められる偽物を渡す）。 */
export interface RevealTimers {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/**
 * エージェント詳細の初回表示ゲート。
 *
 * チャットは通常方向のFlatListで、先頭（最古）から分割描画しつつ contentSize が
 * 伸びるたびに末尾へ寄せて最新へ辿り着く。行の描画が重くなるとこの追いかけが
 * 目に見えるようになり、開いた直後に履歴が上から流れ落ちて最新へ飛ぶように映る。
 * そこで到達するまでリストを見せず、落ち着いてから一度に見せる。
 *
 * 到達の判定は「contentSizeの伸びが静穏時間だけ止まったら」。静穏の計測は最初の
 * noteGrowth() から始める（重い端末で描画開始が遅れたとき、追いかけが始まる前に
 * 静穏が成立して空振りするのを避ける）。伸び続ける場合や描画通知が来ない場合でも
 * 上限時間で必ず見せ、無限に隠れ続けないようにする。上限は最初の begin() を起点に
 * 数え、begin() が短い間隔で繰り返されても延びない。
 */
export class AgentInitialRevealGate {
	private quietHandle: unknown;
	private deadlineHandle: unknown;
	private revealed = true;
	private disposed = false;

	constructor(
		private readonly onReveal: () => void,
		private readonly timers: RevealTimers = globalThis,
		private readonly quietMs: number = INITIAL_REVEAL_QUIET_MS,
		private readonly deadlineMs: number = INITIAL_REVEAL_DEADLINE_MS,
	) { }

	/** まだ隠している最中か。begin() 前・reveal 後はどちらも表示側。 */
	get isRevealed(): boolean {
		return this.revealed;
	}

	/** 画面を開いた／対象を切り替えた。ここから到達するまで隠す。 */
	begin(): void {
		this.disposed = false;
		this.timers.clearTimeout(this.quietHandle);
		this.quietHandle = undefined;
		this.revealed = false;
		// 上限は既に走っていれば引き継ぐ。ここで張り直すと、begin() が静穏時間より
		// 短い間隔で繰り返される状況（再接続直後の none ⇄ snapshot のばたつき等）で
		// どちらのタイマーも成立せず、隠れたまま戻らなくなる。
		if (this.deadlineHandle === undefined) {
			this.deadlineHandle = this.timers.setTimeout(() => this.reveal(), this.deadlineMs);
		}
	}

	/** contentSizeが伸びて末尾へ寄せ直した。静穏の起点を引き直す。 */
	noteGrowth(): void {
		if (this.revealed || this.disposed) {
			return;
		}
		this.timers.clearTimeout(this.quietHandle);
		this.quietHandle = this.timers.setTimeout(() => this.reveal(), this.quietMs);
	}

	/** 隠したままにしてはいけなくなった（保険。通常は静穏か上限で表示に転じる）。 */
	revealNow(): void {
		this.reveal();
	}

	/** 画面を離れる。保留中のタイマーを落とし、以後の通知も止める。 */
	dispose(): void {
		this.disposed = true;
		this.clear();
	}

	private reveal(): void {
		if (this.revealed || this.disposed) {
			return;
		}
		this.clear();
		this.revealed = true;
		this.onReveal();
	}

	private clear(): void {
		this.timers.clearTimeout(this.quietHandle);
		this.timers.clearTimeout(this.deadlineHandle);
		this.quietHandle = undefined;
		this.deadlineHandle = undefined;
	}
}
