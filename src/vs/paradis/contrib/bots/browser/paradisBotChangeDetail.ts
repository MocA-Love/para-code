/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { IParadisBotChangeRequest } from '../common/paradisBotManageTools.js';

/**
 * 設定の変更の確認に出す本文（権限が広がるかどうかを先頭に、何を何から何へ、役割の新しい本文の全文を最後に）。
 * @param caller 依頼したエージェントのターミナルの名前。持ち主が画面から変えるときは渡さない（依頼の行を出さない）
 */
export function paradisBotChangeDetail(request: Pick<IParadisBotChangeRequest, 'changes' | 'permission'>, caller?: string): string {
	const labels: Record<string, string> = {
		// allow-any-unicode-next-line
		agent: localize('paradisBots.field.agent', "エージェント"),
		// allow-any-unicode-next-line
		permission: localize('paradisBots.field.permission', "権限"),
		// allow-any-unicode-next-line
		name: localize('paradisBots.field.name', "名前"),
		// allow-any-unicode-next-line
		model: localize('paradisBots.field.model', "モデル"),
		// allow-any-unicode-next-line
		effort: localize('paradisBots.field.effort', "推論の強さ"),
		// allow-any-unicode-next-line
		face_color: localize('paradisBots.field.faceColor', "顔の色"),
		// allow-any-unicode-next-line
		face_shape: localize('paradisBots.field.faceShape', "顔の形"),
		// allow-any-unicode-next-line
		pinned: localize('paradisBots.field.pinned', "ピン留め"),
		// allow-any-unicode-next-line
		paused: localize('paradisBots.field.paused', "一時停止"),
	};
	// allow-any-unicode-next-line
	const unset = localize('paradisBots.field.default', "（既定）");
	const lines: string[] = caller === undefined ? [] : [
		// allow-any-unicode-next-line
		localize('paradisBots.changeAgentRequest', "この変更は、あなたではなくターミナル「{0}」のエージェントからの依頼です。", caller),
		'',
	];
	// 権限が広がるかどうかを先頭に出す（本文は内側でスクロールするので、長い役割の後ろだと見ずに許可できてしまう）
	switch (request.permission) {
		// allow-any-unicode-next-line
		case 'wider': lines.push(localize('paradisBots.permissionWider', "権限が広がります。Bot が確認なしでできることが増えます。"), ''); break;
		// allow-any-unicode-next-line
		case 'narrower': lines.push(localize('paradisBots.permissionNarrower', "権限が狭まります。"), ''); break;
		// allow-any-unicode-next-line
		case 'same': lines.push(localize('paradisBots.permissionSame', "権限の広さは変わりません。"), ''); break;
		// allow-any-unicode-next-line
		case 'unknown': lines.push(localize('paradisBots.permissionUnknown', "権限が広がるかどうかを Para Code は判断できません（エージェントの種類も変わるか、知らない権限です）。広がるものとして確かめてください。"), ''); break;
	}
	// 前 → 後の要約を先に、役割の全文は最後に
	for (const change of request.changes) {
		if (change.field !== 'role') {
			lines.push(`${labels[change.field] ?? change.field}: ${change.from ?? unset} → ${change.to ?? unset}`);
		}
	}
	for (const change of request.changes) {
		if (change.field === 'role') {
			// allow-any-unicode-next-line
			lines.push('', localize('paradisBots.changeRole', "役割（SOUL.md）を次の本文に書き換えます:"), change.to ?? '');
		}
	}
	return lines.join('\n').trim();
}
