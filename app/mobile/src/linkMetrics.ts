// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	ParadisMobileEchoTracker,
	ParadisMobileLinkMetrics,
	paradisEncodeMetricsPing,
	type IParadisMobileLinkMetricsSnapshot,
} from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileLinkMetrics.js';

/**
 * アプリ側の通信の計測（設計書 5 章の F0「測るもの」）。集計は PC と同じ部品（`paradisMobileLinkMetrics.ts`）を使う。
 *
 * - 既定はオフ。設定 →「接続の記録」→「通信の計測」でオンにし、同じ画面から JSON をクリップボードへ写す
 *   （開発ビルドでは `__paraDev.linkMetrics` からも読める）
 * - 測るのは時間・大きさ・件数だけ。本文・パス・識別子は持たない
 * - 往復時間は PC が `metrics.ping.v1` を広告しているときだけ、2 秒ごとの小さな ping で測る（オフの間は送らない）
 * - 端末の間で時計を引き算しない。区間はこの端末の時計だけで測る
 */

/** ping を送る間隔（秒の刻みの何回に 1 回か）。 */
const PING_EVERY_TICKS = 2;
const TICK_MS = 1_000;
/** 返事を待つ ping の数の上限。 */
const MAX_PENDING_PINGS = 32;
/** これより遅い pong は往復に数えない（届かなかった ping として数える）。 */
const PING_TIMEOUT_MS = 30_000;

/** 再生の数（ネイティブの `playbackStats()` のうち使う分）。 */
export interface VoicePlaybackCounters {
	readonly started?: unknown;
	readonly underruns?: unknown;
	readonly dropped?: unknown;
	readonly prebufferMs?: unknown;
	readonly lastStartDelayMs?: unknown;
}

export interface AppLinkMetricsDeps {
	readonly now: () => number;
	readonly wallClock: () => number;
	readonly setInterval: (callback: () => void, ms: number) => unknown;
	readonly clearInterval: (handle: unknown) => void;
	/** ネイティブの再生の数。無ければ音声の再生側は測らない。 */
	readonly readVoiceStats?: () => VoicePlaybackCounters | undefined;
}

/** ping を送る口（PC ごと）。送れたら true（オフライン・PC が ping を知らないなら false）。 */
export type LinkPingSender = (text: string) => boolean;

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class AppLinkMetrics {
	readonly metrics: ParadisMobileLinkMetrics;
	private readonly echo = new ParadisMobileEchoTracker();
	private timer: unknown;
	private ticks = 0;
	private nextPingId = 0;
	private lastRttMs: number | undefined;
	private readonly pendingPings = new Map<number, number>();
	private readonly pingers = new Set<LinkPingSender>();
	private readonly listeners = new Set<() => void>();
	private readonly voiceStarts = new Map<string, number>();
	private voiceBaseline: VoicePlaybackCounters | undefined;
	/** 入力の後の最初の出力を受けた時刻（描画まで測るため）。 */
	private echoReceivedFromKeyAt: number | undefined;
	private lastStateAt: number | undefined;
	/** 断片に分かれた受信の、最初の断片を受けた時刻（チャネルごと）。 */
	private readonly burstStarts = new Map<string, { at: number; bytes: number }>();

	private readVoiceStats: (() => VoicePlaybackCounters | undefined) | undefined;

	constructor(private readonly deps: AppLinkMetricsDeps) {
		this.metrics = new ParadisMobileLinkMetrics(deps.wallClock, deps.now);
		this.readVoiceStats = deps.readVoiceStats;
	}

	/** ネイティブの再生の数の読み方を差し込む（ネイティブの部品を読み込む側から。テストでは差し込まない）。 */
	setVoiceStatsReader(reader: () => VoicePlaybackCounters | undefined): void {
		this.readVoiceStats = reader;
	}

	get enabled(): boolean {
		return this.metrics.enabled;
	}

	/** 画面の再描画用（オン・オフが変わった）。 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** 計測を始める（前の値は捨てる）・やめる（集めた値は写せる）。 */
	setEnabled(enabled: boolean): void {
		if (enabled === this.metrics.enabled) {
			return;
		}
		this.metrics.setEnabled(enabled);
		this.echo.clear();
		this.pendingPings.clear();
		this.voiceStarts.clear();
		this.burstStarts.clear();
		this.lastRttMs = undefined;
		this.echoReceivedFromKeyAt = undefined;
		this.lastStateAt = undefined;
		if (this.timer !== undefined) {
			this.deps.clearInterval(this.timer);
			this.timer = undefined;
		}
		if (enabled) {
			this.ticks = 0;
			this.voiceBaseline = this.readVoiceStats?.();
			this.timer = this.deps.setInterval(() => this.tick(), TICK_MS);
		}
		for (const listener of this.listeners) {
			listener();
		}
	}

	/** PC ごとの ping の送り口を足す。返した関数で外す。 */
	registerPinger(sender: LinkPingSender): () => void {
		this.pingers.add(sender);
		return () => { this.pingers.delete(sender); };
	}

	// --- ターミナルの入力からエコーの描画まで ---

	/** ターミナルへの入力を送ると決めた（キーを押した）。戻り値は送る直前の区間に使う時刻（オフなら undefined で、時計も読まない）。 */
	noteInput(): number | undefined {
		if (!this.metrics.enabled) {
			return undefined;
		}
		const now = this.deps.now();
		this.echo.mark('input', now);
		return now;
	}

	/** 入力をソケットへ渡した（送り直し用の保存を待った時間を含む）。 */
	noteInputSent(inputAt: number): void {
		this.metrics.observeSince('app.term.input.sendMs', inputAt);
	}

	/** ターミナルの出力を受けた。 */
	noteTermData(chars: number): void {
		if (!this.metrics.enabled) {
			return;
		}
		const now = this.deps.now();
		this.metrics.observe('app.term.data.chars', chars);
		const echo = this.echo.take('input', now);
		if (echo !== undefined) {
			this.metrics.observe('app.term.echo.keyToReceiveMs', echo);
			this.echoReceivedFromKeyAt = now - echo;
		}
	}

	/** ターミナルの表示へ出力を流し込んだ。描画の知らせを頼むなら時刻を返す。 */
	noteTermInjected(): number | undefined {
		return this.metrics.enabled ? this.deps.now() : undefined;
	}

	/** ターミナルの表示が、流し込んだ分を描き終えた（WebView の xterm の書き込みが終わった次のフレーム）。 */
	noteTermDrawn(injectedAt: number): void {
		if (!this.metrics.enabled) {
			return;
		}
		const now = this.deps.now();
		this.metrics.observe('app.term.drawMs', now - injectedAt);
		if (this.echoReceivedFromKeyAt !== undefined) {
			const keyToDraw = now - this.echoReceivedFromKeyAt;
			this.echoReceivedFromKeyAt = undefined;
			if (keyToDraw >= 0 && keyToDraw <= 10_000) {
				this.metrics.observe('app.term.echo.keyToDrawMs', keyToDraw);
			}
		}
	}

	// --- 受信 ---

	/** 封緘を 1 つ開けた（`onChunkOpened`）。断片に分かれた受信は、最初から最後までの速さも数える。 */
	noteChunk(chunk: { readonly ch: string; readonly bytes: number; readonly more: boolean; readonly openMs: number }): void {
		if (!this.metrics.enabled) {
			return;
		}
		this.metrics.observe('app.rx.openMs', chunk.openMs);
		const now = this.deps.now();
		const burst = this.burstStarts.get(chunk.ch);
		if (chunk.more) {
			if (burst === undefined) {
				this.burstStarts.set(chunk.ch, { at: now, bytes: chunk.bytes });
			} else {
				burst.bytes += chunk.bytes;
			}
			return;
		}
		if (burst !== undefined) {
			this.burstStarts.delete(chunk.ch);
			const bytes = burst.bytes + chunk.bytes;
			const elapsedMs = now - burst.at;
			this.metrics.observe(`app.rx.${chunk.ch}.burstMs`, elapsedMs);
			if (elapsedMs > 0 && bytes >= 64 * 1024) {
				// 大きな受信の、最初の断片から最後の断片までの速さ（配送の速さの材料）
				this.metrics.observe('app.rx.burstKiBps', bytes / 1024 / (elapsedMs / 1000));
			}
		}
	}

	/** 論理フレームを 1 つ受けた。 */
	noteFrame(ch: string, bytes: number): void {
		this.metrics.observe(`app.rx.${ch}.frameBytes`, bytes);
	}

	/** Desktop State を読み終えた。 */
	noteState(wireBytes: number, decodeStartedAt: number): void {
		if (!this.metrics.enabled) {
			return;
		}
		const now = this.deps.now();
		this.metrics.observe('app.state.wireBytes', wireBytes);
		this.metrics.observe('app.state.decodeMs', now - decodeStartedAt);
		if (this.lastStateAt !== undefined) {
			this.metrics.observe('app.state.intervalMs', now - this.lastStateAt);
		}
		this.lastStateAt = now;
	}

	// --- 往復時間 ---

	/** pong を受けた。 */
	notePong(id: number): void {
		const sentAt = this.pendingPings.get(id);
		if (sentAt === undefined || !this.metrics.enabled) {
			return;
		}
		this.pendingPings.delete(id);
		const rtt = this.deps.now() - sentAt;
		if (rtt >= 0 && rtt <= PING_TIMEOUT_MS) {
			this.lastRttMs = rtt;
			this.metrics.observe('app.rtt.ms', rtt);
		}
	}

	// --- 音声 ---

	noteVoiceStart(streamId: string): void {
		if (this.metrics.enabled) {
			this.voiceStarts.set(streamId, this.deps.now());
			this.metrics.count('app.voice.streams');
		}
	}

	noteVoiceChunk(streamId: string): void {
		const startedAt = this.voiceStarts.get(streamId);
		if (startedAt !== undefined) {
			this.voiceStarts.delete(streamId);
			// 流れの開始を受けてから最初の音の断片を受けるまで
			this.metrics.observeSince('app.voice.firstChunkMs', startedAt);
		}
	}

	noteVoiceEnd(streamId: string, aborted: boolean): void {
		this.voiceStarts.delete(streamId);
		if (aborted) {
			this.metrics.count('app.voice.abortedStreams');
		}
	}

	snapshot(): IParadisMobileLinkMetricsSnapshot {
		return this.metrics.snapshot();
	}

	private tick(): void {
		this.ticks++;
		this.sampleVoice();
		if (this.ticks % PING_EVERY_TICKS === 0) {
			this.sendPing();
		}
	}

	private sendPing(): void {
		const now = this.deps.now();
		for (const [id, sentAt] of this.pendingPings) {
			if (now - sentAt > PING_TIMEOUT_MS) {
				this.pendingPings.delete(id);
				this.metrics.count('app.rtt.lost');
			}
		}
		if (this.pingers.size === 0 || this.pendingPings.size >= MAX_PENDING_PINGS) {
			return;
		}
		const id = this.nextPingId;
		this.nextPingId = (this.nextPingId + 1) % 0x7fffffff;
		const text = paradisEncodeMetricsPing({ id, ...(this.lastRttMs !== undefined ? { rttMs: this.lastRttMs } : {}) });
		let sent = false;
		for (const pinger of this.pingers) {
			try {
				// 返事は id で突き合わせる。複数の PC へ同じ id で送り、最初の返事を数える
				sent = pinger(text) || sent;
			} catch {
				// 計測の ping で接続を止めない
			}
		}
		if (sent) {
			this.pendingPings.set(id, now);
		}
	}

	/** ネイティブの再生の数の増え方から、鳴り始めまで・途切れ・溜めの増減・捨てた数を数える。 */
	private sampleVoice(): void {
		const stats = this.readVoiceStats?.();
		if (stats === undefined) {
			return;
		}
		const previous = this.voiceBaseline;
		this.voiceBaseline = stats;
		if (previous === undefined) {
			return;
		}
		const delta = (key: keyof VoicePlaybackCounters) => {
			const now = finiteNumber(stats[key]);
			const before = finiteNumber(previous[key]);
			return now !== undefined && before !== undefined && now >= before ? now - before : 0;
		};
		if (delta('started') > 0) {
			// 開始を受けてから鳴り始めるまで（溜めの閾値までのデコード待ちを含む。1 秒に 2 本以上始まったら最後の 1 本だけ）
			const startDelay = finiteNumber(stats.lastStartDelayMs);
			if (startDelay !== undefined && startDelay >= 0) {
				this.metrics.observe('app.voice.timeToFirstAudioMs', startDelay);
			}
		}
		const underruns = delta('underruns');
		if (underruns > 0) {
			this.metrics.count('app.voice.underruns', underruns);
		}
		const dropped = delta('dropped');
		if (dropped > 0) {
			this.metrics.count('app.voice.dropped', dropped);
		}
		const prebuffer = finiteNumber(stats.prebufferMs);
		const previousPrebuffer = finiteNumber(previous.prebufferMs);
		if (prebuffer !== undefined && previousPrebuffer !== undefined && prebuffer !== previousPrebuffer) {
			this.metrics.count(prebuffer > previousPrebuffer ? 'app.voice.prebufferRaised' : 'app.voice.prebufferLowered');
			this.metrics.observe('app.voice.prebufferMs', prebuffer);
		}
	}
}

/** 写す JSON（PC の書き出しと同じ形に、どの側かと版を添える）。 */
export function formatAppLinkMetricsReport(snapshot: IParadisMobileLinkMetricsSnapshot, appVersion: string, generatedAt: number): string {
	return JSON.stringify({ source: 'app', appVersion, generatedAt, ...snapshot }, undefined, '\t');
}
