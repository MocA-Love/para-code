/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントの道具（create_space_section など）を、「スペース」の一覧のセクションのサービスへ写す。
//
// セクションは 2 種類ある。道具は同じ 4 つで両方を扱い、id とスペースのキーの種類で振り分ける。
// - プロジェクトのセクション（IParadisWorkspaceSectionsService）: リポジトリをまとめる。色を持つ
// - スペースのセクション（IParadisSpaceSectionsService）: 1 つのリポジトリの中のワークツリーをまとめる。色は無い
//
// サービスの口は、できなかったとき（上限・保存の拒否・無い id）も何も返さずに終わる。道具は「できた」と
// 嘘を返さないよう、呼ぶ前に相手が居ることを確かめ、呼んだ後に状態を読み直す。
// 人のメニューと同じく、名前の重複は断らない（id で区別する）。消すのは見出しだけで、リポジトリも
// ワークツリーも消さない。中身のあるセクションを消すときだけ、利用者の確認を通す。
//
// 範囲の設定（actionScope）が「同じスペースだけ」のときは、create_space と同じくリポジトリ単位で範囲を決める。
// 触れてよいのは、呼び出し元のスペースのリポジトリ（と、そのエージェントが作ったワークツリーのスペース）だけ。
// - スペースのセクション: 作成・変更・削除は持ち主のリポジトリが範囲内のとき。移すのは動かすワークツリーが範囲内のとき
// - プロジェクトのセクション: 作成は範囲に関係なく許す（空の見出しができるだけ）。変更・削除は中身のリポジトリが
//   すべて範囲内（空を含む）のとき。移すのは動かすリポジトリが範囲内のとき（行き先の中身は問わない。範囲外の中身を
//   外へ出せないので、範囲外の中身を持つセクションを空にして消す経路は無い）

import { getActiveWindow } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IParadisDialogService, paradisNotifyConfirmation } from '../../confirmDialog/browser/paradisDialogService.js';
import { IParadisSpaceSectionsService } from '../../workspaceSwitch/common/paradisSpaceSections.js';
import { IParadisWorkspaceSectionsService, paradisNormalizeSectionName } from '../../workspaceSwitch/common/paradisWorkspaceSections.js';
import { IParadisSpaceEntry, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { PARADIS_AGENT_IDE_SECTION_NONE, ParadisAgentIdeRequest, ParadisAgentIdeResult, paradisAgentIdeUntrustedTitle } from '../common/paradisAgentIde.js';

/** `list_spaces` の `sections` の 1 件。並びは一覧に出る順。 */
export interface IParadisAgentIdeSectionRow {
	readonly id: string;
	readonly name: string;
	/** プロジェクトのセクションで、色があるときだけ。 */
	readonly color?: string;
	/** スペースのセクションのときだけ: 属するリポジトリのキー。 */
	readonly repository?: string;
	readonly collapsed: boolean;
	/** 入っているスペースのキー（プロジェクトのセクションならリポジトリ、スペースのセクションならワークツリー）。 */
	readonly spaces: readonly string[];
}

/**
 * 道具が触れてよい範囲。`'window'` は範囲の設定がウィンドウ全体のとき（制限なし）。
 * それ以外は呼び出し元のスペースのリポジトリと、そのエージェントが作ったスペース。
 */
export type ParadisAgentIdeSectionScope = 'window' | {
	/** 呼び出し元のスペースのリポジトリ。分からないときは undefined（作ったスペースのほかは何も触れない）。 */
	readonly repository: string | undefined;
	/** そのエージェントが create_space で作ったスペースのキー。 */
	readonly createdSpaces: ReadonlySet<string>;
};

type Failure = { readonly ok: false; readonly error: string };

function fail(error: string): Failure {
	return { ok: false, error };
}

const OUT_OF_SCOPE = 'That section or space belongs to a repository other than the one of your own space. Agents can only change sections of the repository of their own space (the user can widen this to the whole window in Para Code settings).';
const NO_SPACE = 'Para Code cannot tell which space your terminal belongs to (it may be the shared panel terminal or still restoring), so it only lets you change sections of spaces you created yourself.';
const NOT_SAVED = 'Para Code could not save the change (the list of sections may be full). Nothing was changed; call list_spaces to see the current sections.';

export class ParadisAgentIdeSections {

	/** 利用者に確認を出している削除の依頼（同時に 1 件まで）。 */
	private _pendingRemoval = false;

	constructor(
		private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		private readonly worktreeService: IParadisWorktreeService,
		private readonly sectionsService: IParadisWorkspaceSectionsService,
		private readonly spaceSectionsService: IParadisSpaceSectionsService,
		private readonly paradisDialogService: IParadisDialogService,
		private readonly hostService: IHostService,
		private readonly logService: ILogService,
	) { }

	/** 今のセクション。プロジェクトのセクションが先、その後にリポジトリごとのスペースのセクション。 */
	list(): IParadisAgentIdeSectionRow[] {
		const rows: IParadisAgentIdeSectionRow[] = [];
		for (const group of this.sectionsService.groups()) {
			if (group.section) {
				rows.push({
					id: group.section.id,
					name: group.section.name,
					...(group.section.color !== undefined ? { color: group.section.color } : {}),
					collapsed: this.sectionsService.isCollapsed(group.section.id),
					spaces: group.repositories.map(repository => repository.id),
				});
			}
		}
		for (const repository of this.workspaceSwitchService.repositories) {
			const sections = this.spaceSectionsService.sectionsOf(repository.id);
			if (sections.length === 0) {
				continue;
			}
			const worktrees = this.spaceSectionsService.orderedWorktrees(repository.id).filter(worktree => !worktree.missing);
			for (const section of sections) {
				rows.push({
					id: section.id,
					name: section.name,
					repository: repository.id,
					collapsed: this.spaceSectionsService.isCollapsed(section.id),
					spaces: worktrees.filter(worktree => this.spaceSectionsService.sectionOf(worktree) === section.id).map(worktree => paradisWorktreeStateKey(worktree.uri)),
				});
			}
		}
		return rows;
	}

	create(request: Extract<ParadisAgentIdeRequest, { op: 'createSection' }>, scope: ParadisAgentIdeSectionScope): ParadisAgentIdeResult {
		if (request.repository !== undefined) {
			if (!this.workspaceSwitchService.repositories.some(repository => repository.id === request.repository)) {
				return fail(`Unknown repository "${request.repository}". Pass a space key of kind "repository" from list_spaces.`);
			}
			if (!inScope(scope, request.repository)) {
				return fail(outOfScope(scope));
			}
			const id = this.spaceSectionsService.createSection(request.repository, request.name);
			return this._created(id);
		}
		const id = this.sectionsService.createSection(request.name);
		if (id !== undefined && request.color !== undefined) {
			this.sectionsService.setSectionColor(id, request.color);
		}
		return this._created(id);
	}

	private _created(id: string | undefined): ParadisAgentIdeResult {
		const row = id !== undefined ? this.list().find(candidate => candidate.id === id) : undefined;
		return row ? { ok: true, data: { section: row } } : fail(NOT_SAVED);
	}

	update(request: Extract<ParadisAgentIdeRequest, { op: 'updateSection' }>, scope: ParadisAgentIdeSectionScope): ParadisAgentIdeResult {
		const rows = this.list();
		const row = rows.find(candidate => candidate.id === request.section);
		if (!row) {
			return fail(this._unknownSection(request.section, rows));
		}
		if (!sectionInScope(scope, row)) {
			return fail(outOfScope(scope));
		}
		if (request.color !== undefined && row.repository !== undefined) {
			return fail('Sections inside a repository have no color.');
		}
		const neighborId = request.before ?? request.after;
		if (neighborId !== undefined) {
			const neighbor = rows.find(candidate => candidate.id === neighborId);
			if (!neighbor) {
				return fail(this._unknownSection(neighborId, rows));
			}
			if (neighbor.id === row.id || neighbor.repository !== row.repository) {
				return fail('"before" / "after" must name another section of the same list: sections of repositories are ordered among themselves, and sections inside a repository among the sections of that repository.');
			}
		}
		const placeAfter = request.after !== undefined;
		if (row.repository !== undefined) {
			if (request.name !== undefined) {
				this.spaceSectionsService.renameSection(row.repository, row.id, request.name);
			}
			if (request.collapsed !== undefined) {
				this.spaceSectionsService.setCollapsed(row.id, request.collapsed);
			}
			if (neighborId !== undefined) {
				this.spaceSectionsService.reorderSection(row.repository, row.id, neighborId, placeAfter);
			}
		} else {
			if (request.name !== undefined) {
				this.sectionsService.renameSection(row.id, request.name);
			}
			if (request.color !== undefined) {
				this.sectionsService.setSectionColor(row.id, request.color === PARADIS_AGENT_IDE_SECTION_NONE ? undefined : request.color);
			}
			if (request.collapsed !== undefined) {
				this.sectionsService.setCollapsed(row.id, request.collapsed);
			}
			if (neighborId !== undefined) {
				this.sectionsService.reorderSection(row.id, neighborId, placeAfter);
			}
		}
		// 書けたかを読み直す（サービスは保存を断っても何も返さない）
		const after = this.list();
		const updated = after.find(candidate => candidate.id === row.id);
		const siblings = after.filter(candidate => candidate.repository === row.repository).map(candidate => candidate.id);
		const placed = neighborId === undefined || siblings.indexOf(row.id) === siblings.indexOf(neighborId) + (placeAfter ? 1 : -1);
		if (!updated
			|| (request.name !== undefined && updated.name !== paradisNormalizeSectionName(request.name))
			|| (request.color !== undefined && updated.color !== (request.color === PARADIS_AGENT_IDE_SECTION_NONE ? undefined : request.color))
			|| (request.collapsed !== undefined && updated.collapsed !== request.collapsed)
			|| !placed) {
			return fail(NOT_SAVED);
		}
		return { ok: true, data: { section: updated } };
	}

	/**
	 * @param requestedBy 依頼元のターミナルの名乗り（確認に出す）
	 */
	remove(request: Extract<ParadisAgentIdeRequest, { op: 'removeSection' }>, requestedBy: string, scope: ParadisAgentIdeSectionScope): ParadisAgentIdeResult {
		const rows = this.list();
		const row = rows.find(candidate => candidate.id === request.section);
		if (!row) {
			return fail(this._unknownSection(request.section, rows));
		}
		if (!sectionInScope(scope, row)) {
			return fail(outOfScope(scope));
		}
		// 一覧（row.spaces）は切り替え先にならない missing のワークツリーを載せないが、セクションには残っている。
		// 中身として数えないと、missing だけのセクションが確認なしで消える
		const contents = row.repository !== undefined
			? this.spaceSectionsService.orderedWorktrees(row.repository).filter(worktree => this.spaceSectionsService.sectionOf(worktree) === row.id).length
			: row.spaces.length;
		if (contents === 0) {
			this._removeNow(row);
			return this.list().some(candidate => candidate.id === row.id) ? fail(NOT_SAVED) : { ok: true, data: { section: row.id, removed: true } };
		}
		if (this._pendingRemoval) {
			return fail('Para Code is already asking the user about another section removal. Wait until they answer.');
		}
		// 中身のあるセクションは、まとめ直しが利用者の手作業になるので確認を通す。確認を待つとツールの呼び出しが
		// 時間切れになるので、出したところで返す（remove_space と同じ）
		this._pendingRemoval = true;
		// エージェントの依頼は窓が後ろにあっても来るので、Dock で知らせる（フォーカスは奪わない）
		paradisNotifyConfirmation(this.hostService, getActiveWindow());
		this.paradisDialogService.confirm({
			destructive: true,
			type: 'warning',
			// allow-any-unicode-next-line
			message: localize('paradis.agentIde.removeSectionConfirm', "セクション「{0}」を削除しますか？", paradisAgentIdeUntrustedTitle(row.name)),
			// allow-any-unicode-next-line
			detail: localize('paradis.agentIde.removeSectionDetail', "この削除は、あなたではなくターミナル「{0}」のエージェントからの依頼です。\n\n見出しだけを消します。中の {1} 件はセクションの外へ戻り、リポジトリとワークツリーは消えません。", requestedBy, contents),
			// allow-any-unicode-next-line
			primaryButton: localize('paradis.agentIde.removeSectionConfirmAction', "削除"),
		}).then(({ confirmed }) => {
			if (confirmed) {
				this._removeNow(row);
			}
		}).catch(error => this.logService.warn('[ParadisAgentIde] remove section failed', error))
			.finally(() => { this._pendingRemoval = false; });
		return { ok: true, data: { section: row.id, requested: true, note: 'Para Code asked the user to confirm. The section is removed only if they agree; call list_spaces later to see the result.' } };
	}

	private _removeNow(row: IParadisAgentIdeSectionRow): void {
		if (row.repository !== undefined) {
			this.spaceSectionsService.removeSection(row.repository, row.id);
		} else {
			this.sectionsService.removeSection(row.id);
		}
	}

	move(request: Extract<ParadisAgentIdeRequest, { op: 'moveSpaceToSection' }>, scope: ParadisAgentIdeSectionScope): ParadisAgentIdeResult {
		const spaces = paradisListSpaces(this.workspaceSwitchService.repositories, this.worktreeService);
		const unknownSpace = (space: string) => fail(`Unknown space "${space}". Call list_spaces for the space keys.`);
		const entry = spaces.find(candidate => candidate.space === request.space);
		if (!entry) {
			return unknownSpace(request.space);
		}
		if (!inScope(scope, entry.repositoryId, entry.kind === 'worktree' ? entry.space : undefined)) {
			return fail(outOfScope(scope));
		}
		if (entry.worktree?.isMainCheckout) {
			return fail('The main checkout of a repository cannot be put into a section inside its repository. To move the whole repository, pass its repository space key.');
		}
		const sectionOf = (candidate: IParadisSpaceEntry) => candidate.worktree ? this.spaceSectionsService.sectionOf(candidate.worktree) : this.sectionsService.sectionOf(candidate.repositoryId);

		const neighborKey = request.before ?? request.after;
		let neighbor: IParadisSpaceEntry | undefined;
		if (neighborKey !== undefined) {
			neighbor = spaces.find(candidate => candidate.space === neighborKey);
			if (!neighbor) {
				return unknownSpace(neighborKey);
			}
			if (neighbor.space === entry.space || neighbor.kind !== entry.kind || (entry.kind === 'worktree' && neighbor.repositoryId !== entry.repositoryId) || neighbor.worktree?.isMainCheckout) {
				return fail('"before" / "after" must name another space of the same kind: another repository for a repository, another worktree space of the same repository for a worktree space.');
			}
		}

		const rows = this.list();
		let destination: string | undefined;
		if (request.section !== undefined && request.section !== PARADIS_AGENT_IDE_SECTION_NONE) {
			const row = rows.find(candidate => candidate.id === request.section);
			if (!row) {
				return fail(this._unknownSection(request.section, rows));
			}
			if (entry.kind === 'repository' ? row.repository !== undefined : row.repository !== entry.repositoryId) {
				return fail(entry.kind === 'repository'
					? `Section "${row.id}" is a section inside repository "${row.repository}" and only holds its worktree spaces. A repository goes into a section without "repository" in list_spaces "sections".`
					: `A worktree space only goes into a section of its own repository ("repository": "${entry.repositoryId}" in list_spaces "sections").`);
			}
			destination = row.id;
		}
		if (neighbor) {
			const neighborSection = sectionOf(neighbor);
			if (request.section !== undefined && neighborSection !== destination) {
				return fail(`"${neighbor.space}" is ${neighborSection !== undefined ? `in section "${neighborSection}"` : 'not in a section'}, which differs from "section". Omit "section" to join the section of the space named by "before" / "after".`);
			}
			destination = neighborSection;
		}

		const after = request.after !== undefined;
		if (entry.worktree) {
			this.spaceSectionsService.moveSpaceToSection(entry.worktree, destination, neighbor?.worktree ? { worktree: neighbor.worktree, after } : undefined);
		} else {
			this.sectionsService.moveRepositoryToSection(entry.repositoryId, destination, neighbor ? { repositoryId: neighbor.repositoryId, after } : undefined);
		}
		if (sectionOf(entry) !== destination) {
			return fail(NOT_SAVED);
		}
		return { ok: true, data: { space: entry.space, section: destination ?? null } };
	}

	/** 無い id を断る文。今ある id を添える。 */
	private _unknownSection(id: string, rows: readonly IParadisAgentIdeSectionRow[]): string {
		const known = rows.map(row => `${row.id} (${JSON.stringify(row.name)}${row.repository !== undefined ? `, in repository ${row.repository}` : ''})`);
		return `Unknown section "${id}". ${known.length > 0 ? `Sections: ${known.join('; ')}.` : 'There are no sections yet; create one with create_space_section.'}`;
	}
}

/** リポジトリ（またはそのワークツリーのスペース）が範囲内か。作ったスペースはリポジトリが違っても範囲内。 */
function inScope(scope: ParadisAgentIdeSectionScope, repositoryId: string, space?: string): boolean {
	return scope === 'window' || repositoryId === scope.repository || (space !== undefined && scope.createdSpaces.has(space));
}

/** 変える・消してよいセクションか。スペースのセクションは持ち主、プロジェクトのセクションは中身のリポジトリがすべて範囲内（空を含む）。 */
function sectionInScope(scope: ParadisAgentIdeSectionScope, row: IParadisAgentIdeSectionRow): boolean {
	return row.repository !== undefined ? inScope(scope, row.repository) : row.spaces.every(repositoryId => inScope(scope, repositoryId));
}

function outOfScope(scope: ParadisAgentIdeSectionScope): string {
	return scope !== 'window' && scope.repository === undefined ? NO_SPACE : OUT_OF_SCOPE;
}
