/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { randomUUID } from 'crypto';
import {
	IParadisAivisDictionaryDetail,
	IParadisAivisDictionaryListItem,
	IParadisAivisDictionaryWord,
	IParadisAivisMeResult,
	IParadisAivisModelSummary,
	IParadisAivisUsageDayEntry,
	IParadisAivisUsageResult,
} from '../common/paradisNotifications.js';

export const AIVIS_BASE_URL = 'https://api.aivis-project.com';
/** 管理系の API（モデル・辞書・使用量・残高）の 1 回の上限。本文を読み終えるまでを含む。 */
const AIVIS_REQUEST_TIMEOUT_MS = 20_000;
/** 辞書の書き出し・読み込みの上限（語の多い辞書は 20 秒では足りないことがある）。 */
const AIVIS_DICTIONARY_TRANSFER_TIMEOUT_MS = 120_000;

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

interface IAivisRequestInit {
	readonly method?: string;
	readonly query?: Record<string, string | number | boolean | undefined>;
	readonly json?: unknown;
	readonly accept?: string;
	/** 辞書の書き出し・読み込みのように時間のかかる要求（長い方の上限を使う）。 */
	readonly transfer?: boolean;
}

class AivisApiError extends Error {
	constructor(readonly status: number, bodyText: string) {
		// allow-any-unicode-next-line
		super(`Aivis API エラー (HTTP ${status})${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
	}
}

/**
 * Aivis Cloud の管理系の API（設定ダイアログとモバイルの使用量が使う）。合成（`/v1/tts/synthesize`）は
 * 最初のバイトと途切れの打ち切りを別に持つので、ここには入れない。
 */
export class ParadisAivisClient {

	constructor(
		private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
		private readonly timeoutMs = AIVIS_REQUEST_TIMEOUT_MS,
		private readonly transferTimeoutMs = AIVIS_DICTIONARY_TRANSFER_TIMEOUT_MS,
	) { }

	/**
	 * 要求を送り、`read` で本文を読み終えるまでをタイムアウトの中に入れる
	 * （ヘッダーだけ返して本文が止まる応答でも打ち切れるように）。
	 */
	private async _request<T>(path: string, apiKey: string, init: IAivisRequestInit, read: (response: Response) => Promise<T>): Promise<T> {
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
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), init.transfer ? this.transferTimeoutMs : this.timeoutMs);
		try {
			const response = await this.fetchImpl(url, { method: init.method ?? 'GET', headers, body, signal: controller.signal });
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new AivisApiError(response.status, text);
			}
			return await read(response);
		} catch (error) {
			if (controller.signal.aborted) {
				// allow-any-unicode-next-line
				throw new Error('Aivis API のリクエストがタイムアウトしました');
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	private _json<T>(path: string, apiKey: string, init: IAivisRequestInit = {}): Promise<T> {
		return this._request(path, apiKey, init, response => response.json() as Promise<T>);
	}

	/** 本文を使わない要求。本文は読み捨てる。 */
	private _send(path: string, apiKey: string, init: IAivisRequestInit = {}): Promise<void> {
		return this._request(path, apiKey, init, async response => { await response.arrayBuffer().catch(() => undefined); });
	}

	private _wrapError(error: unknown): Error {
		if (error instanceof AivisApiError) {
			return new Error(error.message);
		}
		return error instanceof Error ? error : new Error(String(error));
	}

	async getModel(apiKey: string, uuid: string): Promise<IParadisAivisModelSummary | null> {
		interface AivmStyle { voice_samples?: { audio_url?: string | null }[] }
		interface AivmSpeaker { icon_url?: string | null; styles?: AivmStyle[] }
		interface AivmResponse { aivm_model_uuid: string; name: string; description?: string; user?: { name?: string; handle?: string; icon_url?: string | null }; speakers?: AivmSpeaker[] }
		try {
			const model = await this._json<AivmResponse>(`/v1/aivm-models/${uuid}`, apiKey);
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
			throw this._wrapError(error);
		}
	}

	async listDictionaries(apiKey: string): Promise<IParadisAivisDictionaryListItem[]> {
		try {
			const json = await this._json<{ user_dictionaries: IParadisAivisDictionaryListItem[] }>('/v1/user-dictionaries', apiKey);
			return json.user_dictionaries;
		} catch (error) {
			throw this._wrapError(error);
		}
	}

	async getDictionary(apiKey: string, uuid: string): Promise<IParadisAivisDictionaryDetail> {
		try {
			return await this._json<IParadisAivisDictionaryDetail>(`/v1/user-dictionaries/${uuid}`, apiKey);
		} catch (error) {
			throw this._wrapError(error);
		}
	}

	async createDictionary(apiKey: string, name: string, description: string): Promise<{ uuid: string }> {
		const uuid = randomUUID();
		try {
			await this._send(`/v1/user-dictionaries/${uuid}`, apiKey, { method: 'PUT', json: { name, description, word_properties: [] } });
			return { uuid };
		} catch (error) {
			throw this._wrapError(error);
		}
	}

	async updateDictionary(apiKey: string, uuid: string, name: string, description: string, words: readonly IParadisAivisDictionaryWord[]): Promise<void> {
		try {
			await this._send(`/v1/user-dictionaries/${uuid}`, apiKey, { method: 'PUT', json: { name, description, word_properties: words } });
		} catch (error) {
			throw this._wrapError(error);
		}
	}

	async deleteDictionary(apiKey: string, uuid: string): Promise<void> {
		try {
			await this._send(`/v1/user-dictionaries/${uuid}`, apiKey, { method: 'DELETE' });
		} catch (error) {
			throw this._wrapError(error);
		}
	}

	async exportDictionary(apiKey: string, uuid: string): Promise<Record<string, unknown>> {
		try {
			return await this._json<Record<string, unknown>>(`/v1/user-dictionaries/${uuid}/export`, apiKey, { transfer: true });
		} catch (error) {
			throw this._wrapError(error);
		}
	}

	async importDictionary(apiKey: string, uuid: string, data: Record<string, unknown>, override: boolean): Promise<void> {
		try {
			await this._send(`/v1/user-dictionaries/${uuid}/import`, apiKey, { method: 'POST', query: { override }, json: data, transfer: true });
		} catch (error) {
			throw this._wrapError(error);
		}
	}

	async getUsageDaily(apiKey: string, startDate: string, endDate: string): Promise<IParadisAivisUsageResult> {
		interface UsageSummary { api_key_id: string; api_key_name: string; summary_date: string; request_count: number; character_count: number; credit_consumed: number }
		try {
			const json = await this._json<{ summaries: UsageSummary[] }>('/v1/payment/usage-summaries', apiKey, { query: { start_date: startDate, end_date: endDate } });
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
			throw this._wrapError(error);
		}
	}

	async getMe(apiKey: string): Promise<IParadisAivisMeResult> {
		interface UserMeResponse { handle?: string; name?: string; credit_balance?: number }
		try {
			const me = await this._json<UserMeResponse>('/v1/users/me', apiKey);
			return { handle: me.handle ?? null, name: me.name ?? null, creditBalance: typeof me.credit_balance === 'number' ? me.credit_balance : null };
		} catch (error) {
			throw this._wrapError(error);
		}
	}
}
