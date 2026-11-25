/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 見つからなくなった資料の追従と後片付け（common/paradisAgentDocsRelocate.ts）を、このウィンドウのファイルと台帳につなぐ。
// ファイルは IFileService、探索は ISearchService（ripgrep のファイルの列挙）で見るので、SSH の窓では接続先で同じに動く。
// 「資料」ビューを開いていなくても動く（指紋は、資料が書かれたときに取っておかないと、移された後では取れない）。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileChangesEvent, IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IFileQuery, ISearchService, QueryType } from '../../../../workbench/services/search/common/search.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisDocKind } from '../common/paradisAgentDocs.js';
import { IParadisDocRelocatorHost, PARADIS_DOC_FINGERPRINT_MAX_BYTES, PARADIS_DOC_RELOCATE_EXCLUDES, PARADIS_DOC_RELOCATE_MAX_FOUND, ParadisDocRelocator } from '../common/paradisAgentDocsRelocate.js';
import { IParadisDocViewRecord, PARADIS_AGENT_DOCS_VIEW_CHANNEL, PARADIS_AGENT_DOCS_VIEW_ON_DID_CHANGE, ParadisAgentDocsViewCall } from '../common/paradisAgentDocsView.js';
import { paradisDocFolderOf } from './paradisAgentDocsChannel.js';
import { paradisDocResource, paradisDocTargetOf, paradisIsFileNotFound, paradisWindowDocHostId } from './paradisAgentDocsView.js';

/** 台帳が変わってから見直すまでの間（hook が続けて来ても 1 回にする）。 */
const SYNC_DELAY_MS = 500;
/** 1 回の探索の締め切り。 */
const SEARCH_TIMEOUT_MS = 20_000;

function toHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

class ParadisAgentDocsRelocateContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAgentDocsRelocate';

	constructor(
		@IFileService fileService: IFileService,
		@ISearchService searchService: ISearchService,
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService worktreeService: IParadisWorktreeService,
	) {
		super();
		const remoteAuthority = environmentService.remoteAuthority;
		const hostId = paradisWindowDocHostId(remoteAuthority);
		if (hostId === undefined) {
			// 接続先の印を作れない窓では、資料を扱わない
			return;
		}
		const channel = sharedProcessService.getChannel(PARADIS_AGENT_DOCS_VIEW_CHANNEL);
		const resourceOf = (path: string) => paradisDocResource(path, remoteAuthority);
		const pathOf = (resource: URI) => paradisDocTargetOf(resource, hostId)?.path;
		const host: IParadisDocRelocatorHost = {
			hostId,
			now: () => Date.now(),
			list: async () => {
				const records = await channel.call<IParadisDocViewRecord[]>(ParadisAgentDocsViewCall.List);
				return Array.isArray(records) ? records : [];
			},
			roots: () => {
				const folders = [
					...paradisListSpaces(workspaceSwitchService.repositories, worktreeService).map(entry => entry.uri),
					...workspaceContextService.getWorkspace().folders.map(folder => folder.uri),
				];
				return [...new Set(folders.map(folder => paradisDocFolderOf(folder)).filter(folder => folder?.hostId === hostId).map(folder => folder!.path))];
			},
			stat: async path => {
				try {
					const stat = await fileService.stat(resourceOf(path));
					return stat.isFile ? { size: stat.size, mtime: stat.mtime } : undefined;
				} catch (error) {
					return paradisIsFileNotFound(error) ? 'missing' : undefined;
				}
			},
			hash: async path => {
				const content = await fileService.readFile(resourceOf(path), { limits: { size: PARADIS_DOC_FINGERPRINT_MAX_BYTES } });
				const bytes = content.value.buffer;
				return { hash: toHex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), size: bytes.byteLength };
			},
			findDocs: async root => {
				const query: IFileQuery = {
					type: QueryType.File,
					_reason: 'paradisAgentDocsRelocate',
					// 資料は .gitignore に載ったフォルダへ移されることが多いので、無視の設定は使わない
					folderQueries: [{ folder: resourceOf(root), disregardIgnoreFiles: true, disregardGlobalIgnoreFiles: true, disregardParentIgnoreFiles: true, ignoreSymlinks: true }],
					includePattern: { '**/*.{html,htm,md}': true },
					excludePattern: Object.fromEntries(PARADIS_DOC_RELOCATE_EXCLUDES.map(pattern => [pattern, true])),
					ignoreGlobCase: true,
					maxResults: PARADIS_DOC_RELOCATE_MAX_FOUND,
					sortByScore: false,
				};
				const cancellation = new CancellationTokenSource();
				const timer = setTimeout(() => cancellation.cancel(), SEARCH_TIMEOUT_MS);
				try {
					const result = await searchService.fileSearch(query, cancellation.token);
					const paths = result.results.map(match => pathOf(match.resource)).filter((path): path is string => path !== undefined);
					return { paths, complete: result.limitHit !== true && !cancellation.token.isCancellationRequested };
				} finally {
					clearTimeout(timer);
					cancellation.dispose();
				}
			},
			setFingerprints: async updates => {
				await channel.call(ParadisAgentDocsViewCall.SetFingerprints, [hostId, updates]);
			},
			setMissing: async (path, missing) => {
				await channel.call(ParadisAgentDocsViewCall.SetMissing, [hostId, path, missing]);
			},
			relocate: async (from, to, hash) => await channel.call<boolean>(ParadisAgentDocsViewCall.Relocate, [hostId, from, to, hash]) === true,
			remove: async paths => {
				await channel.call(ParadisAgentDocsViewCall.RemoveMany, [hostId, paths]);
			},
		};
		const relocator = new ParadisDocRelocator(host);
		const scheduler = this._register(new RunOnceScheduler(() => void relocator.sync(), SYNC_DELAY_MS));
		this._register(channel.listen<void>(PARADIS_AGENT_DOCS_VIEW_ON_DID_CHANGE)(() => scheduler.schedule()));
		this._register(workspaceSwitchService.onDidSwitchScope(() => scheduler.schedule()));
		this._register(fileService.onDidFilesChange(event => this._onFilesChanged(event, relocator, pathOf)));
		scheduler.schedule();
	}

	private _onFilesChanged(event: FileChangesEvent, relocator: ParadisDocRelocator, pathOf: (resource: URI) => string | undefined): void {
		// 本体と資料の見張りの知らせだけを使う（個別に張った見張りの知らせは、張った側のもの）
		if (event.hasCorrelation()) {
			return;
		}
		const paths = (resources: readonly URI[], docsOnly: boolean) => resources.map(pathOf).filter((path): path is string => path !== undefined && (!docsOnly || paradisDocKind(path) !== undefined));
		// 消えた方は、フォルダごと消えた（移された）知らせも使う
		void relocator.filesChanged({ added: paths(event.rawAdded, true), updated: paths(event.rawUpdated, true), deleted: paths(event.rawDeleted, false) });
	}
}

registerWorkbenchContribution2(ParadisAgentDocsRelocateContribution.ID, ParadisAgentDocsRelocateContribution, WorkbenchPhase.AfterRestored);
