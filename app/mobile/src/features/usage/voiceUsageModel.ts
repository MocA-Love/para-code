// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isNoResponseError, isOldValue, type SeenOn, type Timed, type UsageEntry } from './usageAggregate.js';
import {
	VoiceUsageUnsupportedError,
	type AivisVoiceDay,
	type AivisVoiceKeyRow,
	type AivisVoiceUsage,
	type ElevenLabsVoiceDay,
	type ElevenLabsVoiceRow,
	type ElevenLabsVoiceUsage,
	type VoiceProvider,
	type VoiceUsageResult,
} from './voiceUsageWire.js';

/**
 * 読み上げ（Aivis・ElevenLabs）の使用量の、画面から切り離した算出（`voiceUsageModel.test.ts` で固定）。
 *
 * - PC が複数でも、同じキー（PC が付けたキーの印 `keyId` が同じ）は 1 つにまとめ、違うキーは別々に出す
 *   （{@link groupVoiceUsage}）。まとめた中では、取れている値 → 新しい値の順に 1 つを採る
 * - 眠っている PC の値は最後に取れた値を「古い値」（`old`）として出す（使用量の他の指標と同じ {@link isOldValue}）
 * - 最初に見せるエンジンは、PC で今使っているエンジン（{@link initialVoiceProvider}）
 * - 7 日は、PC が送った 30 日の末尾から切り出す（内訳だけは PC が 7 日ぶんを別に送る）
 */

export type VoicePeriod = 7 | 30;

/** まとめた 1 つのキー（同じキーを使っている PC をまとめたもの）。 */
export interface VoiceKeyGroup<T> {
	readonly provider: VoiceProvider;
	/** `<provider>:<keyId>`（切り替えの選択に使う）。 */
	readonly key: string;
	/** 使っている PC の名前（`・` でつなぐ）。 */
	readonly label: string;
	/** 使っている PC（古い値の PC は薄く）。 */
	readonly seenOn: readonly SeenOn[];
	/** 採った値。 */
	readonly usage: T;
	/** 採った値を取った PC の名前。 */
	readonly fromPc: string;
	/** 採った値が古い（PC がオフライン、または取り直していない）。 */
	readonly old: boolean;
}

export interface VoiceUsageGroups {
	readonly elevenLabs: readonly VoiceKeyGroup<ElevenLabsVoiceUsage>[];
	readonly aivis: readonly VoiceKeyGroup<AivisVoiceUsage>[];
}

interface Candidate<T> {
	readonly entry: UsageEntry;
	readonly usage: T;
	readonly old: boolean;
}

function groupProvider<T extends { readonly keyId: string; readonly fetchedAt: number; readonly error?: string }>(
	provider: VoiceProvider,
	candidates: readonly Candidate<T>[],
): VoiceKeyGroup<T>[] {
	const order: string[] = [];
	const byKey = new Map<string, Candidate<T>[]>();
	for (const candidate of candidates) {
		const list = byKey.get(candidate.usage.keyId);
		if (list !== undefined) {
			list.push(candidate);
		} else {
			order.push(candidate.usage.keyId);
			byKey.set(candidate.usage.keyId, [candidate]);
		}
	}
	return order.map(keyId => {
		const list = byKey.get(keyId)!;
		// 取れている値 → 新しい値（古い値の印が無い方）→ 取得時刻の新しい値
		const chosen = [...list].sort((a, b) => Number(a.usage.error !== undefined) - Number(b.usage.error !== undefined)
			|| Number(a.old) - Number(b.old)
			|| b.usage.fetchedAt - a.usage.fetchedAt)[0]!;
		const names = [...new Set(list.map(item => item.entry.label))];
		return {
			provider,
			key: `${provider}:${keyId}`,
			label: names.join('・'),
			seenOn: list.map(item => ({ key: item.entry.key, label: item.entry.label, old: item.old })),
			usage: chosen.usage,
			fromPc: chosen.entry.label,
			old: chosen.old,
		};
	});
}

/** PC の値をエンジンごと・キーごとにまとめる（並びは PC の並びで、初めて出てきた順）。 */
export function groupVoiceUsage(entries: readonly UsageEntry[], now: number): VoiceUsageGroups {
	const elevenLabs: Candidate<ElevenLabsVoiceUsage>[] = [];
	const aivis: Candidate<AivisVoiceUsage>[] = [];
	for (const entry of entries) {
		const voice = entry.kind === 'pc' ? entry.values.voice : undefined;
		if (voice === undefined) {
			continue;
		}
		const old = isOldValue(entry, voice, now);
		if (voice.value.elevenLabs !== undefined) {
			elevenLabs.push({ entry, usage: voice.value.elevenLabs, old });
		}
		if (voice.value.aivis !== undefined) {
			aivis.push({ entry, usage: voice.value.aivis, old });
		}
	}
	return { elevenLabs: groupProvider('elevenlabs', elevenLabs), aivis: groupProvider('aivis', aivis) };
}

/**
 * PC で今使っているエンジンを、見るべき順に並べる。`preferredPcId`（いま見ている PC）があればその PC を先に、
 * 残りは取得時刻の新しい順。
 */
export function voiceEnginesByPreference(entries: readonly UsageEntry[], preferredPcId: string | undefined): VoiceProvider[] {
	const withVoice = entries.filter(entry => entry.kind === 'pc' && entry.values.voice !== undefined);
	const sorted = [...withVoice].sort((a, b) => Number(b.pcId === preferredPcId) - Number(a.pcId === preferredPcId)
		|| (b.values.voice!.at - a.values.voice!.at));
	return sorted.map(entry => entry.values.voice!.value.engine);
}

/**
 * 最初に見せるエンジン。PC で今使っているエンジンのうち、出せるもの（キーがある）の最初。どれも出せなければ、
 * 出せるものの最初（ElevenLabs → Aivis の順）。何も出せなければ undefined。
 */
export function initialVoiceProvider(available: readonly VoiceProvider[], engines: readonly VoiceProvider[]): VoiceProvider | undefined {
	for (const engine of engines) {
		if (available.includes(engine)) {
			return engine;
		}
	}
	return (['elevenlabs', 'aivis'] as const).find(provider => available.includes(provider));
}

/** 何も出せないときの理由。 */
export type VoiceEmptyReason = 'no-keys' | 'update-pc' | 'loading' | 'not-fetched' | 'failed';

/**
 * 出すものが無い（どのキーも無い）ときに、何と言うか。
 * - どれかの PC から値が届いていてキーが無い → `no-keys`（「PC の通知の設定で API キーを入れると出ます」）
 * - 取りに行けた PC がどれも古い（`usage.voice.v1` を広告しない）→ `update-pc`
 */
export function voiceEmptyReason(input: {
	readonly groups: VoiceUsageGroups;
	readonly anyValue: boolean;
	readonly errors: readonly unknown[];
	readonly loading: boolean;
}): VoiceEmptyReason | undefined {
	if (input.groups.elevenLabs.length > 0 || input.groups.aivis.length > 0) {
		return undefined;
	}
	if (input.anyValue) {
		return 'no-keys';
	}
	if (input.loading) {
		return 'loading';
	}
	if (input.errors.length > 0 && input.errors.every(error => error instanceof VoiceUsageUnsupportedError)) {
		return 'update-pc';
	}
	return input.errors.length > 0 ? 'failed' : 'not-fetched';
}

/** 理由の一文。 */
export function voiceEmptyText(reason: VoiceEmptyReason): string {
	switch (reason) {
		case 'no-keys': return 'PC の通知の設定で API キーを入れると出ます';
		case 'update-pc': return 'PC を更新すると出ます';
		case 'loading': return '取得しています…';
		case 'failed': return '取得できませんでした';
		case 'not-fetched': return 'まだ取得していません';
	}
}

/** 取得の失敗の一文（古い PC は「PC を更新すると出ます」、時間切れは前回の値の話）。 */
export function voiceErrorText(error: unknown, hasPrevious: boolean): string {
	if (error instanceof VoiceUsageUnsupportedError) {
		return 'PC を更新すると出ます';
	}
	if (isNoResponseError(error)) {
		return hasPrevious ? 'PC の応答に時間がかかっています。前回の値を表示しています' : 'PC の応答に時間がかかっています。しばらくしてから取り直してください';
	}
	return String(error instanceof Error ? error.message : error);
}

// --- 失敗したときの引き継ぎ ---------------------------------------------------------------

/** エンジンの部分が失敗だけ（日別が無い）なら、同じキーの前回の値に失敗の理由を添えたものにする。 */
function carryPart<T extends { readonly keyId: string; readonly error?: string; readonly days?: readonly unknown[] }>(previous: T | undefined, next: T | undefined): T | undefined {
	if (next === undefined || next.error === undefined || next.days !== undefined || previous === undefined || previous.keyId !== next.keyId || previous.days === undefined) {
		return next;
	}
	return { ...previous, error: next.error };
}

/**
 * 新しく届いた読み上げの使用量に、前回の値を引き継ぐ。片方のエンジンが失敗だけを返したとき（PC が再起動した直後で
 * PC 側に前回の値が無いときなど）に、端末に残っている前回の日別・内訳を消さない。表示は値を出したまま「更新に失敗」を添える。
 */
export function carryVoiceUsage(previous: VoiceUsageResult | undefined, next: VoiceUsageResult): VoiceUsageResult {
	if (previous === undefined) {
		return next;
	}
	const aivis = carryPart(previous.aivis, next.aivis);
	const elevenLabs = carryPart(previous.elevenLabs, next.elevenLabs);
	return { ...next, ...(aivis !== undefined ? { aivis } : {}), ...(elevenLabs !== undefined ? { elevenLabs } : {}) };
}

/** {@link carryVoiceUsage} の、取得時刻つきの値の版（使用量の控えに入れる直前に使う）。 */
export function carryVoiceResult(previous: Timed<VoiceUsageResult> | undefined, next: Timed<VoiceUsageResult>): Timed<VoiceUsageResult> {
	return { ...next, value: carryVoiceUsage(previous?.value, next.value) };
}

// --- 期間の切り出し ---------------------------------------------------------------------

export interface AivisPeriodView {
	readonly days: readonly AivisVoiceDay[];
	readonly requests: number;
	readonly chars: number;
	readonly credits: number;
	readonly byApiKey: readonly AivisVoiceKeyRow[];
	/** 内訳の期間（7 日の内訳が届いていなければ 30 日のものを出す）。 */
	readonly breakdownDays: VoicePeriod;
}

/** 期間の内訳。7 日の内訳が届いていなければ 30 日の内訳にする（`breakdownDays` で画面が期間を書き分ける）。 */
function breakdownFor<R, T>(period: VoicePeriod, short: readonly R[] | undefined, long: readonly R[] | undefined, wrap: (rows: readonly R[]) => T): T & { readonly breakdownDays: VoicePeriod } {
	return period === 7 && short !== undefined ? { ...wrap(short), breakdownDays: 7 } : { ...wrap(long ?? []), breakdownDays: 30 };
}

/** Aivis の 7 日・30 日（日別は 30 日の末尾から切り出す）。 */
export function aivisPeriodView(usage: AivisVoiceUsage, period: VoicePeriod): AivisPeriodView {
	const days = (usage.days ?? []).slice(-period);
	return {
		days,
		requests: days.reduce((sum, day) => sum + day.requests, 0),
		chars: days.reduce((sum, day) => sum + day.chars, 0),
		credits: days.reduce((sum, day) => sum + day.credits, 0),
		...breakdownFor(period, usage.byApiKey7, usage.byApiKey30, byApiKey => ({ byApiKey })),
	};
}

export interface ElevenLabsPeriodView {
	readonly days: readonly ElevenLabsVoiceDay[];
	readonly chars: number;
	readonly byModel: readonly ElevenLabsVoiceRow[];
	readonly byVoice: readonly ElevenLabsVoiceRow[];
	/** 内訳の期間（7 日の内訳が届いていなければ 30 日のものを出す）。 */
	readonly breakdownDays: VoicePeriod;
}

/** ElevenLabs の 7 日・30 日。 */
export function elevenLabsPeriodView(usage: ElevenLabsVoiceUsage, period: VoicePeriod): ElevenLabsPeriodView {
	const days = (usage.days ?? []).slice(-period);
	return {
		days,
		chars: days.reduce((sum, day) => sum + day.chars, 0),
		...(period === 7 && usage.byModel7 !== undefined && usage.byVoice7 !== undefined
			? { byModel: usage.byModel7, byVoice: usage.byVoice7, breakdownDays: 7 as const }
			: { byModel: usage.byModel30 ?? [], byVoice: usage.byVoice30 ?? [], breakdownDays: 30 as const }),
	};
}

/** プランの残り文字数と使った割合（0〜1）。上限が 0 なら割合は 0。 */
export function elevenLabsQuota(subscription: { readonly used: number; readonly limit: number }): { readonly remaining: number; readonly usedRatio: number } {
	return {
		remaining: Math.max(0, subscription.limit - subscription.used),
		usedRatio: subscription.limit > 0 ? Math.min(1, Math.max(0, subscription.used / subscription.limit)) : 0,
	};
}

// --- 表示の文 ----------------------------------------------------------------------------

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** `YYYY-MM-DD` → `10/2（木）`。形が違えばそのまま返す。 */
export function voiceDayLabel(date: string): string {
	const match = /^(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})$/.exec(date);
	if (match?.groups === undefined) {
		return date;
	}
	const { y, m, d } = match.groups as { y: string; m: string; d: string };
	const weekday = new Date(Number(y), Number(m) - 1, Number(d)).getDay();
	return `${Number(m)}/${Number(d)}（${WEEKDAYS[weekday]}）`;
}

/** `YYYY-MM-DD` → `10/2`（グラフの両端）。 */
export function voiceShortDate(date: string): string {
	const match = /^\d{4}-(?<m>\d{2})-(?<d>\d{2})$/.exec(date);
	return match?.groups !== undefined ? `${Number(match.groups['m'])}/${Number(match.groups['d'])}` : date;
}

/** 戻る日（unix ミリ秒）→ `10/21`。 */
export function voiceResetLabel(resetAt: number | null): string | undefined {
	if (resetAt === null || !Number.isFinite(resetAt)) {
		return undefined;
	}
	const date = new Date(resetAt);
	return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** クレジットの書き方（PC の画面と同じく小数 2 桁）。 */
export function formatCredits(value: number): string {
	return value.toFixed(2);
}

/** 通知と音声の「読み上げの使用量」の行の補足（例: `ElevenLabs 残り 38,460 文字・Aivis 残高 1,000`）。 */
export function voiceSummaryHint(groups: VoiceUsageGroups): string | undefined {
	const parts: string[] = [];
	const elevenLabs = groups.elevenLabs.find(group => group.usage.subscription !== undefined);
	if (elevenLabs?.usage.subscription !== undefined) {
		parts.push(`ElevenLabs 残り ${elevenLabsQuota(elevenLabs.usage.subscription).remaining.toLocaleString()} 文字`);
	} else if (groups.elevenLabs.length > 0) {
		parts.push('ElevenLabs');
	}
	const aivis = groups.aivis.find(group => typeof group.usage.creditBalance === 'number');
	if (typeof aivis?.usage.creditBalance === 'number') {
		parts.push(`Aivis 残高 ${aivis.usage.creditBalance.toLocaleString()}`);
	} else if (groups.aivis.length > 0) {
		parts.push('Aivis');
	}
	return parts.length > 0 ? parts.join('・') : undefined;
}
