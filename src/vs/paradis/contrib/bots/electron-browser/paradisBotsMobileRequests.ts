/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スマホの Bot の画面（設計の PR 16、`bots.page.v1`）の fs の要求を受ける。`paradisMobileRequestHandlerRegistrations.ts` から
// 副作用 import する。読み書きは PC の Bot のページと同じ口（IParadisBotsService）で、設定の変更は管理の道具 update_bot と
// 同じ規則（エージェント・権限・役割は、確かめる本文を返してアプリのシートで確かめてから `confirmed: true` で送り直す）。
// 設定 `paradis.bots.enabled` がオフなら、どの要求も `code: 'disabled'` で断る。書き込みは同じ端末の同じ opId を 2 回当てない。

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ParadisMobileDoNotDisturbOpLedger } from '../../mobileRelay/common/paradisMobileDoNotDisturb.js';
import { IParadisMobileRequest, IParadisMobileRequestContext, IParadisMobileRequestHandler, registerParadisMobileRequestHandler } from '../../mobileRelay/electron-browser/paradisMobileRequestHandlers.js';
import { paradisBotChangeDetail } from '../browser/paradisBotChangeDetail.js';
import { paradisApplyBotChange, paradisBotChangeRequest } from '../common/paradisBotManageTools.js';
import { PARADIS_BOTS_OPEN_COMMAND } from '../common/paradisBotsBandModel.js';
import { IParadisBotsService, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';
import { PARADIS_MOBILE_BOT_FILES, PARADIS_MOBILE_BOT_KINDS, PARADIS_MOBILE_BOT_LIMITS, paradisMobileBotId, paradisMobileBotItemPage, paradisMobileBotItemRow, paradisMobileBotOpId, paradisMobileBotSuggestion, paradisParseMobileBotItemAct, paradisParseMobileBotUpdate } from '../common/paradisBotsMobileProtocol.js';

type Handle = (services: { readonly bots: IParadisBotsService; readonly commands: ICommandService }, request: IParadisMobileRequest, context: IParadisMobileRequestContext) => Promise<void>;

/** 書き込みの opId の台帳（端末ごと。同じ操作が 2 回届いても 1 回だけ当てる）。 */
const ledger = new ParadisMobileDoNotDisturbOpLedger();

function refuse(context: IParadisMobileRequestContext, code: string, error: string): void {
	context.reply({ error, code });
}

/** 書き込みの前の検め。断ったら false。 */
function claimWrite(context: IParadisMobileRequestContext, opId: string | undefined): boolean {
	if (context.mobileId === undefined) {
		refuse(context, 'forbidden', 'unknown device');
		return false;
	}
	if (opId !== undefined && !ledger.claim(context.mobileId, opId)) {
		context.reply({ duplicate: true });
		return false;
	}
	return true;
}

/** 設定を見て、オンなら処理へ渡す（サービスの取り出しは同期の先頭だけ）。 */
export function paradisCreateMobileBotHandler(kind: string, handle: Handle): IParadisMobileRequestHandler {
	return {
		handle(accessor: ServicesAccessor, request, context) {
			if (accessor.get(IConfigurationService).getValue(PARADIS_BOTS_ENABLED_SETTING) !== true) {
				refuse(context, 'disabled', 'bots are turned off on this PC');
				return;
			}
			const services = { bots: accessor.get(IParadisBotsService), commands: accessor.get(ICommandService) };
			return handle(services, request, context).catch(error => refuse(context, 'failed', `${kind} failed: ${String(error)}`));
		},
	};
}

export const PARADIS_MOBILE_BOT_HANDLERS: Readonly<Record<string, Handle>> = {
	[PARADIS_MOBILE_BOT_KINDS.items]: async ({ bots }, request, context) => {
		const botId = paradisMobileBotId(request.botId);
		if (botId === undefined) {
			return refuse(context, 'invalid', 'botItems needs botId');
		}
		const items = await bots.listItems({ botId, ...(typeof request.open === 'boolean' ? { open: request.open } : {}) });
		const now = Date.now();
		context.reply({ t: PARADIS_MOBILE_BOT_KINDS.items, items: items.slice(0, PARADIS_MOBILE_BOT_LIMITS.items).map(item => paradisMobileBotItemRow(item, now)) });
	},
	[PARADIS_MOBILE_BOT_KINDS.item]: async ({ bots }, request, context) => {
		const uid = paradisMobileBotId(request.uid);
		const item = uid !== undefined ? await bots.getItem(uid) : undefined;
		if (item === undefined) {
			return refuse(context, 'not_found', 'no such item');
		}
		context.reply({ t: PARADIS_MOBILE_BOT_KINDS.item, item: paradisMobileBotItemPage(item) });
	},
	[PARADIS_MOBILE_BOT_KINDS.itemAct]: async ({ bots }, request, context) => {
		const parsed = paradisParseMobileBotItemAct(request, Date.now());
		if (parsed === undefined) {
			return refuse(context, 'invalid', 'invalid botItemAct');
		}
		if (!claimWrite(context, parsed.opId)) {
			return;
		}
		const act = parsed.act;
		const result = act.action === 'comment' ? await bots.ownerComment(parsed.uid, { text: act.text, plain: true })
			: act.action === 'done' ? await bots.ownerSetStatus(parsed.uid, 'done')
				: act.action === 'cancel' ? await bots.ownerSetStatus(parsed.uid, 'canceled')
					: await bots.ownerSnooze(parsed.uid, act.action === 'snooze' ? act.until : undefined);
		if (!result.ok) {
			return refuse(context, result.code, result.message);
		}
		context.reply({ t: PARADIS_MOBILE_BOT_KINDS.itemAct, item: paradisMobileBotItemRow(result.value, Date.now()) });
	},
	[PARADIS_MOBILE_BOT_KINDS.suggestions]: async ({ bots }, request, context) => {
		const botId = paradisMobileBotId(request.botId);
		if (botId === undefined) {
			return refuse(context, 'invalid', 'botSuggestions needs botId');
		}
		context.reply({ t: PARADIS_MOBILE_BOT_KINDS.suggestions, suggestions: (await bots.listSuggestions(botId)).map(paradisMobileBotSuggestion) });
	},
	[PARADIS_MOBILE_BOT_KINDS.suggestionAct]: async ({ bots }, request, context) => {
		const id = paradisMobileBotId(request.id);
		const opId = paradisMobileBotOpId(request.opId);
		if (id === undefined || opId === undefined || (request.action !== 'start' && request.action !== 'started' && request.action !== 'dismiss')) {
			return refuse(context, 'invalid', 'invalid botSuggestionAct');
		}
		if (!claimWrite(context, opId)) {
			return;
		}
		// 「始める」は依頼の文を返すだけ。アプリがその Bot の会話の入力欄へ、送らずに入れ、入れられたら `started` で
		// 「始めた」にする（入れ損ねた提案は一覧に残る）
		const result = request.action === 'start' ? await bots.startSuggestion(id)
			: request.action === 'started' ? await bots.markSuggestionStarted(id)
				: await bots.dismissSuggestion(id);
		if (!result.ok) {
			return refuse(context, result.code, result.message);
		}
		context.reply({ t: PARADIS_MOBILE_BOT_KINDS.suggestionAct, suggestion: paradisMobileBotSuggestion(result.value) });
	},
	[PARADIS_MOBILE_BOT_KINDS.file]: async ({ bots }, request, context) => {
		const botId = paradisMobileBotId(request.botId);
		const path = typeof request.path === 'string' ? request.path : '';
		const file = Object.prototype.hasOwnProperty.call(PARADIS_MOBILE_BOT_FILES, path) ? PARADIS_MOBILE_BOT_FILES[path] : undefined;
		if (botId === undefined || file === undefined) {
			return refuse(context, 'invalid', 'botFile reads SOUL.md or MEMORY.md');
		}
		const current = await bots.readHomeFile(botId, path);
		if (!current.ok) {
			return refuse(context, current.code, current.message);
		}
		if (request.text === undefined) {
			context.reply({ t: PARADIS_MOBILE_BOT_KINDS.file, path, text: current.value ?? '' });
			return;
		}
		if (!file.writable || typeof request.text !== 'string' || typeof request.base !== 'string') {
			return refuse(context, 'invalid', `${path} cannot be written from the phone`);
		}
		const opId = paradisMobileBotOpId(request.opId);
		if (opId === undefined) {
			return refuse(context, 'invalid', 'writing needs opId');
		}
		if (!claimWrite(context, opId)) {
			return;
		}
		// 開いた後にほかの場所（Bot 自身・PC）が書き換えていたら上書きしない
		if ((current.value ?? '') !== request.base) {
			context.reply({ t: PARADIS_MOBILE_BOT_KINDS.file, path, text: current.value ?? '', conflict: true });
			return;
		}
		const written = await bots.writeHomeFile(botId, path, request.text);
		if (!written.ok) {
			return refuse(context, written.code, written.message);
		}
		context.reply({ t: PARADIS_MOBILE_BOT_KINDS.file, path, text: request.text });
	},
	[PARADIS_MOBILE_BOT_KINDS.update]: async ({ bots }, request, context) => {
		const parsed = paradisParseMobileBotUpdate(request);
		if (!parsed.ok) {
			return refuse(context, 'invalid', parsed.message);
		}
		const bot = bots.snapshot.bots.find(candidate => candidate.id === parsed.args.botId);
		if (bot === undefined) {
			return refuse(context, 'not_found', 'no such bot');
		}
		const change = paradisBotChangeRequest(bot, parsed.args);
		if (parsed.args.needsConfirmation && !parsed.confirmed) {
			// 確かめる本文は PC と同じ。アプリが自分のシートに出し、確かめたら confirmed: true で送り直す
			context.reply({ t: PARADIS_MOBILE_BOT_KINDS.update, needsConfirmation: true, detail: paradisBotChangeDetail(change), ...(change.permission !== undefined ? { permission: change.permission } : {}) });
			return;
		}
		if (!claimWrite(context, parsed.opId)) {
			return;
		}
		const applied = await paradisApplyBotChange(bots, change);
		if (!applied.ok) {
			return refuse(context, applied.code, applied.message);
		}
		if (parsed.args.patch.paused === true) {
			await bots.requestStop(bot.id);
		}
		context.reply({ t: PARADIS_MOBILE_BOT_KINDS.update, applied: true });
	},
	[PARADIS_MOBILE_BOT_KINDS.open]: async ({ bots, commands }, request, context) => {
		const botId = paradisMobileBotId(request.botId);
		if (botId === undefined || !bots.snapshot.bots.some(bot => bot.id === botId)) {
			return refuse(context, 'not_found', 'no such bot');
		}
		if (!claimWrite(context, paradisMobileBotOpId(request.opId))) {
			return;
		}
		// PC で開く（このウィンドウにペインがあれば前に出し、無ければ起動する。#1207 のコマンド）
		await commands.executeCommand(PARADIS_BOTS_OPEN_COMMAND, botId);
		context.reply({ t: PARADIS_MOBILE_BOT_KINDS.open, ok: true });
	},
};

for (const [kind, handle] of Object.entries(PARADIS_MOBILE_BOT_HANDLERS)) {
	registerParadisMobileRequestHandler('fs', kind, paradisCreateMobileBotHandler(kind, handle));
}
