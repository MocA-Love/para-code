/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の読み上げを ElevenLabs で行うための共有データモデルと純関数。renderer（設定ダイアログ・
// トリガー）と shared process（ElevenLabs API クライアント）の両方から参照される。
// API の生のレスポンスを UI 向けの形へ直す処理はすべてここに置き、単体テストで確かめる。

/** 読み上げエンジン。既定は Aivis（今までの利用者の挙動を変えない）。 */
export type ParadisVoiceEngine = 'aivis' | 'elevenlabs';

export const PARADIS_VOICE_ENGINES: readonly ParadisVoiceEngine[] = ['aivis', 'elevenlabs'];

export function paradisNormalizeVoiceEngine(value: unknown): ParadisVoiceEngine {
	return value === 'elevenlabs' ? 'elevenlabs' : 'aivis';
}

/** 合成に使うモデルの既定値。日本語に対応し、出始めが速い。 */
export const PARADIS_ELEVENLABS_DEFAULT_MODEL_ID = 'eleven_flash_v2_5';

/** voice_settings.speed の範囲（ElevenLabs API の仕様）。 */
export const PARADIS_ELEVENLABS_SPEED_MIN = 0.7;
export const PARADIS_ELEVENLABS_SPEED_MAX = 1.2;
export const PARADIS_ELEVENLABS_SPEED_DEFAULT = 1.0;

/** 話速を API の範囲へ収める。数でない値は既定値にする。 */
export function paradisClampElevenLabsSpeed(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return PARADIS_ELEVENLABS_SPEED_DEFAULT;
	}
	const clamped = Math.max(PARADIS_ELEVENLABS_SPEED_MIN, Math.min(PARADIS_ELEVENLABS_SPEED_MAX, value));
	// スライダーの刻み（0.05）より細かい浮動小数の誤差を落とす。
	return Math.round(clamped * 100) / 100;
}

/**
 * ElevenLabs の音声は Aivis より約 13dB 大きく出る。再生音量（0-100）を -13dB 相当に下げて揃える。
 * Aivis と同じく再生プレイヤーの音量（afplay -v 等）で下げるため、ここでは 0-100 の値を返す。
 */
export const PARADIS_ELEVENLABS_GAIN_DB = -13;

export function paradisElevenLabsPlaybackVolume(volume: number): number {
	const base = Math.max(0, Math.min(100, Number.isFinite(volume) ? volume : 100));
	return base * Math.pow(10, PARADIS_ELEVENLABS_GAIN_DB / 20);
}

/**
 * 文面から SSML 風のタグ（`<break time="1s"/>` 等）を取り除く。ElevenLabs はタグを文字として
 * 読み上げてしまうため。タグを消したあとの連続空白は1つにまとめる。
 */
export function paradisStripSsmlTags(text: string): string {
	return text.replace(/<[^<>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// --- 声 -----------------------------------------------------------------------------------------

export interface IParadisElevenLabsVoice {
	readonly voiceId: string;
	readonly name: string;
	/** 「日本語 · 女性」のような補足。API のラベルから組み立てる。 */
	readonly description: string;
	readonly category: string;
	readonly previewUrl: string | null;
	readonly japanese: boolean;
}

/** `/v2/voices` の1件。必要なフィールドだけ。 */
export interface IParadisElevenLabsRawVoice {
	readonly voice_id?: string;
	readonly name?: string;
	readonly category?: string;
	readonly preview_url?: string | null;
	readonly labels?: Readonly<Record<string, string | undefined>> | null;
	readonly verified_languages?: readonly { readonly language?: string; readonly preview_url?: string | null }[] | null;
	readonly fine_tuning?: { readonly language?: string | null } | null;
}

function isJapaneseCode(value: string | null | undefined): boolean {
	if (!value) {
		return false;
	}
	const lower = value.toLowerCase();
	return lower === 'ja' || lower.startsWith('ja-') || lower.startsWith('ja_') || lower === 'japanese';
}

/** 日本語の声か。ラベル・確認済みの言語・ファインチューニングの言語のどれかが ja なら日本語とみなす。 */
export function paradisIsJapaneseElevenLabsVoice(voice: IParadisElevenLabsRawVoice): boolean {
	return isJapaneseCode(voice.labels?.language)
		|| (voice.verified_languages ?? []).some(entry => isJapaneseCode(entry.language))
		|| isJapaneseCode(voice.fine_tuning?.language);
}

/** `/v2/voices` の1件を UI 向けに直す。voice_id が無いものは捨てる。日本語の声は日本語のサンプルを優先する。 */
export function paradisToElevenLabsVoice(raw: IParadisElevenLabsRawVoice): IParadisElevenLabsVoice | undefined {
	if (!raw.voice_id) {
		return undefined;
	}
	const japanese = paradisIsJapaneseElevenLabsVoice(raw);
	const japanesePreview = (raw.verified_languages ?? []).find(entry => isJapaneseCode(entry.language) && entry.preview_url)?.preview_url ?? null;
	const labels = raw.labels ?? {};
	const description = [labels.language, labels.gender, labels.accent, labels.descriptive ?? labels.description, labels.use_case ?? labels['use case']]
		.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
		.map(value => value.trim())
		.join(' · ');
	return {
		voiceId: raw.voice_id,
		name: raw.name?.trim() || raw.voice_id,
		description: description || (raw.category ?? ''),
		category: raw.category ?? '',
		previewUrl: japanesePreview ?? raw.preview_url ?? null,
		japanese,
	};
}

/** 日本語の声を先に、その中は名前順に並べる。検索語があれば名前・補足・ID の部分一致で絞る。 */
export function paradisFilterElevenLabsVoices(voices: readonly IParadisElevenLabsVoice[], query: string): IParadisElevenLabsVoice[] {
	const needle = query.trim().toLowerCase();
	const matched = needle
		? voices.filter(voice => voice.name.toLowerCase().includes(needle) || voice.description.toLowerCase().includes(needle) || voice.voiceId.toLowerCase().includes(needle))
		: [...voices];
	return matched.sort((a, b) => {
		if (a.japanese !== b.japanese) {
			return a.japanese ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});
}

// --- モデル -------------------------------------------------------------------------------------

export interface IParadisElevenLabsModel {
	readonly modelId: string;
	readonly name: string;
}

export interface IParadisElevenLabsRawModel {
	readonly model_id?: string;
	readonly name?: string;
	readonly can_do_text_to_speech?: boolean;
	readonly languages?: readonly { readonly language_id?: string; readonly name?: string }[] | null;
}

/** 読み上げに使え、日本語に対応したモデルだけを残す。名前は API の name をそのまま使う。 */
export function paradisFilterElevenLabsModels(models: readonly IParadisElevenLabsRawModel[]): IParadisElevenLabsModel[] {
	const result: IParadisElevenLabsModel[] = [];
	for (const model of models) {
		if (!model.model_id || model.can_do_text_to_speech !== true) {
			continue;
		}
		if (!(model.languages ?? []).some(language => isJapaneseCode(language.language_id))) {
			continue;
		}
		result.push({ modelId: model.model_id, name: model.name?.trim() || model.model_id });
	}
	return result;
}

// --- エラー分類 ---------------------------------------------------------------------------------

export type ParadisElevenLabsErrorKind = 'retryable' | 'fatal' | 'item-specific';

/** エラー本文の `detail.status`（例: invalid_api_key）。本文が JSON でなければ undefined。 */
export function paradisElevenLabsErrorStatus(bodyText: string): string | undefined {
	try {
		const parsed = JSON.parse(bodyText) as { detail?: unknown };
		const detail = parsed?.detail;
		if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
			const status = (detail as { status?: unknown }).status;
			return typeof status === 'string' ? status : undefined;
		}
	} catch {
		// JSON でない本文
	}
	return undefined;
}

/** エラー本文の `detail.message`。無ければ本文の先頭を返す。 */
function elevenLabsErrorMessage(bodyText: string): string {
	try {
		const parsed = JSON.parse(bodyText) as { detail?: unknown };
		const detail = parsed?.detail;
		if (typeof detail === 'string') {
			return detail;
		}
		if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
			const message = (detail as { message?: unknown }).message;
			if (typeof message === 'string') {
				return message;
			}
		}
	} catch {
		// JSON でない本文
	}
	return bodyText;
}

/** キーの権限不足（401 で detail.status が missing_permissions）か。 */
export function paradisIsElevenLabsMissingPermissions(status: number, bodyText: string): boolean {
	return status === 401 && paradisElevenLabsErrorStatus(bodyText) === 'missing_permissions';
}

/** 一時停止して利用者に直してもらう必要がある detail.status。 */
const FATAL_DETAIL_STATUSES = new Set([
	'invalid_api_key',
	'quota_exceeded',
	'missing_permissions',
	'payment_required',
	'voice_not_found',
	'model_not_found',
	'detected_unusual_activity',
	'needs_authorization',
	'subscription_required',
]);

/**
 * ElevenLabs の合成失敗を、Aivis と同じ3分類に振り分ける。
 * 401/402 と、キー・残高・声の設定を直さないと通らないもの（invalid_api_key, quota_exceeded 等）は fatal、
 * 429/5xx は retryable、422 とその他の 4xx はその1件だけ飛ばす。
 */
export function paradisClassifyElevenLabsError(status: number, bodyText: string): { readonly kind: ParadisElevenLabsErrorKind; readonly reason: string } {
	const detailStatus = paradisElevenLabsErrorStatus(bodyText);
	const message = elevenLabsErrorMessage(bodyText).slice(0, 120);
	if (status === 429) {
		// allow-any-unicode-next-line
		return { kind: 'retryable', reason: 'ElevenLabs API のレート制限に到達しました' };
	}
	if (status >= 500 && status < 600) {
		// allow-any-unicode-next-line
		return { kind: 'retryable', reason: `ElevenLabs サーバー側の一時障害 (HTTP ${status})` };
	}
	if (detailStatus === 'quota_exceeded') {
		// allow-any-unicode-next-line
		return { kind: 'fatal', reason: 'ElevenLabs の文字数の上限に達しました' };
	}
	if (detailStatus === 'missing_permissions') {
		// allow-any-unicode-next-line
		return { kind: 'fatal', reason: 'ElevenLabs の API キーに読み上げ (Text to Speech) の権限がありません' };
	}
	if (detailStatus === 'voice_not_found' || status === 404) {
		// allow-any-unicode-next-line
		return { kind: 'fatal', reason: 'ElevenLabs の声が見つかりません。設定画面で声を選び直してください' };
	}
	if (status === 401 || detailStatus === 'invalid_api_key') {
		// allow-any-unicode-next-line
		return { kind: 'fatal', reason: 'ElevenLabs の API キーが無効です。設定画面でキーを確認してください' };
	}
	if (status === 402) {
		// allow-any-unicode-next-line
		return { kind: 'fatal', reason: 'ElevenLabs のプランか残高が不足しています' };
	}
	if (detailStatus !== undefined && FATAL_DETAIL_STATUSES.has(detailStatus)) {
		// allow-any-unicode-next-line
		return { kind: 'fatal', reason: `ElevenLabs API エラー (${detailStatus}) ${message}`.trim() };
	}
	if (status === 422) {
		// allow-any-unicode-next-line
		return { kind: 'item-specific', reason: `ElevenLabs リクエスト形式が不正です: ${message}` };
	}
	// allow-any-unicode-next-line
	return { kind: 'item-specific', reason: `ElevenLabs API エラー (HTTP ${status}) ${message}`.trim() };
}

// --- 使用量 -------------------------------------------------------------------------------------

/** `/v1/usage/character-stats` のレスポンス。time は各区間の始まり（unix ミリ秒）。 */
export interface IParadisElevenLabsRawCharacterStats {
	readonly time?: readonly number[];
	readonly usage?: Readonly<Record<string, readonly number[] | undefined>>;
}

export interface IParadisElevenLabsUsageDay {
	/** UTC の日付（YYYY-MM-DD）。ElevenLabs は UTC の日で区切って集計する。 */
	readonly date: string;
	readonly characterCount: number;
}

export interface IParadisElevenLabsUsageBreakdownEntry {
	/** モデル ID または voice の ID（API のキーそのまま）。表示名は UI で引き当てる。 */
	readonly key: string;
	readonly characterCount: number;
}

export interface IParadisElevenLabsUsageResult {
	readonly days: readonly IParadisElevenLabsUsageDay[];
	readonly totalCharacters: number;
	readonly byModel: readonly IParadisElevenLabsUsageBreakdownEntry[];
	readonly byVoice: readonly IParadisElevenLabsUsageBreakdownEntry[];
}

export interface IParadisElevenLabsSubscription {
	readonly characterCount: number;
	readonly characterLimit: number;
	/** 次に文字数が戻る時刻（unix ミリ秒）。不明なら null。 */
	readonly nextResetAt: number | null;
	readonly tier: string | null;
}

/** プランの上限と残り。`missing-permissions` はキーに user_read が無いとき。 */
export type ParadisElevenLabsSubscriptionResult =
	| { readonly kind: 'ok'; readonly subscription: IParadisElevenLabsSubscription }
	| { readonly kind: 'missing-permissions' };

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** 直近 `days` 日（今日を含む、UTC の日）の取得範囲。end は今。 */
export function paradisElevenLabsUsageRange(days: number, now: number): { readonly startMs: number; readonly endMs: number } {
	const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
	return { startMs: todayStart - (days - 1) * DAY_MS, endMs: now };
}

function sumSeries(series: readonly number[] | undefined): number {
	let total = 0;
	for (const value of series ?? []) {
		if (typeof value === 'number' && Number.isFinite(value)) {
			total += value;
		}
	}
	return total;
}

function toBreakdown(stats: IParadisElevenLabsRawCharacterStats | undefined): IParadisElevenLabsUsageBreakdownEntry[] {
	const entries: IParadisElevenLabsUsageBreakdownEntry[] = [];
	for (const [key, series] of Object.entries(stats?.usage ?? {})) {
		const characterCount = sumSeries(series);
		if (characterCount > 0) {
			entries.push({ key, characterCount });
		}
	}
	return entries.sort((a, b) => b.characterCount - a.characterCount || a.key.localeCompare(b.key));
}

/**
 * 日別の文字数（`usage.All`）と、モデル別・声別の内訳を UI 向けの形にまとめる。
 * 範囲内で集計に出てこない日は 0 で埋める。範囲外の区間は捨てる。
 */
export function paradisSummarizeElevenLabsUsage(
	daily: IParadisElevenLabsRawCharacterStats,
	byModel: IParadisElevenLabsRawCharacterStats | undefined,
	byVoice: IParadisElevenLabsRawCharacterStats | undefined,
	range: { readonly startMs: number; readonly endMs: number },
): IParadisElevenLabsUsageResult {
	const counts = new Map<string, number>();
	const times = daily.time ?? [];
	const all = daily.usage?.All ?? daily.usage?.all ?? [];
	for (let i = 0; i < times.length; i++) {
		const time = times[i];
		const value = all[i];
		if (typeof time !== 'number' || typeof value !== 'number' || !Number.isFinite(value)) {
			continue;
		}
		const date = utcDate(time);
		counts.set(date, (counts.get(date) ?? 0) + value);
	}
	const days: IParadisElevenLabsUsageDay[] = [];
	const lastDay = utcDate(range.endMs);
	for (let ms = Math.floor(range.startMs / DAY_MS) * DAY_MS; ; ms += DAY_MS) {
		const date = utcDate(ms);
		days.push({ date, characterCount: counts.get(date) ?? 0 });
		if (date >= lastDay) {
			break;
		}
	}
	return {
		days,
		totalCharacters: days.reduce((acc, day) => acc + day.characterCount, 0),
		byModel: toBreakdown(byModel),
		byVoice: toBreakdown(byVoice),
	};
}

/** `/v1/user/subscription` のレスポンスを直す。数が無いものは 0。 */
export function paradisToElevenLabsSubscription(raw: { readonly character_count?: unknown; readonly character_limit?: unknown; readonly next_character_count_reset_unix?: unknown; readonly tier?: unknown }): IParadisElevenLabsSubscription {
	const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
	const reset = raw.next_character_count_reset_unix;
	return {
		characterCount: num(raw.character_count),
		characterLimit: num(raw.character_limit),
		nextResetAt: typeof reset === 'number' && Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
		tier: typeof raw.tier === 'string' ? raw.tier : null,
	};
}

/** 内訳のキー（モデル ID・voice ID）を表示名に引き当てる。引けないものはキーのまま出す。 */
export function paradisNameElevenLabsBreakdown(entries: readonly IParadisElevenLabsUsageBreakdownEntry[], names: ReadonlyMap<string, string>): { readonly label: string; readonly characterCount: number }[] {
	return entries.map(entry => ({ label: names.get(entry.key) ?? entry.key, characterCount: entry.characterCount }));
}

/** プランの残り文字数と使った割合（0-1）。上限が 0 なら割合は 0。 */
export function paradisElevenLabsQuota(subscription: IParadisElevenLabsSubscription): { readonly remaining: number; readonly usedRatio: number } {
	const remaining = Math.max(0, subscription.characterLimit - subscription.characterCount);
	const usedRatio = subscription.characterLimit > 0 ? Math.min(1, subscription.characterCount / subscription.characterLimit) : 0;
	return { remaining, usedRatio };
}

// --- 発音辞書 -----------------------------------------------------------------------------------

/** ElevenLabs の発音辞書の規則。alias だけを画面で扱い、phoneme は作らない（日本語で音が崩れるため）。 */
export type ParadisElevenLabsRule =
	| { readonly type: 'alias'; readonly string_to_replace: string; readonly alias: string }
	| { readonly type: 'phoneme'; readonly string_to_replace: string; readonly phoneme: string; readonly alphabet: string };

/** 画面の1行（表記・読み）。 */
export interface IParadisElevenLabsDictionaryEntry {
	readonly surface: string;
	readonly reading: string;
}

export interface IParadisElevenLabsDictionaryListItem {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly latestVersionId: string;
	readonly ruleCount: number | null;
	/** 作成時刻（unix ミリ秒）。不明なら null。 */
	readonly createdAt: number | null;
}

export interface IParadisElevenLabsDictionaryDetail {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly latestVersionId: string;
	readonly rules: readonly ParadisElevenLabsRule[];
}

/** API の規則配列から、形の正しいものだけを取り出す。 */
export function paradisNormalizeElevenLabsRules(raw: unknown): ParadisElevenLabsRule[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const rules: ParadisElevenLabsRule[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const rule = item as Record<string, unknown>;
		if (typeof rule.string_to_replace !== 'string') {
			continue;
		}
		if (rule.type === 'alias' && typeof rule.alias === 'string') {
			rules.push({ type: 'alias', string_to_replace: rule.string_to_replace, alias: rule.alias });
		} else if (rule.type === 'phoneme' && typeof rule.phoneme === 'string') {
			rules.push({ type: 'phoneme', string_to_replace: rule.string_to_replace, phoneme: rule.phoneme, alphabet: typeof rule.alphabet === 'string' ? rule.alphabet : 'ipa' });
		}
	}
	return rules;
}

/** 規則のうち alias だけを画面の行にする。 */
export function paradisEntriesFromElevenLabsRules(rules: readonly ParadisElevenLabsRule[]): IParadisElevenLabsDictionaryEntry[] {
	return rules
		.filter((rule): rule is Extract<ParadisElevenLabsRule, { type: 'alias' }> => rule.type === 'alias')
		.map(rule => ({ surface: rule.string_to_replace, reading: rule.alias }));
}

/**
 * 画面の行を保存用の規則に直す。前後の空白を落とし、表記か読みが空の行は捨て、
 * 同じ表記は後の行を優先して1つにまとめる。画面に出していない phoneme 規則（他のツールで作ったもの）は
 * そのまま残す。ただし同じ表記の alias を画面で入れた場合は alias を優先する。
 */
export function paradisRulesFromElevenLabsEntries(entries: readonly IParadisElevenLabsDictionaryEntry[], existing: readonly ParadisElevenLabsRule[] = []): ParadisElevenLabsRule[] {
	const aliases = new Map<string, string>();
	for (const entry of entries) {
		const surface = entry.surface.trim();
		const reading = entry.reading.trim();
		if (!surface || !reading) {
			continue;
		}
		aliases.delete(surface);
		aliases.set(surface, reading);
	}
	const rules: ParadisElevenLabsRule[] = [];
	for (const rule of existing) {
		if (rule.type === 'phoneme' && !aliases.has(rule.string_to_replace)) {
			rules.push(rule);
		}
	}
	for (const [surface, reading] of aliases) {
		rules.push({ type: 'alias', string_to_replace: surface, alias: reading });
	}
	return rules;
}

/** 入力の検証。問題があれば1始まりの行番号と種類を返す。 */
export function paradisValidateElevenLabsEntries(entries: readonly IParadisElevenLabsDictionaryEntry[]): { readonly row: number; readonly problem: 'surface' | 'reading' } | undefined {
	for (let i = 0; i < entries.length; i++) {
		const surface = entries[i].surface.trim();
		const reading = entries[i].reading.trim();
		if (!surface && !reading) {
			continue; // 空行は保存時に捨てる
		}
		if (!surface) {
			return { row: i + 1, problem: 'surface' };
		}
		if (!reading) {
			return { row: i + 1, problem: 'reading' };
		}
	}
	return undefined;
}

function decodeXmlText(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, '\'')
		.replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
		.replace(/&amp;/g, '&')
		.trim();
}

/**
 * 書き出した PLS（XML）から規則を読み取る。辞書の取得 API が規則を返さない場合の控えとして使う。
 * `<lexeme>` ごとに最初の `<grapheme>` を表記とし、`<alias>` があれば alias、`<phoneme>` があれば phoneme にする。
 */
export function paradisParseElevenLabsPls(xml: string): ParadisElevenLabsRule[] {
	const alphabet = /<lexicon\b[^>]*\balphabet\s*=\s*"([^"]*)"/i.exec(xml)?.[1] ?? 'ipa';
	const rules: ParadisElevenLabsRule[] = [];
	const lexemeRe = /<lexeme\b[^>]*>([\s\S]*?)<\/lexeme>/gi;
	let match: RegExpExecArray | null;
	while ((match = lexemeRe.exec(xml)) !== null) {
		const body = match[1];
		const grapheme = /<grapheme\b[^>]*>([\s\S]*?)<\/grapheme>/i.exec(body)?.[1];
		if (grapheme === undefined) {
			continue;
		}
		const surface = decodeXmlText(grapheme);
		const alias = /<alias\b[^>]*>([\s\S]*?)<\/alias>/i.exec(body)?.[1];
		if (alias !== undefined) {
			rules.push({ type: 'alias', string_to_replace: surface, alias: decodeXmlText(alias) });
			continue;
		}
		const phoneme = /<phoneme\b[^>]*>([\s\S]*?)<\/phoneme>/i.exec(body)?.[1];
		if (phoneme !== undefined) {
			rules.push({ type: 'phoneme', string_to_replace: surface, phoneme: decodeXmlText(phoneme), alphabet });
		}
	}
	return rules;
}

// --- API キーの secret storage への移行 ---------------------------------------------------------

export interface IParadisApiKeyMigrationPlan {
	/** 画面と合成に使うキー。 */
	readonly use: string;
	/** secret storage へ書くキー。書かないなら undefined。 */
	readonly writeSecret?: string;
	/** JSON（IStorageService）からキーを消すか。writeSecret がある場合は書けたときだけ消す。 */
	readonly removeFromJson: boolean;
}

/**
 * 起動時に API キーをどこから読むか、secret storage へ移すかを決める。
 * - secret storage が暗号化して保存できない（in-memory 等）なら、今までどおり JSON のキーを使い、何も動かさない
 * - JSON にキーがあれば、それを secret storage へ移して JSON から消す（移せなかったら消さない）。
 *   secret storage にも別の値がある場合は JSON の方を新しいとみなす（古い版へ戻して入れ直した等）
 * - JSON に無ければ secret storage の値を使う
 */
export function paradisPlanApiKeyMigration(jsonKey: string | undefined, secretKey: string | undefined, secretPersisted: boolean): IParadisApiKeyMigrationPlan {
	if (!secretPersisted) {
		return { use: jsonKey ?? '', removeFromJson: false };
	}
	if (jsonKey) {
		return jsonKey === secretKey
			? { use: jsonKey, removeFromJson: true }
			: { use: jsonKey, writeSecret: jsonKey, removeFromJson: true };
	}
	return { use: secretKey ?? '', removeFromJson: jsonKey !== undefined };
}

// --- IPC で渡す合成の要求 -----------------------------------------------------------------------

export interface IParadisPlayElevenLabsRequest {
	readonly apiKey: string;
	readonly voiceId: string;
	readonly modelId: string;
	readonly text: string;
	/** 0.7-1.2 */
	readonly speed?: number;
	/** 適用する発音辞書の ID。版は shared process が最新を引く。 */
	readonly dictionaryId?: string;
	/** 0-100（-13dB の補正は shared process 側でかける） */
	readonly volume?: number;
}
