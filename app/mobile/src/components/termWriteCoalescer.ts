// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ターミナルの WebView へ流す出力のまとめ役（Orca の terminal-write-coalescer と同じ考え方）。
 *
 * `injectJavaScript` は 1 回ごとにネイティブの橋渡しと WebKit のプロセス間通信、描画の手間がかかる。
 * PC は 16ms でまとめて送ってくるが、中継と復号の後にまとめて届くと呼び出しが連発する。ここで
 * 48ms の窓にまとめ、出力が流れ続けるあいだの呼び出しを秒 20 回程度に抑える。
 *
 * - 暇なときの最初の 1 件はすぐ流す（キーのこだまを遅らせない）
 * - 以降は 48ms の窓ごとに 1 回だけ流す
 * - 溜まった量が 512K 文字を超えたら窓を待たずに流す（PC のフロー制御が壊れても膨らみ続けない）
 * - 次の 1 件が来た時点で窓を過ぎていれば、タイマーを待たずにまとめて流す（JS が詰まってタイマーが遅れても止まらない）
 *
 * 流す単位 1 つが WebView への書き込み 1 回になるので、取りこぼし検出の連番（`injectSeq`）は
 * 呼び出し側がこの単位で振る。snapshot・破棄・裏に回る直前は、呼び出し側が `flushNow()` で
 * 先に流してから次の操作をする（順序を崩さない）。
 */

/** まとめる窓（ms）。 */
export const TERM_WRITE_FLUSH_WINDOW_MS = 48;
/** これを超えて溜まったら窓を待たずに流す（UTF-16 の文字数）。 */
export const TERM_WRITE_MAX_PENDING_CHARS = 512 * 1024;

/** 時計とタイマー（テストで差し替える）。 */
export interface TermWriteClock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const systemClock: TermWriteClock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TermWriteCoalescer {
	/** 出力 1 件を受け取る。暇なら即流し、そうでなければ窓の終わりにまとめて流す。 */
	write(data: string): void;
	/** 溜まっている分をいま流す（無ければ何もしない）。 */
	flushNow(): void;
	/** 溜まっている分を流さずに捨て、次の 1 件を即流せる状態へ戻す（WebView を読み直したとき）。 */
	clear(): void;
	/** 溜まっている文字数（テストと診断用）。 */
	readonly pendingChars: number;
}

export function createTermWriteCoalescer(deliver: (data: string) => void, clock: TermWriteClock = systemClock): TermWriteCoalescer {
	let pending: string[] = [];
	let pendingChars = 0;
	let timer: unknown;
	// 最初の 1 件（作った直後・clear の直後）は窓を待たずに流すため、十分に昔にしておく。
	let lastFlushAt = Number.NEGATIVE_INFINITY;

	const cancelTimer = () => {
		if (timer !== undefined) {
			clock.clearTimeout(timer);
			timer = undefined;
		}
	};

	const flushNow = () => {
		cancelTimer();
		if (pending.length === 0) {
			return;
		}
		const data = pending.join('');
		pending = [];
		pendingChars = 0;
		lastFlushAt = clock.now();
		deliver(data);
	};

	return {
		write(data: string) {
			if (data.length === 0) {
				return;
			}
			const now = clock.now();
			if (pending.length === 0 && now - lastFlushAt >= TERM_WRITE_FLUSH_WINDOW_MS) {
				lastFlushAt = now;
				deliver(data);
				return;
			}
			pending.push(data);
			pendingChars += data.length;
			// 窓を過ぎているのに溜まったまま（JS が詰まってタイマーが動けていない）なら、タイマーを待たずに流す。
			// 詰まりが続く間はタイマーの順番が回ってこず、出力が何秒も止まって見える。
			if (pendingChars > TERM_WRITE_MAX_PENDING_CHARS || now - lastFlushAt >= TERM_WRITE_FLUSH_WINDOW_MS) {
				flushNow();
				return;
			}
			if (timer === undefined) {
				// 窓の残りだけ待つ。時計が戻った（NTP・時差）ときに長く待たないよう、窓の長さで頭打ちにする。
				const remaining = Math.min(TERM_WRITE_FLUSH_WINDOW_MS, Math.max(0, TERM_WRITE_FLUSH_WINDOW_MS - (now - lastFlushAt)));
				timer = clock.setTimeout(() => {
					timer = undefined;
					flushNow();
				}, remaining);
			}
		},
		flushNow,
		clear() {
			cancelTimer();
			pending = [];
			pendingChars = 0;
			lastFlushAt = Number.NEGATIVE_INFINITY;
		},
		get pendingChars() {
			return pendingChars;
		},
	};
}
