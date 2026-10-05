// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { decodeUtf8, fromBase64Url, openNotify, sealNotify, toBase64Url } from '@para/protocol';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import type { GithubUsageResult, RateLimitsResult, RtkSavingsResult, UsageDashboardResult } from '../../store.js';
import { localDateKey } from '../../usageFormat.js';
import type { SourceUsageValues, Timed, UsageKind, UsageSourceKind } from './usageAggregate.js';
import { isVoiceUsageResult, parseVoiceUsageResult, type VoiceUsageResult } from './voiceUsageWire.js';

/**
 * 使用量の「最後に取れた値」の控え（出どころごと。取得時刻つき）。オフラインの PC の値を薄く出して合計に入れるため、
 * 端末に 7 日残す。ここは形の検査・期限切れの削除・切り詰め・封緘の純関数（ファイルの読み書きは `usageCacheFile.ts`）。
 *
 * 控えにはアカウントのメール・プロジェクト名・コストが入るので、「前回の一覧」（`lastKnownPcs.ts`）と同じく、その PC の
 * 通知鍵から HKDF でこの用途だけの鍵を導いて封緘する（ファイルだけ持ち出しても読めない）。PC の絶対パス
 * （`rawProject`・`rawName`）は保存前に落とし、表示に要る範囲（日別は 90 日、直近の一覧は数件）に切り詰める。
 */

export const USAGE_CACHE_VERSION = 2;
const USAGE_CACHE_PURPOSE = 'para.usage-cache';
/** 最後の値を残す期間（取得時刻から 7 日）。 */
export const USAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 日別・プロジェクト別を残す日数（コストの画面の集計期間の最大）。 */
export const USAGE_CACHE_DAYS = 90;
const MAX_SESSIONS = 20;
const MAX_HISTORY = 20;
const MAX_COMMANDS = 50;
const MAX_ERRORS = 10;
const MAX_TEXT = 200;

/** 出どころ1つぶんの控え。 */
export interface UsageCacheRecord {
	readonly kind: UsageSourceKind;
	readonly pcId: string;
	readonly pcName: string;
	readonly hostLabel?: string | undefined;
	/** SSH の接続先の機械のハッシュ（接続先のウィンドウを閉じた後も、同じ機械を1回だけ数えるため）。 */
	readonly machineIdHash?: string | undefined;
	readonly values: SourceUsageValues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function clampText(value: unknown): string | undefined {
	return typeof value === 'string' ? value.slice(0, MAX_TEXT) : undefined;
}

/** 値の形をざっと確かめる（自分で書いたファイルだが、版の違い・書きかけで画面が落ちないように）。 */
function parseTimed<T>(raw: unknown, valid: (value: Record<string, unknown>) => boolean): Timed<T> | undefined {
	if (!isRecord(raw) || !isFiniteNumber(raw['at']) || !isRecord(raw['value']) || !valid(raw['value'])) {
		return undefined;
	}
	return { value: raw['value'] as T, at: raw['at'], ...(isFiniteNumber(raw['receivedAt']) ? { receivedAt: raw['receivedAt'] } : {}) };
}

const VALIDATORS: Record<UsageKind, (value: Record<string, unknown>) => boolean> = {
	limits: value => isRecord(value['claude']) && isRecord(value['codex'])
		&& Array.isArray((value['claude'] as Record<string, unknown>)['accounts']) && Array.isArray((value['codex'] as Record<string, unknown>)['accounts']),
	cost: value => Array.isArray(value['days']) && Array.isArray(value['sessions']) && Array.isArray(value['projects']) && Array.isArray(value['failedReports']),
	rtk: value => Array.isArray(value['days']) && isRecord(value['totals']) && Array.isArray(value['commands']) && Array.isArray(value['history']) && Array.isArray(value['failedReports']),
	github: value => isFiniteNumber(value['generatedAt']) && Array.isArray(value['rateLimits']) && Array.isArray(value['operations'])
		&& Array.isArray(value['spaces']) && isRecord(value['totals']) && Array.isArray(value['lastErrors']) && Array.isArray(value['consumption']),
	voice: value => isVoiceUsageResult(value),
};

/** 読み上げの控えは壊れた要素を捨てて読み直す（版の違い・書きかけで画面が欠けた値を受け取らないように）。 */
function sanitizeVoice(timed: Timed<VoiceUsageResult> | undefined): Timed<VoiceUsageResult> | undefined {
	const value = timed !== undefined ? parseVoiceUsageResult(timed.value) : undefined;
	return timed !== undefined && value !== undefined ? { ...timed, value } : undefined;
}

/** 期限（7日）を過ぎた値を落とす。値が1つも残らなければ undefined。 */
export function pruneUsageRecord(record: UsageCacheRecord, now: number): UsageCacheRecord | undefined {
	const values: { -readonly [K in UsageKind]?: Timed<unknown> } = {};
	for (const kind of ['limits', 'cost', 'rtk', 'github', 'voice'] as const) {
		const value = record.values[kind];
		if (value !== undefined && now - value.at <= USAGE_CACHE_TTL_MS) {
			values[kind] = value;
		}
	}
	return Object.keys(values).length > 0 ? { ...record, values: values as SourceUsageValues } : undefined;
}

/** 控えの形を確かめて読む。形の合わない値は捨て、期限切れも落とす。 */
export function parseUsageRecord(raw: unknown, now: number): UsageCacheRecord | undefined {
	if (!isRecord(raw) || (raw['kind'] !== 'pc' && raw['kind'] !== 'ssh') || typeof raw['pcId'] !== 'string' || !isRecord(raw['values'])) {
		return undefined;
	}
	const rawValues = raw['values'];
	return pruneUsageRecord({
		kind: raw['kind'],
		pcId: raw['pcId'],
		pcName: clampText(raw['pcName']) ?? 'PC',
		hostLabel: clampText(raw['hostLabel']),
		machineIdHash: clampText(raw['machineIdHash']),
		values: {
			limits: parseTimed<RateLimitsResult>(rawValues['limits'], VALIDATORS.limits),
			cost: parseTimed<UsageDashboardResult>(rawValues['cost'], VALIDATORS.cost),
			rtk: parseTimed<RtkSavingsResult>(rawValues['rtk'], VALIDATORS.rtk),
			github: parseTimed<GithubUsageResult>(rawValues['github'], VALIDATORS.github),
			voice: sanitizeVoice(parseTimed<VoiceUsageResult>(rawValues['voice'], VALIDATORS.voice)),
		},
	}, now);
}

/**
 * 控えに残す形にする。PC の絶対パス（`rawProject`・`rawName`）を落とし、日別・プロジェクト別は直近 90 日、
 * 直近のセッション・コマンド・失敗は数件に切り詰める。
 */
export function prepareForCache(values: SourceUsageValues, now: number): SourceUsageValues {
	const since = localDateKey(new Date(now - (USAGE_CACHE_DAYS - 1) * 24 * 60 * 60 * 1000));
	const cost = values.cost;
	const rtk = values.rtk;
	const github = values.github;
	return {
		limits: values.limits,
		cost: cost !== undefined ? {
			...cost,
			value: {
				...cost.value,
				days: cost.value.days.filter(day => day.date >= since),
				projects: cost.value.projects
					.map(project => ({ name: project.name, rawName: '', dailyCosts: project.dailyCosts.filter(daily => daily.date >= since) }))
					.filter(project => project.dailyCosts.length > 0),
				sessions: cost.value.sessions.slice(0, MAX_SESSIONS).map(session => ({ ...session, rawProject: '' })),
			},
		} : undefined,
		rtk: rtk !== undefined ? {
			...rtk,
			value: {
				...rtk.value,
				days: rtk.value.days.filter(day => day.date >= since),
				commands: rtk.value.commands.slice(0, MAX_COMMANDS),
				history: rtk.value.history.slice(0, MAX_HISTORY),
			},
		} : undefined,
		github: github !== undefined ? { ...github, value: { ...github.value, lastErrors: github.value.lastErrors.slice(0, MAX_ERRORS) } } : undefined,
		// 読み上げは 30 日ぶんの数と内訳だけ（キーは PC から届かない）なので、そのまま残す
		voice: values.voice,
	};
}

/** 書き直すかの判定に使う印（指標ごとの取得時刻。変わらなければ書かない）。 */
export function usageRecordSignature(record: UsageCacheRecord): string {
	return [record.values.limits?.at, record.values.cost?.at, record.values.rtk?.at, record.values.github?.at, record.values.voice?.at, record.machineIdHash, record.hostLabel, record.pcName]
		.map(part => String(part ?? '')).join('|');
}

/** 通知鍵から、この用途だけの封緘鍵を導く（HKDF-SHA256、info は用途の印）。 */
export function usageCacheSealKey(notifyKey: Uint8Array): Uint8Array {
	return hkdf(sha256, notifyKey, undefined, new TextEncoder().encode(`${USAGE_CACHE_PURPOSE}.v${USAGE_CACHE_VERSION}`), 32);
}

/** 出どころ1つの控えを封緘して base64url にする（ファイルへ書く形）。`notifyKey` はその PC の通知鍵。 */
export function sealUsageRecord(notifyKey: Uint8Array, sourceKey: string, record: UsageCacheRecord, now: number): string {
	const plaintext = JSON.stringify({ v: USAGE_CACHE_VERSION, purpose: USAGE_CACHE_PURPOSE, sourceKey, record: { ...record, values: prepareForCache(record.values, now) } });
	return toBase64Url(sealNotify(usageCacheSealKey(notifyKey), new TextEncoder().encode(plaintext)));
}

/**
 * 封緘を開く。鍵が違う・壊れている・別の PC のもの・形が合わない・値が期限切れで残らないときは undefined。
 */
export function openUsageRecord(notifyKey: Uint8Array, sealed: string, pcId: string, now: number): { readonly sourceKey: string; readonly record: UsageCacheRecord } | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(decodeUtf8(openNotify(usageCacheSealKey(notifyKey), fromBase64Url(sealed))));
	} catch {
		return undefined;
	}
	if (!isRecord(raw) || raw['v'] !== USAGE_CACHE_VERSION || raw['purpose'] !== USAGE_CACHE_PURPOSE || typeof raw['sourceKey'] !== 'string') {
		return undefined;
	}
	const record = parseUsageRecord(raw['record'], now);
	const sourceKey = raw['sourceKey'];
	if (record === undefined || record.pcId !== pcId || (sourceKey !== `pc:${pcId}` && !sourceKey.startsWith(`ssh:${pcId}:`))) {
		return undefined;
	}
	return { sourceKey, record };
}
