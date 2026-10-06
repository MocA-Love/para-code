/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルから PC のおやすみモードを切り替える（fs の `dndSet`、notify.dnd-remote.v1。Q253 B）。
//
// shared process がウィンドウの lease を確かめてから、このウィンドウの renderer へ届ける（handleWindowFrame）。
// 書き込みは PC のステータスバー・通知設定と同じ `setDoNotDisturb` で、APPLICATION の storage なので全ウィンドウに効く
// （音・デスクトップ通知・読み上げ・aivis の --mute も PC で切り替えたときと同じに動く）。解除予定時刻は PC の時計で
// 計算する（「朝まで」は PC のタイムゾーンの 7:00）。スマホへのプッシュは止めない（Q228 A）。

import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IParadisNotificationsSettingsService } from '../../notifications/browser/paradisNotificationsSettings.js';
import { paradisIsDoNotDisturbDurationId, paradisResolveDoNotDisturbUntil } from '../../notifications/common/paradisDoNotDisturbRules.js';
import { IParadisMobileDoNotDisturbSetReply, IParadisMobileDoNotDisturbState, PARADIS_MOBILE_DND_SET_KIND, ParadisMobileDoNotDisturbOpLedger, paradisParseMobileDoNotDisturbSetRequest } from '../common/paradisMobileDoNotDisturb.js';
import { IParadisMobileRequestHandler, registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

/** 通知設定の今の状態を、ワイヤの形にする。 */
export function paradisMobileDoNotDisturbStateOf(state: { readonly enabled: boolean; readonly until: number | undefined }): IParadisMobileDoNotDisturbState {
	return !state.enabled ? { enabled: false } : state.until !== undefined ? { enabled: true, until: state.until } : { enabled: true };
}

/** {@link paradisCreateMobileDoNotDisturbSetHandler} が使う、通知設定の読み書き。 */
export type ParadisMobileDoNotDisturbSettings = Pick<IParadisNotificationsSettingsService, 'getDoNotDisturb' | 'setDoNotDisturb'>;

/**
 * `dndSet` の処理を作る（テストから台帳と時計を差し替えられるように分けてある）。
 *
 * - 形の合わない要求・知らない期限は `code: 'invalid'` で断り、何も変えない
 * - 要求を送ってきたモバイルが分からない要求は `code: 'forbidden'` で断る（ペアリング済みの端末からしか届かない経路だが、念のため）
 * - 同じモバイルの同じ `opId` の 2 回目は適用せず、今の状態を `duplicate: true` で返す
 */
export function paradisCreateMobileDoNotDisturbSetHandler(
	settingsOf: (accessor: ServicesAccessor) => ParadisMobileDoNotDisturbSettings,
	ledger = new ParadisMobileDoNotDisturbOpLedger(),
	now: () => number = Date.now,
): IParadisMobileRequestHandler {
	return {
		handle(accessor, request, context) {
			const settings = settingsOf(accessor);
			const parsed = paradisParseMobileDoNotDisturbSetRequest(request);
			if (parsed === undefined || (parsed.enabled && !paradisIsDoNotDisturbDurationId(parsed.duration))) {
				context.reply({ error: 'invalid do-not-disturb request', code: 'invalid' });
				return;
			}
			if (context.mobileId === undefined) {
				context.reply({ error: 'unknown device', code: 'forbidden' });
				return;
			}
			if (!ledger.claim(context.mobileId, parsed.opId)) {
				const reply: IParadisMobileDoNotDisturbSetReply = { t: PARADIS_MOBILE_DND_SET_KIND, state: paradisMobileDoNotDisturbStateOf(settings.getDoNotDisturb()), duplicate: true };
				context.reply(reply);
				return;
			}
			if (parsed.enabled && paradisIsDoNotDisturbDurationId(parsed.duration)) {
				settings.setDoNotDisturb(true, paradisResolveDoNotDisturbUntil(parsed.duration, now()));
			} else {
				settings.setDoNotDisturb(false, undefined);
			}
			const reply: IParadisMobileDoNotDisturbSetReply = { t: PARADIS_MOBILE_DND_SET_KIND, state: paradisMobileDoNotDisturbStateOf(settings.getDoNotDisturb()) };
			context.reply(reply);
		},
	};
}

registerParadisMobileRequestHandler('fs', PARADIS_MOBILE_DND_SET_KIND, paradisCreateMobileDoNotDisturbSetHandler(accessor => accessor.get(IParadisNotificationsSettingsService)));
