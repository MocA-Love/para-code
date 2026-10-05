/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知音（ringtone）と Aivis 読み上げの再生を重ならないよう調停するスケジューラ。
// Superset apps/desktop の main/lib/notifications/audio-scheduler.ts をほぼそのまま移植したもの。
//
// ルール:
// - 通知音: いずれかの音声チャネルがビジーなら「捨てる」。通知音自体は情報を持たないので、
//   2つ目を無音でスキップしても安全（重ねない・切断しない）。
// - Aivis: FIFOキューで発話を処理する。PermissionRequest（要対応）は待機中の Stop（完了）より
//   前に割り込むが、再生中の発話は中断しない。ただし待機キューには上限があり、超過した
//   normal は捨てられる（high を受け入れるために最古の normal が追い出されることもある）。
// - レート制限: Aivis Cloud は X-Aivis-RateLimit-Requests-* ヘッダーを返す。Remaining が 0 になったら
//   429 を踏む前に Reset + 0.5s 待ってから次のリクエストを送る。
// - エラーポリシー:
//     retryable (429 / 5xx / ネットワーク・タイムアウト): 指数バックオフ、最大3回。
//     fatal (401 / 402 / 404): キューを破棄して一時停止し、ユーザーへ可視通知。APIキー/クレジット/
//       モデル設定の修正が必要なため自動再開しない。
//     item-specific (422 / 再生失敗): そのアイテムだけスキップし、他は処理を続ける。
//
// aivis-mcp 2.5.0 の `--ingest` があるとき（設計 3.3）は、タスクを worker へ渡す（handoff）。鳴らす順番と
// 着信音は worker が決めるので、ここに残すのは優先の割り込み・レート制限・再試行・一時停止の判断だけ。
// `queued`（列に入った）で手放し、同時に渡すのは 3 本まで（high が先）。手放した後も合成を `--ingest` へ流している
// 件（転送中）は別に数え、4 本までにする（手放すたびに次を渡して、転送と控えの音声が際限なく増えないように）。
// 音声入力中も渡してよい（worker の hold が鳴らすのを止める）。渡せなかった件は、合成済みならもう一度だけ worker へ
// 渡し直し、それでも駄目なら afplay で鳴らす普通のタスクとして列の先頭へ戻す。`--ingest` を起こし直している間
// （worker が生きているかもしれない）は afplay に回さず、復旧を待って渡す（上限 2 分）。

export type AivisErrorKind = 'retryable' | 'fatal' | 'item-specific';

export interface AivisRateLimit {
	/** 現在のウィンドウで残っているリクエスト数（レスポンスヘッダー由来）。 */
	readonly remaining: number;
	/** ウィンドウがリセットされるまでの秒数（レスポンスヘッダー由来）。 */
	readonly resetSeconds: number;
	/** ヘッダーを観測したローカルタイムスタンプ。 */
	readonly capturedAt: number;
}

export class AivisError extends Error {
	constructor(
		readonly kind: AivisErrorKind,
		readonly reason: string,
		readonly status?: number,
		/** 429 の場合: リトライまでに待つべき秒数（ヘッダー由来）。 */
		readonly rateLimitReset?: number,
		cause?: unknown,
	) {
		super(reason, cause !== undefined ? { cause } : undefined);
		this.name = 'AivisError';
	}
}

export interface AivisSynthesizeResult {
	readonly audio: Buffer;
	readonly rateLimit?: AivisRateLimit;
}

/** 少しずつ受け取る合成。応答のヘッダーまでを確かめた後の本文。 */
export interface AivisStreamingSynthesis {
	readonly body: AsyncIterable<Uint8Array>;
	readonly rateLimit?: AivisRateLimit;
}

/** 手放した件の転送の終わり。`retry` は最初の音より前に合成が切れた（worker は何も鳴らしていない）ので再試行する。 */
export interface AivisHandoffSettled {
	readonly retry?: AivisError;
}

/**
 * worker へ渡した結果。`released` は列に入った（手放してよい）。`settled` は合成の転送が終わったら解決する。
 * `fallback` は渡せなかったので、Para Code が自分で鳴らす（`audio` があれば合成し直さずにそれを鳴らす）。
 * `defer` は今は渡せないが、worker が生きているかもしれない（`--ingest` を起こし直している）ので afplay で鳴らさず待つ。
 */
export type AivisHandoffResult =
	| { readonly kind: 'released'; readonly rateLimit?: AivisRateLimit; readonly settled?: Promise<AivisHandoffSettled> }
	| { readonly kind: 'fallback'; readonly audio?: Buffer; readonly rateLimit?: AivisRateLimit }
	| { readonly kind: 'defer' };

/**
 * キュー投入可能な Aivis タスク1件。スケジューラは synthesize()（AivisError を throw しうる）を
 * 呼び、返った audio で play() を呼ぶ。play() は再生完了で resolve する（reject は item-specific
 * 失敗として扱う）。
 */
export interface AivisTaskRunner {
	synthesize(): Promise<AivisSynthesizeResult>;
	play(audio: Buffer): Promise<void>;
	/**
	 * worker へ渡す（`--ingest` があるときだけ呼ばれる）。`attempt` は 1 から数える再試行の回数で、2 回目以降は
	 * 着信音を付けない。合成の失敗は AivisError を投げる（再試行・一時停止の判断はスケジューラがする）。
	 */
	handoff?(attempt: number): Promise<AivisHandoffResult>;
	/**
	 * 合成済みの音声を worker へ渡し直す（`queued` の前に `--ingest` が落ちて取り下げられた件など）。無ければ渡し直さず
	 * Para Code が鳴らす。
	 */
	handoffAudio?(audio: Buffer): Promise<AivisHandoffResult>;
	/**
	 * Para Code が自分で鳴らす直前（再生中の判定より前）に呼ぶ。預かった着信音をここで鳴らす（合成の中で鳴らすと、
	 * 再生中として捨てられる）。
	 */
	startRingtone?(): void;
	/** 列に入らなかった・追い出された・一時停止で捨てられた。預かった着信音を今鳴らす。 */
	onDropped?(): void;
}

export type AivisPriority = 'normal' | 'high';

export interface AudioSchedulerDeps {
	/**
	 * 設定された通知音を再生する。onComplete は、再生成功・スキップ（ミュート/ファイル無し）・失敗の
	 * いずれの場合でも必ず1回だけ呼ぶこと。
	 */
	playRingtone(onComplete: () => void): void;
	/**
	 * fatal エラーでキューが破棄された際に、ユーザーへ「Aivis を一時停止した」旨の可視通知を出す。
	 */
	notifyAivisPaused(reason: string): void;
	/** テレメトリ/ログ用フック。任意。 */
	onError?(err: AivisError): void;
	/** 警告ログ出力（shared process では console を避けるため ILogService へ委譲する）。任意。 */
	logWarn?(message: string): void;
	/** 情報ログ出力。任意。 */
	logInfo?(message: string): void;
	/** テスト用に差し込む時計。既定は Date.now。 */
	now?(): number;
	/** テスト用に差し込む sleep。既定は setTimeout。 */
	sleep?(ms: number): Promise<void>;
	/**
	 * onComplete を呼ばない不良 `playRingtone` に対する安全網。この期限までにコールバックが発火
	 * しなければ、スケジューラはビジーフラグを強制解放して待機中の Aivis タスクを起こす。既定 30s。
	 */
	ringtoneSafetyTimeoutMs?: number;
	/**
	 * 完了しない `runner.play` に対する安全網。この期限までに play が resolve/reject しなければ、
	 * スケジューラは再生をあきらめて次の Aivis タスクへ進む（aivisBusy の張り付きを防ぐ）。既定 30s。
	 */
	aivisPlaySafetyTimeoutMs?: number;
	/**
	 * Para Code が自分で声を鳴らす直前に、worker の再生 lock が空くのを待つ（重ねない）。{@link aivisPlaySafetyTimeoutMs}
	 * の外で待つ（待ちが安全網の時間を食って、鳴らしている途中で次の声を重ねないように）。任意。
	 */
	waitForPlayLock?(): Promise<void>;
	/**
	 * 待機キューの上限。通知爆発×レート制限滞留の組合せでキュー（テキスト+APIキーを capture した
	 * クロージャ）が単調増加しないようにする。超過時は normal を落とし、high は最も古い normal を
	 * 追い出して割り込む。既定 20。
	 */
	maxQueuedAivisTasks?: number;
	/** いま worker へ渡せるか（`--ingest` が使えるか）。無ければ渡さない。 */
	isHandoffAvailable?(): boolean;
	/** 同時に worker へ渡す本数の上限。既定 3。 */
	maxConcurrentHandoffs?: number;
	/** 手放した後も合成を流している件を含めた、転送中の本数の上限。既定 4。 */
	maxConcurrentTransfers?: number;
	/** `--ingest` の復旧を待つ上限。過ぎたら Para Code が鳴らす。既定 2 分。 */
	maxHandoffDeferMs?: number;
}

export interface AivisEnqueueOptions {
	/** 列の先頭に入れる（渡せなかった件を鳴らし直すとき）。 */
	readonly front?: boolean;
	/** worker へ渡さず、Para Code が自分で鳴らす。 */
	readonly localOnly?: boolean;
	/** 一時停止中でも入れ、一時停止で捨てない（Para Code の合成と関係ない声）。 */
	readonly ignorePause?: boolean;
	/** 合成済み。レート制限を待たない。 */
	readonly presynthesized?: boolean;
	/**
	 * 引き受けた声（SSH 先の声・worker が鳴らせなかった件の鳴らし直し）。列が満杯でも、別の有界の枠
	 * （{@link MAX_RESERVED_AIVIS_TASKS}）に入れる。high の割り込みでも追い出さない。
	 */
	readonly reserved?: boolean;
}

const MAX_RETRY_ATTEMPTS = 3;
// 「試行 N と N+1 の間の sleep」を1エントリとする。MAX_RETRY_ATTEMPTS=3 では試行1と2の後のみ
// sleep する（試行3は最後なので sleep 前に break する）ため、2エントリで足りる。
const DEFAULT_BACKOFF_MS = [1000, 2000];
const RATE_LIMIT_MARGIN_MS = 500;
const RINGTONE_SAFETY_TIMEOUT_MS = 30_000;
// Aivis 再生ハングに対する安全網の期限。着信音側（RINGTONE_SAFETY_TIMEOUT_MS）と対称の値にする:
// 発話音声1件として十分長く、正常な再生（通常は数秒）が誤って打ち切られることはない一方、
// OS の再生プロセス（afplay 等）がハングしてもこの期限で必ずキューが前進する。
const AIVIS_PLAY_SAFETY_TIMEOUT_MS = 30_000;
// 待機キューの上限。発話1件は数秒〜数十秒の再生を伴うため、この値でもバックログとしては
// 十分に長い。上限なしだと通知爆発×レート制限滞留でメモリと読み上げ遅延が単調増加する。
const MAX_AIVIS_QUEUE_SIZE = 20;
/** 引き受けた声だけが使う、列の上限の外の枠。 */
export const MAX_RESERVED_AIVIS_TASKS = 8;
const MAX_CONCURRENT_HANDOFFS = 3;
const MAX_CONCURRENT_TRANSFERS = 4;
/** `--ingest` の復旧を待つ間、渡し直しを試す間隔と、待つ上限。 */
const HANDOFF_DEFER_RETRY_MS = 1_000;
const MAX_HANDOFF_DEFER_MS = 120_000;
/** 合成済みの音声を worker へ渡し直す回数の上限。 */
const MAX_REHANDOFFS = 1;

function defaultSleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

interface QueueEntry {
	priority: AivisPriority;
	runner: AivisTaskRunner;
	localOnly?: boolean;
	ignorePause?: boolean;
	presynthesized?: boolean;
	reserved?: boolean;
	/** 次に渡すときの試行の回数（1 から）。 */
	attempt?: number;
	/** `--ingest` の復旧を待ち始めた時刻。 */
	deferredSince?: number;
	/** 合成済みの音声を渡し直した回数。 */
	rehandoffs?: number;
	/** 列に入れた順の番号。渡し直し・再試行で戻すときも、この順の位置へ戻す。 */
	order?: number;
}

export class AudioScheduler {
	private ringtoneBusy = false;
	private aivisBusy = false;
	private activeHandoffs = 0;
	private activeTransfers = 0;
	private nextOrder = 0;
	/** `--ingest` の復旧を待っている件の数。待っている間は後ろの件を渡さない（順番を入れ替えない）。 */
	private deferring = 0;
	/** 復旧待ちが一度時間切れになった。次に worker へ渡せるまで、待たずに Para Code が鳴らす。 */
	private deferExpired = false;
	private queue: QueueEntry[] = [];
	private paused = false;
	/** 音声入力（ディクテーション）中。新しい再生を始めない（キューは捨てない）。 */
	private held = false;
	private rateLimit?: AivisRateLimit;
	private disposed = false;
	private ringtoneIdleWaiters: Array<() => void> = [];
	private releaseWaiters: Array<() => void> = [];
	private ringtoneSafetyTimer: ReturnType<typeof setTimeout> | null = null;
	private aivisPlaySafetyTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly deps: AudioSchedulerDeps) { }

	playRingtone(): void {
		if (this.disposed) { return; }
		// 音声入力中の通知音はマイクに拾われるだけなので捨てる（通知音は情報を持たない）。
		if (this.held || this.ringtoneBusy || this.aivisBusy) { return; }
		this.ringtoneBusy = true;
		// 多重防御: deps.playRingtone が onComplete を呼び忘れる（契約違反）と waitForRingtoneIdle が
		// 永久にハングし Aivis キュー全体が止まる。安全タイマーがビジーフラグを強制解放する。
		this.ringtoneSafetyTimer = setTimeout(() => {
			if (this.ringtoneBusy) {
				this.deps.logWarn?.('[audio-scheduler] ringtone onComplete did not fire within safety timeout; force-releasing');
				this.onRingtoneComplete();
			}
		}, this.deps.ringtoneSafetyTimeoutMs ?? RINGTONE_SAFETY_TIMEOUT_MS);
		try {
			this.deps.playRingtone(() => {
				this.onRingtoneComplete();
			});
		} catch (err) {
			this.onRingtoneComplete();
			this.deps.logWarn?.(`[audio-scheduler] ringtone failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private onRingtoneComplete(): void {
		this.ringtoneBusy = false;
		if (this.ringtoneSafetyTimer) {
			clearTimeout(this.ringtoneSafetyTimer);
			this.ringtoneSafetyTimer = null;
		}
		const waiters = this.ringtoneIdleWaiters;
		this.ringtoneIdleWaiters = [];
		for (const resolve of waiters) { resolve(); }
	}

	private waitForRingtoneIdle(): Promise<void> {
		if (!this.ringtoneBusy || this.disposed) { return Promise.resolve(); }
		return new Promise<void>(resolve => {
			this.ringtoneIdleWaiters.push(resolve);
		});
	}

	/** 列に入れる。入らなかった（一時停止中・満杯・破棄済み）ら false。 */
	enqueueAivis(runner: AivisTaskRunner, priority: AivisPriority = 'normal', options: AivisEnqueueOptions = {}): boolean {
		if (this.disposed || (this.paused && !options.ignorePause)) { return false; }
		const max = Math.max(1, this.deps.maxQueuedAivisTasks ?? MAX_AIVIS_QUEUE_SIZE);
		const reservedCount = this.queue.filter(e => e.reserved).length;
		if (options.reserved) {
			if (reservedCount >= MAX_RESERVED_AIVIS_TASKS) {
				this.deps.logWarn?.('[audio-scheduler] dropped an accepted voice because the reserved slots are full');
				return false;
			}
		} else if (this.queue.length - reservedCount >= max) {
			if (priority === 'high') {
				// 要対応の通知は可能な限り生かす。最も古い normal を追い出して割り込む
				// （normal が1件もなければ最も古いエントリを追い出す=新しめの要対応を優先）。引き受けた声は追い出さない
				const oldestNormal = this.queue.findIndex(e => e.priority === 'normal' && !e.reserved);
				const victim = oldestNormal >= 0 ? oldestNormal : this.queue.findIndex(e => !e.reserved);
				if (victim < 0) {
					return false;
				}
				const [evicted] = this.queue.splice(victim, 1);
				evicted?.runner.onDropped?.();
				this.deps.logInfo?.('[audio-scheduler] evicted a queued Aivis task to admit a high-priority one');
			} else {
				this.deps.logInfo?.('[audio-scheduler] dropped a normal-priority Aivis task because the queue is full');
				return false;
			}
		}
		const entry: QueueEntry = {
			priority,
			runner,
			...(options.localOnly ? { localOnly: true } : {}),
			...(options.ignorePause ? { ignorePause: true } : {}),
			...(options.presynthesized ? { presynthesized: true } : {}),
			...(options.reserved ? { reserved: true } : {}),
			order: options.front === true ? Math.min(0, ...this.queue.map(e => e.order ?? 0)) - 1 : ++this.nextOrder,
		};
		this.insert(entry, priority, options.front === true);
		void this.pump();
		return true;
	}

	/** 列の決まった位置に入れる（上限は確かめない。渡し直し・再試行で戻す件に使う）。 */
	private insert(entry: QueueEntry, priority: AivisPriority, front: boolean): void {
		if (front) {
			this.queue.unshift(entry);
		} else if (priority === 'high') {
			const firstNormal = this.queue.findIndex(e => e.priority === 'normal');
			if (firstNormal < 0) { this.queue.push(entry); }
			else { this.queue.splice(firstNormal, 0, entry); }
		} else {
			this.queue.push(entry);
		}
	}

	/**
	 * 渡し直し・再試行・復旧待ちの件を列へ戻す。列に入れた順（high が先）の位置へ戻し、後から入った件に追い越されたまま
	 * にしない。
	 */
	private requeueFront(entry: QueueEntry): void {
		if (this.disposed) {
			entry.runner.onDropped?.();
			return;
		}
		const order = entry.order ?? Number.NEGATIVE_INFINITY;
		const index = this.queue.findIndex(other => entry.priority === 'high' && other.priority === 'normal'
			|| (entry.priority === other.priority && order < (other.order ?? Number.NEGATIVE_INFINITY)));
		if (index < 0) {
			this.queue.push(entry);
		} else {
			this.queue.splice(index, 0, entry);
		}
		void this.pump();
	}

	get aivisQueueSize(): number {
		return this.queue.length;
	}

	get isAivisBusy(): boolean {
		return this.aivisBusy;
	}

	get isPaused(): boolean {
		return this.paused;
	}

	get isHeld(): boolean {
		return this.held;
	}

	/**
	 * 音声入力（ディクテーション）の間、読み上げを止める。
	 *
	 * 止めている間は通知音を捨て、Aivis の発話は始めずにキューへ溜める（上限は通常どおり）。
	 * 解除したら溜まった分を順に読み上げる。再生中の発話を途中で切るのは呼び出し側
	 * （再生プロセスを持っている ParadisNotificationsService）の役目。
	 */
	setHeld(held: boolean): void {
		if (this.disposed || this.held === held) { return; }
		this.held = held;
		if (!held) {
			const waiters = this.releaseWaiters;
			this.releaseWaiters = [];
			for (const resolve of waiters) { resolve(); }
			void this.pump();
		}
	}

	/** 合成中に音声入力が始まった発話は、解除まで再生を待たせる（合成し直さない）。 */
	private waitForRelease(): Promise<void> {
		if (!this.held || this.disposed) { return Promise.resolve(); }
		return new Promise<void>(resolve => {
			this.releaseWaiters.push(resolve);
		});
	}

	/** 一時停止状態を解除する（ユーザーが APIキーを修正した後など）。 */
	resume(): void {
		if (this.disposed) { return; }
		this.paused = false;
		void this.pump();
	}

	dispose(): void {
		this.disposed = true;
		this.queue = [];
		if (this.ringtoneSafetyTimer) {
			clearTimeout(this.ringtoneSafetyTimer);
			this.ringtoneSafetyTimer = null;
		}
		if (this.aivisPlaySafetyTimer) {
			clearTimeout(this.aivisPlaySafetyTimer);
			this.aivisPlaySafetyTimer = null;
		}
		// 進行中の runOne() が永久ハングしないよう、待機中の ringtone-idle / 解除待ちの waiter を全て起こす。
		const waiters = [...this.ringtoneIdleWaiters, ...this.releaseWaiters];
		this.ringtoneIdleWaiters = [];
		this.releaseWaiters = [];
		for (const resolve of waiters) { resolve(); }
	}

	/**
	 * `--ingest` の子が名乗った（worker へ渡せるようになった）。復旧待ちの時間切れを忘れ、次に渡せなくなったときはまた
	 * 待つ。
	 */
	noteHandoffReady(): void {
		this.deferExpired = false;
	}

	/** worker へ渡す件か。 */
	private canHandoff(entry: QueueEntry): boolean {
		return !entry.localOnly && entry.runner.handoff !== undefined && (this.deps.isHandoffAvailable?.() ?? false);
	}

	private async pump(): Promise<void> {
		if (this.disposed) { return; }
		// `--ingest` の復旧を待っている件があれば、後ろの件を先に渡さない・鳴らさない
		if (this.deferring > 0) { return; }
		// worker へ渡す件は、同時に渡す上限まで先頭から順に渡す（音声入力中も渡す。止めるのは worker の hold）
		// 合成済みの声（SSH 先の声・鳴らし直し）は一時停止中でも渡す
		while (this.queue.length > 0 && (!this.paused || this.queue[0].ignorePause) && this.canHandoff(this.queue[0])) {
			if (this.activeHandoffs >= Math.max(1, this.deps.maxConcurrentHandoffs ?? MAX_CONCURRENT_HANDOFFS)) { return; }
			if (this.activeTransfers >= Math.max(1, this.deps.maxConcurrentTransfers ?? MAX_CONCURRENT_TRANSFERS)) { return; }
			const handoffEntry = this.queue.shift()!;
			this.activeHandoffs++;
			this.activeTransfers++;
			let transferDone: Promise<void> | undefined;
			void this.runHandoff(handoffEntry).then(done => { transferDone = done?.transfer; }).finally(() => {
				this.activeHandoffs--;
				// 手放した後も合成を流している件は、流し終えるまで転送の枠を返さない
				void (transferDone ?? Promise.resolve()).finally(() => {
					this.activeTransfers--;
					void this.pump();
				});
				void this.pump();
			});
		}
		if (this.aivisBusy) { return; }
		if (this.paused || this.held) {
			// 一時停止中でも、Para Code の合成と関係ない声（ignorePause で入れた件）は鳴らす
			if (this.held || !this.queue[0]?.ignorePause) { return; }
		}
		const entry = this.queue.shift();
		if (!entry) { return; }
		// 預かった着信音は、再生中の判定より前に鳴らす（runOne は鳴り終わりを待ってから声を鳴らす）
		try {
			entry.runner.startRingtone?.();
		} catch (err) {
			this.deps.logWarn?.(`[audio-scheduler] ringtone failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		this.aivisBusy = true;
		try {
			await this.runOne(entry.runner, entry.presynthesized === true);
		} finally {
			this.aivisBusy = false;
			if (!this.disposed && this.queue.length > 0) {
				void this.pump();
			}
		}
	}

	/**
	 * worker へ渡す。合成の失敗は runOne と同じ決まりで再試行・一時停止する。手放した件は、転送が終わったら解決する
	 * Promise を返す（転送の枠を返す合図。async 関数の戻り値で Promise が平らにならないよう包む）。
	 */
	private async runHandoff(entry: QueueEntry): Promise<{ readonly transfer: Promise<void> } | undefined> {
		if (!entry.presynthesized) {
			await this.waitForRateLimitWindow();
		}
		let lastErr: AivisError | undefined;
		for (let attempt = entry.attempt ?? 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
			if (this.disposed) { return undefined; }
			try {
				const result = await entry.runner.handoff!(attempt);
				if (result.kind === 'released') {
					this.deferExpired = false;
					if (result.rateLimit) { this.rateLimit = result.rateLimit; }
					return result.settled ? { transfer: result.settled.then(settled => this.onHandoffSettled(entry, attempt, settled), () => undefined) } : undefined;
				}
				if (result.kind === 'defer') {
					this.deferHandoff(entry, attempt);
					return undefined;
				}
				if (result.rateLimit) { this.rateLimit = result.rateLimit; }
				this.fallBackToLocal(entry, result.audio);
				return undefined;
			} catch (err) {
				const aivisErr = toAivisError(err);
				lastErr = aivisErr;
				this.deps.onError?.(aivisErr);
				if (aivisErr.kind === 'fatal') {
					entry.runner.onDropped?.();
					this.drainAndPause(aivisErr.reason);
					return undefined;
				}
				if (aivisErr.kind === 'item-specific') {
					entry.runner.onDropped?.();
					return undefined;
				}
				if (attempt >= MAX_RETRY_ATTEMPTS) { break; }
				await (this.deps.sleep ?? defaultSleep)(this.computeBackoffMs(aivisErr, attempt));
			}
		}
		// 読み上げはあきらめたが、預かった着信音（worker が鳴らしていなければ）は鳴らす
		entry.runner.onDropped?.();
		if (lastErr) {
			this.deps.logWarn?.(`[audio-scheduler] aivis handoff gave up after ${MAX_RETRY_ATTEMPTS} attempts: ${lastErr.reason}`);
		}
		return undefined;
	}

	/** 手放した件の転送が終わった。最初の音より前に合成が切れていたら、同じ決まりで再試行する。 */
	private async onHandoffSettled(entry: QueueEntry, attempt: number, settled: AivisHandoffSettled): Promise<void> {
		const err = settled.retry;
		if (err === undefined || this.disposed) {
			return;
		}
		this.deps.onError?.(err);
		if (err.kind === 'fatal') {
			entry.runner.onDropped?.();
			this.drainAndPause(err.reason);
			return;
		}
		if (err.kind === 'item-specific' || attempt >= MAX_RETRY_ATTEMPTS) {
			entry.runner.onDropped?.();
			if (err.kind !== 'item-specific') {
				this.deps.logWarn?.(`[audio-scheduler] aivis handoff gave up after ${MAX_RETRY_ATTEMPTS} attempts: ${err.reason}`);
			}
			return;
		}
		await (this.deps.sleep ?? defaultSleep)(this.computeBackoffMs(err, attempt));
		this.requeueFront({ ...entry, attempt: attempt + 1 });
	}

	/** `--ingest` を起こし直している間は afplay に回さず、少し待って渡し直す。待ちすぎたら Para Code が鳴らす。 */
	private deferHandoff(entry: QueueEntry, attempt: number): void {
		const now = (this.deps.now ?? Date.now)();
		const since = entry.deferredSince ?? now;
		if (this.deferExpired) {
			// 一度待ちきれなかった。次に worker へ渡せるまでは待たない（全部の通知を 2 分ずつ遅らせない）
			this.fallBackToLocal(entry, undefined);
			return;
		}
		if (now - since >= (this.deps.maxHandoffDeferMs ?? MAX_HANDOFF_DEFER_MS)) {
			this.deps.logWarn?.('[audio-scheduler] aivis-mcp --ingest did not come back in time; playing the voice with Para Code');
			this.deferExpired = true;
			this.fallBackToLocal(entry, undefined);
			return;
		}
		this.deferring++;
		void (this.deps.sleep ?? defaultSleep)(HANDOFF_DEFER_RETRY_MS).then(() => {
			this.deferring--;
			this.requeueFront({ ...entry, attempt, deferredSince: since });
		});
	}

	/**
	 * 渡せなかった件を、Para Code が鳴らす件として先頭へ戻す（合成済みならそれを使う）。合成済みの音声は、一度だけ
	 * worker へ渡し直す（`--ingest` が落ちて取り下げられた件は、次の子が名乗っていれば worker が鳴らせる）。
	 */
	private fallBackToLocal(entry: QueueEntry, audio: Buffer | undefined): void {
		const runner = entry.runner;
		const rehandoffs = entry.rehandoffs ?? 0;
		if (audio && runner.handoffAudio && rehandoffs < MAX_REHANDOFFS) {
			const handoffAudio = runner.handoffAudio;
			this.requeueFront({
				priority: entry.priority,
				runner: { synthesize: async () => ({ audio }), play: buffer => runner.play(buffer), startRingtone: () => runner.startRingtone?.(), onDropped: () => runner.onDropped?.(), handoff: () => handoffAudio(audio), handoffAudio },
				ignorePause: true,
				presynthesized: true,
				reserved: entry.reserved,
				rehandoffs: rehandoffs + 1,
				order: entry.order,
			});
			return;
		}
		const local: AivisTaskRunner = audio
			? { synthesize: async () => ({ audio }), play: buffer => runner.play(buffer), startRingtone: () => runner.startRingtone?.(), onDropped: () => runner.onDropped?.() }
			: runner;
		if (this.paused && !(audio !== undefined || entry.ignorePause)) {
			// 一時停止中で鳴らせない。預かった着信音は今鳴らす
			local.onDropped?.();
			return;
		}
		this.requeueFront({ priority: entry.priority, runner: local, localOnly: true, ignorePause: audio !== undefined || entry.ignorePause, presynthesized: audio !== undefined || entry.presynthesized, reserved: entry.reserved, order: entry.order });
	}

	private async runOne(runner: AivisTaskRunner, presynthesized = false): Promise<void> {
		if (!presynthesized) {
			await this.waitForRateLimitWindow();
		}

		let lastErr: AivisError | undefined;
		for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
			if (this.disposed) { return; }
			try {
				const { audio, rateLimit } = await runner.synthesize();
				if (rateLimit) { this.rateLimit = rateLimit; }
				// 合成は通知音と並行してよい（単なるネットワーク呼び出し）が、再生は2つの音声が
				// 重ならないよう通知音の完了を待つ。
				await this.waitForRingtoneIdle();
				await this.waitForRelease();
				if (this.disposed) { return; }
				// worker の再生 lock の待ちは安全網の外で待つ（安全網は鳴らし始めてから数える）
				if (this.deps.waitForPlayLock) {
					await this.deps.waitForPlayLock().catch(() => undefined);
					if (this.disposed) { return; }
				}
				try {
					await this.playWithSafetyTimeout(runner, audio);
				} catch (playErr) {
					// 再生失敗は合成のリトライを正当化しない。
					const wrapped = new AivisError(
						'item-specific',
						// allow-any-unicode-next-line
						'Aivis 音声の再生に失敗しました',
						undefined,
						undefined,
						playErr,
					);
					this.deps.onError?.(wrapped);
				}
				return;
			} catch (err) {
				const aivisErr = toAivisError(err);
				lastErr = aivisErr;
				this.deps.onError?.(aivisErr);

				if (aivisErr.kind === 'fatal') {
					this.drainAndPause(aivisErr.reason);
					return;
				}
				if (aivisErr.kind === 'item-specific') {
					return;
				}
				// retryable — sleep してリトライ（最終試行を除く）。
				if (attempt >= MAX_RETRY_ATTEMPTS) { break; }
				const waitMs = this.computeBackoffMs(aivisErr, attempt);
				await (this.deps.sleep ?? defaultSleep)(waitMs);
			}
		}

		if (lastErr) {
			this.deps.logWarn?.(`[audio-scheduler] aivis task gave up after ${MAX_RETRY_ATTEMPTS} attempts: ${lastErr.reason}`);
		}
	}

	/**
	 * runner.play を安全タイマー付きで待つ。着信音側の ringtoneSafetyTimer と対称の多重防御:
	 * OS の再生プロセス（afplay 等）がハングして play が resolve/reject しないと、runOne が
	 * pump() の finally に到達できず aivisBusy が true のまま張り付き、以後の Aivis 発話が
	 * キューに滞留し続ける。期限内に play が完了しなければ再生をあきらめて resolve し、次の
	 * タスクへ進める（正常完了時は必ずタイマーを clear するので正常系の挙動は変わらない）。
	 */
	private playWithSafetyTimeout(runner: AivisTaskRunner, audio: Buffer): Promise<void> {
		const timeoutMs = this.deps.aivisPlaySafetyTimeoutMs ?? AIVIS_PLAY_SAFETY_TIMEOUT_MS;
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const clearSafetyTimer = () => {
				if (this.aivisPlaySafetyTimer) {
					clearTimeout(this.aivisPlaySafetyTimer);
					this.aivisPlaySafetyTimer = null;
				}
			};
			this.aivisPlaySafetyTimer = setTimeout(() => {
				if (settled) { return; }
				settled = true;
				this.aivisPlaySafetyTimer = null;
				this.deps.logWarn?.('[audio-scheduler] aivis playback did not finish within safety timeout; giving up and continuing');
				// あきらめて次へ進む（item-specific 失敗ではないので握りつぶす）。
				resolve();
			}, timeoutMs);
			runner.play(audio).then(() => {
				if (settled) { return; }
				settled = true;
				clearSafetyTimer();
				resolve();
			}, err => {
				if (settled) { return; }
				settled = true;
				clearSafetyTimer();
				reject(err);
			});
		});
	}

	private computeBackoffMs(err: AivisError, attempt: number): number {
		if (err.status === 429 && err.rateLimitReset !== undefined) {
			return Math.max(0, err.rateLimitReset * 1000 + RATE_LIMIT_MARGIN_MS);
		}
		return DEFAULT_BACKOFF_MS[attempt - 1] ?? DEFAULT_BACKOFF_MS.at(-1) ?? 4000;
	}

	private async waitForRateLimitWindow(): Promise<void> {
		const rl = this.rateLimit;
		if (!rl || rl.remaining > 0) { return; }
		const now = (this.deps.now ?? Date.now)();
		const elapsedMs = now - rl.capturedAt;
		const waitMs = rl.resetSeconds * 1000 - elapsedMs + RATE_LIMIT_MARGIN_MS;
		if (waitMs <= 0) { return; }
		await (this.deps.sleep ?? defaultSleep)(waitMs);
	}

	private drainAndPause(reason: string): void {
		// Para Code の合成と関係ない声（SSH 先の声・合成済みの鳴らし直し）は残す
		const kept = this.queue.filter(entry => entry.ignorePause);
		const droppedEntries = this.queue.filter(entry => !entry.ignorePause);
		const dropped = droppedEntries.length;
		this.queue = kept;
		for (const entry of droppedEntries) {
			entry.runner.onDropped?.();
		}
		this.paused = true;
		this.deps.notifyAivisPaused(reason);
		if (dropped > 0) {
			this.deps.logInfo?.(`[audio-scheduler] dropped ${dropped} queued Aivis task(s) after fatal error: ${reason}`);
		}
		if (kept.length > 0) {
			void this.pump();
		}
	}
}

export function toAivisError(err: unknown): AivisError {
	if (err instanceof AivisError) { return err; }
	if (err instanceof Error && err.name === 'AbortError') {
		return new AivisError(
			'retryable',
			// allow-any-unicode-next-line
			'Aivis API のリクエストがタイムアウトしました',
			undefined,
			undefined,
			err,
		);
	}
	// fetch からのネットワークエラーはここに来る — retryable として扱う。
	return new AivisError(
		'retryable',
		err instanceof Error ? err.message : String(err),
		undefined,
		undefined,
		err,
	);
}
