/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログで、この PC の aivis-mcp の音量の表（`--list-gains`）を読む口と、その短い間の写し。
// 音声報告の「この声の音量の補正」と「音量の補正」ページの両方が使う。音声報告は設定を変えるたびに
// 描き直されるので、そのたびに aivis-mcp を起動しないよう少しの間覚える。
// ElevenLabs の声の保存値（`/v1/voices/{voice_id}/settings`）も同じ理由でここに覚える。

import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisVoiceGainList, PARADIS_VOICE_GAINS_CHANNEL, ParadisVoiceGainsResult } from '../common/paradisVoiceGains.js';
import { IParadisElevenLabsVoiceTuning } from '../common/paradisVoiceTuning.js';

const GAINS_TTL_MS = 15_000;

let gains: { readonly at: number; readonly result: Promise<ParadisVoiceGainsResult<IParadisVoiceGainList>> } | undefined;

/** 音量の表を読む。`force` で写しを使わない。失敗も `failed` として返す（reject しない）。 */
export function paradisLoadVoiceGains(sharedProcessService: ISharedProcessService, force = false): Promise<ParadisVoiceGainsResult<IParadisVoiceGainList>> {
	if (!force && gains && Date.now() - gains.at < GAINS_TTL_MS) {
		return gains.result;
	}
	const result = sharedProcessService.getChannel(PARADIS_VOICE_GAINS_CHANNEL).call<ParadisVoiceGainsResult<IParadisVoiceGainList>>('list')
		.catch((error): ParadisVoiceGainsResult<IParadisVoiceGainList> => ({ status: 'failed', message: error instanceof Error ? error.message : String(error) }));
	gains = { at: Date.now(), result };
	return result;
}

/** 表を書き換えた後に呼ぶ。 */
export function paradisForgetVoiceGains(): void {
	gains = undefined;
}

const savedVoiceSettings = new Map<string, IParadisElevenLabsVoiceTuning>();

function savedKey(apiKey: string, voiceId: string): string {
	return `${apiKey}\n${voiceId}`;
}

export function paradisGetCachedSavedVoiceSettings(apiKey: string, voiceId: string): IParadisElevenLabsVoiceTuning | undefined {
	return savedVoiceSettings.get(savedKey(apiKey, voiceId));
}

export function paradisSetCachedSavedVoiceSettings(apiKey: string, voiceId: string, tuning: IParadisElevenLabsVoiceTuning): void {
	savedVoiceSettings.set(savedKey(apiKey, voiceId), tuning);
}

/** 自動で取りに行って失敗した声（描き直しのたびに取りに行かない。「読み込む」では取り直す）。 */
const failedSavedLoads = new Set<string>();

export function paradisDidSavedVoiceSettingsFail(apiKey: string, voiceId: string): boolean {
	return failedSavedLoads.has(savedKey(apiKey, voiceId));
}

export function paradisMarkSavedVoiceSettingsFailed(apiKey: string, voiceId: string): void {
	failedSavedLoads.add(savedKey(apiKey, voiceId));
}

/** 覚えた値を全部捨てる（テスト用）。 */
export function paradisClearVoiceTuningCaches(): void {
	gains = undefined;
	savedVoiceSettings.clear();
	failedSavedLoads.clear();
}
