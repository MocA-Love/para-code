/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ElevenLabs の声ごとの調整（voice_settings の stability・similarity_boost）。通知の合成で送る値の組み立てと、
// エージェントの読み上げ（aivis-mcp 2.5.4 以上）へ同じ値を書く手順の判定を持つ。
//
// 値が無い声は何も送らない（ElevenLabs のサイトでその声に保存した値が使われる）。
// v3 系のモデルは stability を 0 / 0.5 / 1 の 3 段でしか受け付けないので、送る直前に最寄りへ丸める。
//
// aivis-mcp 2.5.4 の取り決め:
//   aivis-mcp --set-voice-settings --voice <voice_id> [--stability <0〜1>] [--similarity <0〜1>]
//   aivis-mcp --clear-voice-settings --voice <voice_id>
// 成功は標準出力に `ok` の 1 行で終了 0。失敗は標準エラーに `error: <理由>` で終了 1。
// 書いた値は aivis-mcp の `config.json` の `elevenlabs.voiceSettings[<voice_id>]` に入る。

const VOICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** aivis-mcp が声の調整の鍵として拒む名前（Object の性質の名前）。 */
const RESERVED_VOICE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

/** aivis-mcp・ElevenLabs が受け付ける voice_id の形か（英数字と `-` `_`、128 文字まで。Object の性質の名前は拒む）。 */
export function paradisIsElevenLabsVoiceId(voiceId: string): boolean {
	return VOICE_ID.test(voiceId) && !RESERVED_VOICE_IDS.has(voiceId);
}

/** `--set-voice-settings` / `--clear-voice-settings` を持つ aivis-mcp の版。 */
export const PARADIS_VOICE_TUNING_MIN_VERSION: readonly [number, number, number] = [2, 5, 4];

/** スライダーの刻み。 */
export const PARADIS_VOICE_TUNING_STEP = 0.05;

/** 1 つの声の調整。どちらも 0〜1。無い項目は送らない。 */
export interface IParadisElevenLabsVoiceTuning {
	readonly stability?: number;
	readonly similarityBoost?: number;
}

/** 声（voice_id）ごとの調整。 */
export type IParadisElevenLabsVoiceTuningMap = Readonly<Record<string, IParadisElevenLabsVoiceTuning>>;

/** 0〜1 に収め、0.05 刻みに丸める。数でなければ undefined。 */
export function paradisNormalizeTuningValue(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined;
	}
	const clamped = Math.max(0, Math.min(1, value));
	return Math.round(Math.round(clamped / PARADIS_VOICE_TUNING_STEP) * PARADIS_VOICE_TUNING_STEP * 100) / 100;
}

function exactTuningValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/**
 * 1 つの声の調整を形の分かる値に直す。項目が 1 つも無ければ undefined。
 * `exact` は aivis-mcp 側の値を読むとき用で、丸めずに 0〜1 の外だけを捨てる（利用者が CLI で入れた
 * 0.51 を 0.5 と見なして、Para Code の値と取り違えないように）。
 */
export function paradisNormalizeVoiceTuning(raw: unknown, exact = false): IParadisElevenLabsVoiceTuning | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const value = raw as { stability?: unknown; similarityBoost?: unknown };
	const pick = exact ? exactTuningValue : paradisNormalizeTuningValue;
	const stability = pick(value.stability);
	const similarityBoost = pick(value.similarityBoost);
	if (stability === undefined && similarityBoost === undefined) {
		return undefined;
	}
	return {
		...(stability !== undefined ? { stability } : {}),
		...(similarityBoost !== undefined ? { similarityBoost } : {}),
	};
}

/** 保存値や IPC 越しの値を、声ごとの調整に直す。ID の形が違う声・中身の無い声は捨てる。 */
export function paradisNormalizeVoiceTuningMap(raw: unknown, exact = false): IParadisElevenLabsVoiceTuningMap {
	const result: Record<string, IParadisElevenLabsVoiceTuning> = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return result;
	}
	for (const [voiceId, value] of Object.entries(raw as Record<string, unknown>)) {
		const tuning = paradisIsElevenLabsVoiceId(voiceId) ? paradisNormalizeVoiceTuning(value, exact) : undefined;
		if (tuning) {
			result[voiceId] = tuning;
		}
	}
	return result;
}

/** 2 つの調整が同じか（無い項目どうしも同じとみなす）。 */
export function paradisSameVoiceTuning(a: IParadisElevenLabsVoiceTuning | undefined, b: IParadisElevenLabsVoiceTuning | undefined): boolean {
	return a?.stability === b?.stability && a?.similarityBoost === b?.similarityBoost;
}

/** v3 系（`eleven_v3`・`eleven_v3_...`）か。stability は 3 段だけ。 */
export function paradisIsElevenLabsV3Model(modelId: string): boolean {
	return /^eleven_v3(?:_|$)/.test(modelId);
}

/** v4 系（`eleven_v4`・`eleven_v4_turbo` など）か。話速（speed）を送っても効かない。 */
export function paradisElevenLabsModelIgnoresSpeed(modelId: string): boolean {
	return /^eleven_v4(?:_|$)/.test(modelId);
}

/** v3 系に送る stability（0 / 0.5 / 1 の最寄り）。ちょうど中間は高い方へ寄せる。 */
export function paradisRoundV3Stability(value: number): number {
	if (value < 0.25) {
		return 0;
	}
	return value < 0.75 ? 0.5 : 1;
}

/** 合成の要求に入れる `voice_settings`。調整の値はある項目だけを入れる。 */
export function paradisElevenLabsVoiceSettingsBody(modelId: string, speed: number, tuning: IParadisElevenLabsVoiceTuning | undefined): Record<string, number> {
	const body: Record<string, number> = { speed };
	const stability = paradisNormalizeTuningValue(tuning?.stability);
	if (stability !== undefined) {
		body.stability = paradisIsElevenLabsV3Model(modelId) ? paradisRoundV3Stability(stability) : stability;
	}
	const similarityBoost = paradisNormalizeTuningValue(tuning?.similarityBoost);
	if (similarityBoost !== undefined) {
		body.similarity_boost = similarityBoost;
	}
	return body;
}

/** `GET /v1/voices/{voice_id}/settings` の返事から、保存値の stability・similarity_boost を取る。 */
export function paradisToElevenLabsSavedVoiceTuning(raw: unknown): IParadisElevenLabsVoiceTuning {
	const value = (raw && typeof raw === 'object' ? raw : {}) as { stability?: unknown; similarity_boost?: unknown };
	const stability = typeof value.stability === 'number' && Number.isFinite(value.stability) ? Math.max(0, Math.min(1, value.stability)) : undefined;
	const similarityBoost = typeof value.similarity_boost === 'number' && Number.isFinite(value.similarity_boost) ? Math.max(0, Math.min(1, value.similarity_boost)) : undefined;
	return {
		...(stability !== undefined ? { stability } : {}),
		...(similarityBoost !== undefined ? { similarityBoost } : {}),
	};
}

// --- エージェントの読み上げ（aivis-mcp）への同期 ----------------------------------------------------

export type ParadisVoiceTuningStep =
	| { readonly kind: 'set'; readonly voiceId: string; readonly tuning: IParadisElevenLabsVoiceTuning }
	| { readonly kind: 'clear'; readonly voiceId: string }
	/** 書いた値が aivis-mcp 側でもう別のものに変わっていた。消さずに、覚えている値だけ忘れる。 */
	| { readonly kind: 'forget'; readonly voiceId: string };

/**
 * 1 つの声について、aivis-mcp へ何をするかを決める（辞書と同じ考え方）。
 *
 * - 使う設定で値がある: 前回書いた値と同じ、または aivis-mcp に既に同じ値が入っているなら何もしない。
 *   aivis-mcp 側に、渡す値に無い項目が残っているときは、先に消してから書く（`--set-voice-settings` は指定した
 *   項目だけを置き換え、1 項目だけを消す引数は無いので 1 回では済まない）。消してから書くまでの間（CLI 1 回分）に
 *   worker が読むと、その発話は ElevenLabs の保存値で鳴る。設定画面はスライダーの 2 項目をいつも揃えて書くので、
 *   この手順になるのは設定ファイルを手で直して 1 項目だけにしたときだけで、そのずれは許す
 * - 使わない設定か、値が無い: Para Code が書いた値がそのまま残っているときだけ消す。別の値に
 *   変わっていたら消さずに、覚えている値を忘れる。aivis-mcp の設定が読めなければ何もしない
 */
export function paradisPlanVoiceTuningSteps(
	voiceId: string,
	desired: IParadisElevenLabsVoiceTuning | undefined,
	written: IParadisElevenLabsVoiceTuning | undefined,
	current: IParadisElevenLabsVoiceTuningMap | undefined,
): ParadisVoiceTuningStep[] {
	if (!paradisIsElevenLabsVoiceId(voiceId)) {
		return [];
	}
	const now = current?.[voiceId];
	if (desired) {
		if (paradisSameVoiceTuning(desired, written) || paradisSameVoiceTuning(desired, now)) {
			return [];
		}
		const leftover = now !== undefined && ((now.stability !== undefined && desired.stability === undefined) || (now.similarityBoost !== undefined && desired.similarityBoost === undefined));
		const set: ParadisVoiceTuningStep = { kind: 'set', voiceId, tuning: desired };
		return leftover ? [{ kind: 'clear', voiceId }, set] : [set];
	}
	if (!written || current === undefined) {
		return [];
	}
	return [paradisSameVoiceTuning(now, written) ? { kind: 'clear', voiceId } : { kind: 'forget', voiceId }];
}

/** すべての声（使う設定の声と、前回書いた声）についての手順。 */
export function paradisPlanAllVoiceTuningSteps(
	enabled: boolean,
	desired: IParadisElevenLabsVoiceTuningMap,
	written: IParadisElevenLabsVoiceTuningMap,
	current: IParadisElevenLabsVoiceTuningMap | undefined,
): ParadisVoiceTuningStep[] {
	const voiceIds = [...new Set([...(enabled ? Object.keys(desired) : []), ...Object.keys(written)])].sort();
	return voiceIds.flatMap(voiceId => paradisPlanVoiceTuningSteps(voiceId, enabled ? desired[voiceId] : undefined, written[voiceId], current));
}

function formatTuningArg(value: number): string {
	return String(Math.round(value * 100) / 100);
}

/** aivis-mcp へ渡す引数。`forget` と、渡せない値のときは undefined。 */
export function paradisVoiceTuningArgs(step: ParadisVoiceTuningStep): string[] | undefined {
	// `-` で始まる ID は次の引数の名前と取り違えられるので渡さない
	if (!paradisIsElevenLabsVoiceId(step.voiceId) || step.voiceId.startsWith('-')) {
		return undefined;
	}
	switch (step.kind) {
		case 'set': {
			const args = ['--set-voice-settings', '--voice', step.voiceId];
			const stability = paradisNormalizeTuningValue(step.tuning.stability);
			const similarity = paradisNormalizeTuningValue(step.tuning.similarityBoost);
			if (stability !== undefined) {
				args.push('--stability', formatTuningArg(stability));
			}
			if (similarity !== undefined) {
				args.push('--similarity', formatTuningArg(similarity));
			}
			return args.length > 3 ? args : undefined;
		}
		case 'clear':
			return ['--clear-voice-settings', '--voice', step.voiceId];
		case 'forget':
			return undefined;
	}
}

/** 手順を当てた後の「最後に書いた値」。 */
export function paradisApplyVoiceTuningStep(written: IParadisElevenLabsVoiceTuningMap, step: ParadisVoiceTuningStep): IParadisElevenLabsVoiceTuningMap {
	const next: Record<string, IParadisElevenLabsVoiceTuning> = { ...written };
	if (step.kind === 'set') {
		next[step.voiceId] = step.tuning;
	} else {
		delete next[step.voiceId];
	}
	return next;
}

/** aivis-mcp の `config.json` から、今の声ごとの調整（`elevenlabs.voiceSettings`）を読む。 */
export function paradisVoiceTuningFromConfig(config: unknown): IParadisElevenLabsVoiceTuningMap {
	const elevenlabs = config && typeof config === 'object' ? (config as Record<string, unknown>).elevenlabs : undefined;
	const voiceSettings = elevenlabs && typeof elevenlabs === 'object' ? (elevenlabs as Record<string, unknown>).voiceSettings : undefined;
	return paradisNormalizeVoiceTuningMap(voiceSettings, true);
}
