/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process 内で動く ElevenLabs API クライアント。Aivis と同じく呼び出し元（renderer）が
// API キーを持ち、呼び出しごとに引数で渡すステートレスな作り。合成の失敗は AudioScheduler が
// 使う AivisError（エンジンに関係ない3分類）に直して投げる。
// API キーはログ・エラーメッセージに一切含めない。

import { getErrorMessage } from '../../../../base/common/errors.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisElevenLabsDictionaryDetail,
	IParadisElevenLabsDictionaryListItem,
	IParadisElevenLabsModel,
	IParadisElevenLabsRawCharacterStats,
	IParadisElevenLabsRawModel,
	IParadisElevenLabsRawVoice,
	IParadisElevenLabsUsageResult,
	IParadisElevenLabsVoice,
	IParadisPlayElevenLabsRequest,
	paradisClampElevenLabsSpeed,
	paradisClassifyElevenLabsError,
	ParadisElevenLabsRule,
	ParadisElevenLabsSubscriptionResult,
	paradisElevenLabsRetryAfter,
	paradisElevenLabsUsageRange,
	paradisFilterElevenLabsModels,
	paradisIsElevenLabsDictionaryArchived,
	paradisIsElevenLabsMissingPermissions,
	paradisNormalizeElevenLabsRules,
	paradisParseElevenLabsPls,
	paradisStripSsmlTags,
	paradisSummarizeElevenLabsUsage,
	paradisToElevenLabsSubscription,
	paradisToElevenLabsVoice,
	PARADIS_ELEVENLABS_DEFAULT_MODEL_ID,
} from '../common/paradisElevenLabs.js';
import { AivisError, AivisStreamingSynthesis, AivisSynthesizeResult } from './paradisAudioScheduler.js';
import { PARADIS_ELEVENLABS_FIRST_BYTE_TIMEOUT_MS, paradisCollectBody, paradisReadSynthesisBody, ParadisSynthesisTimeouts } from './paradisStreamingBody.js';

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
/** 合成した音声 1 本の上限（読み上げ 1 回分としては十分に大きい）。 */
export const PARADIS_MAX_SYNTHESIZED_AUDIO_BYTES = 8 * 1024 * 1024;
const ELEVENLABS_REQUEST_TIMEOUT_MS = 20_000;
const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';
/** 声の一覧を取りに行くページ数の上限（1ページ100件）。 */
const MAX_VOICE_PAGES = 5;
/** 辞書の最新版 ID を覚えておく時間。辞書を直した直後の合成に古い版が乗らないよう短めにする。 */
const DICTIONARY_VERSION_TTL_MS = 60_000;
/** アーカイブ済み・取得に失敗した辞書を「使わない」と覚えておく時間。 */
const DICTIONARY_UNUSABLE_TTL_MS = 5 * 60_000;

/** ElevenLabs API の失敗。メッセージにはステータスと本文の要約だけを入れる（キーは入れない）。 */
export class ParadisElevenLabsApiError extends Error {
	constructor(readonly status: number, readonly bodyText: string) {
		super(paradisClassifyElevenLabsError(status, bodyText).reason);
	}
}

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

interface IRequestInit {
	readonly method?: string;
	readonly query?: Record<string, string | number | boolean | undefined>;
	readonly json?: unknown;
	readonly accept?: string;
}

export class ParadisElevenLabsClient {

	/** 辞書ごとの最新版 ID。undefined は「アーカイブ済み・取得失敗で使わない」を短い間覚えたもの。 */
	private readonly _dictionaryVersions = new Map<string, { readonly versionId: string | undefined; readonly at: number }>();

	constructor(
		private readonly logService: ILogService,
		private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
		private readonly now: () => number = Date.now,
	) { }

	/**
	 * 要求を送り、`read` で本文を読み終えるまでをタイムアウトの中に入れる
	 * （ヘッダーだけ返して本文が止まる応答でも打ち切れるように）。
	 */
	private async _request<T>(path: string, apiKey: string, init: IRequestInit, read: (response: Response) => Promise<T>): Promise<T> {
		const url = new URL(path, ELEVENLABS_BASE_URL);
		for (const [key, value] of Object.entries(init.query ?? {})) {
			if (value !== undefined) {
				url.searchParams.set(key, String(value));
			}
		}
		const headers: Record<string, string> = { Accept: init.accept ?? 'application/json', 'xi-api-key': apiKey };
		let body: string | undefined;
		if (init.json !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(init.json);
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), ELEVENLABS_REQUEST_TIMEOUT_MS);
		try {
			const response = await this.fetchImpl(url, { method: init.method ?? 'GET', headers, body, signal: controller.signal });
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new ParadisElevenLabsApiError(response.status, text);
			}
			return await read(response);
		} finally {
			clearTimeout(timer);
		}
	}

	private _json<T>(path: string, apiKey: string, init: IRequestInit = {}): Promise<T> {
		return this._request(path, apiKey, init, response => response.json() as Promise<T>);
	}

	private _text(path: string, apiKey: string, init: IRequestInit = {}): Promise<string> {
		return this._request(path, apiKey, init, response => response.text());
	}

	/** 本文を使わない要求。本文は読み捨てる。 */
	private _send(path: string, apiKey: string, init: IRequestInit = {}): Promise<void> {
		return this._request(path, apiKey, init, async response => { await response.arrayBuffer().catch(() => undefined); });
	}

	// --- 声・モデル ------------------------------------------------------------------------------

	/** アカウントで使える声の一覧（`/v2/voices`）。 */
	async listVoices(apiKey: string): Promise<IParadisElevenLabsVoice[]> {
		interface VoicesResponse { voices?: IParadisElevenLabsRawVoice[]; has_more?: boolean; next_page_token?: string | null }
		const voices: IParadisElevenLabsVoice[] = [];
		let pageToken: string | undefined;
		for (let page = 0; page < MAX_VOICE_PAGES; page++) {
			const json = await this._json<VoicesResponse>('/v2/voices', apiKey, { query: { page_size: 100, next_page_token: pageToken } });
			for (const raw of json.voices ?? []) {
				const voice = paradisToElevenLabsVoice(raw);
				if (voice) {
					voices.push(voice);
				}
			}
			if (!json.has_more || !json.next_page_token) {
				break;
			}
			pageToken = json.next_page_token;
		}
		return voices;
	}

	/** 読み上げに使えて日本語に対応したモデルだけ（`/v1/models`）。 */
	async listModels(apiKey: string): Promise<IParadisElevenLabsModel[]> {
		const json = await this._json<IParadisElevenLabsRawModel[]>('/v1/models', apiKey);
		return paradisFilterElevenLabsModels(Array.isArray(json) ? json : []);
	}

	// --- 合成 ------------------------------------------------------------------------------------

	/**
	 * 合成して MP3 を返す（全部受け取ってから）。失敗は AivisError（retryable / fatal / item-specific）にして投げる。
	 * 文面の SSML 風タグは取り除いてから送る。
	 */
	async synthesize(request: IParadisPlayElevenLabsRequest): Promise<AivisSynthesizeResult> {
		const { body } = await this.synthesizeStream(request);
		return { audio: await paradisCollectBody(body, PARADIS_MAX_SYNTHESIZED_AUDIO_BYTES) };
	}

	/**
	 * 合成を少しずつ受け取る（`/stream`）。応答のヘッダーまでを待って返し、失敗の状態は AivisError にして投げる。
	 * 最初の 1 バイトまで 8 秒、途切れ 8 秒で打ち切る。
	 */
	async synthesizeStream(request: IParadisPlayElevenLabsRequest): Promise<AivisStreamingSynthesis> {
		const text = paradisStripSsmlTags(request.text);
		if (!text) {
			// allow-any-unicode-next-line
			throw new AivisError('item-specific', 'ElevenLabs に送る文面が空です');
		}
		const body: Record<string, unknown> = {
			text,
			model_id: request.modelId || PARADIS_ELEVENLABS_DEFAULT_MODEL_ID,
			voice_settings: { speed: paradisClampElevenLabsSpeed(request.speed) },
		};
		if (request.dictionaryId) {
			const versionId = await this._resolveDictionaryVersion(request.apiKey, request.dictionaryId);
			if (versionId) {
				body.pronunciation_dictionary_locators = [{ pronunciation_dictionary_id: request.dictionaryId, version_id: versionId }];
			}
		}

		const url = new URL(`/v1/text-to-speech/${encodeURIComponent(request.voiceId)}/stream`, ELEVENLABS_BASE_URL);
		url.searchParams.set('output_format', ELEVENLABS_OUTPUT_FORMAT);
		const timeouts = new ParadisSynthesisTimeouts(PARADIS_ELEVENLABS_FIRST_BYTE_TIMEOUT_MS);
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: 'POST',
				headers: { 'xi-api-key': request.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
				body: JSON.stringify(body),
				signal: timeouts.signal,
			});
		} catch (error) {
			timeouts.dispose();
			if (error instanceof Error && error.name === 'AbortError') {
				// allow-any-unicode-next-line
				throw new AivisError('retryable', 'ElevenLabs API のリクエストがタイムアウトしました', undefined, undefined, error);
			}
			throw new AivisError('retryable', getErrorMessage(error), undefined, undefined, error);
		}
		if (!response.ok) {
			const bodyText = await response.text().catch(() => '');
			timeouts.dispose();
			const { kind, reason } = paradisClassifyElevenLabsError(response.status, bodyText);
			const retryAfter = response.status === 429 ? paradisElevenLabsRetryAfter(response.headers.get('retry-after')) : undefined;
			throw new AivisError(kind, reason, response.status, retryAfter);
		}
		return { body: paradisReadSynthesisBody(response, timeouts, 'ElevenLabs') };
	}

	/** 辞書の最新版 ID。取れなければ undefined（その回は辞書なしで読み上げる）。 */
	private async _resolveDictionaryVersion(apiKey: string, dictionaryId: string): Promise<string | undefined> {
		const cached = this._dictionaryVersions.get(dictionaryId);
		const ttl = cached?.versionId ? DICTIONARY_VERSION_TTL_MS : DICTIONARY_UNUSABLE_TTL_MS;
		if (cached && this.now() - cached.at < ttl) {
			return cached.versionId;
		}
		try {
			const detail = await this.getDictionary(apiKey, dictionaryId, false);
			// アーカイブ済みなら辞書なしで読み上げる（getDictionary が「使わない」を覚える）。
			return detail.archived ? undefined : (detail.latestVersionId || undefined);
		} catch (error) {
			this.logService.warn(`[ParadisNotifications] could not resolve the ElevenLabs dictionary version; reading without the dictionary: ${getErrorMessage(error)}`);
			// 失敗した辞書を通知のたびに取りに行かないよう、しばらく「使わない」と覚える。
			this._dictionaryVersions.set(dictionaryId, { versionId: undefined, at: this.now() });
			return undefined;
		}
	}

	/** 最新版 ID を覚える。undefined（アーカイブ済み等）は「使わない」として短い間覚える。 */
	private _rememberDictionaryVersion(dictionaryId: string, versionId: string | undefined): void {
		this._dictionaryVersions.set(dictionaryId, { versionId: versionId || undefined, at: this.now() });
	}

	// --- 使用量 ----------------------------------------------------------------------------------

	/**
	 * 直近 `days` 日の日別の文字数と、モデル別・声別の内訳。内訳が取れなくても日別は返す。
	 * `recentDays` を渡すと、同じ取得から直近 `recentDays` 日だけの内訳（`recent`）も作る。
	 */
	async getUsage(apiKey: string, days: number, recentDays?: number): Promise<IParadisElevenLabsUsageResult> {
		const range = paradisElevenLabsUsageRange(Math.max(1, Math.min(90, Math.floor(days))), this.now());
		const query = { start_unix: range.startMs, end_unix: range.endMs, aggregation_interval: 'day' };
		const [daily, byModel, byVoice] = await Promise.all([
			this._json<IParadisElevenLabsRawCharacterStats>('/v1/usage/character-stats', apiKey, { query }),
			this._json<IParadisElevenLabsRawCharacterStats>('/v1/usage/character-stats', apiKey, { query: { ...query, breakdown_type: 'model' } }).catch(error => {
				this.logService.warn(`[ParadisNotifications] ElevenLabs usage by model failed: ${getErrorMessage(error)}`);
				return undefined;
			}),
			this._json<IParadisElevenLabsRawCharacterStats>('/v1/usage/character-stats', apiKey, { query: { ...query, breakdown_type: 'voice' } }).catch(error => {
				this.logService.warn(`[ParadisNotifications] ElevenLabs usage by voice failed: ${getErrorMessage(error)}`);
				return undefined;
			}),
		]);
		return paradisSummarizeElevenLabsUsage(daily, byModel, byVoice, range, recentDays);
	}

	/** プランの上限と残り。キーに user_read が無ければ missing-permissions を返す。 */
	async getSubscription(apiKey: string): Promise<ParadisElevenLabsSubscriptionResult> {
		try {
			const json = await this._json<Record<string, unknown>>('/v1/user/subscription', apiKey);
			return { kind: 'ok', subscription: paradisToElevenLabsSubscription(json) };
		} catch (error) {
			if (error instanceof ParadisElevenLabsApiError && paradisIsElevenLabsMissingPermissions(error.status, error.bodyText)) {
				return { kind: 'missing-permissions' };
			}
			throw error;
		}
	}

	// --- 発音辞書 --------------------------------------------------------------------------------

	async listDictionaries(apiKey: string): Promise<IParadisElevenLabsDictionaryListItem[]> {
		interface RawDictionary { id?: string; name?: string; description?: string | null; latest_version_id?: string; latest_version_rules_num?: number; creation_time_unix?: number; archived_time_unix?: number | null }
		interface ListResponse { pronunciation_dictionaries?: RawDictionary[]; has_more?: boolean; next_cursor?: string | null }
		const items: IParadisElevenLabsDictionaryListItem[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_VOICE_PAGES; page++) {
			const json = await this._json<ListResponse>('/v1/pronunciation-dictionaries', apiKey, { query: { page_size: 100, cursor } });
			for (const raw of json.pronunciation_dictionaries ?? []) {
				if (!raw.id || paradisIsElevenLabsDictionaryArchived(raw.archived_time_unix)) {
					continue;
				}
				items.push({
					id: raw.id,
					name: raw.name ?? raw.id,
					description: raw.description ?? '',
					latestVersionId: raw.latest_version_id ?? '',
					ruleCount: typeof raw.latest_version_rules_num === 'number' ? raw.latest_version_rules_num : null,
					createdAt: typeof raw.creation_time_unix === 'number' ? raw.creation_time_unix * 1000 : null,
				});
				this._rememberDictionaryVersion(raw.id, raw.latest_version_id);
			}
			for (const raw of json.pronunciation_dictionaries ?? []) {
				if (raw.id && paradisIsElevenLabsDictionaryArchived(raw.archived_time_unix)) {
					this._rememberDictionaryVersion(raw.id, undefined);
				}
			}
			if (!json.has_more || !json.next_cursor) {
				break;
			}
			cursor = json.next_cursor;
		}
		return items;
	}

	/**
	 * 辞書の詳細。取得 API が規則を返さない場合は、最新版の PLS を落として規則を読み取る
	 * （`withRules` が false なら規則は取りに行かない）。
	 */
	async getDictionary(apiKey: string, id: string, withRules: boolean = true): Promise<IParadisElevenLabsDictionaryDetail> {
		interface RawDetail { id?: string; name?: string; description?: string | null; latest_version_id?: string; archived_time_unix?: number | null; rules?: unknown }
		const json = await this._json<RawDetail>(`/v1/pronunciation-dictionaries/${encodeURIComponent(id)}`, apiKey);
		const latestVersionId = json.latest_version_id ?? '';
		this._rememberDictionaryVersion(id, paradisIsElevenLabsDictionaryArchived(json.archived_time_unix) ? undefined : latestVersionId);
		let rules: ParadisElevenLabsRule[] = [];
		if (withRules) {
			if (Array.isArray(json.rules)) {
				rules = paradisNormalizeElevenLabsRules(json.rules);
			} else if (latestVersionId) {
				rules = paradisParseElevenLabsPls(await this._downloadVersion(apiKey, id, latestVersionId));
			}
		}
		return { id: json.id ?? id, name: json.name ?? id, description: json.description ?? '', latestVersionId, rules, archived: paradisIsElevenLabsDictionaryArchived(json.archived_time_unix) };
	}

	async createDictionary(apiKey: string, name: string, description: string, rules: readonly ParadisElevenLabsRule[]): Promise<{ id: string; versionId: string }> {
		const json = await this._json<{ id?: string; version_id?: string }>('/v1/pronunciation-dictionaries/add-from-rules', apiKey, {
			method: 'POST',
			json: { name, description, rules },
		});
		if (!json.id) {
			// allow-any-unicode-next-line
			throw new Error('ElevenLabs が辞書の ID を返しませんでした');
		}
		this._rememberDictionaryVersion(json.id, json.version_id);
		return { id: json.id, versionId: json.version_id ?? '' };
	}

	/** 辞書の規則を丸ごと置き換える（`set-rules`）。新しい版 ID を覚えて、次の合成に使う。 */
	async setDictionaryRules(apiKey: string, id: string, rules: readonly ParadisElevenLabsRule[]): Promise<void> {
		const json = await this._json<{ version_id?: string }>(`/v1/pronunciation-dictionaries/${encodeURIComponent(id)}/set-rules`, apiKey, { method: 'POST', json: { rules } });
		this._rememberDictionaryVersion(id, json.version_id);
	}

	/** 辞書を消す。物理削除の API が無いのでアーカイブする。 */
	async archiveDictionary(apiKey: string, id: string): Promise<void> {
		await this._send(`/v1/pronunciation-dictionaries/${encodeURIComponent(id)}`, apiKey, { method: 'PATCH', json: { archived: true } });
		this._rememberDictionaryVersion(id, undefined);
	}

	/** 最新版の PLS（XML）を書き出す。 */
	async downloadDictionary(apiKey: string, id: string): Promise<string> {
		const detail = await this.getDictionary(apiKey, id, false);
		if (!detail.latestVersionId) {
			// allow-any-unicode-next-line
			throw new Error('辞書の版が見つかりません');
		}
		return this._downloadVersion(apiKey, id, detail.latestVersionId);
	}

	private async _downloadVersion(apiKey: string, id: string, versionId: string): Promise<string> {
		return this._text(`/v1/pronunciation-dictionaries/${encodeURIComponent(id)}/${encodeURIComponent(versionId)}/download`, apiKey, { accept: 'application/pls+xml, application/xml, text/xml, */*' });
	}
}
