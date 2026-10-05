// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 読み上げ（Aivis・ElevenLabs）の使用量の、PC から届く形（fs の `voiceUsage` の応答の `data`、capability
 * `usage.voice.v1`）。PC 側の組み立ては `src/vs/paradis/contrib/mobileRelay/common/paradisMobileVoiceUsage.ts`。
 *
 * **このファイルは import を持たない**（`store.ts` から読むので、使用量の集計と循環させない）。
 * API キーそのものは届かない。`keyId` は PC がキーから作った短い印で、PC をまたいで同じキーかを見分けるのに使う。
 */

export type VoiceProvider = 'elevenlabs' | 'aivis';

export interface AivisVoiceDay {
	/** PC の日付（YYYY-MM-DD）。 */
	readonly date: string;
	readonly requests: number;
	readonly chars: number;
	readonly credits: number;
}

export interface AivisVoiceKeyRow {
	/** Aivis に登録した API キーの名前。 */
	readonly name: string;
	readonly requests: number;
	readonly chars: number;
	readonly credits: number;
}

export interface AivisVoiceUsage {
	readonly keyId: string;
	readonly fetchedAt: number;
	/** 取れなかったときの理由（このときは日別などが無い）。 */
	readonly error?: string;
	/** 古い順に 30 日。 */
	readonly days?: readonly AivisVoiceDay[];
	readonly byApiKey7?: readonly AivisVoiceKeyRow[];
	readonly byApiKey30?: readonly AivisVoiceKeyRow[];
	readonly creditBalance?: number | null;
}

export interface ElevenLabsVoiceDay {
	/** UTC の日付（YYYY-MM-DD）。 */
	readonly date: string;
	readonly chars: number;
}

export interface ElevenLabsVoiceRow {
	readonly label: string;
	readonly chars: number;
}

export interface ElevenLabsVoiceUsage {
	readonly keyId: string;
	readonly fetchedAt: number;
	readonly error?: string;
	readonly days?: readonly ElevenLabsVoiceDay[];
	readonly byModel7?: readonly ElevenLabsVoiceRow[];
	readonly byModel30?: readonly ElevenLabsVoiceRow[];
	readonly byVoice7?: readonly ElevenLabsVoiceRow[];
	readonly byVoice30?: readonly ElevenLabsVoiceRow[];
	readonly subscription?: { readonly used: number; readonly limit: number; readonly resetAt: number | null; readonly tier: string | null };
	readonly subscriptionUnavailable?: 'missing-permissions' | 'error';
}

export interface VoiceUsageResult {
	readonly fetchedAt: number;
	/** PC でいま使っている読み上げのエンジン。 */
	readonly engine: VoiceProvider;
	readonly aivis?: AivisVoiceUsage;
	readonly elevenLabs?: ElevenLabsVoiceUsage;
}

/** PC がこの要求を知らない（`usage.voice.v1` を広告しない古い PC）。送らずにこの失敗にする。 */
export class VoiceUsageUnsupportedError extends Error {
	constructor() {
		super('PC を更新すると出ます');
		this.name = 'VoiceUsageUnsupportedError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** 1 つの配列に読む要素の上限（相手は信用しない。30 日の日別と内訳には十分）。 */
const MAX_ITEMS = 100;
const MAX_TEXT = 300;

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value.slice(0, MAX_TEXT) : undefined;
}

/** 配列なら、読めた要素だけを残す（壊れた要素は捨てる）。配列でなければ undefined。 */
function list<T>(value: unknown, read: (item: Record<string, unknown>) => T | undefined): T[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const result: T[] = [];
	for (const item of value.slice(0, MAX_ITEMS)) {
		const parsed = isRecord(item) ? read(item) : undefined;
		if (parsed !== undefined) {
			result.push(parsed);
		}
	}
	return result;
}

/** 任意項目を、値があるときだけ足す（`undefined` の項目を作らない）。 */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return (value !== undefined ? { [key]: value } : {}) as { [P in K]?: V };
}

function aivisDay(item: Record<string, unknown>): AivisVoiceDay | undefined {
	const { date, requests, chars, credits } = item;
	return typeof date === 'string' && isFiniteNumber(requests) && isFiniteNumber(chars) && isFiniteNumber(credits)
		? { date: date.slice(0, 32), requests, chars, credits } : undefined;
}

function aivisKeyRow(item: Record<string, unknown>): AivisVoiceKeyRow | undefined {
	const { name, requests, chars, credits } = item;
	return typeof name === 'string' && isFiniteNumber(requests) && isFiniteNumber(chars) && isFiniteNumber(credits)
		? { name: name.slice(0, MAX_TEXT), requests, chars, credits } : undefined;
}

function elevenLabsDay(item: Record<string, unknown>): ElevenLabsVoiceDay | undefined {
	return typeof item['date'] === 'string' && isFiniteNumber(item['chars']) ? { date: item['date'].slice(0, 32), chars: item['chars'] } : undefined;
}

function elevenLabsRow(item: Record<string, unknown>): ElevenLabsVoiceRow | undefined {
	return typeof item['label'] === 'string' && isFiniteNumber(item['chars']) ? { label: item['label'].slice(0, MAX_TEXT), chars: item['chars'] } : undefined;
}

function head(value: unknown): { keyId: string; fetchedAt: number; error?: string } | undefined {
	if (!isRecord(value) || typeof value['keyId'] !== 'string' || value['keyId'].length === 0 || value['keyId'].length > 64 || !isFiniteNumber(value['fetchedAt'])) {
		return undefined;
	}
	return { keyId: value['keyId'], fetchedAt: value['fetchedAt'], ...optional('error', text(value['error'])) };
}

function parseAivis(value: unknown): AivisVoiceUsage | undefined {
	const base = head(value);
	if (base === undefined || !isRecord(value)) {
		return undefined;
	}
	const balance = value['creditBalance'];
	return {
		...base,
		...optional('days', list(value['days'], aivisDay)),
		...optional('byApiKey7', list(value['byApiKey7'], aivisKeyRow)),
		...optional('byApiKey30', list(value['byApiKey30'], aivisKeyRow)),
		...optional('creditBalance', isFiniteNumber(balance) ? balance : balance === null ? null : undefined),
	};
}

function parseSubscription(value: unknown): ElevenLabsVoiceUsage['subscription'] {
	if (!isRecord(value) || !isFiniteNumber(value['used']) || !isFiniteNumber(value['limit'])) {
		return undefined;
	}
	const resetAt = value['resetAt'];
	const tier = value['tier'];
	return { used: value['used'], limit: value['limit'], resetAt: isFiniteNumber(resetAt) ? resetAt : null, tier: typeof tier === 'string' ? tier.slice(0, 64) : null };
}

function parseElevenLabs(value: unknown): ElevenLabsVoiceUsage | undefined {
	const base = head(value);
	if (base === undefined || !isRecord(value)) {
		return undefined;
	}
	const unavailable = value['subscriptionUnavailable'];
	return {
		...base,
		...optional('days', list(value['days'], elevenLabsDay)),
		...optional('byModel7', list(value['byModel7'], elevenLabsRow)),
		...optional('byModel30', list(value['byModel30'], elevenLabsRow)),
		...optional('byVoice7', list(value['byVoice7'], elevenLabsRow)),
		...optional('byVoice30', list(value['byVoice30'], elevenLabsRow)),
		...optional('subscription', parseSubscription(value['subscription'])),
		...optional<'subscriptionUnavailable', 'missing-permissions' | 'error'>('subscriptionUnavailable', unavailable === 'missing-permissions' || unavailable === 'error' ? unavailable : undefined),
	};
}

/**
 * PC の応答・端末の控えを読む（相手は信用しない）。数は有限の数、文字は文字列のものだけを残し、壊れた要素・項目は捨てる。
 * 全体の形（取得時刻・エンジン）が読めなければ undefined。エンジンの部分が読めなければ、その部分だけを捨てる。
 */
export function parseVoiceUsageResult(value: unknown): VoiceUsageResult | undefined {
	if (!isRecord(value) || !isFiniteNumber(value['fetchedAt']) || (value['engine'] !== 'aivis' && value['engine'] !== 'elevenlabs')) {
		return undefined;
	}
	return {
		fetchedAt: value['fetchedAt'],
		engine: value['engine'],
		...optional('aivis', parseAivis(value['aivis'])),
		...optional('elevenLabs', parseElevenLabs(value['elevenLabs'])),
	};
}

/** 形をざっと確かめる（{@link parseVoiceUsageResult} が読めるか）。 */
export function isVoiceUsageResult(value: unknown): value is VoiceUsageResult {
	return parseVoiceUsageResult(value) !== undefined;
}
