/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルの「読み上げの使用量」（fs の `voiceUsage`、usage.voice.v1）。PC の通知の設定の「使用量 (日別)」と
// 同じ shared process の呼び出し（`PARADIS_NOTIFICATIONS_CHANNEL`）で Aivis と ElevenLabs の使用量を取り、
// キーを除いた結果だけを返す。形と組み立ては `paradisMobileVoiceUsage.ts`。
//
// - キーが入っているエンジンだけ取る（今使っていない方も。モバイルが切り替えて見る）
// - 同じキーの結果は 5 分覚える（引っ張って更新でも 30 秒以内は使い回す）。失敗は覚えない
// - 片方が失敗しても、もう片方は返す。失敗した方は、最後に取れた値に伏せ字にした理由（`error`）を添えて返す
//   （前に取れていなければ理由だけ）
// - 全体は 50 秒で打ち切る（使用量の他の要求と同じ）

import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisElevenLabsModel, IParadisElevenLabsUsageResult, ParadisElevenLabsSubscriptionResult } from '../../notifications/common/paradisElevenLabs.js';
import { IParadisAivisMeResult, IParadisAivisUsageResult, PARADIS_NOTIFICATIONS_CHANNEL } from '../../notifications/common/paradisNotifications.js';
import { IParadisNotificationsSettingsService } from '../../notifications/browser/paradisNotificationsSettings.js';
import { PARADIS_MOBILE_USAGE_DEADLINE_MS, paradisMobileUsageErrorReply, paradisWithHostDeadline } from '../common/paradisMobileHostDeadline.js';
import {
	IParadisMobileAivisUsage,
	IParadisMobileElevenLabsUsage,
	IParadisMobileVoiceUsage,
	PARADIS_MOBILE_VOICE_USAGE_DAYS,
	PARADIS_MOBILE_VOICE_USAGE_KIND,
	PARADIS_MOBILE_VOICE_USAGE_SHORT_DAYS,
	ParadisMobileVoiceUsageCache,
	paradisBuildMobileAivisUsage,
	paradisBuildMobileElevenLabsUsage,
	paradisMobileAivisUsageRange,
	paradisMobileVoiceKeyId,
	paradisMobileVoiceUsageFailure,
	paradisRedactVoiceUsageError,
} from '../common/paradisMobileVoiceUsage.js';
import { registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

/** エンジンとキーの印ごとの結果（ウィンドウと同じ寿命。ウィンドウを閉じれば消える）。 */
const aivisCache = new ParadisMobileVoiceUsageCache<IParadisMobileAivisUsage>();
const elevenLabsCache = new ParadisMobileVoiceUsageCache<IParadisMobileElevenLabsUsage>();

registerParadisMobileRequestHandler('fs', PARADIS_MOBILE_VOICE_USAGE_KIND, {
	handle(accessor, request, context) {
		const settingsService = accessor.get(IParadisNotificationsSettingsService);
		const sharedProcessService = accessor.get(ISharedProcessService);
		const bypass = request.bypassCache === true;
		const work = (async (): Promise<IParadisMobileVoiceUsage> => {
			// キーは起動後に安全な保存先から読み込む。読み終わる前だと「キーが無い」と答えてしまう。
			await settingsService.whenApiKeysLoaded();
			const settings = settingsService.getAivisSettings();
			const aivisKey = settings.apiKey;
			const elevenLabsKey = settings.elevenLabsApiKey;
			const keys = [aivisKey, elevenLabsKey];
			const channel = sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL);

			const loadAivis = async (keyId: string): Promise<IParadisMobileAivisUsage> => {
				const range = paradisMobileAivisUsageRange(Date.now());
				const [usage, me] = await Promise.all([
					channel.call<IParadisAivisUsageResult>('getAivisUsageDaily', [aivisKey, range.start, range.end]),
					channel.call<IParadisAivisMeResult>('getAivisMe', [aivisKey]).catch(() => null),
				]);
				return paradisBuildMobileAivisUsage(keyId, usage, me, range, Date.now());
			};
			const loadElevenLabs = async (keyId: string): Promise<IParadisMobileElevenLabsUsage> => {
				// 7 日の内訳は同じ取得の日別の内訳から作る（3 つ目の引数。古い shared process は無視し、そのときは 7 日の内訳を省く）
				const [usage, subscription, models] = await Promise.all([
					channel.call<IParadisElevenLabsUsageResult>('getElevenLabsUsage', [elevenLabsKey, PARADIS_MOBILE_VOICE_USAGE_DAYS, PARADIS_MOBILE_VOICE_USAGE_SHORT_DAYS]),
					channel.call<ParadisElevenLabsSubscriptionResult>('getElevenLabsSubscription', [elevenLabsKey]).catch(() => ({ kind: 'error' as const })),
					channel.call<IParadisElevenLabsModel[]>('listElevenLabsModels', [elevenLabsKey]).catch(() => []),
				]);
				return paradisBuildMobileElevenLabsUsage(keyId, usage, subscription, new Map(models.map(model => [model.modelId, model.name])), Date.now());
			};

			const aivisId = aivisKey ? paradisMobileVoiceKeyId('aivis', aivisKey) : undefined;
			const elevenLabsId = elevenLabsKey ? paradisMobileVoiceKeyId('elevenlabs', elevenLabsKey) : undefined;
			// キーを入れ替えたら、前のキーの結果は捨てる
			aivisCache.prune(new Set(aivisId !== undefined ? [aivisId] : []));
			elevenLabsCache.prune(new Set(elevenLabsId !== undefined ? [elevenLabsId] : []));
			const [aivis, elevenLabs] = await Promise.all([
				aivisId !== undefined
					? aivisCache.get(aivisId, bypass, () => loadAivis(aivisId)).catch((error): IParadisMobileAivisUsage => paradisMobileVoiceUsageFailure(aivisCache.lastGood(aivisId), aivisId, paradisRedactVoiceUsageError(error, keys), Date.now()))
					: undefined,
				elevenLabsId !== undefined
					? elevenLabsCache.get(elevenLabsId, bypass, () => loadElevenLabs(elevenLabsId)).catch((error): IParadisMobileElevenLabsUsage => paradisMobileVoiceUsageFailure(elevenLabsCache.lastGood(elevenLabsId), elevenLabsId, paradisRedactVoiceUsageError(error, keys), Date.now()))
					: undefined,
			]);
			return {
				fetchedAt: Date.now(),
				engine: settings.engine === 'elevenlabs' ? 'elevenlabs' : 'aivis',
				...(aivis !== undefined ? { aivis } : {}),
				...(elevenLabs !== undefined ? { elevenLabs } : {}),
			};
		})();
		return paradisWithHostDeadline(work, PARADIS_MOBILE_USAGE_DEADLINE_MS).then(
			data => context.reply({ t: PARADIS_MOBILE_VOICE_USAGE_KIND, data }),
			// 打ち切りは「応答なし」（no-response）。それ以外の失敗の文にもキーを混ぜない。
			error => {
				const reply = paradisMobileUsageErrorReply(error);
				const settings = settingsService.getAivisSettings();
				context.reply({ ...reply, error: paradisRedactVoiceUsageError(reply.error, [settings.apiKey, settings.elevenLabsApiKey]) });
			},
		);
	},
});
