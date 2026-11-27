/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スマホの「要対応」に出す「人が答えるもの」の台帳の 1 件（fs の `humanAsks`・`humanAskAnswer`、human-ask.v1）。
//
// 一覧も答えも、このウィンドウの台帳の写し（IParadisHumanAskService）を通す。答えは受信箱と同じ台帳の claim で、
// 届けるのは台帳の持ち主（ボード・Bot・ask_human）。スマホに見えない 1 件（許可・ペインの質問）にはこの口から答えさせない
// （それはスマホの既存のカードの口で答える）。

import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IParadisHumanAskService } from '../../humanAsk/common/paradisHumanAsk.js';
import {
	IParadisMobileHumanAskAnswerReply,
	IParadisMobileHumanAsksReply,
	PARADIS_MOBILE_HUMAN_ASK_ANSWER_KIND,
	PARADIS_MOBILE_HUMAN_ASKS_KIND,
	paradisMobileHumanAskSummary,
	paradisMobileHumanAsks,
	paradisParseMobileHumanAskAnswerRequest,
} from '../common/paradisMobileHumanAsks.js';
import { ParadisMobileOpResults } from '../common/paradisMobileOpResults.js';
import { IParadisMobileRequestHandler, registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

type HumanAsks = Pick<IParadisHumanAskService, 'snapshot' | 'answer'>;

/** `humanAsks`（今の一覧）。 */
export function paradisCreateMobileHumanAsksHandler(serviceOf: (accessor: ServicesAccessor) => HumanAsks): IParadisMobileRequestHandler {
	return {
		handle(accessor, _request, context) {
			const snapshot = serviceOf(accessor).snapshot;
			const reply: IParadisMobileHumanAsksReply = { t: PARADIS_MOBILE_HUMAN_ASKS_KIND, signature: paradisMobileHumanAskSummary(snapshot).signature, asks: paradisMobileHumanAsks(snapshot) };
			context.reply(reply);
		},
	};
}

/**
 * `humanAskAnswer`（答える）。
 *
 * - 形の合わない要求は `code: 'invalid'`、送ってきたモバイルが分からない要求は `code: 'forbidden'` で断る
 * - 同じモバイルの同じ `opId` の 2 回目は何もせず、1 回目と同じ返事を返す（受けた 1 回目なら `duplicate: true` を足す。
 *   断った 1 回目の再送に「答えた」と返さないため。覚える件数と期間は {@link ParadisMobileOpResults}）
 * - スマホの一覧に無い 1 件（もう待っていない・許可・ペインの質問）は `reason: 'gone'`
 */
export function paradisCreateMobileHumanAskAnswerHandler(serviceOf: (accessor: ServicesAccessor) => HumanAsks, results = new ParadisMobileOpResults<IParadisMobileHumanAskAnswerReply>()): IParadisMobileRequestHandler {
	return {
		async handle(accessor, request, context) {
			const service = serviceOf(accessor);
			const parsed = paradisParseMobileHumanAskAnswerRequest(request);
			if (parsed === undefined) {
				context.reply({ error: 'invalid human ask answer', code: 'invalid' });
				return;
			}
			if (context.mobileId === undefined) {
				context.reply({ error: 'unknown device', code: 'forbidden' });
				return;
			}
			const reply = await results.run(context.mobileId, parsed.opId, async (): Promise<IParadisMobileHumanAskAnswerReply> => {
				if (!paradisMobileHumanAsks(service.snapshot).some(ask => ask.key === parsed.key)) {
					return { t: PARADIS_MOBILE_HUMAN_ASK_ANSWER_KIND, ok: false, reason: 'gone' };
				}
				const result = await service.answer(parsed.key, parsed.answer as Parameters<HumanAsks['answer']>[1], 'mobile');
				return result.ok ? { t: PARADIS_MOBILE_HUMAN_ASK_ANSWER_KIND, ok: true } : { t: PARADIS_MOBILE_HUMAN_ASK_ANSWER_KIND, ok: false, reason: result.reason };
			});
			context.reply(reply);
		},
	};
}

registerParadisMobileRequestHandler('fs', PARADIS_MOBILE_HUMAN_ASKS_KIND, paradisCreateMobileHumanAsksHandler(accessor => accessor.get(IParadisHumanAskService)));
registerParadisMobileRequestHandler('fs', PARADIS_MOBILE_HUMAN_ASK_ANSWER_KIND, paradisCreateMobileHumanAskAnswerHandler(accessor => accessor.get(IParadisHumanAskService)));
