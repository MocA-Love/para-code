/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 声とモデルの組ごとの音量の表の写し（設計 3.2・3.3）。どの声も -20 LUFS に揃える。
// 正は aivis-mcp 2.5.0 の src/audio/gain-table.ts（INITIAL_GAIN_DB）。手元に aivis-mcp 2.5.0 が無く、
// Para Code が自分で鳴らすとき（afplay 等）だけ使う。2.5.0 があれば `--ingest` の `gain?` で取った
// 表（覚え直した値を含む）を優先する。

/** 揃える大きさ。 */
export const PARADIS_VOICE_TARGET_LUFS = -20;
/** 上げる方向の上限（表の値にも、最後の合計にも掛ける）。 */
export const PARADIS_VOICE_MAX_BOOST_DB = 8;
const MIN_FINAL_DB = -60;

/** 最初の値（目標 -20 − 実測 LUFS）。aivis-mcp 2.5.0 の INITIAL_GAIN_DB と同じ。 */
export const PARADIS_VOICE_INITIAL_GAIN_DB: Readonly<Record<string, number>> = {
	'elevenlabs:p2RZwE9UMQp5xjKPWM5c:eleven_v4_turbo': -7.4,
	'elevenlabs:p2RZwE9UMQp5xjKPWM5c:eleven_v3': -10.4,
	'elevenlabs:p2RZwE9UMQp5xjKPWM5c:eleven_flash_v2_5': -11.0,
	'elevenlabs:ZVu8zjKuHze7jtI0hoZK:eleven_v4_turbo': 0.0,
	'elevenlabs:ZVu8zjKuHze7jtI0hoZK:eleven_v3': -5.1,
	'elevenlabs:ZVu8zjKuHze7jtI0hoZK:eleven_flash_v2_5': -3.6,
	'elevenlabs:LSiB0PSif0xwvbQ34IjW:eleven_v4_turbo': 0.0,
	'elevenlabs:LSiB0PSif0xwvbQ34IjW:eleven_v3': -3.1,
	'elevenlabs:LSiB0PSif0xwvbQ34IjW:eleven_flash_v2_5': -4.6,
	'elevenlabs:fzUpiMn8RWy33hh3Oyex:eleven_v4_turbo': 0.5,
	'elevenlabs:fzUpiMn8RWy33hh3Oyex:eleven_v3': -2.1,
	'elevenlabs:fzUpiMn8RWy33hh3Oyex:eleven_flash_v2_5': -3.8,
	'elevenlabs:wdu0pCCtM4iELsmsPURL:eleven_v4_turbo': 1.4,
	'elevenlabs:wdu0pCCtM4iELsmsPURL:eleven_v3': -2.5,
	'elevenlabs:wdu0pCCtM4iELsmsPURL:eleven_flash_v2_5': -3.2,
	'aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default': 4.1,
	'aivis:f13c2ec8-1069-403f-a23e-503b3a270c57:default': 4.9,
	'aivis:734c12b6-eaf2-4dbd-8596-8663c72d2afa:default': 4.5,
};

/** 音量の表（`gain?` の返事、または写し）。 */
export interface IParadisVoiceGainTable {
	readonly entries: Readonly<Record<string, number>>;
	readonly defaultDb: number;
	/** 利用者の上乗せ（aivis-mcp の volume_db の移行分・AIVIS_VOLUME_OFFSET_DB）。どの声にも足す。 */
	readonly volumeOffsetDb?: number;
	/** ElevenLabs の声だけに足す上乗せ（古い ELEVENLABS_VOLUME_DB の読み替え）。 */
	readonly elevenLabsVolumeOffsetDb?: number;
}

export const PARADIS_VOICE_INITIAL_GAIN_TABLE: IParadisVoiceGainTable = { entries: PARADIS_VOICE_INITIAL_GAIN_DB, defaultDb: 0 };

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

function splitKey(key: string): { readonly provider: string; readonly model: string } | undefined {
	const first = key.indexOf(':');
	const last = key.lastIndexOf(':');
	if (first <= 0 || last <= first || last === key.length - 1) {
		return undefined;
	}
	return { provider: key.slice(0, first), model: key.slice(last + 1) };
}

/** ElevenLabs の鍵。 */
export function paradisElevenLabsGainKey(voiceId: string, modelId: string): string {
	return `elevenlabs:${voiceId}:${modelId}`;
}

/** Aivis の鍵。 */
export function paradisAivisGainKey(modelUuid: string): string {
	return `aivis:${modelUuid}:default`;
}

/** 鍵の補正値。知らない組は同じ provider・同じモデルの平均、それも無ければ既定値（aivis-mcp と同じ引き方）。 */
export function paradisResolveVoiceGainDb(key: string | undefined, table: IParadisVoiceGainTable = PARADIS_VOICE_INITIAL_GAIN_TABLE): number {
	if (key === undefined) {
		return table.defaultDb;
	}
	const exact = table.entries[key];
	if (typeof exact === 'number' && Number.isFinite(exact)) {
		return Math.min(PARADIS_VOICE_MAX_BOOST_DB, exact);
	}
	const parts = splitKey(key);
	if (parts === undefined) {
		return table.defaultDb;
	}
	const sameModel: number[] = [];
	for (const [candidate, value] of Object.entries(table.entries)) {
		const other = splitKey(candidate);
		if (other && other.provider === parts.provider && other.model === parts.model && Number.isFinite(value)) {
			sameModel.push(value);
		}
	}
	if (sameModel.length === 0) {
		return table.defaultDb;
	}
	return Math.min(PARADIS_VOICE_MAX_BOOST_DB, round1(sameModel.reduce((sum, value) => sum + value, 0) / sameModel.length));
}

/** `gain?` の返事を表として読む。壊れていれば undefined。 */
export function paradisParseVoiceGainTable(message: { readonly entries?: unknown; readonly defaultDb?: unknown; readonly volumeOffsetDb?: unknown; readonly elevenLabsVolumeOffsetDb?: unknown }): IParadisVoiceGainTable | undefined {
	if (typeof message.entries !== 'object' || message.entries === null || Array.isArray(message.entries)) {
		return undefined;
	}
	const entries: Record<string, number> = {};
	for (const [key, value] of Object.entries(message.entries as Record<string, unknown>)) {
		if (typeof value === 'number' && Number.isFinite(value) && key.length <= 300) {
			entries[key] = value;
		}
	}
	const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
	return {
		entries,
		defaultDb: finite(message.defaultDb) ?? 0,
		volumeOffsetDb: finite(message.volumeOffsetDb),
		elevenLabsVolumeOffsetDb: finite(message.elevenLabsVolumeOffsetDb),
	};
}

/**
 * Para Code の音量（0〜100 %）を dB に直す（`--ingest` のジョブの volumeDb）。0 以下は鳴らさない印として undefined。
 */
export function paradisVolumePercentToDb(volume: number): number | undefined {
	const value = Number.isFinite(volume) ? Math.min(100, volume) : 100;
	if (value <= 0) {
		return undefined;
	}
	return Math.max(MIN_FINAL_DB, round1(20 * Math.log10(value / 100)));
}

/**
 * Para Code が自分で（afplay 等で）鳴らすときの音量（0〜100）。表の補正と利用者の上乗せを足すが、100 を超える分は
 * 捨てる（aivis-mcp の afplay と同じく、頭打ちの無いプレイヤーで上げる方向は使わない。上げるのは 2.5.0 の worker
 * 経由のときだけ）。
 */
export function paradisCorrectedPlaybackVolume(volume: number, gainKey: string | undefined, table?: IParadisVoiceGainTable): number {
	const base = Math.max(0, Math.min(100, Number.isFinite(volume) ? volume : 100));
	if (base === 0) {
		return 0;
	}
	const offset = (table?.volumeOffsetDb ?? 0) + (gainKey?.startsWith('elevenlabs:') ? table?.elevenLabsVolumeOffsetDb ?? 0 : 0);
	const totalDb = 20 * Math.log10(base / 100) + paradisResolveVoiceGainDb(gainKey, table) + offset;
	return Math.min(100, 100 * Math.pow(10, totalDb / 20));
}
