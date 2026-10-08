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

import { execFile, spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync, type Dirent } from 'fs';
import { copyFile, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { basename, delimiter, dirname, extname, join } from '../../../../base/common/path.js';
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
import { ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { PARADIS_MAX_SYNTHESIZED_AUDIO_BYTES, ParadisElevenLabsClient } from './paradisElevenLabsClient.js';
import { PARADIS_AIVIS_FIRST_BYTE_TIMEOUT_MS, paradisBufferBody, paradisCollectBody, paradisReadSynthesisBody, ParadisMobileVoiceTaskGate, ParadisSynthesisTimeouts, paradisTeeBody } from './paradisStreamingBody.js';
import { paradisHandoffVoice } from './paradisVoiceHandoff.js';
import { ParadisVoiceSynthesisCache } from './paradisVoiceSynthesisCache.js';
import { IParadisVoiceCacheInfo } from '../common/paradisVoiceCache.js';
import {
	CUSTOM_RINGTONE_ID,
	getRingtoneFilename,
	IParadisNotifyAudioRequest,
	isBuiltInRingtoneId,
	IParadisAivisDictionaryDetail,
	IParadisAivisDictionaryListItem,
	IParadisAivisDictionaryWord,
	IParadisAivisMeResult,
	IParadisAivisModelSummary,
	IParadisAivisUsageDayEntry,
	IParadisAivisUsageResult,
	IParadisCustomRingtoneInfo,
	IParadisInstallLogLine,
	IParadisInstallLogResult,
	IParadisPlayAivisRequest,
	IParadisRenderClipRequest,
	IParadisRingtoneEditState,
	IParadisYouTubeDownloadResult,
	PARADIS_MAX_CLIP_DURATION_SECONDS,
	PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES,
	PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES,
	PARADIS_MAX_MOBILE_VOICE_SIZE_BYTES,
} from '../common/paradisNotifications.js';
import { IParadisYtDlpCheckResult, IParadisYtDlpStatus, paradisAssessYtDlpVersion, paradisClassifyYtDlpError, paradisDetectYtDlpInstallMethod, paradisExtractYtDlpWarnings, paradisParseYtDlpVersion, paradisYtDlpUpdatePlan, ParadisYtDlpFailure } from '../common/paradisYtDlp.js';
import { IParadisMyinstantsDownloadResult, paradisCheckMyinstantsUrl, paradisIsMp3ContentType, paradisLooksLikeMp3, paradisMyinstantsDisplayName } from '../common/paradisMyinstants.js';

const AIVIS_BASE_URL = 'https://api.aivis-project.com';
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
const YT_DLP_TIMEOUT_MS = 120_000;
const FULL_DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_FULL_DOWNLOAD_DURATION_SECONDS = 600;
/** 保持する yt-dlp インストール状態の上限。通常は1件しか走らない。 */
const PARADIS_MAX_INSTALL_STATES = 4;
const FETCH_AUDIO_TIMEOUT_MS = 15_000;
/** Myinstants の mp3 を取るときに追うリダイレクトの上限（追う先も同じ形の URL に限る）。 */
const MYINSTANTS_MAX_REDIRECTS = 3;
const REQUIRED_BINARIES = ['yt-dlp', 'ffmpeg', 'ffprobe'] as const;
/** yt-dlp が既定で使う JS ランタイム。無くても動くが、一部の形式が取れなくなる。Para Code は入れず案内だけする。 */
const OPTIONAL_BINARIES = ['deno'] as const;
/** `yt-dlp --version` の打ち切り。 */
const YT_DLP_VERSION_TIMEOUT_MS = 10_000;

const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg']);
const ALLOWED_SOURCE_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.webm']);
const OUTPUT_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.webm']);

const CUSTOM_STEM = 'notification-custom';
const CUSTOM_SOURCE_STEM = 'notification-custom-source';

function mimeTypeFor(filePath: string): string {
	switch (extname(filePath).toLowerCase()) {
		case '.wav': return 'audio/wav';
		case '.ogg': return 'audio/ogg';
		case '.m4a': return 'audio/mp4';
		case '.aac': return 'audio/aac';
		case '.opus': return 'audio/opus';
		case '.webm': return 'audio/webm';
		default: return 'audio/mpeg';
	}
}

/** インストールログの購読用バッファ（yt-dlp/ffmpeg の `brew install` 進捗、UIはポーリングで取得）。 */
interface IInstallState {
	lines: IParadisInstallLogLine[];
	done: boolean;
	error?: string;
	nextSeq: number;
}

/** 子プロセスの失敗。メッセージは標準エラーの末尾、`stderr` には全文、`exitCode` には終了コードを持つ（失敗の理由と警告の見分けに使う）。 */
class ParadisProcessError extends Error {
	constructor(message: string, readonly stderr: string, readonly exitCode?: number) {
		super(message);
	}
}

class AivisApiError extends Error {
	constructor(readonly status: number, bodyText: string) {
		// allow-any-unicode-next-line
		super(`Aivis API エラー (HTTP ${status})${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
	}
}

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

	/** 起動時 sweep の対象となる yt-dlp / ffmpeg 作業ディレクトリのプレフィックス。 */
	private static readonly TEMP_WORK_DIR_PREFIXES = ['paradis-ytfull-', 'paradis-ytclip-', 'paradis-myinstants-'];

	/**
	 * この年齢より新しい作業ディレクトリは sweep しない。フルダウンロードのタイムアウト(5分)より
	 * 十分長い時間を置くことで、同一マシンの別アプリインスタンスが実行中の取得と衝突しない
	 * ようにする(孤立した直後のものは次回起動以降で回収される)。
	 */
	private static readonly TEMP_WORK_DIR_MIN_AGE_MS = 30 * 60 * 1000;

	/** カスタム音源の置き場所（`~/.para-code/assets/ringtones/`。テストでは差し替える）。 */
	private readonly _assetsDir: string;
	private readonly _metadataPath: string;

	/**
	 * downloadYouTubeAudio / downloadMyinstantsAudio が発行した一時音源 (tempId → { path, dir })。
	 * Myinstants 由来のものだけ、取得した mp3 の URL（出典）を持つ。
	 */
	private readonly _tempAudio = new Map<string, { readonly path: string; readonly dir: string; readonly myinstantsSourceUrl?: string }>();
	private readonly _installStates = new Map<string, IInstallState>();

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
		this._metadataPath = join(this._assetsDir, `${CUSTOM_STEM}.json`);
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
		this._sweepOrphanTempWorkDirs();
	}

	override dispose(): void {
		// 取り込み成功/キャンセルどちらの経路でも掃除漏れがあり得るため、残った一時音源
		// ディレクトリ (paradis-ytfull-*) をプロセス終了前にまとめて削除する。
		for (const entry of this._tempAudio.values()) {
			void rm(entry.dir, { recursive: true, force: true }).catch(() => { /* ignore */ });
		}
		this._tempAudio.clear();
		this._installStates.clear();
		super.dispose();
	}

	/**
	 * 前回までのプロセスが残した YouTube 取込の一時ディレクトリ ($TMPDIR/paradis-ytfull-*,
	 * $TMPDIR/paradis-ytclip-*) を起動時に掃除する。
	 *
	 * ダウンロード完了前にダイアログが閉じられる（backdrop クリックやウィンドウリロード）と
	 * renderer 側の参照は消えるため、正常終了なら quit 時の dispose() で回収されるものの、
	 * shared process がクラッシュ・強制終了されると workDir は永久に残る。長時間セッションで
	 * の蓄積も同じ場所に溜まる。dispose 時の掃除は _tempAudio に載ったものしか対象にできず、
	 * この漏れを拾えない。
	 *
	 * 掃除はコンストラクタ（downloadYouTubeAudio をまだ受け付けていない時点）に1回だけ走り、
	 * 最終更新から一定年齢を超えたディレクトリだけを対象にする。同一マシンで別インスタンスが
	 * 実行中の取得を持っていても、その作業ディレクトリは更新され続けているため触られない。
	 */
	private _sweepOrphanTempWorkDirs(): void {
		const tmp = tmpdir();
		let entries: Dirent[];
		try {
			entries = readdirSync(tmp, { withFileTypes: true });
		} catch (error) {
			this.logService.warn(`[ParadisNotifications] failed to list ${tmp} for the temp work dir sweep: ${getErrorMessage(error)}`);
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !ParadisNotificationsService.TEMP_WORK_DIR_PREFIXES.some(prefix => entry.name.startsWith(prefix))) {
				continue;
			}
			const dirPath = join(tmp, entry.name);
			try {
				if (Date.now() - statSync(dirPath).mtimeMs < ParadisNotificationsService.TEMP_WORK_DIR_MIN_AGE_MS) {
					continue;
				}
			} catch {
				continue;
			}
			void rm(dirPath, { recursive: true, force: true })
				.catch(error => this.logService.warn(`[ParadisNotifications] failed to sweep the orphan temp dir ${entry.name}: ${getErrorMessage(error)}`));
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

	/** ビルトイン音源は out 配下の media から、カスタム音源は ~/.para-code の保存先から解決する。 */
	private _resolveRingtonePath(ringtoneId: string): string | null {
		if (this.testing.resolveRingtonePath) {
			return this.testing.resolveRingtonePath(ringtoneId);
		}
		if (ringtoneId === CUSTOM_RINGTONE_ID) {
			const filename = this._findFileByStem(CUSTOM_STEM, ALLOWED_AUDIO_EXTENSIONS);
			return filename ? join(this._assetsDir, filename) : null;
		}
		if (isBuiltInRingtoneId(ringtoneId)) {
			const filename = getRingtoneFilename(ringtoneId);
			if (!filename) {
				return null;
			}
			const path = FileAccess.asFileUri(`vs/paradis/contrib/notifications/browser/media/sounds/${filename}`).fsPath;
			return existsSync(path) ? path : null;
		}
		return null;
	}

	// === カスタム音源 ============================================================================

	private _ensureAssetsDir(): void {
		if (!existsSync(this._assetsDir)) {
			mkdirSync(this._assetsDir, { recursive: true, mode: 0o700 });
		}
	}

	private _findFileByStem(stem: string, extensions: ReadonlySet<string>): string | null {
		if (!existsSync(this._assetsDir)) {
			return null;
		}
		const candidates = readdirSync(this._assetsDir).filter(file => file.startsWith(`${stem}.`) && extensions.has(extname(file).toLowerCase()));
		if (candidates.length === 0) {
			return null;
		}
		candidates.sort((a, b) => statSync(join(this._assetsDir, b)).mtimeMs - statSync(join(this._assetsDir, a)).mtimeMs);
		return candidates[0] ?? null;
	}

	private _removeFilesByStem(stem: string): void {
		if (!existsSync(this._assetsDir)) {
			return;
		}
		for (const file of readdirSync(this._assetsDir)) {
			if (file.startsWith(`${stem}.`)) {
				try {
					unlinkSync(join(this._assetsDir, file));
				} catch {
					// best effort
				}
			}
		}
	}

	/**
	 * カスタム音源のメタ情報。`sourceUrl` は Myinstants から取り込んだ音の出典（後から足した項目。無い JSON は
	 * 今までどおり読める）。YouTube 由来の出典は `editState.sourceUrl` にある。
	 */
	private _readMetadata(): { name?: string; importedAt?: number; thumbnailUrl?: string; editState?: IParadisRingtoneEditState; sourceUrl?: string } {
		if (!existsSync(this._metadataPath)) {
			return {};
		}
		try {
			return JSON.parse(readFileSync(this._metadataPath, 'utf8'));
		} catch {
			return {};
		}
	}

	private _writeMetadata(name: string, importedAt: number, thumbnailUrl?: string, editState?: IParadisRingtoneEditState, sourceUrl?: string): void {
		this._ensureAssetsDir();
		writeFileSync(this._metadataPath, JSON.stringify({ name, importedAt, ...(thumbnailUrl ? { thumbnailUrl } : {}), ...(editState ? { editState } : {}), ...(sourceUrl ? { sourceUrl } : {}) }), 'utf8');
		try {
			chmodSync(this._metadataPath, 0o600);
		} catch {
			// best effort
		}
	}

	async getCustomRingtoneInfo(): Promise<IParadisCustomRingtoneInfo | null> {
		const filename = this._findFileByStem(CUSTOM_STEM, ALLOWED_AUDIO_EXTENSIONS);
		if (!filename) {
			return null;
		}
		const metadata = this._readMetadata();
		return {
			id: CUSTOM_RINGTONE_ID,
			name: metadata.name?.trim() || 'Custom Audio',
			description: 'Imported from your local machine',
			// allow-any-unicode-next-line
			emoji: '🔊',
			...(metadata.thumbnailUrl ? { thumbnailUrl: metadata.thumbnailUrl } : {}),
		};
	}

	async getCustomEditState(): Promise<IParadisRingtoneEditState | null> {
		return this._readMetadata().editState ?? null;
	}

	async importCustomAudio(sourceFsPath: string): Promise<IParadisCustomRingtoneInfo> {
		const ext = extname(sourceFsPath).toLowerCase();
		if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
			// allow-any-unicode-next-line
			throw new Error('.mp3、.wav、.ogg のみサポートしています');
		}
		const stat = statSync(sourceFsPath);
		if (!stat.isFile()) {
			// allow-any-unicode-next-line
			throw new Error('指定されたパスはファイルではありません');
		}
		if (stat.size > PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES) {
			// allow-any-unicode-next-line
			throw new Error(`音源ファイルが大きすぎます (${Math.round(stat.size / 1024 / 1024)}MB)。最大20MBです。`);
		}

		this._ensureAssetsDir();
		const destination = join(this._assetsDir, `${CUSTOM_STEM}${ext}`);
		const displayName = basename(sourceFsPath).replace(/\.[^/.]+$/, '').trim().slice(0, 80) || 'Custom Audio';

		const tempPath = join(this._assetsDir, `.tmp-${CUSTOM_STEM}-${randomUUID()}${ext}`);
		try {
			await copyFile(sourceFsPath, tempPath);
			this._removeFilesByStem(CUSTOM_STEM);
			await rename(tempPath, destination);
		} catch (error) {
			await unlink(tempPath).catch(() => { /* ignore */ });
			throw error;
		}
		try {
			chmodSync(destination, 0o600);
		} catch {
			// best effort
		}
		// 直接インポートはYouTube由来ではないため再編集用ソース・editStateは残さない。
		this._removeSourceFiles();
		this._writeMetadata(displayName, Date.now());

		// allow-any-unicode-next-line
		return { id: CUSTOM_RINGTONE_ID, name: displayName, description: 'Imported from your local machine', emoji: '🔊' };
	}

	async deleteCustomAudio(): Promise<void> {
		this._removeFilesByStem(CUSTOM_STEM);
		this._removeSourceFiles();
		if (existsSync(this._metadataPath)) {
			try {
				unlinkSync(this._metadataPath);
			} catch {
				// best effort
			}
		}
	}

	async renameCustomAudio(name: string): Promise<IParadisCustomRingtoneInfo> {
		const existing = await this.getCustomRingtoneInfo();
		if (!existing) {
			// allow-any-unicode-next-line
			throw new Error('カスタム音源が見つかりません');
		}
		const displayName = name.trim().slice(0, 80) || 'Custom Audio';
		const metadata = this._readMetadata();
		this._writeMetadata(displayName, metadata.importedAt ?? Date.now(), metadata.thumbnailUrl, metadata.editState, metadata.sourceUrl);
		return { ...existing, name: displayName };
	}

	async readCustomAudioFile(): Promise<{ base64: string; mimeType: string } | null> {
		const filename = this._findFileByStem(CUSTOM_STEM, ALLOWED_AUDIO_EXTENSIONS);
		if (!filename) {
			return null;
		}
		const filePath = join(this._assetsDir, filename);
		const buffer = await readFile(filePath);
		return { base64: buffer.toString('base64'), mimeType: mimeTypeFor(filePath) };
	}

	// --- 再編集用ソース保存 ---------------------------------------------------------------------

	private _removeSourceFiles(): void {
		if (!existsSync(this._assetsDir)) {
			return;
		}
		for (const file of readdirSync(this._assetsDir)) {
			if (file.startsWith(`${CUSTOM_SOURCE_STEM}.`)) {
				try {
					unlinkSync(join(this._assetsDir, file));
				} catch {
					// best effort
				}
			}
		}
	}

	private _getCustomSourcePath(): string | null {
		const filename = this._findFileByStem(CUSTOM_SOURCE_STEM, ALLOWED_SOURCE_EXTENSIONS);
		return filename ? join(this._assetsDir, filename) : null;
	}

	private async _saveCustomSource(sourcePath: string): Promise<void> {
		this._ensureAssetsDir();
		const ext = extname(sourcePath).toLowerCase();
		const destination = join(this._assetsDir, `${CUSTOM_SOURCE_STEM}${ext}`);
		const tempPath = join(this._assetsDir, `.tmp-${CUSTOM_SOURCE_STEM}-${randomUUID()}${ext}`);
		try {
			await copyFile(sourcePath, tempPath);
			this._removeSourceFiles();
			await rename(tempPath, destination);
		} catch (error) {
			await unlink(tempPath).catch(() => { /* ignore */ });
			throw error;
		}
		try {
			chmodSync(destination, 0o600);
		} catch {
			// best effort
		}
	}

	// === YouTube取込 =============================================================================

	private async _getShellPath(): Promise<string> {
		// macOS/Linux の GUI アプリはログインシェルのPATHを継承しないことがあるため、
		// ログインシェル経由でPATHを取得してフォールバックに使う（HomebrewやNVM等のPATH拡張対策）。
		if (process.platform === 'win32') {
			return process.env.PATH ?? '';
		}
		const shell = process.env.SHELL || '/bin/zsh';
		return new Promise<string>(resolve => {
			const timer = setTimeout(() => resolve(process.env.PATH ?? ''), 3000);
			execFile(shell, ['-ilc', 'echo -n "$PATH"'], { timeout: 3000 }, (error, stdout) => {
				clearTimeout(timer);
				resolve(!error && stdout.trim() ? stdout.trim() : (process.env.PATH ?? ''));
			});
		});
	}

	private async _resolveBinaryEnv(): Promise<NodeJS.ProcessEnv> {
		const shellPath = await this._getShellPath();
		// `~/.deno/bin` は deno の公式インストーラの既定の置き場所（yt-dlp が deno を見つけられるよう PATH にも足す）。
		const fallbackDirs = process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/usr/sbin', '/bin', '/sbin', join(homedir(), '.deno', 'bin')];
		const entries = new Set(shellPath.split(delimiter).filter(Boolean));
		for (const dir of fallbackDirs) {
			entries.add(dir);
		}
		return { ...process.env, PATH: [...entries].join(delimiter) };
	}

	private async _resolveBinaryPath(binary: string, env: NodeJS.ProcessEnv): Promise<string | null> {
		const pathValue = env.PATH ?? '';
		for (const dir of pathValue.split(delimiter)) {
			if (!dir) {
				continue;
			}
			const candidate = join(dir, process.platform === 'win32' ? `${binary}.exe` : binary);
			if (existsSync(candidate) && statSync(candidate).isFile()) {
				return candidate;
			}
		}
		return null;
	}

	private async _resolveRequiredBinaries(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
		const missing = await this._checkRequiredBinaries(env);
		if (missing.missing.length > 0) {
			// allow-any-unicode-next-line
			throw new Error(`必要なツールが見つかりません: ${missing.missing.join(', ')}。\`brew install yt-dlp ffmpeg\`（macOS、ffprobeはffmpegに同梱）またはお使いのパッケージマネージャでインストールしてください。`);
		}
		const resolved: Record<string, string> = {};
		for (const binary of REQUIRED_BINARIES) {
			resolved[binary] = (await this._resolveBinaryPath(binary, env))!;
		}
		return resolved;
	}

	private async _checkRequiredBinaries(env: NodeJS.ProcessEnv): Promise<{ missing: string[] }> {
		const missing: string[] = [];
		for (const binary of REQUIRED_BINARIES) {
			if (!(await this._resolveBinaryPath(binary, env))) {
				missing.push(binary);
			}
		}
		return { missing };
	}

	/**
	 * 取り込みの前の確認。欠けている必須のツールに加え、無いと一部の動画が取れなくなる deno と、yt-dlp の版
	 * （既知の壊れた版か・古すぎるか、入れ方に応じた更新の手段）を返す。
	 */
	async checkYtDlp(): Promise<IParadisYtDlpCheckResult> {
		const env = await this._resolveBinaryEnv();
		const { missing } = await this._checkRequiredBinaries(env);
		const optionalMissing: string[] = [];
		for (const binary of OPTIONAL_BINARIES) {
			if (!(await this._resolveBinaryPath(binary, env))) {
				optionalMissing.push(binary);
			}
		}
		const ytDlp = await this._getYtDlpStatus(env);
		return { missing, optionalMissing, ...(ytDlp ? { ytDlp } : {}) };
	}

	private async _getYtDlpStatus(env: NodeJS.ProcessEnv): Promise<IParadisYtDlpStatus | undefined> {
		const binaryPath = await this._resolveBinaryPath('yt-dlp', env);
		if (!binaryPath) {
			return undefined;
		}
		let output: string;
		try {
			output = await this._runProcess(binaryPath, ['--version'], tmpdir(), env, YT_DLP_VERSION_TIMEOUT_MS);
		} catch (error) {
			this.logService.warn(`[ParadisNotifications] yt-dlp --version failed: ${getErrorMessage(error)}`);
			return undefined;
		}
		const version = paradisParseYtDlpVersion(output);
		if (!version) {
			this.logService.warn(`[ParadisNotifications] could not read the yt-dlp version from ${JSON.stringify(output.slice(0, 80))}`);
			return undefined;
		}
		const assessment = paradisAssessYtDlpVersion(version, Date.now());
		const [realPath, head] = this._readBinaryIdentity(binaryPath);
		const installMethod = paradisDetectYtDlpInstallMethod(realPath, head);
		return { version: version.raw, status: assessment.status, ageDays: assessment.ageDays, installMethod, update: paradisYtDlpUpdatePlan(installMethod) };
	}

	/** 実行ファイルのシンボリックリンクを解いた実体のパスと、先頭 512 バイト（入れ方の見分けに使う）。 */
	private _readBinaryIdentity(binaryPath: string): [string, string] {
		let realPath = binaryPath;
		try {
			realPath = realpathSync(binaryPath);
		} catch {
			// 解けなければ見つけたパスのまま
		}
		let head = '';
		try {
			const fd = openSync(realPath, 'r');
			try {
				const buffer = Buffer.alloc(512);
				const read = readSync(fd, buffer, 0, buffer.length, 0);
				head = buffer.subarray(0, read).toString('latin1');
			} finally {
				closeSync(fd);
			}
		} catch {
			// 読めなければパスだけで見分ける
		}
		return [realPath, head];
	}

	private _appendInstallLog(installId: string, level: IParadisInstallLogLine['level'], message: string): void {
		const state = this._installStates.get(installId);
		if (!state) {
			return;
		}
		for (const line of message.split(/\r?\n/)) {
			const trimmed = line.trimEnd();
			if (!trimmed) {
				continue;
			}
			state.lines.push({ seq: state.nextSeq++, time: Date.now(), level, message: trimmed });
			if (state.lines.length > 1000) {
				state.lines.splice(0, state.lines.length - 1000);
			}
		}
	}

	private _beginInstallState(installId: string): void {
		// 通常は同時1件だが、ダイアログを閉じるとポーリングが止まり done 済みエントリが
		// 残り続ける（ログ最大1000行分）。少数上限に達したら done 済みのうち最も古いものを
		// 優先して破棄し、done が一つも無ければ最も古いもの（アクティブなものも含む）を
		// 破棄する（その installId のポーリングは unknown-id 契約に乗る）。
		while (this._installStates.size >= PARADIS_MAX_INSTALL_STATES) {
			let victim: string | undefined;
			for (const [key, value] of this._installStates) {
				if (value.done) {
					victim = key;
					break;
				}
			}
			victim ??= this._installStates.keys().next().value;
			if (victim === undefined) {
				break;
			}
			this._installStates.delete(victim);
		}
		this._installStates.set(installId, { lines: [], done: false, nextSeq: 1 });
	}

	private _finishInstallWithError(installId: string, message: string): void {
		this._appendInstallLog(installId, 'error', message);
		const state = this._installStates.get(installId);
		if (state) {
			state.done = true;
			state.error = message;
		}
	}

	async installYtDlp(installId: string): Promise<void> {
		this._beginInstallState(installId);

		if (process.platform !== 'darwin') {
			// allow-any-unicode-next-line
			const message = 'Homebrewによる自動インストールはmacOSのみ対応しています。yt-dlpとffmpegを手動でインストールしてください。';
			this._appendInstallLog(installId, 'error', message);
			const state = this._installStates.get(installId)!;
			state.done = true;
			state.error = message;
			return;
		}

		const env = await this._resolveBinaryEnv();
		const brewPath = await this._resolveBinaryPath('brew', env);
		if (!brewPath) {
			// allow-any-unicode-next-line
			const message = 'Homebrewがインストールされていません。https://brew.sh からインストールしてから、yt-dlpとffmpegをインストールしてください。';
			this._appendInstallLog(installId, 'error', message);
			const state = this._installStates.get(installId)!;
			state.done = true;
			state.error = message;
			return;
		}

		this._spawnLoggedCommand(installId, brewPath, ['install', 'yt-dlp', 'ffmpeg'], env, 'brew install',
			// allow-any-unicode-next-line
			'インストールが完了しました。');
	}

	/**
	 * yt-dlp を、入れ方に応じた手段で更新する（設定画面で利用者が「更新」を押したときだけ呼ばれる）。出力は
	 * インストールと同じく getInstallLog で読ませる。pip で入れたものと入れ方が分からないものは実行しない。
	 */
	async updateYtDlp(installId: string): Promise<void> {
		this._beginInstallState(installId);
		const env = await this._resolveBinaryEnv();
		const status = await this._getYtDlpStatus(env);
		if (!status || !status.update.runnable) {
			this._finishInstallWithError(installId, status?.installMethod === 'pip'
				// allow-any-unicode-next-line
				? `pip で入れた yt-dlp は Para Code から更新できません。yt-dlp を入れた Python の pip で更新してください（例: ${status.update.command}）。`
				// allow-any-unicode-next-line
				: 'yt-dlp の入れ方が分からないため更新できません。入れたときの方法で更新してください。');
			return;
		}
		const [program, ...args] = status.update.command.split(' ');
		const programPath = await this._resolveBinaryPath(program, env);
		if (!programPath) {
			// allow-any-unicode-next-line
			this._finishInstallWithError(installId, `${program} が見つかりません。ターミナルで「${status.update.command}」を実行してください。`);
			return;
		}
		this._spawnLoggedCommand(installId, programPath, args, env, status.update.command,
			// allow-any-unicode-next-line
			'更新が完了しました。');
	}

	private _spawnLoggedCommand(installId: string, programPath: string, args: string[], env: NodeJS.ProcessEnv, label: string, doneMessage: string): void {
		this._appendInstallLog(installId, 'info', `$ ${programPath} ${args.join(' ')}`);

		// fire-and-forget: 呼び出し元はgetInstallLogでポーリングする。
		const proc = spawn(programPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
		const timer = setTimeout(() => proc.kill('SIGKILL'), 600_000);
		proc.stdout?.on('data', (chunk: Buffer) => this._appendInstallLog(installId, 'info', chunk.toString()));
		proc.stderr?.on('data', (chunk: Buffer) => this._appendInstallLog(installId, 'info', chunk.toString()));
		proc.on('error', error => {
			clearTimeout(timer);
			const state = this._installStates.get(installId);
			if (state) {
				state.done = true;
				// allow-any-unicode-next-line
				state.error = `${label} の起動に失敗しました: ${error.message}`;
				this._appendInstallLog(installId, 'error', state.error);
			}
		});
		proc.on('exit', code => {
			clearTimeout(timer);
			const state = this._installStates.get(installId);
			if (!state) {
				return;
			}
			state.done = true;
			if (code === 0) {
				this._appendInstallLog(installId, 'info', doneMessage);
			} else {
				// allow-any-unicode-next-line
				state.error = `${label} がコード ${code ?? '?'} で終了しました`;
				this._appendInstallLog(installId, 'error', state.error);
			}
		});
	}

	async getInstallLog(installId: string, afterSeq: number): Promise<IParadisInstallLogResult> {
		const state = this._installStates.get(installId);
		if (!state) {
			return { lines: [], done: true, error: 'unknown installId' };
		}
		const result: IParadisInstallLogResult = { lines: state.lines.filter(l => l.seq > afterSeq), done: state.done, error: state.error };
		if (state.done) {
			// 完了ログ（最大1000行）を返し切ったので、shared process に残さず破棄する。
			// UIは done を受け取るとポーリングを止めるため、これ以降 getInstallLog は呼ばれない。
			this._installStates.delete(installId);
		}
		return result;
	}

	private async _runProcess(binaryPath: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
		return (await this._runProcessWithStderr(binaryPath, args, cwd, env, timeoutMs)).stdout;
	}

	/** _runProcess と同じだが、標準エラーも返す。失敗したときは {@link ParadisProcessError} に標準エラーの全文を載せる。 */
	private _runProcessWithStderr(binaryPath: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			const proc: ChildProcess = spawn(binaryPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '';
			let stderr = '';
			proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
			proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
			const timer = setTimeout(() => {
				proc.kill('SIGKILL');
				// allow-any-unicode-next-line
				reject(new ParadisProcessError('処理がタイムアウトしました', stderr));
			}, timeoutMs);
			proc.on('error', error => {
				clearTimeout(timer);
				// allow-any-unicode-next-line
				reject(new Error(`プロセスの起動に失敗しました: ${error.message}`));
			});
			proc.on('exit', code => {
				clearTimeout(timer);
				if (code === 0) {
					resolve({ stdout, stderr });
				} else {
					// allow-any-unicode-next-line
					reject(new ParadisProcessError(stderr.trim().split('\n').slice(-3).join('\n') || `プロセスがコード ${code ?? '?'} で終了しました`, stderr, code ?? undefined));
				}
			});
		});
	}

	private _findProducedAudio(workDir: string): string | null {
		if (!existsSync(workDir)) {
			return null;
		}
		const candidates = readdirSync(workDir)
			.filter(name => OUTPUT_EXTENSIONS.has(extname(name).toLowerCase()))
			.map(name => join(workDir, name))
			.filter(p => { try { return statSync(p).isFile() && statSync(p).size > 0; } catch { return false; } });
		if (candidates.length === 0) {
			return null;
		}
		candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
		return candidates[0] ?? null;
	}

	async downloadYouTubeAudio(url: string): Promise<IParadisYouTubeDownloadResult> {
		const trimmed = url.trim();
		if (!/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)[\w-]+|youtu\.be\/[\w-]+)/i.test(trimmed)) {
			// allow-any-unicode-next-line
			throw new Error('有効なYouTube URL (youtube.com または youtu.be) を入力してください。');
		}

		const env = await this._resolveBinaryEnv();
		const resolved = await this._resolveRequiredBinaries(env);
		const ffmpegDir = dirname(resolved.ffmpeg);
		const pathEntries = (env.PATH ?? '').split(delimiter).filter(Boolean);
		if (!pathEntries.includes(ffmpegDir)) {
			pathEntries.unshift(ffmpegDir);
		}
		const spawnEnv: NodeJS.ProcessEnv = { ...env, PATH: pathEntries.join(delimiter) };

		const workDir = await mkdtemp(join(tmpdir(), 'paradis-ytfull-'));
		const outputTemplate = join(workDir, 'audio.%(ext)s');

		const args = [
			// 警告は捨てずに拾う（古い版・JS ランタイムの欠け・署名の解読失敗などの壊れる前兆が出る）。
			'--no-playlist',
			// `--match-filter` だけだと、長すぎる動画は終了コード 0 で黙って飛ばされる（`--print-json` で理由の行も出ない）。
			// `--break-match-filters` なら終了コード 101 で止まるので、長さの超過と見分けられる。
			'--break-match-filters', `duration <= ${MAX_FULL_DOWNLOAD_DURATION_SECONDS}`,
			'-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
			'--concurrent-fragments', '5',
			'--ffmpeg-location', ffmpegDir,
			'--print-json', '--no-simulate',
			'-o', outputTemplate,
			trimmed,
		];

		let info: { title: string; thumbnailUrl: string; durationSeconds: number };
		let stderr = '';
		try {
			const output = await this._runProcessWithStderr(resolved['yt-dlp'], args, workDir, spawnEnv, FULL_DOWNLOAD_TIMEOUT_MS);
			const jsonOutput = output.stdout;
			stderr = output.stderr;
			const lastJsonLine = jsonOutput.split('\n').map(l => l.trim()).filter(l => l.startsWith('{') && l.endsWith('}')).pop();
			const data = lastJsonLine ? JSON.parse(lastJsonLine) as { title?: string; duration?: number; thumbnail?: string } : {};
			info = { title: data.title?.trim() || 'YouTube Video', thumbnailUrl: data.thumbnail || '', durationSeconds: data.duration ?? 0 };
		} catch (error) {
			await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
			const message = error instanceof Error ? error.message : String(error);
			const fullStderr = error instanceof ParadisProcessError ? error.stderr : message;
			this._logYtDlpWarnings(fullStderr);
			const reason = paradisClassifyYtDlpError(fullStderr, error instanceof ParadisProcessError ? error.exitCode : undefined);
			if (reason === 'unknown') {
				throw error;
			}
			this.logService.warn(`[ParadisNotifications] yt-dlp failed (${reason}): ${message}`);
			const ytDlp = reason === 'forbidden' || reason === 'noFormats' ? await this._getYtDlpStatus(env).catch(() => undefined) : undefined;
			throw new Error(this._youTubeFailureMessage(reason, ytDlp));
		}

		const { precursors } = this._logYtDlpWarnings(stderr);
		const producedPath = this._findProducedAudio(workDir);
		if (!producedPath) {
			await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
			// 「非公開」と決めつけない。理由が分からないときは、まず yt-dlp の更新を勧める。
			// allow-any-unicode-next-line
			throw new Error('yt-dlpが音源を生成できませんでした。yt-dlp を更新してから、もう一度試してください。');
		}

		const tempId = randomUUID();
		this._tempAudio.set(tempId, { path: producedPath, dir: workDir });
		return { tempId, info, ...(precursors.length > 0 ? { precursors } : {}) };
	}

	/** yt-dlp の警告の行をログへ出し、壊れる前兆を返す。 */
	private _logYtDlpWarnings(stderr: string): ReturnType<typeof paradisExtractYtDlpWarnings> {
		const warnings = paradisExtractYtDlpWarnings(stderr);
		for (const line of warnings.lines.slice(0, 20)) {
			this.logService.warn(`[ParadisNotifications] yt-dlp: ${line}`);
		}
		return warnings;
	}

	/** yt-dlp の失敗の理由を、利用者に見せる文に変える。403 は非公開ではなく、版の古さを疑わせる。 */
	private _youTubeFailureMessage(reason: Exclude<ParadisYtDlpFailure, 'unknown'>, ytDlp?: IParadisYtDlpStatus): string {
		// 画面はこの文をそのまま文字として出すので、コマンドはバックティックではなく「」で囲む。
		const updateHint = !ytDlp?.update.command
			? ''
			: ytDlp.installMethod === 'pip'
				// allow-any-unicode-next-line
				? `（いまの版は ${ytDlp.version}。yt-dlp を入れた Python の pip で更新してください）`
				// allow-any-unicode-next-line
				: `（いまの版は ${ytDlp.version}。更新は「${ytDlp.update.command}」）`;
		switch (reason) {
			// allow-any-unicode-next-line
			case 'forbidden': return `YouTube が取得を拒みました (HTTP 403)。動画が非公開なのではなく、yt-dlp が YouTube の変更に追いついていないことがほとんどです。yt-dlp を更新してから、もう一度試してください${updateHint}。`;
			// allow-any-unicode-next-line
			case 'botCheck': return 'YouTube がロボットではない確認を求めたため取得できませんでした。時間をおいて試すか、yt-dlp を更新してください。';
			// allow-any-unicode-next-line
			case 'ageRestricted': return '年齢制限のある動画のため取得できませんでした。';
			// allow-any-unicode-next-line
			case 'membersOnly': return 'メンバー限定の動画のため取得できませんでした。';
			// allow-any-unicode-next-line
			case 'private': return '非公開の動画のため取得できませんでした。';
			// allow-any-unicode-next-line
			case 'unavailable': return 'この動画は削除されたか、見られない状態です。';
			// allow-any-unicode-next-line
			case 'liveNotStarted': return 'まだ始まっていないライブ配信・プレミア公開のため取得できませんでした。';
			// allow-any-unicode-next-line
			case 'tooLong': return `動画が長すぎます。最大 ${MAX_FULL_DOWNLOAD_DURATION_SECONDS / 60} 分までです。`;
			// allow-any-unicode-next-line
			case 'noFormats': return `取り込める音声の形式が見つかりませんでした。deno を入れていない場合は入れ、yt-dlp を更新してから、もう一度試してください${updateHint}。`;
			// allow-any-unicode-next-line
			case 'network': return 'YouTube に接続できませんでした。ネットワークの接続を確かめてください。';
		}
	}

	async readTempAudioFile(tempId: string): Promise<{ base64: string; mimeType: string } | null> {
		const entry = this._tempAudio.get(tempId);
		if (!entry) {
			return null;
		}
		const buffer = await readFile(entry.path);
		return { base64: buffer.toString('base64'), mimeType: mimeTypeFor(entry.path) };
	}

	async cleanupTempAudio(tempId: string): Promise<void> {
		const entry = this._tempAudio.get(tempId);
		this._tempAudio.delete(tempId);
		if (entry) {
			await rm(entry.dir, { recursive: true, force: true }).catch(() => { /* ignore */ });
		}
	}

	/**
	 * リモート音声（Aivisモデルのサンプル音声等）を取得してbase64で返す。renderer側の
	 * workbench CSP (`media-src`) は `<audio>` の再生元として https を許可していないため、
	 * shared process 側でバイト列を取得し、rendererはBlob URL化して再生する
	 * （カスタム音源のreadCustomAudioFileと同じパターン）。https以外・サイズ超過・タイムアウトは
	 * すべて null を返す（呼び出し元は再生をスキップする想定）。
	 */
	async fetchAudio(url: string): Promise<{ base64: string; mimeType: string } | null> {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return null;
		}
		if (parsed.protocol !== 'https:') {
			// allow-any-unicode-next-line
			this.logService.warn(`[ParadisNotifications] fetchAudio: https以外のURLは許可していません (${parsed.protocol})`);
			return null;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_AUDIO_TIMEOUT_MS);
		try {
			const response = await fetch(parsed, { signal: controller.signal });
			if (!response.ok) {
				this.logService.warn(`[ParadisNotifications] fetchAudio: HTTP ${response.status} (${url})`);
				return null;
			}
			const contentLength = Number(response.headers.get('content-length') ?? '0');
			if (contentLength > PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES) {
				// allow-any-unicode-next-line
				this.logService.warn(`[ParadisNotifications] fetchAudio: レスポンスが大きすぎます (${contentLength} bytes)`);
				return null;
			}
			const buffer = Buffer.from(await response.arrayBuffer());
			if (buffer.byteLength > PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES) {
				// allow-any-unicode-next-line
				this.logService.warn(`[ParadisNotifications] fetchAudio: レスポンスが大きすぎます (${buffer.byteLength} bytes)`);
				return null;
			}
			const contentType = response.headers.get('content-type');
			const mimeType = contentType?.startsWith('audio/') ? contentType.split(';')[0].trim() : mimeTypeFor(parsed.pathname);
			return { base64: buffer.toString('base64'), mimeType };
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				// allow-any-unicode-next-line
				this.logService.warn(`[ParadisNotifications] fetchAudio: タイムアウトしました (${url})`);
			} else {
				this.logService.warn(`[ParadisNotifications] fetchAudio failed (${url})`, error);
			}
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Myinstants の mp3 の直リンクを 1 回だけ取得し、一時音源として持つ（試聴は readTempAudioFile、保存は
	 * importMyinstantsAudio）。fetchAudio と違い、取りに行く先を `paradisCheckMyinstantsUrl` の形に絞る。
	 * リダイレクトは自分で追い、追う先も同じ形を満たすものに限る。Content-Type と先頭のバイト列で mp3 を確かめ、
	 * ファイルからの取り込みと同じ大きさの上限と、15 秒の打ち切りを掛ける。失敗は理由つきで返す（例外にしない）。
	 */
	async downloadMyinstantsAudio(url: string): Promise<IParadisMyinstantsDownloadResult> {
		const check = paradisCheckMyinstantsUrl(url);
		if (check.kind === 'page') {
			return { ok: false, reason: 'pageUrl' };
		}
		if (check.kind !== 'mp3') {
			return { ok: false, reason: 'invalidUrl' };
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_AUDIO_TIMEOUT_MS);
		let workDir: string | undefined;
		try {
			let current = check;
			let response: Response;
			for (let redirects = 0; ; redirects++) {
				response = await fetch(current.url, { signal: controller.signal, redirect: 'manual' });
				if (response.status < 300 || response.status >= 400) {
					break;
				}
				await response.body?.cancel().catch(() => { /* ignore */ });
				const location = response.headers.get('location');
				let next: string | undefined;
				try {
					next = location ? new URL(location, current.url).toString() : undefined;
				} catch {
					next = undefined;
				}
				const nextCheck = next !== undefined ? paradisCheckMyinstantsUrl(next) : undefined;
				if (redirects >= MYINSTANTS_MAX_REDIRECTS || nextCheck?.kind !== 'mp3') {
					this.logService.warn(`[ParadisNotifications] downloadMyinstantsAudio: refused a redirect from ${current.url}`);
					return { ok: false, reason: 'redirect' };
				}
				current = nextCheck;
			}

			if (!response.ok) {
				await response.body?.cancel().catch(() => { /* ignore */ });
				this.logService.warn(`[ParadisNotifications] downloadMyinstantsAudio: HTTP ${response.status} (${current.url})`);
				if (response.status === 404 || response.status === 410) {
					return { ok: false, reason: 'notFound', status: response.status };
				}
				if (response.status === 403) {
					return { ok: false, reason: 'blocked', status: response.status };
				}
				return { ok: false, reason: 'http', status: response.status };
			}
			if (!paradisIsMp3ContentType(response.headers.get('content-type'))) {
				await response.body?.cancel().catch(() => { /* ignore */ });
				return { ok: false, reason: 'notMp3' };
			}
			const contentLength = Number(response.headers.get('content-length') ?? '0');
			if (contentLength > PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES) {
				await response.body?.cancel().catch(() => { /* ignore */ });
				return { ok: false, reason: 'tooLarge' };
			}

			const chunks: Buffer[] = [];
			let size = 0;
			// 先頭のバイト列は、16 バイトそろった時点で確かめる（mp3 でなければ残りを読まずにやめる）。
			let headChecked = false;
			const reader = response.body?.getReader();
			while (reader) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				size += value.byteLength;
				if (size > PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES) {
					await reader.cancel().catch(() => { /* ignore */ });
					return { ok: false, reason: 'tooLarge' };
				}
				chunks.push(Buffer.from(value));
				if (!headChecked && size >= 16) {
					headChecked = true;
					if (!paradisLooksLikeMp3(Buffer.concat(chunks, size).subarray(0, 16))) {
						await reader.cancel().catch(() => { /* ignore */ });
						return { ok: false, reason: 'notMp3' };
					}
				}
			}
			const buffer = Buffer.concat(chunks, size);
			if (!headChecked && !paradisLooksLikeMp3(buffer)) {
				return { ok: false, reason: 'notMp3' };
			}

			workDir = await mkdtemp(join(tmpdir(), 'paradis-myinstants-'));
			const audioPath = join(workDir, 'audio.mp3');
			await writeFile(audioPath, buffer, { mode: 0o600 });
			const tempId = randomUUID();
			this._tempAudio.set(tempId, { path: audioPath, dir: workDir, myinstantsSourceUrl: current.url });
			workDir = undefined;
			return {
				ok: true,
				tempId,
				sourceUrl: current.url,
				fileName: current.fileName,
				sizeBytes: buffer.byteLength,
				suggestedName: paradisMyinstantsDisplayName(current.fileName),
			};
		} catch (error) {
			if (controller.signal.aborted) {
				// allow-any-unicode-next-line
				this.logService.warn(`[ParadisNotifications] downloadMyinstantsAudio: タイムアウトしました (${check.url})`);
				return { ok: false, reason: 'timeout' };
			}
			this.logService.warn(`[ParadisNotifications] downloadMyinstantsAudio failed (${check.url})`, error);
			return { ok: false, reason: 'network' };
		} finally {
			clearTimeout(timer);
			if (workDir) {
				await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
			}
		}
	}

	/**
	 * downloadMyinstantsAudio が持った一時音源を、カスタム音源の 1 枠へ上書きで保存する（ファイルからの取り込みと
	 * 同じ importCustomAudio を通す）。出典は shared process が取得時に控えた URL を使い、renderer からは受け取らない。
	 */
	async importMyinstantsAudio(tempId: string, displayName: string): Promise<IParadisCustomRingtoneInfo> {
		const entry = this._tempAudio.get(tempId);
		if (!entry?.myinstantsSourceUrl) {
			// allow-any-unicode-next-line
			throw new Error('取り込む音源が見つかりません。もう一度読み込んでください。');
		}
		await this.importCustomAudio(entry.path);
		const name = displayName.trim().slice(0, 80) || paradisMyinstantsDisplayName(basename(new URL(entry.myinstantsSourceUrl).pathname));
		this._writeMetadata(name, Date.now(), undefined, undefined, entry.myinstantsSourceUrl);
		await this.cleanupTempAudio(tempId);
		return (await this.getCustomRingtoneInfo())!;
	}

	async renderClip(request: IParadisRenderClipRequest): Promise<IParadisCustomRingtoneInfo> {
		const inputPath = request.tempId ? this._tempAudio.get(request.tempId)?.path : this._getCustomSourcePath() ?? undefined;
		if (!inputPath) {
			// allow-any-unicode-next-line
			throw new Error('編集元の音源が見つかりません。YouTubeから再度取り込んでください。');
		}

		const startSeconds = Math.max(0, request.startSeconds);
		const endSeconds = request.endSeconds;
		const playbackRate = Math.max(0.5, Math.min(2.0, request.playbackRate ?? 1.0));
		const rawDuration = endSeconds - startSeconds;
		const outputDuration = rawDuration / playbackRate;

		if (!Number.isFinite(rawDuration) || rawDuration <= 0) {
			// allow-any-unicode-next-line
			throw new Error('終了時刻は開始時刻より後にしてください。');
		}
		if (outputDuration > PARADIS_MAX_CLIP_DURATION_SECONDS) {
			// allow-any-unicode-next-line
			throw new Error(`出力クリップの長さ (${outputDuration.toFixed(1)}秒) が上限の ${PARADIS_MAX_CLIP_DURATION_SECONDS}秒を超えています。`);
		}

		const env = await this._resolveBinaryEnv();
		const resolved = await this._resolveRequiredBinaries(env);
		const workDir = await mkdtemp(join(tmpdir(), 'paradis-ytclip-'));

		try {
			const filters: string[] = [];
			if (playbackRate !== 1.0) {
				filters.push(`atempo=${playbackRate.toFixed(3)}`);
			}
			const fadeIn = request.fadeInSeconds ?? 0;
			const fadeOut = request.fadeOutSeconds ?? 0;
			if (fadeIn > 0) {
				filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
			}
			if (fadeOut > 0) {
				filters.push(`afade=t=out:st=${Math.max(0, outputDuration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
			}

			const outputPath = join(workDir, `output_${randomUUID()}.mp3`);
			const ffmpegArgs = ['-ss', startSeconds.toFixed(3), '-i', inputPath, '-t', rawDuration.toFixed(3)];
			if (filters.length > 0) {
				ffmpegArgs.push('-af', filters.join(','));
			}
			ffmpegArgs.push('-acodec', 'libmp3lame', '-q:a', '5', '-y', outputPath);

			await this._runProcess(resolved.ffmpeg, ffmpegArgs, workDir, env, YT_DLP_TIMEOUT_MS);

			const result = await this.importCustomAudio(outputPath);
			const displayName = request.displayName?.trim().slice(0, 80);
			if (displayName) {
				await this.renameCustomAudio(displayName);
			}
			if (request.thumbnailUrl) {
				const metadata = this._readMetadata();
				this._writeMetadata(metadata.name ?? result.name, metadata.importedAt ?? Date.now(), request.thumbnailUrl, metadata.editState);
			}

			// 再編集用にソース音源と編集パラメータを保存する。
			await this._saveCustomSource(inputPath);
			const metadata = this._readMetadata();
			this._writeMetadata(metadata.name ?? result.name, metadata.importedAt ?? Date.now(), metadata.thumbnailUrl, {
				startSeconds, endSeconds, fadeInSeconds: request.fadeInSeconds, fadeOutSeconds: request.fadeOutSeconds,
				playbackRate, sourceTitle: request.sourceTitle, sourceUrl: request.sourceUrl,
			});

			return (await this.getCustomRingtoneInfo())!;
		} finally {
			await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
		}
	}

	// === Aivis Cloud API =========================================================================

	private async _aivisFetch(path: string, apiKey: string, init: { method?: string; query?: Record<string, string | number | boolean | undefined>; json?: unknown; accept?: string } = {}): Promise<Response> {
		const url = new URL(path, AIVIS_BASE_URL);
		for (const [key, value] of Object.entries(init.query ?? {})) {
			if (value !== undefined) {
				url.searchParams.set(key, String(value));
			}
		}
		const headers: Record<string, string> = { Accept: init.accept ?? 'application/json' };
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}
		let body: string | undefined;
		if (init.json !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(init.json);
		}
		const response = await fetch(url, { method: init.method ?? 'GET', headers, body });
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new AivisApiError(response.status, text);
		}
		return response;
	}

	private async _aivisJson<T>(path: string, apiKey: string, init?: Parameters<ParadisNotificationsService['_aivisFetch']>[2]): Promise<T> {
		const response = await this._aivisFetch(path, apiKey, init);
		return response.json() as Promise<T>;
	}

	async getAivisModel(apiKey: string, uuid: string): Promise<IParadisAivisModelSummary | null> {
		interface AivmStyle { voice_samples?: { audio_url?: string | null }[] }
		interface AivmSpeaker { icon_url?: string | null; styles?: AivmStyle[] }
		interface AivmResponse { aivm_model_uuid: string; name: string; description?: string; user?: { name?: string; handle?: string; icon_url?: string | null }; speakers?: AivmSpeaker[] }
		try {
			const model = await this._aivisJson<AivmResponse>(`/v1/aivm-models/${uuid}`, apiKey);
			const speakerIcon = model.speakers?.[0]?.icon_url ?? null;
			const sampleUrl = model.speakers?.[0]?.styles?.[0]?.voice_samples?.[0]?.audio_url ?? null;
			return {
				uuid: model.aivm_model_uuid, name: model.name, description: model.description ?? '',
				iconUrl: speakerIcon ?? model.user?.icon_url ?? null, sampleUrl,
				authorName: model.user?.name ?? null, authorHandle: model.user?.handle ?? null,
			};
		} catch (error) {
			if (error instanceof AivisApiError && error.status === 404) {
				return null;
			}
			throw this._wrapAivisError(error);
		}
	}

	private _wrapAivisError(error: unknown): Error {
		if (error instanceof AivisApiError) {
			return new Error(error.message);
		}
		return error instanceof Error ? error : new Error(String(error));
	}

	async listAivisDictionaries(apiKey: string): Promise<IParadisAivisDictionaryListItem[]> {
		try {
			const json = await this._aivisJson<{ user_dictionaries: IParadisAivisDictionaryListItem[] }>('/v1/user-dictionaries', apiKey);
			return json.user_dictionaries;
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async getAivisDictionary(apiKey: string, uuid: string): Promise<IParadisAivisDictionaryDetail> {
		try {
			return await this._aivisJson<IParadisAivisDictionaryDetail>(`/v1/user-dictionaries/${uuid}`, apiKey);
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async createAivisDictionary(apiKey: string, name: string, description: string): Promise<{ uuid: string }> {
		const uuid = randomUUID();
		try {
			await this._aivisFetch(`/v1/user-dictionaries/${uuid}`, apiKey, { method: 'PUT', json: { name, description, word_properties: [] } });
			return { uuid };
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async updateAivisDictionary(apiKey: string, uuid: string, name: string, description: string, words: readonly IParadisAivisDictionaryWord[]): Promise<void> {
		try {
			await this._aivisFetch(`/v1/user-dictionaries/${uuid}`, apiKey, { method: 'PUT', json: { name, description, word_properties: words } });
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async deleteAivisDictionary(apiKey: string, uuid: string): Promise<void> {
		try {
			await this._aivisFetch(`/v1/user-dictionaries/${uuid}`, apiKey, { method: 'DELETE' });
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async exportAivisDictionary(apiKey: string, uuid: string): Promise<Record<string, unknown>> {
		try {
			return await this._aivisJson<Record<string, unknown>>(`/v1/user-dictionaries/${uuid}/export`, apiKey);
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async importAivisDictionary(apiKey: string, uuid: string, data: Record<string, unknown>, override: boolean): Promise<void> {
		try {
			await this._aivisFetch(`/v1/user-dictionaries/${uuid}/import`, apiKey, { method: 'POST', query: { override }, json: data });
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async getAivisUsageDaily(apiKey: string, startDate: string, endDate: string): Promise<IParadisAivisUsageResult> {
		interface UsageSummary { api_key_id: string; api_key_name: string; summary_date: string; request_count: number; character_count: number; credit_consumed: number }
		try {
			const json = await this._aivisJson<{ summaries: UsageSummary[] }>('/v1/payment/usage-summaries', apiKey, { query: { start_date: startDate, end_date: endDate } });
			const byDate = new Map<string, { date: string; requestCount: number; characterCount: number; creditConsumed: number; byApiKey: Record<string, { name: string; requestCount: number; characterCount: number; creditConsumed: number }> }>();
			for (const s of json.summaries) {
				const entry = byDate.get(s.summary_date) ?? { date: s.summary_date, requestCount: 0, characterCount: 0, creditConsumed: 0, byApiKey: {} };
				entry.requestCount += s.request_count;
				entry.characterCount += s.character_count;
				entry.creditConsumed += s.credit_consumed;
				const bucket = entry.byApiKey[s.api_key_id] ?? { name: s.api_key_name, requestCount: 0, characterCount: 0, creditConsumed: 0 };
				bucket.requestCount += s.request_count;
				bucket.characterCount += s.character_count;
				bucket.creditConsumed += s.credit_consumed;
				entry.byApiKey[s.api_key_id] = bucket;
				byDate.set(s.summary_date, entry);
			}
			const days: IParadisAivisUsageDayEntry[] = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
			const total = days.reduce((acc, d) => ({
				requestCount: acc.requestCount + d.requestCount,
				characterCount: acc.characterCount + d.characterCount,
				creditConsumed: acc.creditConsumed + d.creditConsumed,
			}), { requestCount: 0, characterCount: 0, creditConsumed: 0 });
			return { days, total };
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async getAivisMe(apiKey: string): Promise<IParadisAivisMeResult> {
		interface UserMeResponse { handle?: string; name?: string; credit_balance?: number }
		try {
			const me = await this._aivisJson<UserMeResponse>('/v1/users/me', apiKey);
			return { handle: me.handle ?? null, name: me.name ?? null, creditBalance: typeof me.credit_balance === 'number' ? me.credit_balance : null };
		} catch (error) {
			throw this._wrapAivisError(error);
		}
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
		if (!existsSync(soundPath)) {
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
