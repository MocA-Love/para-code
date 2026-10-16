/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP のブックマークの道具（paradisBookmarkToolProvider.ts）の受け口。shared process が呼び出し元ペインの
// ウィンドウだけへ送ってくる。ブックマークはアプリ全体で 1 本の木なので、どのウィンドウで変えてもすべてのウィンドウの
// バーに反映される（paradisBookmarksService.ts がストレージのイベントで同期する）。
//
// - 指すのは id だけ（題名では探さない。同じ題名がいくつあっても取り違えない）
// - 変えたら、どのターミナルのエージェントが何をしたかを通知する（SILENT。IDE 操作ツールの通知と同じ書き方）
// - 削除は、ページ共有と同じ承認のダイアログ（拒否が既定・拒否の後しばらくは自動で断る）で利用者が承認したときだけ行う。
//   中身のあるフォルダは recursive の明示が要り、消える件数をダイアログに出す。消したら件数を通常の通知で知らせ、
//   通知の「元に戻す」で消す前の場所へ戻す（消した後に同じ id や URL が足されていたら戻さない）

import { toAction } from '../../../../base/common/actions.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { INotificationService, NotificationPriority, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisSanitizeDisplayText } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import { paradisBindingRestoreDisplayName } from '../../agentBrowser/common/paradisBindingRestoreController.js';
import { IParadisAgentApprovalRequest, IParadisAgentBrowserTabsService, ParadisAgentApprovalOutcome, ParadisApprovalDeadline } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { countParadisDescendants, findParadisBookmarkByUrl, findParadisNodeById, findParadisParentFolderId, isParadisBookmarkFolder, ParadisBookmarkMoveError, ParadisBookmarkNode } from '../common/paradisBookmarkModel.js';
import { PARADIS_BOOKMARK_MCP_CHANNEL, PARADIS_BOOKMARK_MCP_METHOD, PARADIS_BOOKMARK_URL_MAX_LENGTH, ParadisBookmarkToolRequest, ParadisBookmarkToolResult, paradisBookmarkToolTitle, paradisBookmarkToolTree, paradisBookmarkToolUrlAllowed } from '../common/paradisBookmarkTools.js';
import { IParadisBookmarksService } from './paradisBookmarksService.js';

const MOVE_ERRORS: Readonly<Record<ParadisBookmarkMoveError, string>> = {
	'not-found': 'No bookmark or folder has that "id". Call list_bookmarks for the current ids.',
	'folder-not-found': '"folder_id" is not a folder. Call list_bookmarks for the current folder ids.',
	'into-itself': 'A folder cannot move into itself or into one of its own folders.',
};

/** 削除の確認で、承認以外の答えのときにエージェントへ返す英文。 */
const DELETE_REFUSALS: Readonly<Record<Exclude<ParadisAgentApprovalOutcome, 'approve' | 'alternative'>, string>> = {
	'denied': 'The user declined to delete it. Do not ask again for this; ask the user in the conversation if needed.',
	'recentlyDenied': 'The user declined a deletion a short while ago, so Para Code turned this one down without asking. Ask the user in the conversation.',
	'busy': 'Another request from this terminal pane is waiting for the user. Wait for it to finish, then try again.',
	'unanswered': 'Para Code could not get a clear answer: the dialog was answered right after it appeared or with a keyboard shortcut. Nothing was deleted. Ask the user to click a button in the dialog, then ask again.',
	'cancelled': 'The deletion was cancelled before the user answered, so nothing was deleted.',
};

/** 利用者への知らせ。`undo` があれば通知に「元に戻す」を付ける。 */
export interface IParadisBookmarkNotice {
	readonly message: string;
	readonly silent: boolean;
	readonly undo?: () => void;
}

/** 削除の確認のダイアログを出す口（ページ共有と同じ承認のダイアログ。テストでは差し替える）。 */
export type ParadisBookmarkDeleteConfirm = (paneToken: string, request: IParadisAgentApprovalRequest, cancellation: CancellationToken) => Promise<ParadisAgentApprovalOutcome>;

/**
 * 題名を通知とダイアログに入れられる形にする。題名はエージェントやページ・ターミナルの中のプログラムが決められ、
 * 通知は `[文字](command:…)` をコマンドの実行のリンクとして描くので、かっこを全角にし、双方向の制御文字を落とす。
 */
function display(title: string | undefined): string {
	return paradisBindingRestoreDisplayName(title, localize('paradis.bookmarks.mcp.unknownCaller', "不明"));
}

function fail(error: string): ParadisBookmarkToolResult {
	return { ok: false, error };
}

/** 節を、エージェントへ返す形（id・種類・題名・URL・入っているフォルダ）にする。 */
function describeNode(nodes: readonly ParadisBookmarkNode[], node: ParadisBookmarkNode): object {
	return {
		id: node.id,
		type: node.type,
		title: paradisBookmarkToolTitle(node.title),
		...(node.type === 'bookmark' ? { url: node.url } : {}),
		folder_id: findParadisParentFolderId(nodes, node.id),
	};
}

/** shared process で検証済みの要求でも、形だけはここでも確かめる（チャネルは誰でも呼べる名前で登録されるため）。 */
function isRequest(value: unknown): value is ParadisBookmarkToolRequest {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const request = value as Record<string, unknown>;
	const optionalFolder = request.folderId === null || typeof request.folderId === 'string';
	switch (request.op) {
		case 'list':
			return (request.folderId === undefined || typeof request.folderId === 'string') && (request.redactUrls === undefined || typeof request.redactUrls === 'boolean');
		case 'add':
			return typeof request.url === 'string' && typeof request.title === 'string' && optionalFolder;
		case 'createFolder':
			return typeof request.title === 'string' && request.title.length > 0 && optionalFolder;
		case 'rename':
			return typeof request.id === 'string' && typeof request.title === 'string' && request.title.length > 0;
		case 'move':
			return typeof request.id === 'string' && optionalFolder && (request.index === undefined || (typeof request.index === 'number' && Number.isInteger(request.index) && request.index >= 0));
		case 'delete':
			return typeof request.id === 'string' && typeof request.recursive === 'boolean';
		default:
			return false;
	}
}

/**
 * ブックマークの道具の要求を、ブックマークのサービスへ当てる。
 * `notify` は利用者への知らせ（`caller` はどのターミナルのエージェントかの名前）。
 */
export class ParadisBookmarkMcpChannel implements IServerChannel {

	constructor(
		private readonly bookmarks: IParadisBookmarksService,
		private readonly notify: (notice: IParadisBookmarkNotice) => void,
		private readonly describeCaller: (paneToken: string) => string | undefined,
		private readonly confirmDelete: ParadisBookmarkDeleteConfirm,
	) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
		if (command !== PARADIS_BOOKMARK_MCP_METHOD) {
			throw new Error(`Method not found: ${command}`);
		}
		const [paneToken, request] = Array.isArray(arg) ? arg : [];
		if (typeof paneToken !== 'string' || !isRequest(request)) {
			return fail('Para Code received a malformed bookmark request.') as T;
		}
		return await this.handle(paneToken, request, cancellationToken ?? CancellationToken.None) as T;
	}

	async handle(paneToken: string, request: ParadisBookmarkToolRequest, cancellation: CancellationToken = CancellationToken.None): Promise<ParadisBookmarkToolResult> {
		const nodes = this.bookmarks.nodes;
		switch (request.op) {
			case 'list': {
				if (request.folderId !== undefined) {
					const folder = findParadisNodeById(nodes, request.folderId);
					if (!folder || !isParadisBookmarkFolder(folder)) {
						return fail(MOVE_ERRORS['folder-not-found']);
					}
					const tree = paradisBookmarkToolTree(folder.children, undefined, request.redactUrls);
					return { ok: true, data: { folder: describeNode(nodes, folder), ...tree } };
				}
				return { ok: true, data: paradisBookmarkToolTree(nodes, undefined, request.redactUrls) };
			}
			case 'add': {
				if (!paradisBookmarkToolUrlAllowed(request.url)) {
					return fail('"url" must be an http or https URL.');
				}
				if (!this.isFolder(request.folderId)) {
					return fail(MOVE_ERRORS['folder-not-found']);
				}
				const existing = findParadisBookmarkByUrl(nodes, request.url);
				if (existing) {
					return { ok: true, data: { added: false, note: 'This URL is already bookmarked; nothing changed.', bookmark: describeNode(nodes, existing) } };
				}
				const added = this.bookmarks.addBookmark({ url: request.url, title: request.title, folderId: request.folderId });
				if (!added) {
					return fail('"url" must be an http or https URL.');
				}
				this.announce(paneToken, caller => localize('paradis.bookmarks.mcp.added', "ターミナル「{0}」のエージェントがブックマーク「{1}」を追加しました。", caller, display(added.title)));
				return { ok: true, data: { added: true, bookmark: describeNode(this.bookmarks.nodes, added) } };
			}
			case 'createFolder': {
				if (!this.isFolder(request.folderId)) {
					return fail(MOVE_ERRORS['folder-not-found']);
				}
				const folder = this.bookmarks.addFolder({ title: request.title, parentFolderId: request.folderId });
				this.announce(paneToken, caller => localize('paradis.bookmarks.mcp.folderCreated', "ターミナル「{0}」のエージェントがブックマークのフォルダ「{1}」を作りました。", caller, display(folder.title)));
				return { ok: true, data: { created: describeNode(this.bookmarks.nodes, folder) } };
			}
			case 'rename': {
				const target = findParadisNodeById(nodes, request.id);
				if (!target) {
					return fail(MOVE_ERRORS['not-found']);
				}
				const renamed = this.bookmarks.renameNode(request.id, request.title);
				if (!renamed) {
					return fail(MOVE_ERRORS['not-found']);
				}
				this.announce(paneToken, caller => localize('paradis.bookmarks.mcp.renamed', "ターミナル「{0}」のエージェントがブックマーク「{1}」の名前を「{2}」に変えました。", caller, display(target.title), display(renamed.title)));
				return { ok: true, data: { renamed: describeNode(this.bookmarks.nodes, renamed), previous_title: paradisBookmarkToolTitle(target.title) } };
			}
			case 'move': {
				const target = findParadisNodeById(nodes, request.id);
				const error = this.bookmarks.moveNodeTo(request.id, request.folderId, request.index);
				if (error !== undefined || !target) {
					return fail(MOVE_ERRORS[error ?? 'not-found']);
				}
				const after = this.bookmarks.nodes;
				const folder = request.folderId === null ? undefined : findParadisNodeById(after, request.folderId);
				const siblings = folder && isParadisBookmarkFolder(folder) ? folder.children : after;
				const destinationTitle = folder?.title;
				this.announce(paneToken, caller => destinationTitle === undefined
					? localize('paradis.bookmarks.mcp.movedToBar', "ターミナル「{0}」のエージェントがブックマーク「{1}」をバーへ移しました。", caller, display(target.title))
					: localize('paradis.bookmarks.mcp.moved', "ターミナル「{0}」のエージェントがブックマーク「{1}」をフォルダ「{2}」へ移しました。", caller, display(target.title), display(destinationTitle)));
				return { ok: true, data: { moved: describeNode(after, target), index: siblings.findIndex(node => node.id === target.id) } };
			}
			case 'delete':
				return this.delete(paneToken, request.id, request.recursive, cancellation);
		}
	}

	private async delete(paneToken: string, id: string, recursive: boolean, cancellation: CancellationToken): Promise<ParadisBookmarkToolResult> {
		const target = findParadisNodeById(this.bookmarks.nodes, id);
		if (!target) {
			return fail(MOVE_ERRORS['not-found']);
		}
		const inside = countParadisDescendants(target);
		if (inside.bookmarks + inside.folders > 0 && !recursive) {
			return fail(`That folder contains ${inside.bookmarks} bookmarks and ${inside.folders} folders. Pass "recursive": true to delete it with everything inside, after checking with list_bookmarks that this is what the user wants.`);
		}
		const title = display(target.title);
		const isFolder = isParadisBookmarkFolder(target);
		const request: IParadisAgentApprovalRequest = {
			messageTemplate: pane => isFolder
				? localize('paradis.bookmarks.mcp.deleteFolderMessage', "{0} のエージェントが、ブックマークのフォルダ「{1}」を削除しようとしています", pane, title)
				: localize('paradis.bookmarks.mcp.deleteMessage', "{0} のエージェントが、ブックマーク「{1}」を削除しようとしています", pane, title),
			detail: [
				...(target.type === 'bookmark' ? [localize('paradis.bookmarks.mcp.deleteUrl', "URL: {0}", paradisSanitizeDisplayText(target.url, PARADIS_BOOKMARK_URL_MAX_LENGTH) ?? '')] : []),
				...(inside.bookmarks + inside.folders > 0 ? [localize('paradis.bookmarks.mcp.deleteInside', "フォルダの中のブックマーク {0} 件とフォルダ {1} 個も一緒に削除されます。", inside.bookmarks, inside.folders)] : []),
				localize('paradis.bookmarks.mcp.deleteUndo', "削除した後に出る通知の「元に戻す」で、元の場所へ戻せます。"),
			],
			approveLabel: localize('paradis.bookmarks.mcp.deleteApprove', "削除"),
			cooldownKey: 'bookmark-delete',
		};
		const outcome = await this.confirmDelete(paneToken, request, cancellation);
		if (outcome !== 'approve') {
			return fail(outcome === 'alternative' ? DELETE_REFUSALS.cancelled : DELETE_REFUSALS[outcome]);
		}
		// ダイアログを待つ間に木が変わっていれば、消す前の場所と中身を取り直す
		const current = findParadisNodeById(this.bookmarks.nodes, id);
		if (!current) {
			return fail(MOVE_ERRORS['not-found']);
		}
		const removedInside = countParadisDescendants(current);
		const parentId = findParadisParentFolderId(this.bookmarks.nodes, id);
		const parent = parentId === null ? undefined : findParadisNodeById(this.bookmarks.nodes, parentId);
		const siblings = parent && isParadisBookmarkFolder(parent) ? parent.children : this.bookmarks.nodes;
		const index = siblings.findIndex(node => node.id === id);
		this.bookmarks.removeNode(id);
		const count = 1 + removedInside.bookmarks + removedInside.folders;
		const caller = display(this.describeCaller(paneToken));
		this.notify({
			message: localize('paradis.bookmarks.mcp.deleted', "ターミナル「{0}」のエージェントがブックマークを {1} 件削除しました（「{2}」）。", caller, count, display(current.title)),
			silent: false,
			undo: () => {
				if (!this.bookmarks.restoreNode(current, parentId, index)) {
					this.notify({ message: localize('paradis.bookmarks.mcp.undoFailed', "削除したブックマーク「{0}」を戻せませんでした。同じブックマークがもう一度足されています。", display(current.title)), silent: false });
				}
			},
		});
		return {
			ok: true, data: {
				deleted: { id: current.id, type: current.type, title: paradisBookmarkToolTitle(current.title), folder_id: parentId },
				bookmarks_deleted: removedInside.bookmarks + (current.type === 'bookmark' ? 1 : 0),
				folders_deleted: removedInside.folders + (current.type === 'folder' ? 1 : 0),
				note: 'The user can undo this from the notification.',
			},
		};
	}

	private isFolder(folderId: string | null): boolean {
		if (folderId === null) {
			return true;
		}
		const folder = findParadisNodeById(this.bookmarks.nodes, folderId);
		return folder !== undefined && isParadisBookmarkFolder(folder);
	}

	private announce(paneToken: string, message: (caller: string) => string): void {
		this.notify({ message: message(display(this.describeCaller(paneToken))), silent: true });
	}
}

/** 呼び出し元ペインのウィンドウとして、ブックマークの道具の受け口を shared process へ登録する。 */
class ParadisBookmarkMcpContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisBookmarkMcp';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IParadisBookmarksService bookmarks: IParadisBookmarksService,
		@INotificationService notificationService: INotificationService,
		@IParadisPaneTokenService paneTokenService: IParadisPaneTokenService,
		@ITerminalService terminalService: ITerminalService,
		@IParadisAgentBrowserTabsService approvals: IParadisAgentBrowserTabsService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_BOOKMARK_MCP_CHANNEL, new ParadisBookmarkMcpChannel(
			bookmarks,
			notice => notificationService.notify({
				severity: Severity.Info,
				...(notice.silent ? { priority: NotificationPriority.SILENT } : {}),
				message: notice.message,
				...(notice.undo ? { actions: { primary: [toAction({ id: 'paradis.bookmarks.mcp.undo', label: localize('paradis.bookmarks.mcp.undo', "元に戻す"), run: notice.undo })] } } : {}),
			}),
			// 題名はターミナルの中のプログラムが書けるので、通知に入れる所（display）で整える
			paneToken => {
				const instanceId = paneTokenService.getInstanceForToken(paneToken);
				return instanceId !== undefined ? terminalService.getInstanceFromId(instanceId)?.title : undefined;
			},
			async (paneToken, request, cancellation) => {
				// ダイアログはウィンドウ側の締め切り（50 秒）で閉じる。shared process の待ちはそれより長い
				const deadline = new ParadisApprovalDeadline(cancellation);
				try {
					return await approvals.askApproval(paneToken, request, deadline.token);
				} finally {
					deadline.dispose();
				}
			},
		));
	}
}

registerWorkbenchContribution2(ParadisBookmarkMcpContribution.ID, ParadisBookmarkMcpContribution, WorkbenchPhase.AfterRestored);
