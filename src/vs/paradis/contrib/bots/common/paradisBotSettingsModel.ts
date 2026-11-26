/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のページの「設定」「ファイル」のタブ（paradisBotPageSettings.ts）の、DOM を持たない決まり。
//
// 変更は管理の道具 update_bot と同じ形（{@link IParadisBotUpdateArgs}）にする。確かめるかどうか（エージェント・権限・役割）も
// update_bot と同じ規則で、確かめる本文は同じ {@link paradisBotChangeRequest} から作る（規則を二重に持たない）。

import type { ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';
import { IParadisAgentPermissionOption, PARADIS_DEFAULT_AGENT_COMMANDS } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { IParadisBotUpdateArgs, PARADIS_BOT_ROLE_LIMIT } from './paradisBotManageTools.js';
import { IParadisBot, IParadisBotPatch } from './paradisBots.js';

/** 設定のタブで選べるエージェント（作成の画面と同じ 2 つ）。今の Bot がほかのエージェントなら、それも足す。 */
export function paradisBotSettingsAgents(current: ParadisAgentKind): readonly ParadisAgentKind[] {
	const base: ParadisAgentKind[] = ['claude', 'codex'];
	return base.includes(current) ? base : [...base, current];
}

/** そのエージェントの権限の選択肢（新しいスペースの画面と同じ一覧）。無ければ空。 */
export function paradisBotPermissionOptions(agent: ParadisAgentKind): readonly IParadisAgentPermissionOption[] {
	return PARADIS_DEFAULT_AGENT_COMMANDS.find(template => template.id === agent)?.permissions ?? [];
}

/** 設定のタブの入力。 */
export interface IParadisBotSettingsDraft {
	readonly name: string;
	readonly agent: ParadisAgentKind;
	/** `undefined` は既定。 */
	readonly permissionId: string | undefined;
	/** 役割（SOUL.md の全文）。読めていないときは undefined（変えない）。 */
	readonly role: string | undefined;
}

/**
 * 入力と今の値の差を、update_bot と同じ変更にする。何も変わっていなければ undefined。
 * エージェントを変えて、今の権限がそのエージェントに無ければ既定へ戻す。確かめるのは update_bot と同じく
 * エージェント・権限・役割のどれかを変えるとき。
 */
export function paradisBotSettingsChange(bot: Pick<IParadisBot, 'id' | 'name' | 'agent' | 'permissionId'>, currentRole: string | undefined, draft: IParadisBotSettingsDraft): IParadisBotUpdateArgs | undefined {
	const patch: { -readonly [K in keyof IParadisBotPatch]: IParadisBotPatch[K] } = {};
	const name = draft.name.trim();
	if (name !== bot.name) {
		patch.name = name;
	}
	const agentChanges = draft.agent !== bot.agent;
	if (agentChanges) {
		patch.agent = draft.agent;
	}
	const known = paradisBotPermissionOptions(draft.agent).some(option => option.id === draft.permissionId);
	const permission = draft.permissionId === 'default' || !known ? undefined : draft.permissionId;
	const before = bot.permissionId === 'default' ? undefined : bot.permissionId;
	if (permission !== before) {
		patch.permissionId = permission ?? null;
	}
	const role = draft.role !== undefined && draft.role !== currentRole ? draft.role.slice(0, PARADIS_BOT_ROLE_LIMIT) : undefined;
	if (Object.keys(patch).length === 0 && role === undefined) {
		return undefined;
	}
	return {
		botId: bot.id,
		patch,
		...(role !== undefined ? { role } : {}),
		needsConfirmation: patch.agent !== undefined || Object.prototype.hasOwnProperty.call(patch, 'permissionId') || role !== undefined,
	};
}

/** 「ファイル」のタブで出すファイル。SOUL.md は役割なので、書き換えは設定のタブから（確かめる）。 */
export interface IParadisBotHomeFileEntry {
	readonly path: string;
	readonly editable: boolean;
}

export const PARADIS_BOT_HOME_FILES: readonly IParadisBotHomeFileEntry[] = [
	{ path: 'SOUL.md', editable: false },
	{ path: 'MEMORY.md', editable: true },
];

/** 保存の前に読み直した中身が、開いたときと違えば、ほかの場所（Bot 自身など）が書き換えた。 */
export function paradisBotHomeFileConflict(base: string | undefined, latest: string | undefined): boolean {
	return (base ?? '') !== (latest ?? '');
}
