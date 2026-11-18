/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 資料のツール（list_docs・adopt_doc）の、ウィンドウ側の受け口。shared process の ParadisAgentDocsToolProvider が
// 「呼び出し元ペインを所有するウィンドウ」だけへ送る。
//  - inspect: ペインのスペースのフォルダ、ファイルの有無と realpath（IFileService なので SSH の窓では接続先のファイルを見る）
//  - confirmAdopt: 生きている（か分からない）別の会話の資料を引き取る前に、ページ共有と同じ承認のダイアログで確かめる

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { paradisAgentHookRemoteHostId } from '../../agentBrowser/common/paradisAgentHooks.js';
import { paradisSanitizeDisplayText } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import type { IParadisAgentApprovalRequest, ParadisAgentApprovalOutcome } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import {
	IParadisDocAdoptConfirm,
	IParadisDocFolder,
	IParadisDocInspectedFile,
	IParadisDocInspectItem,
	IParadisDocInspectResult,
	PARADIS_ADOPT_DOC_MAX_PATHS,
	PARADIS_ADOPT_DOC_REASON_MAX_LENGTH,
	PARADIS_AGENT_DOCS_CONFIRM_METHOD,
	PARADIS_AGENT_DOCS_INSPECT_METHOD,
	PARADIS_LIST_DOCS_MAX,
	ParadisDocAdoptConfirmOutcome,
	paradisNormalizeDocPath,
} from '../common/paradisAgentDocs.js';

/** ダイアログに並べるファイル名の上限。超えた分は「ほか N 件」にまとめる。 */
const DIALOG_MAX_NAMES = 10;
const DIALOG_NAME_MAX_LENGTH = 80;
/** 拒否の後の自動の断りを数える単位（ページ共有などは止めない）。 */
const APPROVAL_COOLDOWN_KEY = 'agent-docs-adopt';

/** ウィンドウのうち、受け口が使う部分（テストでは差し替える）。 */
export interface IParadisAgentDocsWindow {
	/** このウィンドウの接続先（`ssh-remote+<host>` など）。手元の窓なら undefined。 */
	readonly remoteAuthority: string | undefined;
	/** そのトークンのペインがこのウィンドウにあるか。 */
	paneKnown(token: string): boolean;
	/** ペインが属するスペースのフォルダ。分からなければ undefined。 */
	paneFolder(token: string): URI | undefined;
	/** ファイルの種類。無ければ undefined。 */
	stat(resource: URI): Promise<{ readonly isFile: boolean } | undefined>;
	/** リンクを辿った先。分からなければ undefined。 */
	realpath(resource: URI): Promise<URI | undefined>;
}

/** 確認のダイアログを出す口。締め切りで閉じたときは 'timedOut' を返す。 */
export type ParadisAgentDocsAsk = (token: string, request: IParadisAgentApprovalRequest, cancellation: CancellationToken) => Promise<ParadisAgentApprovalOutcome | 'timedOut'>;

/** フォルダの URI を、台帳と同じ形（接続先の印と絶対パス）にする。 */
export function paradisDocFolderOf(resource: URI): IParadisDocFolder | undefined {
	if (resource.scheme === Schemas.file) {
		const path = paradisNormalizeDocPath(resource.fsPath);
		return path !== undefined ? { hostId: '', path } : undefined;
	}
	if (resource.scheme === Schemas.vscodeRemote) {
		const hostId = paradisAgentHookRemoteHostId(resource.authority);
		const path = paradisNormalizeDocPath(resource.path);
		return hostId !== undefined && path !== undefined ? { hostId, path } : undefined;
	}
	return undefined;
}

export class ParadisAgentDocsChannel implements IServerChannel<unknown> {

	constructor(
		private readonly _window: IParadisAgentDocsWindow,
		private readonly _ask: ParadisAgentDocsAsk,
	) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown, cancellationToken: CancellationToken = CancellationToken.None): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const token = typeof args[0] === 'string' ? args[0] : '';
		if (command === PARADIS_AGENT_DOCS_INSPECT_METHOD) {
			return this.inspect(token, Array.isArray(args[1]) ? args[1] : []) as Promise<T>;
		}
		if (command === PARADIS_AGENT_DOCS_CONFIRM_METHOD) {
			return this.confirmAdopt(token, args[1], cancellationToken) as Promise<T>;
		}
		throw new Error(`Call not found: ${command}`);
	}

	get windowHostId(): string {
		return this._window.remoteAuthority !== undefined ? paradisAgentHookRemoteHostId(this._window.remoteAuthority) ?? '' : '';
	}

	async inspect(token: string, rawItems: readonly unknown[]): Promise<IParadisDocInspectResult> {
		const windowHostId = this.windowHostId;
		if (token.length === 0 || !this._window.paneKnown(token)) {
			return { paneKnown: false, windowHostId, files: rawItems.map(() => ({})) };
		}
		const folderResource = this._window.paneFolder(token);
		const folder = folderResource !== undefined ? paradisDocFolderOf(folderResource) : undefined;
		const files = await Promise.all(rawItems.map((item, index) => index < PARADIS_LIST_DOCS_MAX ? this._inspectFile(item, windowHostId) : Promise.resolve({})));
		return { paneKnown: true, windowHostId, ...(folder !== undefined ? { folder } : {}), files };
	}

	private async _inspectFile(rawItem: unknown, windowHostId: string): Promise<IParadisDocInspectedFile> {
		const item = typeof rawItem === 'object' && rawItem !== null ? rawItem as Partial<IParadisDocInspectItem> : {};
		const path = paradisNormalizeDocPath(item.path);
		if (path === undefined || (typeof item.hostId === 'string' && item.hostId !== windowHostId)) {
			// 別の機械のファイルは、このウィンドウからは確かめられない
			return {};
		}
		const authority = this._window.remoteAuthority;
		const resource = authority !== undefined ? URI.from({ scheme: Schemas.vscodeRemote, authority, path: path.replace(/\\/g, '/') }) : URI.file(path);
		try {
			const stat = await this._window.stat(resource);
			if (stat === undefined) {
				return { exists: false };
			}
			const real = await this._window.realpath(resource).catch(() => undefined);
			const realPath = real !== undefined ? (real.scheme === Schemas.file ? real.fsPath : real.path) : undefined;
			return { exists: true, isFile: stat.isFile, ...(realPath !== undefined ? { realPath } : {}) };
		} catch {
			return {};
		}
	}

	async confirmAdopt(token: string, rawRequest: unknown, cancellationToken: CancellationToken): Promise<ParadisDocAdoptConfirmOutcome> {
		if (token.length === 0 || !this._window.paneKnown(token)) {
			return 'paneUnknown';
		}
		const request = typeof rawRequest === 'object' && rawRequest !== null ? rawRequest as Partial<IParadisDocAdoptConfirm> : {};
		const names = (Array.isArray(request.names) ? request.names : [])
			.slice(0, PARADIS_ADOPT_DOC_MAX_PATHS)
			.map(name => paradisSanitizeDisplayText(typeof name === 'string' ? name : undefined, DIALOG_NAME_MAX_LENGTH))
			.filter((name): name is string => name !== undefined && name.length > 0);
		if (names.length === 0) {
			return 'denied';
		}
		const reason = paradisSanitizeDisplayText(typeof request.reason === 'string' ? request.reason : undefined, PARADIS_ADOPT_DOC_REASON_MAX_LENGTH);
		const detail = names.slice(0, DIALOG_MAX_NAMES);
		if (names.length > DIALOG_MAX_NAMES) {
			detail.push(localize('paradis.agentDocs.adopt.more', "ほか {0} 件", names.length - DIALOG_MAX_NAMES));
		}
		if (reason !== undefined && reason.length > 0) {
			detail.push(localize('paradis.agentDocs.adopt.reason', "エージェントが示した理由: {0}", reason));
		}
		detail.push(localize('paradis.agentDocs.adopt.note', "移すと、資料の持ち主がこのターミナルのエージェントになります。ファイルの中身は変わりません。"));
		const outcome = await this._ask(token, {
			messageTemplate: paneLabel => localize('paradis.agentDocs.adopt.message', "{0} のエージェントが、別のエージェントが作った資料を自分の資料に移そうとしています。", paneLabel),
			detail,
			approveLabel: localize('paradis.agentDocs.adopt.approve', "移す"),
			cooldownKey: APPROVAL_COOLDOWN_KEY,
		}, cancellationToken);
		return outcome === 'alternative' ? 'denied' : outcome;
	}
}
