/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { stringHash } from '../../../../base/common/hash.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { isEqualOrParent, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IGitService, type GitChange, type GitRepositoryState, type IGitRepository } from '../../../../workbench/contrib/git/common/gitService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { ParadisOfficeGitSource, type IParadisOfficeGitByteProvider, type IParadisOfficeGitRepository, type ParadisOfficeGitChange, type ParadisOfficeGitRepositorySnapshot } from '../browser/paradisOfficeGitSource.js';
import { ParadisOfficeRemoteClient, type ParadisOfficeRemoteClientOptions } from '../browser/paradisOfficeRemoteClient.js';
import { PARADIS_OFFICE_CHANNEL } from '../common/paradisOfficeChannel.js';

export const IParadisOfficeDesktopSourceService = createDecorator<IParadisOfficeDesktopSourceService>('paradisOfficeDesktopSourceService');

export interface IParadisOfficeDesktopSourceService {
	readonly _serviceBrand: undefined;
	createGitSource(resource: URI): ParadisOfficeGitSource | undefined;
	createRemoteClient(options: Pick<ParadisOfficeRemoteClientOptions, 'sourceBroker' | 'spoolClient' | 'onWarning'>): ParadisOfficeRemoteClient;
}

function checksum(value: string): string {
	let result = '';
	for (let index = 0; index < 8; index++) { result += (stringHash(`${index}\0${value}`, index) >>> 0).toString(16).padStart(8, '0'); }
	return result;
}

function changePath(root: URI, resource: URI | undefined): string | undefined {
	if (!resource) { return undefined; }
	const path = relativePath(root, resource);
	return path && !path.includes('\\') ? path : undefined;
}

function snapshotChange(root: URI, change: GitChange): ParadisOfficeGitChange | undefined {
	const original = changePath(root, change.originalUri);
	const modified = changePath(root, change.modifiedUri);
	const current = modified ?? original ?? changePath(root, change.uri);
	if (!current) { return undefined; }
	if (original && modified && original !== modified) { return { status: 'renamed', path: modified, originalPath: original }; }
	if (!original && modified) { return { status: 'added', path: modified }; }
	if (original && !modified) { return { status: 'deleted', path: original }; }
	return { status: 'modified', path: current };
}

class WorkbenchGitRepository extends Disposable implements IParadisOfficeGitRepository {
	private readonly changeEmitter = this._register(new Emitter<void>());
	readonly onDidChange = this.changeEmitter.event;
	readonly snapshot!: ParadisOfficeGitRepositorySnapshot;
	private revision = 0;

	constructor(private readonly repository: IGitRepository) {
		super();
		this._register(autorun(reader => this.update(repository.state.read(reader))));
	}

	private update(state: GitRepositoryState): void {
		this.revision++;
		const indexChanges = state.indexChanges.map(change => snapshotChange(this.repository.rootUri, change)).filter((change): change is ParadisOfficeGitChange => !!change);
		const workingTreeChanges = [...state.workingTreeChanges, ...state.untrackedChanges].map(change => snapshotChange(this.repository.rootUri, change)).filter((change): change is ParadisOfficeGitChange => !!change);
		const identity = JSON.stringify({ head: state.HEAD?.commit ?? '', indexChanges, revision: this.revision });
		Object.defineProperty(this, 'snapshot', {
			configurable: true, enumerable: true, writable: true, value: {
				repositoryRoot: URI.parse(this.repository.rootUri.toString(true), true),
				headCommit: state.HEAD?.commit ?? '', indexChecksum: checksum(identity), workingTreeRevision: `repository-event:${this.revision}:${checksum(JSON.stringify(workingTreeChanges))}`,
				indexChanges, workingTreeChanges,
			} satisfies ParadisOfficeGitRepositorySnapshot
		});
		if (this.revision > 1) { this.changeEmitter.fire(); }
	}
}

class WorkbenchGitBytes implements IParadisOfficeGitByteProvider {
	constructor(private readonly fileService: IFileService) { }
	async readFile(resource: URI, token: CancellationToken, maximumBytes: number) {
		const content = await this.fileService.readFile(resource, { limits: { size: maximumBytes } }, token);
		return content.value.clone();
	}
}

export class ParadisOfficeDesktopSourceService implements IParadisOfficeDesktopSourceService {
	declare readonly _serviceBrand: undefined;
	constructor(
		@IGitService private readonly gitService: IGitService,
		@IFileService private readonly fileService: IFileService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	createGitSource(resource: URI): ParadisOfficeGitSource | undefined {
		for (const repository of this.gitService.repositories) {
			if (isEqualOrParent(resource, repository.rootUri) && /^[a-f\d]{40,64}$/i.test(repository.state.get().HEAD?.commit ?? '')) {
				return new ParadisOfficeGitSource(new WorkbenchGitRepository(repository), new WorkbenchGitBytes(this.fileService));
			}
		}
		return undefined;
	}

	createRemoteClient(options: Pick<ParadisOfficeRemoteClientOptions, 'sourceBroker' | 'spoolClient' | 'onWarning'>): ParadisOfficeRemoteClient {
		return new ParadisOfficeRemoteClient({ ...options, remoteAgentService: this.remoteAgentService, localChannel: this.sharedProcessService.getChannel(PARADIS_OFFICE_CHANNEL), isPlatformBackendEnabled: () => this.configurationService.getValue<string>('paradis.officeViewer.engine') !== 'legacy' && this.configurationService.getValue<boolean>('paradis.officeViewer.platformBackend') !== false });
	}
}

registerSingleton(IParadisOfficeDesktopSourceService, ParadisOfficeDesktopSourceService, InstantiationType.Delayed);
