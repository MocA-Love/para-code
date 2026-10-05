/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `aivis-mcp --ingest` を shared process の常駐の子として起動し、読み上げを手元の aivis-mcp の worker 1 つへ
// 流し込む（設計 3.3・3.6 N1・N2）。鳴らすのは worker だけで、Para Code は `queued` を受け取ったら手を離す。
//
// - 起動の前に `aivis-mcp --version` で 2.5.0 以上かを確かめ、最初の枠（hello）で名乗った版も確かめる
//   （古い版は `--ingest` を知らず MCP サーバーとして標準入力を待ち続けるので、確かめずに起こさない）
// - 落ちたら 1・2・4・8 秒の間隔で起動し直す。5 回続けて失敗したら afplay に切り替える。ただし worker の
//   lock が生きている間は切り替えない（列に積んだ発話を worker が鳴らせるので、afplay で重ねない）
// - 起動し直したら hold を掛け直す。aivis-mcp の版が変わったら起動し直す
// - 書き込みは子の標準入力の drain を待つ。制御の枠（hold・abort・ping・withdraw）は音声の後ろに並ばない
// - 呼び出し側が自分で鳴らしてよいのは、`withdrawn: true` の付いた終わりの知らせと、withdraw の `removed: true` の件
//   だけ（aivis-mcp の docs/ingest-protocol.md 2.5.1「親が自分で鳴らしてよいとき」）。`queued` が遅れて届くこともある
//   ので、`queued` が来ないことを「積まれていない」とは扱わない
// - `open` を子の標準入力へ書いた件は、`queued` が届く前に子が落ちても「積まれたかもしれない」として扱う。次の子に
//   withdraw を頼み、取り下げられた（removed: true）件だけ呼び出し側が鳴らし直す。返事が無い・外せなかった件は
//   worker が鳴らすとみなす（二重に鳴らすより、鳴らし損ねの方を選ぶ）
// - 落ちた子・こちらから入れ替えた子の件のうち、書き終えた件と鳴り始めた件は取り下げず、新しい子に `adopt` で追跡を
//   引き継いでもらう（2.5.1 以上。2.5.0 の子なら追跡をやめて worker に任せる）。取り下げを頼むのは書きかけだった件だけ。
//   withdraw の返事は `removed`・`notQueued` のときだけ鳴らし、`taken` と確かめられなかった件は鳴らさない
// - 版の入れ替えの間（新しい子が名乗るまで）は新しい流れを開かない（`whenReady` で待たせる）。古い子は、書きかけの
//   流れを書き終え、書き込みの列が空になってから（上限 60 秒）標準入力を閉じる
// - 子の終わりは標準出力を読み切ってから扱う（終わる直前の `queued` などを捨てない）
// - 標準入力への書き込みが {@link PARADIS_INGEST_WRITE_STALL_MS} 進まなければ、その子を見限って（落ちたものとして扱い）
//   止める。止まらなければ SIGKILL する。動いている子はすべて終わるまで追いかけ、終了時に止める
// - worker の `failed` が 3 回続いたら、しばらく afplay に任せる（手放した件は鳴らし直さない）

import { execFile, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { connect } from 'net';
import { homedir } from 'os';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisIngestOpenOptions,
	IParadisIngestStream,
	IParadisIngestTerminal,
	PARADIS_AIVIS_INGEST_MIN_VERSION,
	paradisAivisVersionAtLeast,
	paradisParseAivisVersion,
} from '../common/paradisVoiceIngest.js';
import { IParadisVoiceGainTable, paradisParseVoiceGainTable } from '../common/paradisVoiceGain.js';
import {
	IParadisIngestMessage,
	PARADIS_INGEST_MAX_AUDIO_PER_FRAME,
	PARADIS_INGEST_PROTOCOL_VERSION,
	ParadisIngestFrameDecoder,
	paradisEncodeIngestAudio,
	paradisEncodeIngestControl,
} from './paradisAivisIngestFrames.js';

/** 起動し直すまでの間隔（1 回目・2 回目・3 回目・4 回目以降）。 */
export const PARADIS_INGEST_RESTART_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];
/** これだけ続けて起動に失敗したら afplay に切り替える。 */
export const PARADIS_INGEST_MAX_FAILURES = 5;
/** 名乗ってからこれだけ動き続けたら、失敗の回数を数え直す。 */
const STABLE_MS = 30_000;
/** 名乗るのを待つ上限（aivis-mcp は Redis へつながってから名乗る。Redis を起こす分も見込む）。 */
const HELLO_TIMEOUT_MS = 10_000;
/** afplay に切り替えた後、もう一度起こしてみるまで。 */
const FALLBACK_RETRY_MS = 5 * 60_000;
/** 版の確認と音量の表の取り直しの間隔。 */
const VERSION_CHECK_INTERVAL_MS = 10 * 60_000;
/** hold を延長する間隔（aivis-mcp 側の期限は 60 秒）。 */
export const PARADIS_INGEST_HOLD_RENEW_MS = 20_000;
/** worker の `failed` がこれだけ続いたら afplay に任せる。 */
export const PARADIS_INGEST_MAX_FAILED_STREAK = 3;
/** 失敗が続いて afplay に任せた後、もう一度 worker に渡してみるまで。 */
const DEGRADED_RETRY_MS = 5 * 60_000;
/** 生きているかを確かめる間隔と、返事を待つ上限。 */
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
/** 止めるときに、標準入力を閉じてから終わるのを待つ上限。 */
const KILL_GRACE_MS = 2_000;
/** 版が変わったとき、書きかけの流れが空くのを待つ上限と確かめる間隔。 */
const VERSION_RESTART_MAX_WAIT_MS = 60_000;
const VERSION_RESTART_POLL_MS = 1_000;
/** 子が落ちた後、列に残った件の withdraw の返事を待つ上限。 */
const ORPHAN_WITHDRAW_WAIT_MS = 30_000;
/** 呼び出し側が頼んだ withdraw の返事を待つ上限。 */
const WITHDRAW_REPLY_WAIT_MS = 5_000;
/**
 * 標準入力の drain がこれだけ来なければ子を見限る。aivis-mcp は読むのを止めても 10 秒で読み直すので、それより長くする。
 */
export const PARADIS_INGEST_WRITE_STALL_MS = 20_000;
/** `aivis-mcp --mute` の状態を読み直すまで（afplay の前に毎回 Redis を読まない）。 */
const MUTE_CACHE_MS = 1_000;
const WORKER_LOCK_KEY = 'aivis-mcp:worker-lock';
/** `queued` の前の失敗にも `withdrawn` を付けるようになった aivis-mcp の版（それより前は `queued` の前の失敗＝積めていない）。 */
const PARADIS_AIVIS_WITHDRAWN_CONTRACT_VERSION: readonly [number, number, number] = [2, 5, 1];
/** `adopt`（落ちた・入れ替えた子の件の追跡を引き継ぐ）を持つ aivis-mcp の版。 */
const PARADIS_AIVIS_ADOPT_VERSION: readonly [number, number, number] = [2, 5, 1];
/** 入れ替えで止める古い子が、書きかけの流れを書き終えるのを待つ上限と、確かめる間隔。 */
const RETIRE_DRAIN_MAX_WAIT_MS = 60_000;
const RETIRE_DRAIN_POLL_MS = 200;
/** `aivis --mute` が置くキー（aivis-mcp の src/services/mute-service.ts）。あればミュート中。 */
const MUTE_KEY = 'aivis-mcp:muted';
/** worker の再生 lock（aivis-mcp の docs/ingest-protocol.md）。鳴らしている間ある。 */
const PLAY_LOCK_KEY = 'aivis-mcp:play-lock';
/** 再生 lock が空くのを確かめる間隔。 */
const PLAY_LOCK_POLL_MS = 500;

/** `--ingest` の子プロセス（テストで差し替える）。 */
export interface IParadisIngestChild {
	readonly stdin: NodeJS.WritableStream;
	readonly stdout: NodeJS.ReadableStream;
	/** プロセスが終わり、標準出力も読み切った（または終わってから少し待っても閉じなかった）。 */
	onExit(listener: (code: number | null) => void): void;
	onError(listener: (error: Error) => void): void;
	/** 止める。`force` は SIGKILL（Windows は taskkill /T /F）。 */
	kill(force?: boolean): void;
}

export type ParadisIngestSpawner = (args: readonly string[], env: NodeJS.ProcessEnv) => IParadisIngestChild;
/** `aivis-mcp --version` の出力。入っていなければ undefined。 */
export type ParadisAivisVersionProbe = (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
/** worker の lock が生きているか。確かめられないときは undefined（afplay へ切り替えない）。 */
export type ParadisWorkerLockProbe = (env: NodeJS.ProcessEnv) => Promise<boolean | undefined>;
/** `aivis --mute` 中か。確かめられないときは undefined（ミュートしていないとみなす）。 */
export type ParadisMuteProbe = (env: NodeJS.ProcessEnv) => Promise<boolean | undefined>;

export type ParadisIngestClientState = 'idle' | 'checking' | 'unsupported' | 'starting' | 'ready' | 'fallback' | 'disposed';

export interface IParadisAivisIngestClientOptions {
	readonly getEnv: () => Promise<NodeJS.ProcessEnv>;
	/** 着信音として鳴らしてよいフォルダ（Para Code の着信音のフォルダとアプリの中）。 */
	readonly preludeDirs: () => readonly string[];
	readonly logService: ILogService;
	readonly spawnIngest?: ParadisIngestSpawner;
	readonly probeVersion?: ParadisAivisVersionProbe;
	readonly probeWorkerLock?: ParadisWorkerLockProbe;
	readonly probeMute?: ParadisMuteProbe;
	/** worker の再生 lock があるか。確かめられなければ undefined（無いとみなす）。 */
	readonly probePlayLock?: ParadisMuteProbe;
	readonly now?: () => number;
}

/** 書き込みの列。制御の枠（open・hold・abort・ping・withdraw・gain?）は音声より先に書く。`end` は音声の後ろに並べる。 */
type ParadisIngestLane = 'control' | 'audio';

interface IPendingWrite {
	readonly frame: Buffer;
	/** 標準入力へ渡せたら true、渡す前に子が終わった（見限った）ら false。 */
	readonly resolve: (written: boolean) => void;
}

interface IChildState {
	readonly process: IParadisIngestChild;
	readonly decoder: ParadisIngestFrameDecoder;
	readyAt: number | undefined;
	version: readonly [number, number, number] | undefined;
	/** こちらから止めた理由。終わりを失敗として数えない。 */
	stopReason: 'retired' | 'dispose' | 'unsupported' | undefined;
	/** プロセスが本当に終わった（{@link exited} は見限った時点で立つ）。 */
	processExited: boolean;
	killTimer: ReturnType<typeof setTimeout> | undefined;
	helloTimer: ReturnType<typeof setTimeout> | undefined;
	pingTimer: ReturnType<typeof setTimeout> | undefined;
	pingInterval: ReturnType<typeof setInterval> | undefined;
	/** 返事を待っている ping（背圧中に次の ping を積まない）。 */
	pingAwaiting: number | undefined;
	exited: boolean;
	readonly controlQueue: IPendingWrite[];
	readonly audioQueue: IPendingWrite[];
	writing: boolean;
	/** drain を待っている間に子が終わったら起こす。 */
	drainWaiter: (() => void) | undefined;
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}

class ParadisIngestStream implements IParadisIngestStream {

	readonly id = generateUuid();
	private readonly handoffDeferred = deferred<boolean>();
	private readonly finishedDeferred = deferred<IParadisIngestTerminal>();
	readonly handoff = this.handoffDeferred.promise;
	readonly finished = this.finishedDeferred.promise;
	private readonly startListeners: Array<() => void> = [];
	private readonly preludeRejectListeners: Array<(reason: string) => void> = [];
	private preludeRejectedReason: string | undefined;
	private ended = false;
	private aborted = false;
	private settled = false;
	queued = false;
	started = false;
	/** `open` を子の標準入力へ渡した（aivis-mcp が積んだかもしれない）。 */
	openWritten = false;
	/** 音声と `end` を書き終えた（`end` を標準入力へ渡した）。 */
	fullyWritten = false;

	constructor(
		/** この流れを追っている子。音声と `end` はこの子へ書く（落ちた子の件を引き継いだら、引き継いだ子に替わる）。 */
		public child: IChildState,
		readonly kind: 'stream' | 'sound',
		private readonly send: (child: IChildState, frame: Buffer, lane: ParadisIngestLane) => Promise<boolean>,
		private readonly requestWithdraw: (stream: ParadisIngestStream) => Promise<boolean | undefined>,
	) { }

	onDidStart(listener: () => void): void {
		if (this.started) {
			listener();
			return;
		}
		if (!this.settled) {
			this.startListeners.push(listener);
		}
	}

	onDidRejectPrelude(listener: (reason: string) => void): void {
		if (this.preludeRejectedReason !== undefined) {
			listener(this.preludeRejectedReason);
			return;
		}
		if (!this.settled) {
			this.preludeRejectListeners.push(listener);
		}
	}

	rejectPrelude(reason: string): void {
		if (this.preludeRejectedReason !== undefined) {
			return;
		}
		this.preludeRejectedReason = reason;
		for (const listener of this.preludeRejectListeners.splice(0)) {
			listener(reason);
		}
	}

	get isClosed(): boolean {
		return this.ended || this.aborted || this.settled || this.child.exited;
	}

	get isSettled(): boolean {
		return this.settled;
	}

	/** まだ子へ書き終えていない（`end` か `abort` を標準入力へ渡していない）声の流れか。 */
	get writesPending(): boolean {
		return this.kind === 'stream' && !this.settled && !this.child.exited && !this.fullyWritten && !this.aborted;
	}

	async write(chunk: Uint8Array): Promise<void> {
		for (let offset = 0; offset < chunk.byteLength && !this.isClosed; offset += PARADIS_INGEST_MAX_AUDIO_PER_FRAME) {
			await this.send(this.child, paradisEncodeIngestAudio(this.id, chunk.subarray(offset, Math.min(chunk.byteLength, offset + PARADIS_INGEST_MAX_AUDIO_PER_FRAME))), 'audio');
		}
	}

	async end(): Promise<void> {
		if (this.isClosed) {
			return;
		}
		this.ended = true;
		if (await this.send(this.child, paradisEncodeIngestControl({ type: 'end', id: this.id }), 'audio')) {
			this.fullyWritten = true;
		}
	}

	async abort(reason: string): Promise<void> {
		if (this.aborted || this.settled || this.child.exited) {
			return;
		}
		this.aborted = true;
		await this.send(this.child, paradisEncodeIngestControl({ type: 'abort', id: this.id, reason: reason.slice(0, 64) }), 'control');
	}

	withdraw(): Promise<boolean | undefined> {
		return this.requestWithdraw(this);
	}

	/** aivis-mcp から届いた進み具合。終わりなら true。 */
	onStatus(status: string, reason: string | undefined, withdrawn: boolean): boolean {
		switch (status) {
			case 'queued':
				this.queued = true;
				this.handoffDeferred.resolve(true);
				return false;
			case 'playing':
				this.markStarted();
				return false;
			case 'done':
			case 'skipped':
			case 'held':
			case 'muted':
			case 'failed':
				// `queued` の前に終わった件を呼び出し側が鳴らしてよいのは `withdrawn: true`（列に無く worker は鳴らさないと
				// aivis-mcp が確かめた）のときだけ。それ以外は worker が鳴らしたかもしれないので、手放したことにする
				// （取り決め 2.5.1「親が自分で鳴らしてよいとき」）。2.5.0 は `queued` の前の失敗に `withdrawn` を付けない
				// （積めなかった件だけ `queued` の前に終わる）ので、今までどおり呼び出し側に鳴らさせる
				this.settle({ status, ...(reason !== undefined ? { reason } : {}), ...(withdrawn ? { withdrawn: true } : {}) }, paradisAivisVersionAtLeast(this.child.version, PARADIS_AIVIS_WITHDRAWN_CONTRACT_VERSION) && !withdrawn);
				return true;
			default:
				return false;
		}
	}

	/** 新しい子が追跡を引き継いだ（列か知らせに痕跡がある）。`queued` は返らないので、ここで手放したことにする。 */
	markAdopted(child: IChildState): void {
		this.child = child;
		this.queued = true;
		this.handoffDeferred.resolve(true);
	}

	private markStarted(): void {
		if (this.started || this.settled) {
			return;
		}
		this.started = true;
		for (const listener of this.startListeners.splice(0)) {
			listener();
		}
	}

	/**
	 * 終える。`handedOff` は `queued` の前に終わった件の handoff の値（既定 false＝手放せなかったので呼び出し側が鳴らす）。
	 * 積まれたかもしれないのに確かめられなかった件は true（worker が鳴らすとみなし、呼び出し側に鳴らさせない）。
	 */
	settle(terminal: IParadisIngestTerminal, handedOff = false): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.startListeners.length = 0;
		this.preludeRejectListeners.length = 0;
		this.handoffDeferred.resolve(handedOff);
		this.finishedDeferred.resolve(terminal);
	}
}

/** 通知の読み上げ（ParadisNotificationsService）が使う口。テストで差し替える。 */
export interface IParadisAivisIngest {
	readonly state: ParadisIngestClientState;
	readonly gainTable: IParadisVoiceGainTable | undefined;
	isUsable(): boolean;
	whenReady(timeoutMs: number): Promise<boolean>;
	hasLocalAivis(timeoutMs: number): Promise<boolean>;
	open(options: IParadisIngestOpenOptions): IParadisIngestStream | undefined;
	setHold(owner: string, active: boolean): void;
	/**
	 * `--ingest` へ渡せないとき、Para Code が自分で（afplay 等で）鳴らしてよいか。worker が生きているかもしれない間
	 * （`--ingest` を起こし直している・版を確かめている）は false で、呼び出し側は復旧を待って列経由で渡す。
	 */
	mayPlayDirectly(): boolean;
	/** ユーザー（またはおやすみモード）が `aivis --mute` しているか。Para Code が自分で鳴らす前に確かめる。 */
	isMuted(): Promise<boolean>;
	/**
	 * worker が鳴らしている間（再生 lock `aivis-mcp:play-lock` がある間）は、空くまで `timeoutMs` まで待つ。Para Code が
	 * 自分で鳴らす前に呼ぶ（worker の声と重ねない）。
	 */
	whenPlayLockFree(timeoutMs: number): Promise<void>;
}

/**
 * `aivis-mcp --ingest` の常駐の子を持つ。shared process に 1 つだけ作り、通知の読み上げと SSH 先の声が共有する。
 */
export class ParadisAivisIngestClient extends Disposable implements IParadisAivisIngest {

	private _state: ParadisIngestClientState = 'idle';
	private child: IChildState | undefined;
	/** 版が変わったときに起こした新しい子。名乗ったら {@link child} と入れ替える。 */
	private incoming: IChildState | undefined;
	/** 入れ替えで止めている古い子。終わったら hold を掛け直す（古い子は終わるときに同じ持ち主の hold を外す）。 */
	private readonly retiring = new Set<IChildState>();
	/** プロセスがまだ終わっていない子（見限った子・入れ替えで止めている子を含む）。終了時に全部止める。 */
	private readonly alive = new Set<IChildState>();
	/** 呼び出し側が頼んだ withdraw の返事待ち。 */
	private readonly withdrawWaiters = new Map<string, (removed: boolean | undefined) => void>();
	private muteCache: { readonly at: number; readonly value: Promise<boolean> } | undefined;
	private env: NodeJS.ProcessEnv | undefined;
	private failures = 0;
	/** worker の lock を確かめられなかった回数（続けて）。 */
	private unknownLockStreak = 0;
	private failedStreak = 0;
	private degradedUntil = 0;
	private installedVersion: readonly [number, number, number] | undefined;
	private versionChecked = false;
	private readonly versionCheckedWaiters: Array<() => void> = [];
	private readonly streams = new Map<string, ParadisIngestStream>();
	/** 子が落ちたときに列に入っていてまだ鳴っていなかった件。次の子が名乗ったら withdraw を送る。 */
	private readonly orphans = new Map<string, ParadisIngestStream>();
	/**
	 * 落ちた・入れ替えた子の件の扱い。`adopt` は書き終えた件・鳴り始めた件（新しい子に追跡を引き継いでもらう。2.5.1 以上）、
	 * `withdraw` は書きかけの件（音声の続きは送れないので、取り下げを頼んで確かめる）。
	 */
	private readonly orphanModes = new Map<string, 'adopt' | 'withdraw'>();
	private orphanTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly holds = new Set<string>();
	private holdTimer: ReturnType<typeof setInterval> | undefined;
	private restartTimer: ReturnType<typeof setTimeout> | undefined;
	private stableTimer: ReturnType<typeof setTimeout> | undefined;
	private versionRestartTimer: ReturnType<typeof setTimeout> | undefined;
	private pingCounter = 0;
	private _gainTable: IParadisVoiceGainTable | undefined;

	private readonly _onDidChangeState = this._register(new Emitter<ParadisIngestClientState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly spawnIngest: ParadisIngestSpawner;
	private readonly probeVersion: ParadisAivisVersionProbe;
	private readonly probeWorkerLock: ParadisWorkerLockProbe;
	private readonly probeMute: ParadisMuteProbe;
	private readonly probePlayLock: ParadisMuteProbe;
	private readonly now: () => number;

	constructor(private readonly options: IParadisAivisIngestClientOptions) {
		super();
		this.spawnIngest = options.spawnIngest ?? spawnAivisIngest;
		this.probeVersion = options.probeVersion ?? probeAivisVersion;
		this.probeWorkerLock = options.probeWorkerLock ?? probeAivisWorkerLock;
		this.probeMute = options.probeMute ?? probeAivisMute;
		this.probePlayLock = options.probePlayLock ?? (env => probeAivisRedisKey(env, PLAY_LOCK_KEY));
		this.now = options.now ?? Date.now;
		const versionTimer = setInterval(() => void this.checkVersion(), VERSION_CHECK_INTERVAL_MS);
		this._register(toDisposable(() => clearInterval(versionTimer)));
	}

	/** await の後に読み直す（TypeScript の絞り込みを効かせない）。 */
	private isDisposed(): boolean {
		return this._state === 'disposed';
	}

	get state(): ParadisIngestClientState {
		return this._state;
	}

	/** `gain?` で取った音量の表（取れていなければ undefined）。 */
	get gainTable(): IParadisVoiceGainTable | undefined {
		return this._gainTable;
	}

	/** 版を確かめて、2.5.0 以上なら子を起こす。2 回目以降は何もしない。 */
	start(): void {
		if (this._state !== 'idle') {
			return;
		}
		void this.checkVersion();
	}

	/** いま `open` できるか。 */
	isUsable(): boolean {
		return !(this.incoming && !this.incoming.exited) && this._state === 'ready' && this.child?.readyAt !== undefined && !this.child.exited && !this.isDegraded();
	}

	private isDegraded(): boolean {
		if (this.failedStreak < PARADIS_INGEST_MAX_FAILED_STREAK) {
			return false;
		}
		if (this.now() >= this.degradedUntil) {
			this.failedStreak = 0;
			return false;
		}
		return true;
	}

	mayPlayDirectly(): boolean {
		if (this.isUsable()) {
			return false;
		}
		// 2.5.0 が無い・afplay に切り替えた（worker の lock も無い）・失敗が続いた・止めた
		return this._state === 'unsupported' || this._state === 'fallback' || this._state === 'disposed' || this._state === 'idle' || this.isDegraded();
	}

	isMuted(): Promise<boolean> {
		if (this._state === 'disposed' || !paradisAivisVersionAtLeast(this.installedVersion, [2, 4, 0])) {
			// 手元に aivis-mcp が無い（ミュートの持ち主がいない）
			return Promise.resolve(false);
		}
		const now = this.now();
		if (this.muteCache && now - this.muteCache.at < MUTE_CACHE_MS) {
			return this.muteCache.value;
		}
		const value = this.probeMute(this.env ?? process.env).then(muted => muted === true, () => false);
		this.muteCache = { at: now, value };
		return value;
	}

	async whenPlayLockFree(timeoutMs: number): Promise<void> {
		if (this._state === 'disposed' || !paradisAivisVersionAtLeast(this.installedVersion, [2, 4, 0])) {
			return;
		}
		const deadline = this.now() + timeoutMs;
		while (!this.isDisposed() && (await this.probePlayLock(this.env ?? process.env).catch(() => undefined)) === true && this.now() < deadline) {
			await new Promise<void>(resolve => setTimeout(resolve, PLAY_LOCK_POLL_MS));
		}
	}

	/**
	 * 起動中なら `timeoutMs` まで待つ。使えるようになったら true。2.5.0 が無い・afplay に切り替えた・失敗が続いた
	 * ときは待たずに false。
	 */
	whenReady(timeoutMs: number): Promise<boolean> {
		if (this.isUsable()) {
			return Promise.resolve(true);
		}
		if (this._state === 'unsupported' || this._state === 'fallback' || this._state === 'disposed' || this._state === 'idle' || this.isDegraded() || timeoutMs <= 0) {
			return Promise.resolve(false);
		}
		return new Promise<boolean>(resolve => {
			const listener = this.onDidChangeState(() => {
				if (this.isUsable()) {
					finish(true);
				} else if (this._state !== 'checking' && this._state !== 'starting' && !(this.incoming && !this.incoming.exited)) {
					// 版の入れ替えの間（新しい子が名乗る前）は待ち続ける
					finish(false);
				}
			});
			const timer = setTimeout(() => finish(false), timeoutMs);
			const finish = (value: boolean) => {
				clearTimeout(timer);
				listener.dispose();
				resolve(value);
			};
		});
	}

	/** 手元に 2.4.0 以上（`--play-audio` か `--ingest` を持つ）の aivis-mcp があるか。`timeoutMs` まで版の確認を待つ。 */
	async hasLocalAivis(timeoutMs: number): Promise<boolean> {
		if (!this.versionChecked && this._state !== 'disposed') {
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, timeoutMs);
				this.versionCheckedWaiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		return paradisAivisVersionAtLeast(this.installedVersion, [2, 4, 0]);
	}

	/** 流れを開く（ジョブはすぐ列に積まれる）。使えなければ undefined。 */
	open(options: IParadisIngestOpenOptions): IParadisIngestStream | undefined {
		const child = this.child;
		if (!this.isUsable() || !child) {
			return undefined;
		}
		const stream = new ParadisIngestStream(child, options.kind ?? 'stream', (target, frame, lane) => this.send(target, frame, lane), target => this.withdrawStream(target));
		this.streams.set(stream.id, stream);
		const message: { type: string;[key: string]: unknown } = {
			type: 'open',
			id: stream.id,
			kind: options.kind ?? 'stream',
			priority: options.priority,
		};
		if (options.gainKey !== undefined) {
			message.gainKey = options.gainKey;
		}
		if (options.volumeDb !== undefined && Number.isFinite(options.volumeDb)) {
			message.volumeDb = Math.max(-60, Math.min(20, options.volumeDb));
		}
		if (options.tagged) {
			message.tagged = true;
		}
		if (options.prelude) {
			message.prelude = { path: options.prelude.path, volume: Math.max(0, Math.min(1, options.prelude.volume)) };
		}
		void this.send(child, paradisEncodeIngestControl(message), 'control').then(written => {
			if (written) {
				stream.openWritten = true;
			}
		});
		void stream.finished.then(terminal => this.noteTerminal(terminal));
		return stream;
	}

	/**
	 * `queued` の前に `withdrawn` の無い `failed` が来た件。列に残っていれば外してもらい、外せたときだけ呼び出し側に
	 * 鳴らさせる（外せた件は withdrawn の返事の処理が `withdrawn: true` で終える）。外せない・分からない件は worker が
	 * 鳴らしたかもしれないので、手放したことにする。
	 */
	private async verifyUnqueuedFailure(stream: ParadisIngestStream, reason: string | undefined): Promise<void> {
		const removed = await this.withdrawStream(stream);
		if (removed === true || stream.isSettled) {
			return;
		}
		this.streams.delete(stream.id);
		stream.settle({ status: 'failed', ...(reason !== undefined ? { reason } : {}) }, true);
	}

	/** 呼び出し側が頼んだ取り下げ。返事（removed）を待つ。返事が無い・子が落ちたら undefined。 */
	private async withdrawStream(stream: ParadisIngestStream): Promise<boolean | undefined> {
		const child = stream.child;
		if (stream.isSettled || child.exited || this.withdrawWaiters.has(stream.id)) {
			return undefined;
		}
		const reply = new Promise<boolean | undefined>(resolve => {
			const timer = setTimeout(() => finish(undefined), WITHDRAW_REPLY_WAIT_MS);
			const finish = (removed: boolean | undefined) => {
				clearTimeout(timer);
				if (this.withdrawWaiters.get(stream.id) === finish) {
					this.withdrawWaiters.delete(stream.id);
				}
				resolve(removed);
			};
			this.withdrawWaiters.set(stream.id, finish);
			void stream.finished.then(() => finish(undefined));
		});
		if (!(await this.send(child, paradisEncodeIngestControl({ type: 'withdraw', id: stream.id }), 'control'))) {
			this.withdrawWaiters.get(stream.id)?.(undefined);
		}
		return reply;
	}

	/** 音声入力中などに鳴らすのを止める。掛けている間は 20 秒ごとに延長し、起動し直したら掛け直す。 */
	setHold(owner: string, active: boolean): void {
		if (this._state === 'disposed') {
			return;
		}
		if (active) {
			this.holds.add(owner);
			if (this.holdTimer === undefined) {
				this.holdTimer = setInterval(() => this.sendHolds(), PARADIS_INGEST_HOLD_RENEW_MS);
			}
		} else {
			this.holds.delete(owner);
			if (this.holds.size === 0 && this.holdTimer !== undefined) {
				clearInterval(this.holdTimer);
				this.holdTimer = undefined;
			}
		}
		const child = this.child;
		if (child?.readyAt !== undefined) {
			void this.send(child, paradisEncodeIngestControl({ type: 'hold', owner, active }), 'control');
		}
	}

	private sendHolds(): void {
		const child = this.child;
		if (child?.readyAt === undefined) {
			return;
		}
		for (const owner of this.holds) {
			void this.send(child, paradisEncodeIngestControl({ type: 'hold', owner, active: true }), 'control');
		}
	}

	private noteTerminal(terminal: IParadisIngestTerminal): void {
		if (terminal.reason === 'ingest-exited') {
			// 子が落ちたのは起動し直しの数え方で扱う
			return;
		}
		if (terminal.status === 'failed') {
			// worker-stopped・lost・untracked なども数える（N2）
			this.failedStreak++;
			if (this.failedStreak === PARADIS_INGEST_MAX_FAILED_STREAK) {
				this.degradedUntil = this.now() + DEGRADED_RETRY_MS;
				this.options.logService.warn(`[ParadisAivisIngest] worker failed ${this.failedStreak} times in a row (last: ${terminal.reason ?? 'unknown'}); playing with afplay for a while`);
				this._onDidChangeState.fire(this._state);
			}
		} else {
			this.failedStreak = 0;
		}
	}

	// --- 書き込み ------------------------------------------------------------------------------

	/**
	 * 子の標準入力へ書く。制御の枠を音声より先に書き、drain を待つ。子が終わっていれば捨てる。標準入力へ渡せたら true。
	 */
	private send(child: IChildState, frame: Buffer, lane: ParadisIngestLane): Promise<boolean> {
		if (child.exited) {
			return Promise.resolve(false);
		}
		return new Promise<boolean>(resolve => {
			(lane === 'control' ? child.controlQueue : child.audioQueue).push({ frame, resolve });
			void this.pumpWrites(child);
		});
	}

	private async pumpWrites(child: IChildState): Promise<void> {
		if (child.writing) {
			return;
		}
		child.writing = true;
		try {
			while (!child.exited) {
				const next = child.controlQueue.shift() ?? child.audioQueue.shift();
				if (!next) {
					break;
				}
				const stdin = child.process.stdin as NodeJS.WritableStream & { readonly writableEnded?: boolean };
				if (stdin.writableEnded === true || !stdin.writable) {
					// 閉じた標準入力への書き込みは成功として扱わない
					next.resolve(false);
					continue;
				}
				let ok = true;
				try {
					ok = stdin.write(next.frame);
				} catch {
					next.resolve(false);
					continue;
				}
				next.resolve(true);
				if (!ok && !child.exited) {
					// drain を待つ。進まないまま期限を過ぎたら子を見限る（書き込みを待つ人を全員起こす）
					const drained = await new Promise<boolean>(resolve => {
						const timer = setTimeout(() => done(false), PARADIS_INGEST_WRITE_STALL_MS);
						const done = (value: boolean) => {
							clearTimeout(timer);
							child.process.stdin.removeListener('drain', onDrain);
							child.drainWaiter = undefined;
							resolve(value);
						};
						const onDrain = () => done(true);
						child.drainWaiter = () => done(true);
						child.process.stdin.once('drain', onDrain);
					});
					if (!drained && !child.exited) {
						this.abandonChild(child);
					}
				}
			}
		} finally {
			child.writing = false;
		}
		if (child.exited) {
			for (const pending of [...child.controlQueue.splice(0), ...child.audioQueue.splice(0)]) {
				pending.resolve(false);
			}
		}
	}

	/** 標準入力が進まない子を見限る。落ちたものとして扱い（件は次の子に取り下げを頼む）、止める。 */
	private abandonChild(child: IChildState): void {
		this.options.logService.warn(`[ParadisAivisIngest] aivis-mcp --ingest stopped reading for ${PARADIS_INGEST_WRITE_STALL_MS / 1000}s; abandoning it`);
		this.killChild(child);
		this.onChildExit(child, null);
	}

	// --- 起動 ----------------------------------------------------------------------------------

	private setState(state: ParadisIngestClientState): void {
		if (this._state === 'disposed' || this._state === state) {
			return;
		}
		this._state = state;
		this._onDidChangeState.fire(state);
	}

	private async resolveEnv(): Promise<NodeJS.ProcessEnv> {
		this.env ??= await this.options.getEnv().catch(() => process.env);
		return this.env;
	}

	/** 版を確かめる。初回は子を起こし、以後は版が変わっていたら起こし直す。音量の表も取り直す。 */
	private async checkVersion(): Promise<void> {
		if (this._state === 'disposed') {
			return;
		}
		const initial = this._state === 'idle';
		if (initial) {
			this.setState('checking');
		}
		const env = await this.resolveEnv();
		const output = await this.probeVersion(env).catch(() => undefined);
		if (this.isDisposed()) {
			return;
		}
		const version = output === undefined ? undefined : paradisParseAivisVersion(output);
		this.installedVersion = version;
		if (!this.versionChecked) {
			this.versionChecked = true;
			for (const waiter of this.versionCheckedWaiters.splice(0)) {
				waiter();
			}
		}
		const supported = paradisAivisVersionAtLeast(version, PARADIS_AIVIS_INGEST_MIN_VERSION);
		if (initial || this._state === 'unsupported') {
			if (supported) {
				this.failures = 0;
				this.spawnChild();
			} else {
				this.setState('unsupported');
			}
			return;
		}
		const child = this.child;
		if (!supported && version !== undefined) {
			// 2.4 以前へ戻された。子がいない間（起動し直しの待ち・afplay への切り替え中）も、古い版の --ingest を起こし続けない
			this.options.logService.info(`[ParadisAivisIngest] aivis-mcp is now ${version.join('.')}; --ingest needs 2.5.0 or later`);
			if (this.restartTimer !== undefined) {
				clearTimeout(this.restartTimer);
				this.restartTimer = undefined;
			}
			if (child) {
				this.stopChild(child, 'unsupported');
			}
			this.setState('unsupported');
			return;
		}
		if (child?.version && version && !sameVersion(child.version, version)) {
			this.options.logService.info(`[ParadisAivisIngest] aivis-mcp changed from ${child.version.join('.')} to ${version.join('.')}; restarting --ingest`);
			this.scheduleVersionRestart(this.now());
			return;
		}
		if (child?.readyAt !== undefined) {
			void this.send(child, paradisEncodeIngestControl({ type: 'gain?', requestId: `gain-${++this.pingCounter}` }), 'control');
		}
	}

	/** 版が変わった。書きかけの流れが空くまで（上限付きで）待ってから、新しい子を起こす。 */
	private scheduleVersionRestart(since: number): void {
		if (this.versionRestartTimer !== undefined || this.incoming) {
			return;
		}
		const tryRestart = () => {
			this.versionRestartTimer = undefined;
			if (this.isDisposed() || this.incoming || this._state !== 'ready') {
				return;
			}
			const busy = [...this.streams.values()].some(stream => stream.writesPending);
			if (busy && this.now() - since < VERSION_RESTART_MAX_WAIT_MS) {
				this.versionRestartTimer = setTimeout(tryRestart, VERSION_RESTART_POLL_MS);
				return;
			}
			this.spawnChild(true);
		};
		tryRestart();
	}

	private createChild(process_: IParadisIngestChild): IChildState {
		return {
			process: process_,
			decoder: new ParadisIngestFrameDecoder(),
			readyAt: undefined,
			version: undefined,
			stopReason: undefined,
			processExited: false,
			killTimer: undefined,
			helloTimer: undefined,
			pingTimer: undefined,
			pingInterval: undefined,
			pingAwaiting: undefined,
			exited: false,
			controlQueue: [],
			audioQueue: [],
			writing: false,
			drainWaiter: undefined,
		};
	}

	/** 子を起こす。`replace` は版が変わったときの入れ替え（今の子は名乗るまで動かしたまま）。 */
	private spawnChild(replace = false): void {
		if (this._state === 'disposed') {
			return;
		}
		if (this.installedVersion !== undefined && !paradisAivisVersionAtLeast(this.installedVersion, PARADIS_AIVIS_INGEST_MIN_VERSION)) {
			// 最後に確かめた版が 2.5.0 未満。--ingest を知らない版を起こさない
			this.setState('unsupported');
			return;
		}
		// 二重に起こさない（起動し直しの予約と版の入れ替えが重なっても、追跡しない子を作らない）
		if (this.incoming && !this.incoming.exited) {
			return;
		}
		if (!replace && this.child && !this.child.exited) {
			return;
		}
		if (this.restartTimer !== undefined) {
			clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
		if (!replace) {
			this.setState('starting');
		}
		const env = this.env ?? process.env;
		const args = ['--ingest'];
		for (const dir of this.options.preludeDirs()) {
			args.push('--prelude-dir', dir);
		}
		let process_: IParadisIngestChild;
		try {
			process_ = this.spawnIngest(args, env);
		} catch (error) {
			this.options.logService.warn(`[ParadisAivisIngest] could not start aivis-mcp --ingest: ${error instanceof Error ? error.message : String(error)}`);
			if (!replace) {
				this.onStartFailure();
			}
			return;
		}
		const child = this.createChild(process_);
		this.alive.add(child);
		if (replace) {
			this.incoming = child;
		} else {
			this.child = child;
		}
		child.helloTimer = setTimeout(() => {
			if (child.readyAt === undefined && !child.exited) {
				this.options.logService.warn('[ParadisAivisIngest] aivis-mcp --ingest did not introduce itself in time; restarting');
				this.killChild(child);
			}
		}, HELLO_TIMEOUT_MS);
		process_.stdin.on('error', () => { /* 子が先に終わったときの EPIPE は終わりの知らせで扱う */ });
		process_.stdout.on('data', (chunk: Buffer) => this.onChildData(child, chunk));
		process_.onError(error => {
			this.options.logService.trace(`[ParadisAivisIngest] aivis-mcp --ingest error: ${error.message}`);
			this.onProcessExit(child, null);
		});
		process_.onExit(code => this.onProcessExit(child, code));
	}

	private onProcessExit(child: IChildState, code: number | null): void {
		child.processExited = true;
		this.alive.delete(child);
		if (child.killTimer !== undefined) {
			clearTimeout(child.killTimer);
			child.killTimer = undefined;
		}
		this.onChildExit(child, code);
	}

	private isTracked(child: IChildState): boolean {
		return child === this.child || child === this.incoming || this.retiring.has(child);
	}

	private onChildData(child: IChildState, chunk: Buffer): void {
		if (!this.isTracked(child) || child.exited) {
			return;
		}
		let messages: IParadisIngestMessage[];
		try {
			messages = child.decoder.push(chunk);
		} catch (error) {
			this.options.logService.warn(`[ParadisAivisIngest] broken frame from aivis-mcp --ingest: ${error instanceof Error ? error.message : String(error)}`);
			this.killChild(child);
			return;
		}
		for (const message of messages) {
			this.onMessage(child, message);
		}
	}

	private onMessage(child: IChildState, message: IParadisIngestMessage): void {
		switch (message.type) {
			case 'hello':
				this.onHello(child, message);
				return;
			case 'accepted': {
				if (typeof message.preludeRejected === 'string') {
					this.options.logService.info(`[ParadisAivisIngest] the ringtone was not accepted as a prelude: ${message.preludeRejected}`);
					const stream = typeof message.id === 'string' ? this.streams.get(message.id) : undefined;
					if (stream && stream.child === child) {
						// 着信音を付けずに積まれた。呼び出し側が着信音を鳴らす
						stream.rejectPrelude(message.preludeRejected);
					}
				}
				return;
			}
			case 'status': {
				const id = typeof message.id === 'string' ? message.id : undefined;
				const stream = id === undefined ? undefined : this.streams.get(id);
				if (stream && stream.child === child && typeof message.status === 'string') {
					if (message.status === 'failed' && message.withdrawn !== true && !stream.queued && paradisAivisVersionAtLeast(child.version, PARADIS_AIVIS_WITHDRAWN_CONTRACT_VERSION)) {
						// `queued` の前の、`withdrawn` の付かない失敗（積めたか分からない件）。鳴らさずに withdraw で確かめる
						void this.verifyUnqueuedFailure(stream, typeof message.reason === 'string' ? message.reason : undefined);
						return;
					}
					const terminal = stream.onStatus(message.status, typeof message.reason === 'string' ? message.reason : undefined, message.withdrawn === true);
					if (terminal) {
						this.streams.delete(stream.id);
					}
				}
				return;
			}
			case 'withdrawn': {
				const id = typeof message.id === 'string' ? message.id : undefined;
				if (id === undefined) {
					return;
				}
				// 呼び出し側が鳴らしてよいのは、外せた（removed）・積まれていなかった（notQueued）件だけ。taken（worker が
				// 取り出した）と、確かめられなかった件（理由の無い removed: false）は鳴らさない（取り決め 2.5.1 の withdraw）
				const mayPlay = message.removed === true || message.notQueued === true;
				const orphan = this.orphans.get(id);
				if (orphan) {
					this.orphans.delete(orphan.id);
					this.orphanModes.delete(orphan.id);
					if (mayPlay && !orphan.started) {
						orphan.settle({ status: 'failed', reason: 'ingest-exited', withdrawn: true }, false);
					} else {
						orphan.settle({ status: 'failed', reason: 'ingest-exited' }, true);
					}
					return;
				}
				const waiter = this.withdrawWaiters.get(id);
				const stream = this.streams.get(id);
				waiter?.(mayPlay ? true : message.taken === true ? false : undefined);
				if (stream && stream.child === child && mayPlay) {
					// 外せた・積まれていなかった件には以後 status が来ない
					this.streams.delete(id);
					stream.settle({ status: 'skipped', reason: 'withdrawn', withdrawn: true });
				}
				return;
			}
			case 'adopted': {
				const id = typeof message.id === 'string' ? message.id : undefined;
				const orphan = id === undefined ? undefined : this.orphans.get(id);
				if (!orphan || this.orphanModes.get(orphan.id) !== 'adopt') {
					return;
				}
				this.orphans.delete(orphan.id);
				this.orphanModes.delete(orphan.id);
				if (message.adopted === true && !child.exited) {
					// 追跡（playing・終わり）を続ける
					orphan.markAdopted(child);
					this.streams.set(orphan.id, orphan);
				} else if (orphan.started) {
					orphan.settle({ status: 'failed', reason: 'ingest-exited' }, true);
				} else {
					// 列にも知らせにも痕跡が無い（積まれていない）。withdraw の notQueued と同じく呼び出し側が鳴らす
					orphan.settle({ status: 'failed', reason: 'ingest-exited', withdrawn: true }, false);
				}
				return;
			}
			case 'gain': {
				const table = paradisParseVoiceGainTable({ entries: message.entries, defaultDb: message.defaultDb, volumeOffsetDb: message.volumeOffsetDb, elevenLabsVolumeOffsetDb: message.elevenLabsVolumeOffsetDb });
				if (table) {
					this._gainTable = table;
				}
				return;
			}
			case 'pong':
				if (message.requestId === child.pingAwaiting) {
					child.pingAwaiting = undefined;
				}
				if (child.pingTimer !== undefined) {
					clearTimeout(child.pingTimer);
					child.pingTimer = undefined;
				}
				return;
			case 'error':
				if (message.reason === 'unknown-stream') {
					// 終わった流れへの書き込みの行き違い（aivis-mcp の版によっては黙って捨てる）
					this.options.logService.trace('[ParadisAivisIngest] aivis-mcp --ingest did not know a stream we wrote to');
					return;
				}
				this.options.logService.warn(`[ParadisAivisIngest] aivis-mcp --ingest reported an error: ${String(message.reason)}`);
				return;
			default:
				// hold など、待っていない返事
				return;
		}
	}

	private onHello(child: IChildState, message: IParadisIngestMessage): void {
		if (child.readyAt !== undefined || child.exited) {
			return;
		}
		const version = typeof message.version === 'string' ? paradisParseAivisVersion(message.version) : undefined;
		if (message.protocol !== PARADIS_INGEST_PROTOCOL_VERSION || !paradisAivisVersionAtLeast(version, PARADIS_AIVIS_INGEST_MIN_VERSION)) {
			this.options.logService.warn(`[ParadisAivisIngest] aivis-mcp --ingest speaks protocol ${String(message.protocol)} (version ${String(message.version)}); not using it`);
			this.stopChild(child, 'unsupported');
			if (child === this.incoming) {
				this.incoming = undefined;
				const current = this.child;
				if (current) {
					this.stopChild(current, 'unsupported');
				}
			}
			this.setState('unsupported');
			return;
		}
		if (child.helloTimer !== undefined) {
			clearTimeout(child.helloTimer);
			child.helloTimer = undefined;
		}
		child.version = version;
		child.readyAt = this.now();
		if (child === this.incoming) {
			// 版が変わったときの入れ替え（または今の子が落ちた間に名乗った）。新しい子が名乗ってから古い子を止める
			// （hold は古い子が終わってから掛け直す）
			this.incoming = undefined;
			const previous = this.child;
			this.child = child;
			if (previous && !previous.exited) {
				this.retiring.add(previous);
				this.retireWhenDrained(previous);
			}
			this.failures = 0;
			this.failedStreak = 0;
		}
		// 起動し直しの予約が残っていたら外す（名乗った子を、予約で起こした別の子に置き換えない）
		if (this.restartTimer !== undefined) {
			clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
		if (this.stableTimer !== undefined) {
			clearTimeout(this.stableTimer);
		}
		this.stableTimer = setTimeout(() => {
			if (this.child === child && !child.exited) {
				this.failures = 0;
			}
		}, STABLE_MS);
		this.setState('ready');
		// 入れ替えの間に待たせていた呼び出し側を起こす（状態は ready のまま変わらないので、ここで知らせる）
		this._onDidChangeState.fire(this._state);
		// 起動し直したら hold を掛け直す
		this.sendHolds();
		void this.send(child, paradisEncodeIngestControl({ type: 'gain?', requestId: `gain-${++this.pingCounter}` }), 'control');
		this.withdrawOrphans(child);
		this.schedulePing(child);
	}

	/** 前の子が落ちたときに列に残った、まだ鳴っていない件を取り下げてもらう。取り下げられた件は呼び出し側が鳴らし直す。 */
	private withdrawOrphans(child: IChildState): void {
		const canAdopt = paradisAivisVersionAtLeast(child.version, PARADIS_AIVIS_ADOPT_VERSION);
		for (const orphan of [...this.orphans.values()]) {
			if (this.orphanModes.get(orphan.id) === 'adopt') {
				if (canAdopt) {
					void this.send(child, paradisEncodeIngestControl({ type: 'adopt', id: orphan.id }), 'control');
					continue;
				}
				// adopt を知らない子（2.5.0）。鳴り始めた件・書き終えて列に入った件は worker に任せて追跡をやめる
				if (orphan.started) {
					this.orphans.delete(orphan.id);
					this.orphanModes.delete(orphan.id);
					orphan.settle({ status: 'failed', reason: 'ingest-exited' }, true);
					continue;
				}
				if (orphan.queued) {
					this.orphans.delete(orphan.id);
					this.orphanModes.delete(orphan.id);
					orphan.settle({ status: 'done', reason: 'untracked' }, true);
					continue;
				}
				this.orphanModes.set(orphan.id, 'withdraw');
			}
			void this.send(child, paradisEncodeIngestControl({ type: 'withdraw', id: orphan.id }), 'control');
		}
		if (this.orphans.size > 0) {
			this.armOrphanTimer();
		}
	}

	private armOrphanTimer(): void {
		if (this.orphanTimer !== undefined) {
			clearTimeout(this.orphanTimer);
		}
		this.orphanTimer = setTimeout(() => {
			this.orphanTimer = undefined;
			this.settleOrphans(true);
		}, ORPHAN_WITHDRAW_WAIT_MS);
	}

	/**
	 * 取り下げの返事が来ないまま終える。`maybePlayed` は worker が鳴らすかもしれない（呼び出し側に鳴らさせない）。
	 * worker がいない・古い版に戻された（2.5 の列を読む worker がいない）ときは false で、呼び出し側が鳴らす。
	 */
	private settleOrphans(maybePlayed: boolean): void {
		if (this.orphanTimer !== undefined) {
			clearTimeout(this.orphanTimer);
			this.orphanTimer = undefined;
		}
		for (const orphan of this.orphans.values()) {
			// 鳴り始めた件は、鳴らす worker がいなくなっても鳴らし直さない
			const played = maybePlayed || orphan.started;
			orphan.settle(played ? { status: 'failed', reason: 'ingest-exited' } : { status: 'failed', reason: 'ingest-exited', withdrawn: true }, played);
		}
		this.orphans.clear();
		this.orphanModes.clear();
	}

	private schedulePing(child: IChildState): void {
		child.pingInterval = setInterval(() => {
			if (this.child !== child || child.exited || child.pingAwaiting !== undefined) {
				return;
			}
			const requestId = ++this.pingCounter;
			child.pingAwaiting = requestId;
			// 返事を待つ時計は、背圧で書けずにいる間は数えない（書き終えてから掛ける）
			void this.send(child, paradisEncodeIngestControl({ type: 'ping', requestId }), 'control').then(() => {
				if (child.exited || child.pingAwaiting !== requestId || this.child !== child) {
					return; // 書き終える前に返事が来た
				}
				child.pingTimer = setTimeout(() => {
					this.options.logService.warn('[ParadisAivisIngest] aivis-mcp --ingest stopped answering; restarting');
					this.killChild(child);
				}, PING_TIMEOUT_MS);
			});
		}, PING_INTERVAL_MS);
	}

	/** 子が終わった（または見限った）。 */
	private onChildExit(child: IChildState, code: number | null): void {
		if (child.exited) {
			return;
		}
		child.exited = true;
		if (child.helloTimer !== undefined) {
			clearTimeout(child.helloTimer);
		}
		if (child.pingTimer !== undefined) {
			clearTimeout(child.pingTimer);
		}
		if (child.pingInterval !== undefined) {
			clearInterval(child.pingInterval);
		}
		child.drainWaiter?.();
		for (const pending of [...child.controlQueue.splice(0), ...child.audioQueue.splice(0)]) {
			pending.resolve(false);
		}
		const disposing = child.stopReason === 'dispose' || this._state === 'disposed';
		for (const stream of [...this.streams.values()]) {
			if (stream.child !== child) {
				continue;
			}
			this.streams.delete(stream.id);
			if (disposing || !stream.openWritten) {
				// `open` を書けなかった件は積まれていない（呼び出し側が鳴らす）。鳴り始めた件は鳴らさない
				stream.settle({ status: 'failed', reason: 'ingest-exited' }, stream.started);
			} else if (stream.started || stream.fullyWritten || stream.kind === 'sound') {
				// 鳴り始めた件・書き終えた件は取り下げず、次の子に追跡を引き継いでもらう（adopt。こちらから入れ替えた子も
				// 落ちた子も同じ）
				this.orphans.set(stream.id, stream);
				this.orphanModes.set(stream.id, 'adopt');
			} else {
				// 書きかけの件（音声の続きは新しい子へ送れない）。積まれたかもしれないので、取り下げを頼んでから決める
				this.orphans.set(stream.id, stream);
				this.orphanModes.set(stream.id, 'withdraw');
			}
		}
		if (this.orphans.size > 0) {
			this.armOrphanTimer();
		}
		if (this.retiring.delete(child)) {
			// 古い子は終わるときに自分の hold（新しい子と同じ持ち主）を外すので、掛け直す
			this.sendHolds();
			const current = this.child;
			if (current?.readyAt !== undefined && !current.exited && this.orphans.size > 0) {
				this.withdrawOrphans(current);
			}
			return;
		}
		if (child === this.incoming) {
			this.incoming = undefined;
			// 入れ替えの間に待たせていた呼び出し側を起こす（今の子をそのまま使う）
			this._onDidChangeState.fire(this._state);
			if (this.child === undefined && !disposing && child.stopReason === undefined) {
				// 今の子が落ちた後、代わりの子も名乗る前に落ちた
				this.options.logService.warn(`[ParadisAivisIngest] aivis-mcp --ingest exited before introducing itself (code ${code === null ? 'none' : code})`);
				this.onStartFailure();
			}
			// それ以外は入れ替えに失敗しただけ。今の子を使い続け、次の版の確認でもう一度試す
			return;
		}
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
		if (disposing || child.stopReason === 'unsupported') {
			if (child.stopReason === 'unsupported') {
				// 2.5 の列を読む worker がいなくなる。取り下げを確かめられない件は呼び出し側が鳴らす
				this.settleOrphans(false);
			}
			return;
		}
		const stable = child.readyAt !== undefined && this.now() - child.readyAt >= STABLE_MS;
		if (stable) {
			this.failures = 0;
		}
		this.options.logService.warn(`[ParadisAivisIngest] aivis-mcp --ingest exited (code ${code === null ? 'none' : code})`);
		if (this.incoming && !this.incoming.exited) {
			// 版の入れ替えで起こした子が名乗れば、それを使う（別の子を起こさない）
			this.setState('starting');
			return;
		}
		this.onStartFailure();
	}

	private onStartFailure(): void {
		this.failures++;
		this.setState('starting');
		if (this.failures < PARADIS_INGEST_MAX_FAILURES) {
			this.scheduleRestart(PARADIS_INGEST_RESTART_DELAYS_MS[Math.min(this.failures, PARADIS_INGEST_RESTART_DELAYS_MS.length) - 1]);
			return;
		}
		void this.decideFallback();
	}

	private async decideFallback(): Promise<void> {
		const alive = await this.probeWorkerLock(this.env ?? process.env).catch(() => undefined);
		if (this.isDisposed() || this._state === 'unsupported' || (this.child && !this.child.exited) || this.incoming) {
			return;
		}
		this.unknownLockStreak = alive === undefined ? this.unknownLockStreak + 1 : 0;
		if (alive === true || (alive === undefined && this.unknownLockStreak < PARADIS_INGEST_MAX_FAILURES)) {
			// worker が動いている（または確かめられない）。列に積んだ発話は worker が鳴らすので、afplay で重ねずに起こし直し続ける。
			// 確かめられないのが 5 回続いたら afplay に倒す
			this.scheduleRestart(PARADIS_INGEST_RESTART_DELAYS_MS[PARADIS_INGEST_RESTART_DELAYS_MS.length - 1]);
			return;
		}
		this.unknownLockStreak = 0;
		this.options.logService.warn(`[ParadisAivisIngest] aivis-mcp --ingest failed ${this.failures} times in a row; playing with afplay for now`);
		this.setState('fallback');
		// worker の lock が無い（鳴らす worker がいない）なら、取り下げを確かめられない件は呼び出し側が鳴らす
		this.settleOrphans(alive !== false);
		this.scheduleRestart(FALLBACK_RETRY_MS, true);
	}

	private scheduleRestart(delayMs: number, resetFailures = false): void {
		if (this.restartTimer !== undefined) {
			clearTimeout(this.restartTimer);
		}
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (resetFailures) {
				this.failures = 0;
			}
			this.spawnChild();
		}, delayMs);
	}

	/**
	 * 入れ替えで古い子を止める。書きかけの流れ（`end` か `abort` をまだ渡していない）を書き終え、書き込みの列が空になって
	 * から標準入力を閉じる（閉じると aivis-mcp は書きかけの流れを中断する）。上限を過ぎたら閉じる。
	 */
	private retireWhenDrained(child: IChildState, since = this.now()): void {
		if (child.exited || this._state === 'disposed') {
			return;
		}
		const busy = child.writing || child.controlQueue.length > 0 || child.audioQueue.length > 0
			|| [...this.streams.values()].some(stream => stream.child === child && stream.writesPending);
		if (busy && this.now() - since < RETIRE_DRAIN_MAX_WAIT_MS) {
			const timer = setTimeout(() => this.retireWhenDrained(child, since), RETIRE_DRAIN_POLL_MS);
			(timer as { unref?: () => void }).unref?.();
			return;
		}
		this.stopChild(child, 'retired');
	}

	/** 標準入力を閉じて終わってもらう。終わらなければ止める（それでも終わらなければ SIGKILL）。 */
	private stopChild(child: IChildState, reason: NonNullable<IChildState['stopReason']>): void {
		child.stopReason = reason;
		try {
			child.process.stdin.end();
		} catch {
			// 既に閉じている
		}
		const timer = setTimeout(() => {
			if (!child.processExited) {
				this.killChild(child);
			}
		}, KILL_GRACE_MS);
		(timer as { unref?: () => void }).unref?.();
	}

	/** 止める。{@link KILL_GRACE_MS} 待っても終わらなければ SIGKILL する。 */
	private killChild(child: IChildState): void {
		if (child.processExited) {
			return;
		}
		try {
			child.process.kill();
		} catch {
			// 既に終わっている
		}
		if (child.killTimer === undefined && !child.processExited) {
			child.killTimer = setTimeout(() => {
				child.killTimer = undefined;
				if (!child.processExited) {
					try {
						child.process.kill(true);
					} catch {
						// 既に終わっている
					}
				}
			}, KILL_GRACE_MS);
			(child.killTimer as { unref?: () => void }).unref?.();
		}
	}

	override dispose(): void {
		if (this._state !== 'disposed') {
			const children = [...this.alive];
			this._state = 'disposed';
			for (const timer of [this.restartTimer, this.stableTimer, this.versionRestartTimer, this.orphanTimer]) {
				if (timer !== undefined) {
					clearTimeout(timer);
				}
			}
			this.restartTimer = undefined;
			if (this.holdTimer !== undefined) {
				clearInterval(this.holdTimer);
				this.holdTimer = undefined;
			}
			for (const waiter of this.versionCheckedWaiters.splice(0)) {
				waiter();
			}
			for (const waiter of [...this.withdrawWaiters.values()]) {
				waiter(undefined);
			}
			for (const stream of this.streams.values()) {
				stream.settle({ status: 'failed', reason: 'ingest-exited' });
			}
			this.streams.clear();
			this.settleOrphans(true);
			for (const child of children) {
				if (child.pingInterval !== undefined) {
					clearInterval(child.pingInterval);
				}
				if (child.helloTimer !== undefined) {
					clearTimeout(child.helloTimer);
				}
				if (child.pingTimer !== undefined) {
					clearTimeout(child.pingTimer);
				}
				// 標準入力を閉じると aivis-mcp は書きかけの流れを中断し、自分の hold を外して終わる
				this.stopChild(child, 'dispose');
			}
		}
		super.dispose();
	}
}

function sameVersion(a: readonly number[], b: readonly number[]): boolean {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

// --- 既定の実装 ---------------------------------------------------------------------------------

/** 子が終わって標準出力も閉じた（`close`）のを待つ上限。`exit` の後これだけ待っても閉じなければ終わったとみなす。 */
const STDOUT_CLOSE_WAIT_MS = 2_000;

/**
 * 子の終わりを 1 回だけ知らせる。`exit` の後にも標準出力に残った枠（終わる直前の `queued` など）が届くので、標準出力まで
 * 閉じた `close` で知らせる。孫が標準出力を握ったままで `close` が来ないときは、`exit` から少し待って知らせる。
 */
export function paradisOnIngestChildDone(child: Pick<NodeJS.EventEmitter, 'once'>, listener: (code: number | null) => void, waitMs = STDOUT_CLOSE_WAIT_MS): void {
	let reported = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const report = (code: number | null) => {
		if (reported) {
			return;
		}
		reported = true;
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		listener(code);
	};
	child.once('close', (code: number | null) => report(code));
	child.once('exit', (code: number | null) => {
		timer = setTimeout(() => report(code), waitMs);
		(timer as { unref?: () => void }).unref?.();
	});
}

/** 手元の `aivis-mcp --ingest` をログインシェル由来の PATH で起こす。 */
function spawnAivisIngest(args: readonly string[], env: NodeJS.ProcessEnv): IParadisIngestChild {
	const isWindows = process.platform === 'win32';
	if (isWindows && args.some(arg => arg.includes('"'))) {
		throw new Error('unsupported argument');
	}
	// Windows の npm のグローバルは `aivis-mcp.cmd` で、cmd.exe を通さないと起動できない。/s は外側の引用符を
	// 1 組剥がすので、全体をもう 1 組の引用符で包む。cwd を指定しないと今のフォルダの aivis-mcp.cmd を先に拾う
	const child = isWindows
		? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"aivis-mcp ${args.map(arg => arg.startsWith('--') ? arg : `"${arg}"`).join(' ')}"`], { env, cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, windowsVerbatimArguments: true })
		: spawn('aivis-mcp', [...args], { env, cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'] });
	return {
		stdin: child.stdin!,
		stdout: child.stdout!,
		onExit: listener => paradisOnIngestChildDone(child, listener),
		onError: listener => { child.once('error', listener); },
		kill: force => {
			if (isWindows && child.pid !== undefined) {
				// cmd.exe の下の node まで止める
				spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).once('error', () => child.kill());
				return;
			}
			child.kill(force ? 'SIGKILL' : 'SIGTERM');
		},
	};
}

function probeAivisVersion(env: NodeJS.ProcessEnv): Promise<string | undefined> {
	return new Promise(resolve => {
		const isWindows = process.platform === 'win32';
		const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'aivis-mcp';
		const args = isWindows ? ['/d', '/s', '/c', 'aivis-mcp --version'] : ['--version'];
		execFile(command, args, { env, cwd: homedir(), timeout: 3_000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
			resolve(error ? undefined : stdout);
		});
	});
}

/** aivis-mcp と同じ順（REDIS_URL → ~/.config/aivis-mcp/config.json → 既定）で Redis の URL を決める。 */
function resolveRedisUrl(env: NodeJS.ProcessEnv): string {
	if (env.REDIS_URL) {
		return env.REDIS_URL;
	}
	try {
		const settings = JSON.parse(readFileSync(join(homedir(), '.config', 'aivis-mcp', 'config.json'), 'utf8')) as { redisUrl?: unknown };
		if (typeof settings.redisUrl === 'string' && settings.redisUrl) {
			return settings.redisUrl;
		}
	} catch {
		// 無い・読めない
	}
	return 'redis://127.0.0.1:6379';
}

function respCommand(parts: readonly string[]): string {
	return `*${parts.length}\r\n${parts.map(part => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`;
}

/**
 * worker の lock（`aivis-mcp:worker-lock`）が Redis にあるかを、GET 1 回だけで確かめる。読むだけで書かない。
 * つながらない（Redis が無い）ときは false（worker も Redis が無ければ動けない）。rediss・認証の失敗・壊れた URL など
 * 確かめられないときは undefined（「分からない」として afplay へ切り替えない）。
 */
export function probeAivisWorkerLock(env: NodeJS.ProcessEnv): Promise<boolean | undefined> {
	return probeAivisRedisKey(env, WORKER_LOCK_KEY);
}

/** `aivis --mute` のキーがあるか（読むだけ）。確かめられなければ undefined。 */
export function probeAivisMute(env: NodeJS.ProcessEnv): Promise<boolean | undefined> {
	return probeAivisRedisKey(env, MUTE_KEY);
}

function probeAivisRedisKey(env: NodeJS.ProcessEnv, key: string): Promise<boolean | undefined> {
	const commands: string[][] = [];
	let host: string;
	let port: number;
	try {
		const url = new URL(resolveRedisUrl(env));
		if (url.protocol !== 'redis:') {
			return Promise.resolve(undefined);
		}
		if (url.password) {
			commands.push(url.username ? ['AUTH', decodeURIComponent(url.username), decodeURIComponent(url.password)] : ['AUTH', decodeURIComponent(url.password)]);
		}
		const db = url.pathname.replace(/^\//, '');
		if (/^\d+$/.test(db) && db !== '0') {
			commands.push(['SELECT', db]);
		}
		host = (url.hostname || '127.0.0.1').replace(/^\[(?<address>.*)\]$/, '$<address>');
		port = Number(url.port) || 6379;
	} catch {
		return Promise.resolve(undefined);
	}
	commands.push(['GET', key]);
	return new Promise<boolean | undefined>(resolve => {
		let settled = false;
		let buffer = '';
		const finish = (value: boolean | undefined) => {
			if (!settled) {
				settled = true;
				socket.destroy();
				resolve(value);
			}
		};
		const socket = connect({ host, port });
		socket.setTimeout(1_000, () => finish(undefined));
		socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED' ? false : undefined));
		socket.once('connect', () => socket.write(commands.map(respCommand).join('')));
		socket.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			if (buffer.length > 64 * 1024) {
				finish(undefined);
				return;
			}
			const replies = parseRespReplies(buffer);
			if (replies === undefined || replies.length < commands.length) {
				return;
			}
			if (replies.some(reply => reply === RESP_ERROR)) {
				// NOAUTH など。確かめられない
				finish(undefined);
				return;
			}
			const last = replies[commands.length - 1];
			finish(typeof last === 'string' && last.length > 0);
		});
	});
}

/** RESP の返事を並べて読む（単純な型だけ）。読み切れていなければ undefined。 */
const RESP_ERROR = Symbol('resp-error');

function parseRespReplies(text: string): Array<string | null | typeof RESP_ERROR> | undefined {
	const replies: Array<string | null | typeof RESP_ERROR> = [];
	let index = 0;
	while (index < text.length) {
		const lineEnd = text.indexOf('\r\n', index);
		if (lineEnd < 0) {
			return replies.length > 0 ? replies : undefined;
		}
		const kind = text[index];
		const line = text.slice(index + 1, lineEnd);
		if (kind === '+' || kind === ':') {
			replies.push(line);
			index = lineEnd + 2;
		} else if (kind === '-') {
			replies.push(RESP_ERROR);
			index = lineEnd + 2;
		} else if (kind === '$') {
			const length = Number(line);
			if (length < 0) {
				replies.push(null);
				index = lineEnd + 2;
				continue;
			}
			if (text.length < lineEnd + 2 + length + 2) {
				return replies.length > 0 ? replies : undefined;
			}
			replies.push(text.slice(lineEnd + 2, lineEnd + 2 + length));
			index = lineEnd + 2 + length + 2;
		} else {
			replies.push(null);
			index = lineEnd + 2;
		}
	}
	return replies;
}
