// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 裏に回っても30秒は接続を保つ（W2-34。Orca の mobile-relay-background-grace.ts に倣い、Q126 A で絞った）。
 *
 * 以前は裏に回った瞬間にソケットを閉じていたので、通知を見に一瞬ほかのアプリへ移るだけで、戻るたびに
 * 暗号の握手と状態の読み直しが走っていた。
 *
 * **単純に保つだけにしてはいけない。** PC は「最後にスマホから受信してから40秒以内ならアプリは生きている」
 * とみなしてプッシュを送らず、アプリは裏にいる間バナーを出さない。保つだけだと、裏に回った直後の
 * 完了や質問がプッシュにもバナーにもならない。そこでアプリは裏に回ったことを PC へ知らせ、PC が2秒以内に
 * 確認を返したときだけ保つ（確認を受けた PC は、そのスマホへの通知をプッシュで送る）。確認が来なければ、
 * 今までどおりすぐ閉じる。旧 PC は確認を返さないので（capability も広告しない）、何も変わらない。
 *
 * 期限は時刻で持つ。裏では JS が止まってタイマーが遅れるので、前面に戻ったときに期限を過ぎていれば、
 * 閉じてから張り直す（今の suspend → resume と同じ）。保っている間に切れた・張り直しそうになった接続は
 * RelayClient が suspend 相当に落とす（`holdInBackground`）。iOS の背景タスクは使わない。
 */

/** 保つ長さ。 */
export const BACKGROUND_GRACE_MS = 30_000;
/** PC の確認を待つ長さ。裏に回ったあとの数秒で JS が止まりうるので短くする。 */
export const BACKGROUND_GRACE_ACK_TIMEOUT_MS = 2_000;

/** PC 1台ぶんの操作（実体は MobileController）。 */
export interface BackgroundGraceTarget {
	readonly id: string;
	/** 保てる状態か（つながっていて、PC が `conn.background-grace.v1` を広告している）。 */
	canHold(): boolean;
	/** 「裏に回った」を送り、PC の確認を待つ。確認が来たら true（このとき RelayClient は保持に入っている）。 */
	requestGrace(timeoutMs: number): Promise<boolean>;
	/** 今までどおり閉じる。 */
	suspend(): void;
	/** 前面へ戻る（閉じていれば張り直す、保っていれば保持を解く）。 */
	resume(): void;
	/** 「前面に戻った」を PC へ送り、生きているかを確かめる。 */
	sendForeground(): void;
}

export type BackgroundGraceLog = (id: string, event: { readonly kind: 'grace-requested' | 'grace-held' | 'grace-refused' | 'grace-ended'; readonly detail?: string }) => void;

export interface BackgroundGraceTimers {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

interface Held {
	readonly target: BackgroundGraceTarget;
	readonly deadline: number;
	readonly timer: unknown;
}

export class BackgroundGrace {
	/** 裏へ回る・前へ戻るたびに進める。確認が遅れて届いたとき、もう戻っていれば捨てる。 */
	private generation = 0;
	private readonly held = new Map<string, Held>();
	private readonly pending = new Map<string, BackgroundGraceTarget>();

	constructor(
		private readonly timers: BackgroundGraceTimers = globalThis,
		private readonly now: () => number = Date.now,
		private readonly log: BackgroundGraceLog = () => undefined,
	) { }

	/** 保っている、または確認を待っている PC か（その間は接続方針から閉じない）。 */
	isHolding(id: string): boolean {
		return this.held.has(id) || this.pending.has(id);
	}

	/** 裏に回った。保てる PC は PC の確認を待ち、それ以外はすぐ閉じる。 */
	enterBackground(targets: readonly BackgroundGraceTarget[]): void {
		const generation = ++this.generation;
		const deadline = this.now() + BACKGROUND_GRACE_MS;
		for (const target of targets) {
			this.release(target.id);
			if (!target.canHold()) {
				target.suspend();
				continue;
			}
			this.pending.set(target.id, target);
			this.log(target.id, { kind: 'grace-requested' });
			const settle = (acked: boolean) => {
				if (generation !== this.generation || this.pending.get(target.id) !== target) {
					return;
				}
				this.pending.delete(target.id);
				const remaining = deadline - this.now();
				if (!acked || remaining <= 0) {
					this.log(target.id, { kind: 'grace-refused', detail: acked ? '確認が遅れた' : '2 秒以内に確認なし' });
					target.suspend();
					return;
				}
				this.log(target.id, { kind: 'grace-held' });
				const timer = this.timers.setTimeout(() => {
					if (this.held.get(target.id)?.timer === timer) {
						this.held.delete(target.id);
						this.log(target.id, { kind: 'grace-ended', detail: '30 秒たった' });
						target.suspend();
					}
				}, remaining);
				this.held.set(target.id, { target, deadline, timer });
			};
			target.requestGrace(BACKGROUND_GRACE_ACK_TIMEOUT_MS).then(settle, () => settle(false));
		}
	}

	/**
	 * 前面へ戻った。保っていた PC は「前面に戻った」を送って続きから使う。期限を過ぎていたら
	 * （裏でタイマーが止まっていた）閉じてから張り直す。保っていなかった PC はいつもどおり張り直す。
	 */
	enterForeground(targets: readonly BackgroundGraceTarget[]): void {
		this.generation++;
		const now = this.now();
		const seen = new Set<string>();
		for (const target of targets) {
			seen.add(target.id);
			const held = this.held.get(target.id);
			const pending = this.pending.get(target.id);
			this.release(target.id);
			if (held !== undefined && now >= held.deadline) {
				this.log(target.id, { kind: 'grace-ended', detail: '期限を過ぎていたので張り直す' });
				target.suspend();
				target.resume();
				continue;
			}
			target.resume();
			if (held !== undefined || pending !== undefined) {
				target.sendForeground();
			}
		}
		// 一覧から外れた PC（接続を保たない設定になった等）の保持は、ここで閉じて終える。
		for (const [id, held] of [...this.held]) {
			if (!seen.has(id)) {
				this.release(id);
				held.target.suspend();
			}
		}
		for (const [id, target] of [...this.pending]) {
			if (!seen.has(id)) {
				this.release(id);
				target.suspend();
			}
		}
	}

	/** その PC の保持を終えて閉じる（ペアリング解除など）。 */
	end(id: string): void {
		const held = this.held.get(id);
		const pending = this.pending.get(id);
		this.release(id);
		(held?.target ?? pending)?.suspend();
	}

	private release(id: string): void {
		const held = this.held.get(id);
		if (held !== undefined) {
			this.timers.clearTimeout(held.timer);
			this.held.delete(id);
		}
		this.pending.delete(id);
	}
}
