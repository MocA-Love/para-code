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
// - Aivis: FIFOキューで発話を絶対に失わない。PermissionRequest（要対応）は待機中の Stop（完了）より
//   前に割り込むが、再生中の発話は中断しない。
// - レート制限: Aivis Cloud は X-Aivis-RateLimit-Requests-* ヘッダーを返す。Remaining が 0 になったら
//   429 を踏む前に Reset + 0.5s 待ってから次のリクエストを送る。
// - エラーポリシー:
//     retryable (429 / 5xx / ネットワーク・タイムアウト): 指数バックオフ、最大3回。
//     fatal (401 / 402 / 404): キューを破棄して一時停止し、ユーザーへ可視通知。APIキー/クレジット/
//       モデル設定の修正が必要なため自動再開しない。
//     item-specific (422 / 再生失敗): そのアイテムだけスキップし、他は処理を続ける。

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

/**
 * キュー投入可能な Aivis タスク1件。スケジューラは synthesize()（AivisError を throw しうる）を
 * 呼び、返った audio で play() を呼ぶ。play() は再生完了で resolve する（reject は item-specific
 * 失敗として扱う）。
 */
export interface AivisTaskRunner {
	synthesize(): Promise<AivisSynthesizeResult>;
	play(audio: Buffer): Promise<void>;
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
}

const MAX_RETRY_ATTEMPTS = 3;
// 「試行 N と N+1 の間の sleep」を1エントリとする。MAX_RETRY_ATTEMPTS=3 では試行1と2の後のみ
// sleep する（試行3は最後なので sleep 前に break する）ため、2エントリで足りる。
const DEFAULT_BACKOFF_MS = [1000, 2000];
const RATE_LIMIT_MARGIN_MS = 500;
const RINGTONE_SAFETY_TIMEOUT_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

interface QueueEntry {
	priority: AivisPriority;
	runner: AivisTaskRunner;
}

export class AudioScheduler {
	private ringtoneBusy = false;
	private aivisBusy = false;
	private queue: QueueEntry[] = [];
	private paused = false;
	private rateLimit?: AivisRateLimit;
	private disposed = false;
	private ringtoneIdleWaiters: Array<() => void> = [];
	private ringtoneSafetyTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly deps: AudioSchedulerDeps) { }

	playRingtone(): void {
		if (this.disposed) { return; }
		if (this.ringtoneBusy || this.aivisBusy) { return; }
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

	enqueueAivis(runner: AivisTaskRunner, priority: AivisPriority = 'normal'): void {
		if (this.disposed || this.paused) { return; }
		const entry: QueueEntry = { priority, runner };
		if (priority === 'high') {
			const firstNormal = this.queue.findIndex(e => e.priority === 'normal');
			if (firstNormal < 0) { this.queue.push(entry); }
			else { this.queue.splice(firstNormal, 0, entry); }
		} else {
			this.queue.push(entry);
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

	/** 一時停止状態を解除する（ユーザーが APIキーを修正した後など）。 */
	resume(): void {
		if (this.disposed) { return; }
		this.paused = false;
	}

	dispose(): void {
		this.disposed = true;
		this.queue = [];
		if (this.ringtoneSafetyTimer) {
			clearTimeout(this.ringtoneSafetyTimer);
			this.ringtoneSafetyTimer = null;
		}
		// 進行中の runOne() が永久ハングしないよう、待機中の ringtone-idle waiter を全て起こす。
		const waiters = this.ringtoneIdleWaiters;
		this.ringtoneIdleWaiters = [];
		for (const resolve of waiters) { resolve(); }
	}

	private async pump(): Promise<void> {
		if (this.aivisBusy) { return; }
		if (this.disposed || this.paused) { return; }
		const entry = this.queue.shift();
		if (!entry) { return; }
		this.aivisBusy = true;
		try {
			await this.runOne(entry.runner);
		} finally {
			this.aivisBusy = false;
			if (!this.disposed && !this.paused && this.queue.length > 0) {
				void this.pump();
			}
		}
	}

	private async runOne(runner: AivisTaskRunner): Promise<void> {
		await this.waitForRateLimitWindow();

		let lastErr: AivisError | undefined;
		for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
			if (this.disposed) { return; }
			try {
				const { audio, rateLimit } = await runner.synthesize();
				if (rateLimit) { this.rateLimit = rateLimit; }
				// 合成は通知音と並行してよい（単なるネットワーク呼び出し）が、再生は2つの音声が
				// 重ならないよう通知音の完了を待つ。
				await this.waitForRingtoneIdle();
				if (this.disposed) { return; }
				try {
					await runner.play(audio);
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
		const dropped = this.queue.length;
		this.queue = [];
		this.paused = true;
		this.deps.notifyAivisPaused(reason);
		if (dropped > 0) {
			this.deps.logInfo?.(`[audio-scheduler] dropped ${dropped} queued Aivis task(s) after fatal error: ${reason}`);
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
