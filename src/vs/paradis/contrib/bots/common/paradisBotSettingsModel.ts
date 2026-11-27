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

/** 書きかけを始めたときの台帳の値（名前・エージェント・権限）。台帳がほかで変わったかを見分ける元。 */
export type ParadisBotSettingsBase = Pick<IParadisBotSettingsDraft, 'name' | 'agent' | 'permissionId'>;

/** 台帳の値の欄（書きかけと台帳を突き合わせる欄）。 */
export type ParadisBotSettingsField = keyof ParadisBotSettingsBase;

/**
 * 台帳の値が変わったときに、書きかけを合わせ直す。手を付けていない欄（書きかけが元の値のまま）は新しい値にし、
 * 書き換えていた欄は書きかけを残して `changedElsewhere` に挙げる（台帳の値で上書きしない。画面は「ほかで変わりました」と
 * 知らせる）。台帳と同じ値に書き換えていた欄は挙げない。
 */
export function paradisBotSettingsRebase(base: ParadisBotSettingsBase, draft: IParadisBotSettingsDraft, bot: ParadisBotSettingsBase): { readonly base: ParadisBotSettingsBase; readonly draft: IParadisBotSettingsDraft; readonly changedElsewhere: readonly ParadisBotSettingsField[] } {
	const changedElsewhere: ParadisBotSettingsField[] = [];
	const pick = <F extends ParadisBotSettingsField>(field: F): ParadisBotSettingsBase[F] => {
		if (bot[field] === base[field]) {
			return draft[field];
		}
		if (draft[field] === base[field]) {
			return bot[field];
		}
		if (draft[field] !== bot[field]) {
			changedElsewhere.push(field);
		}
		return draft[field];
	};
	const next: IParadisBotSettingsDraft = { ...draft, name: pick('name'), agent: pick('agent'), permissionId: pick('permissionId') };
	return { base: { name: bot.name, agent: bot.agent, permissionId: bot.permissionId }, draft: next, changedElsewhere };
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
	const role = draft.role !== undefined && draft.role !== currentRole ? draft.role : undefined;
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

/** 役割が上限（{@link PARADIS_BOT_ROLE_LIMIT}）を何文字超えているか。超えていなければ 0（黙って切り詰めず、保存を断る）。 */
export function paradisBotRoleOverflow(role: string | undefined): number {
	return Math.max(0, (role?.length ?? 0) - PARADIS_BOT_ROLE_LIMIT);
}

/** 差分の 1 行。`removed` は開いたときにあって今は無い行、`added` は今だけにある行。 */
export interface IParadisBotHomeFileDiffLine {
	readonly kind: 'same' | 'removed' | 'added';
	readonly text: string;
}

/** 差分を出す行数の上限（これを超える長さの比べは、全部を消して全部を足した形にする）。 */
const DIFF_LINE_LIMIT = 2000;

/** 開いたときの中身と今の中身の行の差分（最長共通部分列）。開いた後に書き換わったとき、何が変わったかを見せる。 */
export function paradisBotHomeFileDiff(base: string | undefined, latest: string | undefined): readonly IParadisBotHomeFileDiffLine[] {
	const before = (base ?? '').split('\n');
	const after = (latest ?? '').split('\n');
	if (before.length > DIFF_LINE_LIMIT || after.length > DIFF_LINE_LIMIT) {
		return [...before.map(text => ({ kind: 'removed' as const, text })), ...after.map(text => ({ kind: 'added' as const, text }))];
	}
	// lengths[i][j] は before[i..] と after[j..] の最長共通部分列の長さ
	const lengths = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			lengths[i][j] = before[i] === after[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
		}
	}
	const lines: IParadisBotHomeFileDiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < before.length || j < after.length) {
		if (i < before.length && j < after.length && before[i] === after[j]) {
			lines.push({ kind: 'same', text: before[i] });
			i++;
			j++;
		} else if (i < before.length && (j >= after.length || lengths[i + 1][j] >= lengths[i][j + 1])) {
			// 同じ長さなら消えた行を先に出す（差分の見慣れた並び）
			lines.push({ kind: 'removed', text: before[i] });
			i++;
		} else {
			lines.push({ kind: 'added', text: after[j] });
			j++;
		}
	}
	return lines;
}
