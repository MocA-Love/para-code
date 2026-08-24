/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import type { IGitRepository, IGitService } from '../../../../../workbench/contrib/git/common/gitService.js';
import type { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { ParadisOfficeDesktopSourceService } from '../../electron-browser/paradisOfficeDesktopSourceService.js';
import { PARADIS_OFFICE_CHANNEL, decodeParadisOfficeWireValue, marshalParadisOfficeResponse } from '../../common/paradisOfficeChannel.js';
import { createParadisOfficeError } from '../../common/paradisOfficeErrors.js';
import type { ParadisOfficeRequest, ParadisOfficeResponse, ParadisOfficeSourceDescriptor } from '../../common/paradisOfficeProtocol.js';

const capabilities = ['inspect', 'open', 'getViewport', 'compare', 'search', 'getRenderableAsset', 'getPrintModel', 'exportPrint', 'close', 'cancel'];

class Channel implements IChannel {
	readonly calls: string[] = [];
	constructor(private readonly callback: (command: string, arg: unknown) => unknown) { }
	call<T>(command: string, arg?: unknown): Promise<T> { this.calls.push(command); return Promise.resolve(this.callback(command, arg)) as Promise<T>; }
	listen<T>(): never { throw new Error('No events'); }
}

function failure(request: ParadisOfficeRequest): ParadisOfficeResponse {
	return { version: 1, requestId: request.requestId, operation: request.operation, ok: false, outcome: 'failed', error: createParadisOfficeError('source', 'notFound', { severity: 'error', retryable: false, recoverable: true, userAction: 'retry' }) };
}

suite('ParadisOfficeDesktopSourceService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('connects the real Git repository observable and remote/shared-process services', async () => {
		const root = URI.file('/workspace/repo');
		const state = observableValue('office-git-state', {
			HEAD: { type: 0, name: 'main', commit: '1'.repeat(40) }, remotes: [], mergeChanges: [],
			indexChanges: [{ uri: URI.file('/workspace/repo/book.xlsx'), originalUri: URI.file('/workspace/repo/book.xlsx'), modifiedUri: URI.file('/workspace/repo/book.xlsx') }],
			workingTreeChanges: [], untrackedChanges: [],
		});
		const repository = { rootUri: root, state } as unknown as IGitRepository;
		const reads: URI[] = [];
		const fileService = { readFile: async (resource: URI) => { reads.push(resource); return { value: VSBuffer.fromString(resource.scheme === 'git' ? 'head-or-index' : 'working') }; } } as unknown as IFileService;
		const remote = new Channel((command, arg) => {
			if (command === 'negotiate') { return { version: 1, channel: PARADIS_OFFICE_CHANNEL, capabilities, ownerCapability: 'd'.repeat(64), connectionEpoch: 1 }; }
			const request = decodeParadisOfficeWireValue(arg).value as ParadisOfficeRequest;
			return marshalParadisOfficeResponse(failure(request));
		});
		const local = new Channel(() => { throw new Error('local fallback must not be selected'); });
		const service = new ParadisOfficeDesktopSourceService(
			{ repositories: [repository] } as unknown as IGitService,
			fileService,
			{ getChannel: (name: string) => { assert.strictEqual(name, PARADIS_OFFICE_CHANNEL); return local; } } as unknown as ISharedProcessService,
			{ getConnection: () => ({ remoteAuthority: 'ssh-remote+host', getChannel: (name: string) => { assert.strictEqual(name, PARADIS_OFFICE_CHANNEL); return remote; } }) } as unknown as IRemoteAgentService,
			{ getValue: () => true } as unknown as IConfigurationService,
		);
		const gitSource = service.createGitSource(URI.file('/workspace/repo/book.xlsx'));
		assert.ok(gitSource);
		const comparison = await gitSource.createComparison('headToIndex', 'book.xlsx', CancellationToken.None);
		assert.deepStrictEqual([comparison.original.descriptor.kind, comparison.modified.descriptor.kind], ['gitCommit', 'gitIndex']);
		assert.deepStrictEqual(reads.map(resource => resource.scheme), ['git', 'git']);

		let brokerCalls = 0;
		const descriptor: ParadisOfficeSourceDescriptor = { kind: 'remote', uri: 'vscode-remote://ssh-remote%2Bhost/workspace/book.xlsx', displayName: 'book.xlsx' };
		const client = service.createRemoteClient({
			sourceBroker: { open: async () => { brokerCalls++; throw new Error('must not spool'); } },
			spoolClient: { begin: async () => { throw new Error(); }, claim: async () => { }, append: async () => { }, seal: async () => { throw new Error(); }, dispose: async () => { }, disposeAttempt: async () => { } },
			onWarning: () => { },
		});
		const result = await client.request({ version: 1, requestId: 'integration', operation: 'inspect', source: descriptor }, CancellationToken.None);
		assert.strictEqual(result.route, 'remoteV1');
		assert.strictEqual(brokerCalls, 0);
		assert.deepStrictEqual(remote.calls, ['negotiate', 'request']);
		client.dispose();
		gitSource.dispose();
	});
});
