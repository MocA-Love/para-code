/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process内で動く、通知サウンド機能のバックエンド本体（Superset apps/desktop の
// main/lib/custom-ringtones.ts, main/lib/youtube-ringtone.ts, main/lib/play-sound.ts,
// main/lib/aivis/client.ts, main/lib/notifications/aivis-tts.ts の移植・統合）。
// 呼び出し元（renderer）はAPIキー等の設定をIStorageServiceで持つため、Aivis関連の全メソッドは
// 引数でAPIキーを明示的に受け取るステートレス設計にしている（Supersetのようなmain側local-dbは無い）。

import { execFile, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, statSync } from 'fs';
import { unlink, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { Promises } from '../../../../base/node/pfs.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	AivisError,
	AivisHandoffResult,
	AivisPriority,
	AivisRateLimit,
	AivisStreamingSynthesis,
	AivisSynthesizeResult,
	AivisTaskRunner,
	AudioScheduler,
} from './paradisAudioScheduler.js';
import { ParadisDictationHold } from '../common/paradisDictationHold.js';
import { IParadisPlayElevenLabsRequest, PARADIS_ELEVENLABS_DEFAULT_MODEL_ID, paradisStripSsmlTags } from '../common/paradisElevenLabs.js';
import { paradisAivisGainKey, paradisCorrectedPlaybackVolume, paradisElevenLabsGainKey, paradisResolveVoiceGainDb, paradisVolumePercentToDb } from '../common/paradisVoiceGain.js';
import { IParadisMobileVoiceStreamWriter, ParadisMobileVoiceEvent, ParadisMobileVoiceStreamWriter } from '../../mobileRelay/common/paradisMobileVoiceStream.js';
import { IParadisIngestOpenOptions, IParadisIngestStream, IParadisLocalVoiceOutput, IParadisVoiceRetention, PARADIS_AIVIS_PRELUDE_MAX_BYTES } from '../common/paradisVoiceIngest.js';
import { ParadisVoiceRetentionBudget } from '../common/paradisVoiceRetention.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IParadisAivisIngest, ParadisAivisIngestClient } from './paradisAivisIngestClient.js';
import { AIVIS_BASE_URL, ParadisAivisClient } from './paradisAivisClient.js';
import { ALLOWED_AUDIO_EXTENSIONS, CUSTOM_STEM, ParadisRingtoneIngestService } from './paradisRingtoneIngestService.js';
import { ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { PARADIS_MAX_SYNTHESIZED_AUDIO_BYTES, ParadisElevenLabsClient } from './paradisElevenLabsClient.js';
import { PARADIS_AIVIS_FIRST_BYTE_TIMEOUT_MS, paradisBufferBody, paradisCollectBody, paradisReadSynthesisBody, ParadisMobileVoiceTaskGate, ParadisSynthesisTimeouts, paradisTeeBody } from './paradisStreamingBody.js';
import { paradisHandoffVoice } from './paradisVoiceHandoff.js';
import { ParadisVoiceSynthesisCache } from './paradisVoiceSynthesisCache.js';
import { IParadisVoiceCacheInfo } from '../common/paradisVoiceCache.js';
import { CUSTOM_RINGTONE_ID, getRingtoneFilename, IParadisNotifyAudioRequest, isBuiltInRingtoneId, IParadisAivisDictionaryDetail, IParadisAivisDictionaryListItem, IParadisAivisDictionaryWord, IParadisAivisMeResult, IParadisAivisModelSummary, IParadisAivisUsageResult, IParadisPlayAivisRequest, PARADIS_MAX_MOBILE_VOICE_SIZE_BYTES } from '../common/paradisNotifications.js';

/**
 * 音声入力中に `--ingest` へ掛ける hold の持ち主の頭。shared process ごとの UUID を足す（Para Code を 2 つ動かして
 * いても、片方が外したときにもう片方の hold まで外さない）。
 */
const DICTATION_HOLD_OWNER_PREFIX = 'para-code-voice-input';
/** 着信音だけの通知を `--ingest` へ渡すとき、起動を待つ上限。 */
const SOUND_HANDOFF_READY_WAIT_MS = 1_000;
/** 着信音を鳴らしてよい古さ（worker も列で 5 秒以上待った着信音は鳴らさない）。 */
const SOUND_FRESHNESS_MS = 5_000;
/** Para Code が自分で鳴らす前に、worker の再生 lock が空くのを待つ上限。 */
const PLAY_LOCK_WAIT_MS = 30_000;

// --- Aivis レート制限 / エラー分類（Superset main/lib/notifications/aivis-tts.ts 移植） --------

function parseIntHeader(value: string | null): number | undefined {
	if (value === null) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function extractRateLimit(headers: Headers): AivisRateLimit | undefined {
	const remaining = parseIntHeader(headers.get('X-Aivis-RateLimit-Requests-Remaining'));
	const resetSeconds = parseIntHeader(headers.get('X-Aivis-RateLimit-Requests-Reset'));
	if (remaining === undefined || resetSeconds === undefined) {
		return undefined;
	}
	return { remaining, resetSeconds, capturedAt: Date.now() };
}

function classifyAivisStatus(status: number): 'retryable' | 'fatal' | 'item-specific' {
	if (status === 401 || status === 402 || status === 404) {
		return 'fatal';
	}
	if (status === 422) {
		return 'item-specific';
	}
	if (status === 429) {
		return 'retryable';
	}
	if (status >= 500 && status < 600) {
		return 'retryable';
	}
	// 未知の 4xx は叩き続けず item-specific 扱い。
	return 'item-specific';
}

function reasonForAivisStatus(status: number, bodyHint: string): string {
	switch (status) {
		// allow-any-unicode-next-line
		case 401: return 'Aivis API キーが無効です。設定画面でキーを確認してください';
		// allow-any-unicode-next-line
		case 402: return 'Aivis のクレジット残高が不足しています';
		// allow-any-unicode-next-line
		case 404: return 'Aivis の音声合成モデルが見つかりません';
		// allow-any-unicode-next-line
		case 422: return `Aivis リクエスト形式が不正です: ${bodyHint.slice(0, 120)}`;
		// allow-any-unicode-next-line
		case 429: return 'Aivis API のレート制限に到達しました';
		case 500:
		case 502:
		case 503:
		// allow-any-unicode-next-line
		case 504: return `Aivis サーバー側の一時障害 (HTTP ${status})`;
		// allow-any-unicode-next-line
		default: return `Aivis API エラー (HTTP ${status}) ${bodyHint.slice(0, 120)}`;
	}
}

/** テストで差し替える口（本番では使わない）。 */
export interface IParadisNotificationsTestingOptions {
	readonly ingest?: IParadisAivisIngest;
	readonly playRingtoneFile?: (ringtoneId: string, volume: number) => Promise<void>;
	readonly playVoiceAudio?: (audio: Buffer, volume: number) => Promise<void>;
	readonly resolveRingtonePath?: (ringtoneId: string) => string | null;
	/** カスタム音源の置き場所。テストが実際の `~/.para-code` に書かないよう差し替える。 */
	readonly assetsDir?: string;
	/** 読み上げの音声キャッシュの置き場所。テストが実際の `~/.para-code` に書かないよう差し替える。 */
	readonly voiceCacheDir?: string;
}

/**
 * 通知サウンド機能のバックエンド本体。カスタム音源の保存 (`~/.para-code/assets/ringtones/`)、
 * YouTube取込 (yt-dlp/ffmpeg 呼び出し)、Aivis Cloud APIクライアント、TTS再生を担う。
 */
export class ParadisNotificationsService extends Disposable implements IParadisLocalVoiceOutput {

	/** カスタム音源の置き場所（`~/.para-code/assets/ringtones/`。テストでは差し替える）。 */
	private readonly _assetsDir: string;
	/** 着信音のカスタム音源の取り込み（paradisRingtoneIngestService.ts）。 */
	readonly ringtones: ParadisRingtoneIngestService;

	/** fatal エラーで Aivis を一時停止した際に理由を通知する（renderer が INotificationService で提示）。 */
	private readonly _onAivisPaused = this._register(new Emitter<string>());
	readonly onAivisPaused: Event<string> = this._onAivisPaused.event;

	/**
	 * モバイルへ配る音声（流れの開始・断片・終わりと、1 本まるごとの MP3）。同じ shared process のモバイルリレーが
	 * 購読する。履歴は持たず、その場でだけ使う。
	 */
	private readonly _onDidCreateMobileVoiceClip = this._register(new Emitter<ParadisMobileVoiceEvent>());
	readonly onDidCreateMobileVoiceClip: Event<ParadisMobileVoiceEvent> = this._onDidCreateMobileVoiceClip.event;

	/** notifyAudio の直近要求で鳴らすべき通知音。scheduler.playRingtone() の直前に同期でセットする。 */
	private _currentRingtone: { readonly id: string; readonly volume: number } | undefined;

	/** 通知音と Aivis 再生の重なりを調停する単一スケジューラ。 */
	private readonly _scheduler: AudioScheduler;

	/** ElevenLabs API クライアント。読み上げエンジンが ElevenLabs のときの合成と、設定画面の各 API を受け持つ。 */
	readonly elevenLabs: ParadisElevenLabsClient;
	private readonly _aivisClient = new ParadisAivisClient();

	/** ElevenLabs で合成した音声の置き場所（`~/.para-code/cache/voice/`）。同じ文の通知を毎回合成させない。 */
	private readonly _voiceCache: ParadisVoiceSynthesisCache;

	/** 再生中の音声プレイヤー（afplay 等）。音声入力が始まったら止める。 */
	private readonly _audioPlayers = new Set<ChildProcess>();
	/** 音声入力で止めたプレイヤー。その終了は失敗として扱わない。 */
	private readonly _stoppedPlayers = new WeakSet<ChildProcess>();
	/** 音声入力（ディクテーション）中のウィンドウ（接続）。1つでもあれば読み上げを止める。上限はウィンドウごと。 */
	private readonly _dictationHold = this._register(new ParadisDictationHold(
		held => this._applyDictationHold(held),
		client => this.logService.warn(`[ParadisNotifications] dictation in ${client} kept the audio on hold for too long; no longer holding for it`),
	));

	/**
	 * `aivis-mcp --ingest`（2.5.0 以上）の常駐の子。あれば通知の読み上げと SSH 先の声を worker の 1 列へ渡す。
	 * 無い（テスト・aivis-mcp を入れていない）ときは今までどおり afplay で鳴らす。
	 */
	private readonly _ingest: IParadisAivisIngest | undefined;

	/** worker が鳴らせなかったときのために控える音声の、全体の枠（通知の読み上げと SSH 先の声で分け合う）。 */
	private readonly _retention = new ParadisVoiceRetentionBudget();

	/** 音声入力中の hold の持ち主（shared process ごと）。 */
	private readonly _dictationHoldOwner = `${DICTATION_HOLD_OWNER_PREFIX}-${generateUuid()}`;

	constructor(
		private readonly logService: ILogService,
		/** ログインシェル由来の環境。agentBrowser（SSH の戻り経路・`--play-audio`）と 1 本を共有する。 */
		readonly shellEnv?: ParadisCachedShellEnv,
		private readonly testing: IParadisNotificationsTestingOptions = {},
	) {
		super();
		this._assetsDir = testing.assetsDir ?? join(homedir(), '.para-code', 'assets', 'ringtones');
		this.ringtones = this._register(new ParadisRingtoneIngestService(logService, this._assetsDir));
		this._voiceCache = this._register(new ParadisVoiceSynthesisCache(testing.voiceCacheDir ?? join(homedir(), '.para-code', 'cache', 'voice'), logService));
		this.elevenLabs = new ParadisElevenLabsClient(logService, undefined, undefined, this._voiceCache);
		if (testing.ingest) {
			this._ingest = testing.ingest;
		} else if (shellEnv) {
			const ingest = this._register(new ParadisAivisIngestClient({
				getEnv: () => shellEnv.getEnv(),
				// 着信音として鳴らしてよいのは、Para Code の着信音のフォルダとアプリの中だけ
				preludeDirs: () => [this._assetsDir, FileAccess.asFileUri('vs/paradis/contrib/notifications/browser/media/sounds').fsPath],
				logService,
			}));
			ingest.start();
			this._ingest = ingest;
		}
		this._scheduler = new AudioScheduler({
			playRingtone: onComplete => {
				const ringtone = this._currentRingtone;
				if (!ringtone) {
					onComplete();
					return;
				}
				// ユーザーが `aivis --mute` している間は、Para Code が自分で鳴らす着信音も鳴らさない。worker が鳴らしている間
				// （再生 lock がある間）は待たずに捨てる（待つと安全網の時間を食い、後の声と重なる。着信音は情報を持たない）
				void (async () => {
					if (await this._isAivisMuted()) {
						return;
					}
					if (await this._ingest?.isPlayLockHeld().catch(() => false)) {
						this.logService.info('[ParadisNotifications] dropped a ringtone while aivis-mcp is playing');
						return;
					}
					await this._playRingtoneFile(ringtone.id, ringtone.volume);
				})()
					.catch(error => this.logService.warn(`[ParadisNotifications] Failed to play ringtone: ${getErrorMessage(error)}`))
					.finally(() => onComplete());
			},
			notifyAivisPaused: reason => this._onAivisPaused.fire(reason),
			onError: err => this.logService.warn(`[ParadisNotifications] Aivis scheduler error (${err.kind}): ${err.reason}`),
			logWarn: message => this.logService.warn(message),
			logInfo: message => this.logService.info(message),
			isHandoffAvailable: () => this._isHandoffAvailable(),
			// worker の再生 lock の待ちは、スケジューラが再生の安全網の外で待つ
			waitForPlayLock: async () => { await this._ingest?.whenPlayLockFree(PLAY_LOCK_WAIT_MS); },
		});
		this._register({ dispose: () => this._scheduler.dispose() });
		if (this._ingest) {
			const ingestForReady = this._ingest;
			// 子が名乗ったら、復旧待ちの時間切れを忘れる（次に起こし直す間はまた待つ）
			this._register(ingestForReady.onDidChangeState(() => {
				if (ingestForReady.isUsable()) {
					this._scheduler.noteHandoffReady();
				}
			}));
		}
	}

	// === 通知音 + Aivis の再生調停 ================================================================

	/**
	 * 通知1回分の音声（通知音 + Aivis 読み上げ）をスケジューラへ渡す。トリガー(renderer)から
	 * 通知ごとに1回呼ばれる。通知音はビジー時に捨てられる。Aivis はFIFOキューで処理するが
	 * 待機キューには上限があり、超過した normal は捨てられる（high を受け入れるために
	 * 最古の normal が追い出されることもある）。
	 */
	notifyAudio(request: IParadisNotifyAudioRequest): void {
		const priority: AivisPriority = request.priority === 'high' ? 'high' : 'normal';
		if (request.mobileOnly === true) {
			this._notifyMobileOnly(request, priority);
			return;
		}
		// 音声入力中の着信音はマイクに拾われるだけなので今までどおり捨てる（前置きにも、着信音だけのジョブにもしない）
		const ringtone = this._dictationHold.held ? undefined : request.ringtone;
		const voice = this._createVoiceTask(request, priority);
		// `--ingest` が使えるとき（起こし直し・入れ替えの最中で、復旧を待って渡すときも）は、着信音を声のジョブの前置き
		// （prelude）にして worker の 1 列で鳴らす
		const deferRingtone = this._isHandoffAvailable();
		if (voice) {
			if (ringtone) {
				if (deferRingtone) {
					voice.setRingtone(ringtone);
				} else {
					this._playRingtoneNow(ringtone);
				}
			}
			if (!this._scheduler.enqueueAivis(voice.runner, priority)) {
				// 一時停止中・列が満杯で入らなかった。預けた着信音は今鳴らす（worker が使えれば worker の列で）
				voice.runner.onDropped?.();
			}
		} else if (ringtone) {
			if (deferRingtone) {
				void this._handOffRingtoneOnly(ringtone, priority);
			} else {
				this._playRingtoneNow(ringtone);
			}
		}
	}

	/**
	 * おやすみモード中の読み上げ（Q310 A）。PC では鳴らさず、合成を受け取りながらモバイルへだけ流す（`aivis --mute` 中に
	 * モバイルへ届ける Q209 B と同じ扱い）。声を聞いているモバイルが無ければ合成しない（読み上げの利用料を使わない）。
	 * 数えるのは列に積むときと、合成する直前の 2 回。合成は通常の読み上げと同じ口を通るので、音声のキャッシュにも乗る。
	 * PC の音量が 0 の読み上げは、通常の読み上げと同じく作らない（モバイルへも送らない）。
	 */
	private _notifyMobileOnly(request: IParadisNotifyAudioRequest, priority: AivisPriority): void {
		const listeners = this.mobileVoiceListenerCount() ?? 0;
		if (listeners <= 0) {
			return;
		}
		const voice = this._createVoiceTask({ ...request, ringtone: undefined }, priority);
		if (voice === undefined) {
			return;
		}
		const runner: AivisTaskRunner = {
			synthesize: async () => {
				// 列で待つ間にモバイルが離れたら、合成しない（数え直す）
				if ((this.mobileVoiceListenerCount() ?? 0) <= 0) {
					return { audio: Buffer.alloc(0) };
				}
				return voice.runner.synthesize();
			},
			play: async () => undefined,
			mobileOnly: true,
		};
		if (!this._scheduler.enqueueAivis(runner, priority, { localOnly: true })) {
			this.logService.info('[ParadisNotifications] dropped a do-not-disturb voice for the mobile because the audio queue is full or paused');
		}
	}

	// === 手元で鳴らす口（SSH 先の声。IParadisLocalVoiceOutput） ==================================

	async openIngest(options: IParadisIngestOpenOptions, waitMs: number): Promise<IParadisIngestStream | undefined> {
		if (!this._ingest || !(await this._ingest.whenReady(waitMs))) {
			return undefined;
		}
		return this._ingest.open(options);
	}

	async hasLocalAivis(waitMs: number): Promise<boolean> {
		return this._ingest !== undefined && await this._ingest.hasLocalAivis(waitMs);
	}

	/**
	 * 通知の読み上げと同じ列に入れて鳴らす（音声入力中は待つ。Aivis の一時停止・レート制限には巻き込まない）。
	 * `--ingest` が使えれば worker へ渡し直し、使えなければ Para Code が鳴らす（worker が生きているかもしれない間は
	 * 復旧を待つ）。鳴り終わりは待たない。列が満杯でも、引き受けた声の枠に入れる。入れられなければ false。
	 */
	async playFallback(audio: Uint8Array, gainKey?: string): Promise<boolean> {
		const buffer = Buffer.from(audio);
		const runner = this._presynthesizedRunner(buffer, 'normal', gainKey, 100, true);
		const queued = this._scheduler.enqueueAivis(runner, 'normal', { ignorePause: true, presynthesized: true, reserved: true });
		if (!queued) {
			this.logService.warn('[ParadisNotifications] dropped an accepted remote voice because the audio queue is full');
		}
		return queued;
	}

	reserveFallbackCopy(): IParadisVoiceRetention | undefined {
		return this._retention.open();
	}

	/**
	 * 合成済みの声 1 件のタスク。`allowHandoff` なら worker へ渡し（取り下げられたら Para Code が鳴らす）、そうでなければ
	 * Para Code が鳴らす。音量は、worker へ渡すときは dB にしてジョブに載せ、自分で鳴らすときは音量の表で揃える。
	 */
	private _presynthesizedRunner(audio: Buffer, priority: AivisPriority, gainKey: string | undefined, volume: number, allowHandoff: boolean): AivisTaskRunner {
		const playLocally = (data: Buffer) => this._playVoiceUnlessMuted(data, paradisCorrectedPlaybackVolume(volume, gainKey, this._ingest?.gainTable));
		const ingest = this._ingest;
		const volumeDb = paradisVolumePercentToDb(volume);
		const handoffAudio = ingest === undefined || !allowHandoff || volumeDb === undefined ? undefined : (data: Buffer) => paradisHandoffVoice({
			ingest,
			open: { priority, ...(gainKey !== undefined ? { gainKey } : {}), volumeDb },
			synthesize: async () => ({ body: paradisBufferBody(data) }),
			retention: () => this._retention.open(),
			// 渡し直した件がまた鳴らせなかったら、もう渡さずに Para Code が鳴らす
			onPlayLocally: clip => this._enqueueLocalVoice(this._presynthesizedRunner(clip, priority, gainKey, volume, false), priority),
		});
		return {
			synthesize: async () => ({ audio }),
			play: playLocally,
			...(handoffAudio ? { handoff: () => handoffAudio(audio), handoffAudio } : {}),
		};
	}

	/** worker が鳴らせなかった声を、引き受けた声の枠で列に入れる。入らなければ記録だけ残す。 */
	private _enqueueLocalVoice(runner: AivisTaskRunner, priority: AivisPriority): void {
		if (!this._scheduler.enqueueAivis(runner, priority, { localOnly: runner.handoff === undefined, ignorePause: true, presynthesized: true, reserved: true })) {
			this.logService.warn('[ParadisNotifications] dropped a voice that the worker could not play because the audio queue is full');
			runner.onDropped?.();
		}
	}

	/**
	 * worker へ渡す（渡せなければ復旧を待つ）か。使える・起こしている・版を確かめている・新しい子へ入れ替えている間は true
	 * （worker が動いているかもしれないので、afplay で重ねない）。
	 */
	private _isHandoffAvailable(): boolean {
		const ingest = this._ingest;
		return ingest !== undefined && (ingest.isUsable() || ingest.isReplacing() || ingest.state === 'starting' || ingest.state === 'checking');
	}

	/** scheduler.playRingtone() は同期で deps.playRingtone を呼ぶため、直前セットで取り違えは起きない。 */
	private _playRingtoneNow(ringtone: { readonly id: string; readonly volume: number }): void {
		this._currentRingtone = ringtone;
		this._scheduler.playRingtone();
	}

	/**
	 * 誰も鳴らさなかった着信音を鳴らす。`--ingest` が使えれば着信音だけのジョブ（kind: 'sound'）として worker の列へ
	 * 入れ（`aivis --mute` と hold が効く）、使えなければ Para Code が鳴らす。
	 */
	private _playRingtoneAnywhere(ringtone: { readonly id: string; readonly volume: number }, priority: AivisPriority): void {
		if (this._dictationHold.held) {
			return;
		}
		if (this._isHandoffAvailable()) {
			void this._handOffRingtoneOnly(ringtone, priority);
		} else {
			this._playRingtoneNow(ringtone);
		}
	}

	/**
	 * 着信音のジョブの前置き。鳴らせない（音量 0・ファイルが無い）なら undefined。aivis-mcp が前置きとして受け付けない
	 * 大きさ（10MiB 超）なら 'direct'（Para Code が鳴らす）。
	 *
	 * ファイルの確認まで同期で行う。声の受け渡し（handOff）は `pendingRingtone` を読み、同じターンで消すか worker へ
	 * 預ける。ここで await すると、その間に `startRingtone` / `onDropped` が同じ着信音をもう一度鳴らしうる。
	 */
	private _ringtonePrelude(ringtone: { readonly id: string; readonly volume: number }): IParadisIngestOpenOptions['prelude'] | 'direct' {
		if (!(ringtone.volume > 0)) {
			return undefined;
		}
		const path = this._resolveRingtonePath(ringtone.id);
		if (!path) {
			return undefined;
		}
		try {
			// eslint-disable-next-line local/code-no-sync-fs -- The ringtone handoff in the voice runner reads and clears pendingRingtone in the same turn; awaiting here would let startRingtone or onDropped play it a second time.
			if (statSync(path).size > PARADIS_AIVIS_PRELUDE_MAX_BYTES) {
				return 'direct';
			}
		} catch {
			// 確かめられない。aivis-mcp に任せる（受け付けなければ preludeRejected が返る）
		}
		return { path, volume: Math.min(1, ringtone.volume / 100) };
	}

	/**
	 * 声を読まない設定の通知の着信音を worker へ渡す。渡せなければ Para Code が鳴らす（worker が生きているかもしれない
	 * 間は少し復旧を待ち、それでも渡せなければ捨てる。重ねない）。取り下げられた（まだ鳴っていない）着信音は、5 秒以内
	 * なら渡し直す。
	 */
	private async _handOffRingtoneOnly(ringtone: { readonly id: string; readonly volume: number }, priority: AivisPriority, since = Date.now()): Promise<void> {
		const prelude = this._ringtonePrelude(ringtone);
		if (!prelude) {
			return;
		}
		if (prelude === 'direct') {
			this._playRingtoneNow(ringtone);
			return;
		}
		const ingest = this._ingest;
		let ready = ingest !== undefined && await ingest.whenReady(SOUND_HANDOFF_READY_WAIT_MS);
		if (!ready && ingest !== undefined && !ingest.mayPlayDirectly()) {
			ready = await ingest.whenReady(Math.max(0, SOUND_FRESHNESS_MS - (Date.now() - since)));
			if (!ready) {
				// worker が生きているかもしれない（`--ingest` を起こし直している）。重ねて鳴らさない（着信音は情報を持たない）
				this.logService.info('[ParadisNotifications] dropped a ringtone while aivis-mcp --ingest is restarting');
				return;
			}
		}
		if (this._dictationHold.held) {
			return;
		}
		const stream = ready ? ingest?.open({ kind: 'sound', priority, prelude }) : undefined;
		if (!stream || !(await stream.handoff)) {
			// 取り下げが遅れて分かった着信音は、古くなっていれば鳴らさない
			if (Date.now() - since <= SOUND_FRESHNESS_MS && !this._dictationHold.held) {
				this._playRingtoneNow(ringtone);
			}
			return;
		}
		let started = false;
		stream.onDidStart(() => { started = true; });
		const terminal = await stream.finished;
		if (started || terminal.status !== 'failed' || terminal.withdrawn !== true) {
			return;
		}
		// 取り下げられた（まだ鳴っていない）。古くなった着信音・音声入力中は鳴らさない
		if (Date.now() - since > SOUND_FRESHNESS_MS || this._dictationHold.held) {
			return;
		}
		if (this._ingest?.isUsable() === true) {
			await this._handOffRingtoneOnly(ringtone, priority, since);
		} else if (this._ingest?.mayPlayDirectly() !== false) {
			this._playRingtoneNow(ringtone);
		}
	}

	/**
	 * 読み上げ 1 件のタスク。`--ingest` が使えれば worker へ渡し（handoff）、使えなければ全部受け取ってから
	 * afplay で鳴らす。音量は、worker へ渡すときは dB にしてジョブに載せ、自分で鳴らすときは音量の表で揃える。
	 *
	 * 預かった着信音（setRingtone）は、worker が鳴らし始めるまで手放さない。worker へ渡せなかった・取り下げられた・
	 * 列に入らなかった件は、Para Code が鳴らす。
	 */
	private _createVoiceTask(request: IParadisNotifyAudioRequest, priority: AivisPriority): { readonly runner: AivisTaskRunner; setRingtone(ringtone: { readonly id: string; readonly volume: number }): void } | undefined {
		let synthesizeStream: () => Promise<AivisStreamingSynthesis>;
		let gainKey: string;
		let volume: number;
		let text: string;
		if (request.aivis) {
			const aivis = request.aivis;
			text = aivis.text.trim();
			if (!text || !aivis.apiKey || !aivis.modelUuid) {
				return undefined;
			}
			const trimmed = text;
			synthesizeStream = () => this._synthesizeAivisStream({ ...aivis, text: trimmed });
			gainKey = paradisAivisGainKey(aivis.modelUuid);
			volume = aivis.volume ?? 100;
		} else if (request.elevenLabs) {
			// ElevenLabs でも同じスケジューラ（通知音の後・FIFO・一時停止・音声入力中の保留）に乗せる。
			const elevenLabs = request.elevenLabs;
			text = paradisStripSsmlTags(elevenLabs.text);
			if (!text || !elevenLabs.apiKey || !elevenLabs.voiceId) {
				return undefined;
			}
			const stripped = text;
			synthesizeStream = () => this.elevenLabs.synthesizeStream({ ...elevenLabs, text: stripped });
			gainKey = paradisElevenLabsGainKey(elevenLabs.voiceId, elevenLabs.modelId || PARADIS_ELEVENLABS_DEFAULT_MODEL_ID);
			volume = elevenLabs.volume ?? 100;
		} else {
			return undefined;
		}
		const volumeDb = paradisVolumePercentToDb(volume);
		if (volumeDb === undefined) {
			return undefined; // 音量 0
		}
		// 合成を受け取りながらモバイルへも流す（voice.stream.v1。受け取れない端末には終わってから 1 本で送る）
		// 合成の再試行をまたいでも、1 件につきモバイルへの流れは 1 本（ParadisMobileVoiceTaskGate）
		const synthesizeDirect = synthesizeStream;
		const mobileGainKey = gainKey;
		const mobileGate = new ParadisMobileVoiceTaskGate(() => this.beginMobileVoiceStream(mobileGainKey));
		synthesizeStream = async () => {
			const synthesis = await synthesizeDirect();
			return { ...synthesis, body: paradisTeeBody(synthesis.body, () => mobileGate.openSink()) };
		};
		// 感情タグ（[...]）入りの発話は、音量の覚え直しに使わない
		const tagged = /\[[^\]]+\]/.test(text);
		// まだ誰も鳴らしていない着信音
		let pendingRingtone: { readonly id: string; readonly volume: number } | undefined;
		const playPendingRingtone = () => {
			const ringtone = pendingRingtone;
			pendingRingtone = undefined;
			if (ringtone) {
				this._playRingtoneNow(ringtone);
			}
		};
		const playLocally = (audio: Buffer) => this._playVoiceUnlessMuted(audio, paradisCorrectedPlaybackVolume(volume, gainKey, this._ingest?.gainTable));
		const ingest = this._ingest;
		/** worker へ渡す（合成しながら、または合成済みの音声を）。 */
		const handOff = async (synthesize: () => Promise<AivisStreamingSynthesis>): Promise<AivisHandoffResult> => {
			const ringtone = pendingRingtone;
			const preludeOrDirect = ringtone && !this._dictationHold.held ? this._ringtonePrelude(ringtone) : undefined;
			if (ringtone && (preludeOrDirect === undefined || preludeOrDirect === 'direct')) {
				// 音声入力中（捨てる決まり）か、鳴らせる着信音が無い。大きすぎて前置きにできない着信音は Para Code が鳴らす
				pendingRingtone = undefined;
				if (preludeOrDirect === 'direct') {
					this._playRingtoneNow(ringtone);
				}
			}
			const prelude = preludeOrDirect === 'direct' ? undefined : preludeOrDirect;
			let started = false;
			let result: AivisHandoffResult;
			try {
				result = await paradisHandoffVoice({
					ingest: ingest!,
					open: { priority, gainKey, volumeDb, tagged, prelude },
					synthesize,
					retention: () => this._retention.open(),
					onStarted: () => {
						started = true;
						if (prelude) {
							// worker が着信音を鳴らした
							pendingRingtone = undefined;
						}
					},
					onPreludeRejected: () => {
						// 着信音を付けずに積まれた。worker が鳴らし始める前に Para Code が鳴らす
						if (!started && ringtone) {
							pendingRingtone = undefined;
							this._playRingtoneNow(ringtone);
						}
					},
					onPlayLocally: audio => {
						// worker は声を鳴らさなかった。着信音も鳴っていなければ、両方 Para Code が鳴らす（worker が使えれば
						// 列経由でもう一度渡す。重ねない）
						const ringtoneToPlay = prelude && !started ? ringtone : undefined;
						const runner = this._presynthesizedRunner(audio, priority, gainKey, volume, true);
						this._enqueueLocalVoice({
							...runner,
							startRingtone: () => {
								if (ringtoneToPlay) {
									this._playRingtoneNow(ringtoneToPlay);
								}
							},
						}, priority);
					},
				});
			} catch (error) {
				// 合成に失敗した。worker が鳴らし始める前なら、着信音は預かったまま（再試行のジョブに付け直すか、
				// あきらめたら Para Code が鳴らす）
				if (started) {
					pendingRingtone = undefined;
				}
				throw error;
			}
			if (result.kind === 'released') {
				// 着信音は worker が鳴らす（取り下げられたら onPlayLocally で鳴らす）
				pendingRingtone = undefined;
			}
			return result;
		};
		const runner: AivisTaskRunner = {
			synthesize: async () => {
				const synthesis = await synthesizeStream();
				return { audio: await paradisCollectBody(synthesis.body, PARADIS_MAX_SYNTHESIZED_AUDIO_BYTES), ...(synthesis.rateLimit ? { rateLimit: synthesis.rateLimit } : {}) };
			},
			// モバイルへは合成を受け取りながら流し終えている（synthesizeStream）
			play: audio => playLocally(audio),
			// Para Code が自分で鳴らす直前に、預かった着信音を鳴らす
			startRingtone: playPendingRingtone,
			// 列から外れた・あきらめた。預かった着信音は、worker が使えれば worker の列で鳴らす
			onDropped: () => {
				const ringtone = pendingRingtone;
				pendingRingtone = undefined;
				if (ringtone) {
					this._playRingtoneAnywhere(ringtone, priority);
				}
			},
			handoff: ingest === undefined ? undefined : () => handOff(synthesizeStream),
			// 合成済みの音声を渡し直す（モバイルへは送り終えている）
			handoffAudio: ingest === undefined ? undefined : audio => handOff(async () => ({ body: paradisBufferBody(audio) })),
		};
		return { runner, setRingtone: ringtone => { pendingRingtone = ringtone; } };
	}

	/**
	 * 生成済みの MP3 を、専有コピーとして 1 本まるごとモバイルへ渡す（流しながら渡せない古い経路）。
	 * `gainKey`（声とモデル）があれば、モバイルが -20 LUFS に揃える補正（gainDb）を添える。
	 */
	publishMobileVoiceClip(audio: Uint8Array, gainKey?: string): void {
		if (audio.byteLength === 0 || audio.byteLength > PARADIS_MAX_MOBILE_VOICE_SIZE_BYTES) {
			return;
		}
		this._onDidCreateMobileVoiceClip.fire({ kind: 'clip', audio: Uint8Array.from(audio), gainDb: this._mobileGainDb(gainKey) });
	}

	/**
	 * モバイルへの音声の流れを始める（通知の読み上げ・SSH 先の声・手元のエージェントの声が、受け取りながら書く）。
	 * 流すか 1 本まるごとで送るかは、モバイルリレーが最初の音で端末ごとに決める。
	 */
	beginMobileVoiceStream(gainKey?: string): IParadisMobileVoiceStreamWriter {
		return new ParadisMobileVoiceStreamWriter(event => this._onDidCreateMobileVoiceClip.fire(event), this._mobileGainDb(gainKey), PARADIS_MAX_MOBILE_VOICE_SIZE_BYTES);
	}

	private _mobileVoiceListenerProbe: (() => number) | undefined;

	/** モバイルリレーが、声を聞いているモバイルの数を数える口を置く（同じ shared process の中だけ）。 */
	setMobileVoiceListenerProbe(probe: () => number): IDisposable {
		this._mobileVoiceListenerProbe = probe;
		return toDisposable(() => {
			if (this._mobileVoiceListenerProbe === probe) {
				this._mobileVoiceListenerProbe = undefined;
			}
		});
	}

	mobileVoiceListenerCount(): number | undefined {
		try {
			return this._mobileVoiceListenerProbe?.();
		} catch {
			return undefined;
		}
	}

	/** 声とモデルの組の補正（-20 LUFS に揃える dB）。`--ingest` から取った表があればそれ、無ければ写しの最初の値。 */
	private _mobileGainDb(gainKey: string | undefined): number {
		return gainKey === undefined ? 0 : paradisResolveVoiceGainDb(gainKey, this._ingest?.gainTable);
	}

	/** Aivis の一時停止状態を解除する（ユーザーが APIキー等を修正して設定を保存した時に呼ばれる）。 */
	resumeAivis(): void {
		this._scheduler.resume();
	}

	/**
	 * あるウィンドウで音声入力（ディクテーション）が始まった・終わった。
	 *
	 * どれか1つのウィンドウでも音声入力中なら、読み上げと通知音を止める。マイクが Para Code 自身の
	 * 読み上げを拾って文字起こしに混ざるのを防ぐため。再生中の発話はその場で切り（その発話は
	 * 読み直さない）、その後に届いた発話は溜めておいて、音声入力が終わってから読み上げる。
	 */
	setDictationActive(client: string, active: boolean): void {
		this._dictationHold.set(client, active);
	}

	private _applyDictationHold(held: boolean): void {
		this._scheduler.setHeld(held);
		// worker が鳴らしているエージェントの声・通知の読み上げも止める（20 秒ごとに延長し、外したら消す）
		this._ingest?.setHold(this._dictationHoldOwner, held);
		if (held) {
			for (const player of this._audioPlayers) {
				this._stoppedPlayers.add(player);
				player.kill();
			}
		}
	}

	/**
	 * ウィンドウとの接続が切れたら、そのウィンドウの音声入力は終わったものとみなす。
	 * ただし同じ接続名の新しい接続（再読み込み）が既にあれば、そちらの状態を消さない。
	 */
	trackClientDisconnects(onDidDisconnect: Event<string>, isStillConnected: (client: string) => boolean): void {
		this._register(onDidDisconnect(client => {
			if (!isStillConnected(client)) {
				this.setDictationActive(client, false);
			}
		}));
	}

	/** ringtoneId から実ファイルパスを解決して再生し、完了を待つ。解決不可なら即 resolve（＝スキップ）。 */
	private async _playRingtoneFile(ringtoneId: string, volume: number): Promise<void> {
		if (this.testing.playRingtoneFile) {
			return this.testing.playRingtoneFile(ringtoneId, volume);
		}
		const path = this._resolveRingtonePath(ringtoneId);
		if (!path) {
			return;
		}
		await this._playSoundFile(path, volume);
	}

	/**
	 * ビルトイン音源は out 配下の media から、カスタム音源は ~/.para-code の保存先から解決する。
	 * {@link _ringtonePrelude} から同じターンで呼ばれるので同期のまま（理由はそちら）。
	 */
	private _resolveRingtonePath(ringtoneId: string): string | null {
		if (this.testing.resolveRingtonePath) {
			return this.testing.resolveRingtonePath(ringtoneId);
		}
		if (ringtoneId === CUSTOM_RINGTONE_ID) {
			const filename = this.ringtones.findFileByStem(CUSTOM_STEM, ALLOWED_AUDIO_EXTENSIONS);
			return filename ? join(this._assetsDir, filename) : null;
		}
		if (isBuiltInRingtoneId(ringtoneId)) {
			const filename = getRingtoneFilename(ringtoneId);
			if (!filename) {
				return null;
			}
			const path = FileAccess.asFileUri(`vs/paradis/contrib/notifications/browser/media/sounds/${filename}`).fsPath;
			// eslint-disable-next-line local/code-no-sync-fs -- Also resolves the ringtone for _ringtonePrelude, which must answer in the same turn (see there).
			return existsSync(path) ? path : null;
		}
		return null;
	}

	// === Aivis Cloud API（管理系。paradisAivisClient.ts） ==========================================

	getAivisModel(apiKey: string, uuid: string): Promise<IParadisAivisModelSummary | null> {
		return this._aivisClient.getModel(apiKey, uuid);
	}

	listAivisDictionaries(apiKey: string): Promise<IParadisAivisDictionaryListItem[]> {
		return this._aivisClient.listDictionaries(apiKey);
	}

	getAivisDictionary(apiKey: string, uuid: string): Promise<IParadisAivisDictionaryDetail> {
		return this._aivisClient.getDictionary(apiKey, uuid);
	}

	createAivisDictionary(apiKey: string, name: string, description: string): Promise<{ uuid: string }> {
		return this._aivisClient.createDictionary(apiKey, name, description);
	}

	updateAivisDictionary(apiKey: string, uuid: string, name: string, description: string, words: readonly IParadisAivisDictionaryWord[]): Promise<void> {
		return this._aivisClient.updateDictionary(apiKey, uuid, name, description, words);
	}

	deleteAivisDictionary(apiKey: string, uuid: string): Promise<void> {
		return this._aivisClient.deleteDictionary(apiKey, uuid);
	}

	exportAivisDictionary(apiKey: string, uuid: string): Promise<Record<string, unknown>> {
		return this._aivisClient.exportDictionary(apiKey, uuid);
	}

	importAivisDictionary(apiKey: string, uuid: string, data: Record<string, unknown>, override: boolean): Promise<void> {
		return this._aivisClient.importDictionary(apiKey, uuid, data, override);
	}

	getAivisUsageDaily(apiKey: string, startDate: string, endDate: string): Promise<IParadisAivisUsageResult> {
		return this._aivisClient.getUsageDaily(apiKey, startDate, endDate);
	}

	getAivisMe(apiKey: string): Promise<IParadisAivisMeResult> {
		return this._aivisClient.getMe(apiKey);
	}

	// --- TTS再生 -----------------------------------------------------------------------------

	/**
	 * 単発の合成 + 再生（設定画面の「音声テスト」ボタン用。スケジューラを意図的にバイパスする）。
	 * 通知経路は notifyAudio 経由でスケジューラに乗せるため、こちらはプレビュー専用。
	 */
	async playAivis(request: IParadisPlayAivisRequest): Promise<void> {
		const text = request.text.trim();
		if (!text || !request.apiKey || !request.modelUuid) {
			return;
		}
		const { audio } = await this._synthesizeAivis({ ...request, text });
		await this._playAivisAudio(audio, paradisCorrectedPlaybackVolume(request.volume ?? 100, paradisAivisGainKey(request.modelUuid), this._ingest?.gainTable));
	}

	/** 読み上げの音声キャッシュの件数・大きさと、キャッシュから鳴らした回数・API で合成した回数（日別）。 */
	getVoiceCacheInfo(): Promise<IParadisVoiceCacheInfo> {
		return this._voiceCache.getInfo();
	}

	/** 読み上げの音声キャッシュを全部消す（回数の記録は残す）。 */
	clearVoiceCache(): Promise<void> {
		return this._voiceCache.clear();
	}

	/** 設定画面の「テスト再生」の ElevenLabs 版。playAivis と同じくスケジューラを通さない。 */
	async playElevenLabs(request: IParadisPlayElevenLabsRequest): Promise<void> {
		if (!request.apiKey || !request.voiceId || !paradisStripSsmlTags(request.text)) {
			return;
		}
		// テスト再生はキャッシュを読まずに合成し直して置き換える（崩れた音を引き直せるように）
		const { audio } = await this.elevenLabs.synthesize(request, { refreshCache: true });
		await this._playAivisAudio(audio, paradisCorrectedPlaybackVolume(request.volume ?? 100, paradisElevenLabsGainKey(request.voiceId, request.modelId || PARADIS_ELEVENLABS_DEFAULT_MODEL_ID), this._ingest?.gainTable));
	}

	/**
	 * 低レベルの合成呼び出し。音声 + レート制限スナップショットを返すか、分類済みの AivisError を throw
	 * する（Superset aivis-tts.ts の synthesizeAivisAudio 相当）。スケジューラのリトライ判定に使われる。
	 */
	private async _synthesizeAivis(request: IParadisPlayAivisRequest): Promise<AivisSynthesizeResult> {
		const { body, rateLimit } = await this._synthesizeAivisStream(request);
		return { audio: await paradisCollectBody(body, PARADIS_MAX_SYNTHESIZED_AUDIO_BYTES), rateLimit };
	}

	/**
	 * 合成を少しずつ受け取る。応答のヘッダーまでを待って返し、失敗の状態は AivisError にして投げる。
	 * 最初の 1 バイトまで 10 秒、途切れ 8 秒で打ち切る。
	 */
	private async _synthesizeAivisStream(request: IParadisPlayAivisRequest): Promise<AivisStreamingSynthesis> {
		const body: Record<string, unknown> = { model_uuid: request.modelUuid, text: request.text, output_format: 'mp3' };
		if (request.userDictionaryUuid) {
			body.user_dictionary_uuid = request.userDictionaryUuid;
		}
		if (request.speakingRate !== undefined) {
			body.speaking_rate = request.speakingRate;
		}

		const timeouts = new ParadisSynthesisTimeouts(PARADIS_AIVIS_FIRST_BYTE_TIMEOUT_MS);
		let response: Response;
		try {
			response = await fetch(new URL('/v1/tts/synthesize', AIVIS_BASE_URL), {
				method: 'POST',
				headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
				body: JSON.stringify(body),
				signal: timeouts.signal,
			});
		} catch (error) {
			timeouts.dispose();
			if (error instanceof Error && error.name === 'AbortError') {
				// allow-any-unicode-next-line
				throw new AivisError('retryable', 'Aivis API のリクエストがタイムアウトしました', undefined, undefined, error);
			}
			throw new AivisError('retryable', error instanceof Error ? error.message : String(error), undefined, undefined, error);
		}

		if (!response.ok) {
			const bodyText = await response.text().catch(() => '');
			timeouts.dispose();
			const kind = classifyAivisStatus(response.status);
			const reason = reasonForAivisStatus(response.status, bodyText);
			const rateLimitReset = response.status === 429
				? parseIntHeader(response.headers.get('X-Aivis-RateLimit-Requests-Reset'))
				: undefined;
			throw new AivisError(kind, reason, response.status, rateLimitReset);
		}
		return { body: paradisReadSynthesisBody(response, timeouts, 'Aivis'), rateLimit: extractRateLimit(response.headers) };
	}

	/** `aivis --mute` 中か（手元に aivis-mcp が無ければ false）。 */
	private async _isAivisMuted(): Promise<boolean> {
		return this._ingest !== undefined && await this._ingest.isMuted().catch(() => false);
	}

	/**
	 * 通知・SSH 先の声を Para Code が自分で鳴らす。ユーザーが `aivis --mute` している間は鳴らさない（モバイルへは
	 * 送り終えている）。設定画面の試し聞きはこれを通さない。
	 */
	private async _playVoiceUnlessMuted(audio: Buffer, volume: number): Promise<void> {
		if (await this._isAivisMuted()) {
			return;
		}
		// worker の再生 lock の待ちは、スケジューラが再生の安全網の外で済ませている（waitForPlayLock）
		await this._playAivisAudio(audio, volume);
	}

	/** 合成済み音声を一時ファイルへ書き出して再生し、完了後に削除する。 */
	private async _playAivisAudio(audio: Buffer, volume: number): Promise<void> {
		if (this.testing.playVoiceAudio) {
			return this.testing.playVoiceAudio(audio, volume);
		}
		const tempPath = join(tmpdir(), `paradis-aivis-${Date.now()}-${randomUUID().slice(0, 8)}.mp3`);
		await writeFile(tempPath, audio);
		try {
			await this._playSoundFile(tempPath, volume);
		} finally {
			unlink(tempPath).catch(() => { /* ignore */ });
		}
	}

	/**
	 * サウンドファイルをOSの標準ツールで再生し、完了を待つ（Superset main/lib/play-sound.ts 移植）。
	 * macOS: afplay -v、Linux: 利用可能な音声プレイヤーを順に試行、Windows: PowerShell。
	 */
	private async _playSoundFile(soundPath: string, volume: number): Promise<void> {
		if (!await Promises.exists(soundPath)) {
			this.logService.warn(`[ParadisNotifications] sound file not found: ${soundPath}`);
			return;
		}
		// afplay 等には頭打ち（リミッター）が無いので、1.0 を超えて上げない（上げるのは aivis-mcp 2.5.0 の worker 経由だけ）
		const volumeDecimal = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume / 100 : 1));
		if (volumeDecimal === 0) {
			return;
		}

		if (this._scheduler.isHeld) {
			return; // 音声入力中（setDictationActive）
		}
		if (process.platform === 'darwin') {
			await this._runAudioPlayer('afplay', ['-v', volumeDecimal.toString(), soundPath]);
			return;
		}
		if (process.platform === 'win32') {
			const escapedPath = soundPath.replace(/'/g, '\'\'');
			const isWav = /\.wav$/i.test(soundPath);
			const script = isWav
				? `$p = New-Object Media.SoundPlayer '${escapedPath}'; $p.PlaySync()`
				: `Add-Type -AssemblyName presentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([System.Uri]::new('${escapedPath}')); $p.Volume = ${volumeDecimal}; $p.Play(); Start-Sleep -Milliseconds 500; while ($p.NaturalDuration.HasTimeSpan -and $p.Position -lt $p.NaturalDuration.TimeSpan) { Start-Sleep -Milliseconds 200 }`;
			await this._runAudioPlayer('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], true);
			return;
		}

		// Linux: MP3を扱えないaplayだけに依存せず、一般的なデスクトップ/メディア環境を順に試す。
		const paVolume = Math.round(volumeDecimal * 65536);
		const percentVolume = Math.round(volumeDecimal * 100);
		const candidates: ReadonlyArray<readonly [string, readonly string[]]> = [
			['paplay', ['--volume', paVolume.toString(), soundPath]],
			['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', '-volume', percentVolume.toString(), soundPath]],
			['mpv', ['--no-video', '--really-quiet', `--volume=${percentVolume}`, soundPath]],
			['play', ['-q', '-v', volumeDecimal.toString(), soundPath]],
			...(/\.mp3$/i.test(soundPath) ? [['mpg123', ['-q', '-f', Math.round(volumeDecimal * 32768).toString(), soundPath]] as const] : []),
			...(/\.wav$/i.test(soundPath) ? [['aplay', ['-q', soundPath]] as const] : []),
		];
		for (const [command, args] of candidates) {
			if (await this._tryAudioPlayer(command, args)) {
				return;
			}
			if (this._scheduler.isHeld) {
				return; // 音声入力で止めたプレイヤーを、次の候補で鳴らし直さない
			}
		}
		throw new Error('Linuxで音声を再生できませんでした（paplay、ffplay、mpv、play、mpg123、aplayのいずれかが必要です）');
	}

	private _runAudioPlayer(command: string, args: readonly string[], windowsHide: boolean = false): Promise<void> {
		return new Promise((resolve, reject) => {
			const player = execFile(command, [...args], { windowsHide }, error => {
				this._audioPlayers.delete(player);
				if (error && !this._stoppedPlayers.has(player)) {
					reject(error);
				} else {
					resolve();
				}
			});
			this._audioPlayers.add(player);
		});
	}

	private async _tryAudioPlayer(command: string, args: readonly string[]): Promise<boolean> {
		try {
			await this._runAudioPlayer(command, args);
			return true;
		} catch {
			return false;
		}
	}
}
