/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// グループの部屋（paradisBotGroupEditor.ts）の、DOM を持たない決まり。記録の 1 行の文、送った結果の文、名指しの
// 断りの文をここに集め、単体テストで値を確かめる。

import { localize } from '../../../../nls.js';
import { paradisAgentDescriptor } from '../../agentChat/common/paradisAgentDescriptor.js';
import { IParadisBotGroup, IParadisBotGroupRecord, PARADIS_BOT_GROUP_LIMITS, ParadisBotGroupMentionResult, paradisSanitizeBotGroupName } from './paradisBotGroups.js';

/** 記録の 1 行の頭（誰が誰に）。本文は別の要素に出す。 */
export function paradisBotGroupRecordHead(record: Pick<IParadisBotGroupRecord, 'kind' | 'from' | 'to'>, nameOf: (botId: string) => string): string {
	const to = record.to.map(nameOf).join('・');
	switch (record.kind) {
		case 'sent': return localize('paradis.botGroups.record.sent', "あなた → {0}", to);
		case 'asked': return localize('paradis.botGroups.record.asked', "{0}が{1}に聞きました", nameOf(record.from), to);
		case 'told': return localize('paradis.botGroups.record.told', "{0}が{1}に伝えました", nameOf(record.from), to);
	}
}

/** 記録の 1 行に添える印（Bot 同士の伝言を順番待ちに入れた・届かなかった理由）。無ければ undefined。 */
export function paradisBotGroupRecordMark(record: Pick<IParadisBotGroupRecord, 'undelivered' | 'queued'>): string | undefined {
	if (record.queued === true) {
		return localize('paradis.botGroups.record.queued', "順番待ちに入れました");
	}
	switch (record.undelivered) {
		case 'refused': return localize('paradis.botGroups.record.refused', "宛先が受け取らなかった");
		case 'unreachable': return localize('paradis.botGroups.record.unreachable', "届けられなかった");
		case 'unknown': return localize('paradis.botGroups.record.unknown', "届いたか分からない");
		case undefined: return undefined;
	}
}

/**
 * その Bot のエージェントが、ほかの Bot からの伝言を受け取れる種類か（作業中の発言を次の番まで待たせられる。今は
 * Claude Code だけ）。受け取れても、届けるときに入力欄の mod が無ければ断る（ここでは見ない）。
 */
export function paradisBotCanReceiveBotMessages(agent: string): boolean {
	return paradisAgentDescriptor(agent)?.queuesWhileWorking === true;
}

/** 伝言を受け取れない Bot に添える文。 */
export function paradisBotCannotReceiveLabel(): string {
	return localize('paradis.botGroups.cannotReceive', "伝言を受け取れません");
}

/** 名指しを読めなかったときの文。読めたら undefined。 */
export function paradisBotGroupMentionProblem(result: ParadisBotGroupMentionResult): string | undefined {
	if (result.ok) {
		return undefined;
	}
	switch (result.problem) {
		case 'empty': return localize('paradis.botGroups.mention.empty', "送る文を入れてください");
		case 'no_target': return localize('paradis.botGroups.mention.noTarget', "「@名前」か「@全員」で送り先を選んでください（このグループは名指しのときだけ返事をします）");
		case 'unknown_name': return localize('paradis.botGroups.mention.unknown', "「@{0}」はこのグループにいません", result.name);
	}
}

/** 送った結果の文。`failed` は届かなかった Bot の名前と理由。 */
export function paradisBotGroupSendSummary(sent: readonly string[], failed: readonly { readonly name: string; readonly reason: string }[]): string {
	const failures = failed.map(failure => localize('paradis.botGroups.send.failedOne', "{0}（{1}）", failure.name, failure.reason)).join('、');
	if (failed.length === 0) {
		return localize('paradis.botGroups.send.done', "{0} に送りました", sent.join('・'));
	}
	if (sent.length === 0) {
		return localize('paradis.botGroups.send.none', "送れませんでした: {0}", failures);
	}
	return localize('paradis.botGroups.send.partial', "{0} に送りました。送れなかった Bot: {1}", sent.join('・'), failures);
}

/** グループの名前とメンバーの数を検める。通れば undefined、通らなければ下の帯に出す文。同じ名前のグループは断る。 */
export function paradisBotGroupDialogProblem(name: string, memberCount: number, groups: readonly Pick<IParadisBotGroup, 'id' | 'name'>[], exceptId?: string): string | undefined {
	const sanitized = paradisSanitizeBotGroupName(name);
	if (name.trim().length === 0) {
		return localize('paradis.botGroups.dialog.nameEmpty', "名前を入れてください");
	}
	if (sanitized === undefined) {
		return localize('paradis.botGroups.dialog.nameInvalid', "名前は {0} 字までで、改行は入れられません", PARADIS_BOT_GROUP_LIMITS.name);
	}
	const key = sanitized.normalize('NFKC').toLowerCase();
	if (groups.some(group => group.id !== exceptId && group.name.normalize('NFKC').toLowerCase() === key)) {
		return localize('paradis.botGroups.dialog.nameDuplicate', "同じ名前のグループがあります");
	}
	if (memberCount < 2 || memberCount > PARADIS_BOT_GROUP_LIMITS.members) {
		return localize('paradis.botGroups.dialog.memberCount', "Bot は 2〜{0} 人選んでください", PARADIS_BOT_GROUP_LIMITS.members);
	}
	return undefined;
}
