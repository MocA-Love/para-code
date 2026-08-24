/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_OFFICE_CHANNEL, type IParadisOfficeDocumentBackend, type ParadisOfficeV1Negotiation } from '../../common/paradisOfficeChannel.js';
import { createParadisOfficeError } from '../../common/paradisOfficeErrors.js';
import type { ParadisOfficeRequest, ParadisOfficeResponse, ParadisOfficeSourceDescriptor } from '../../common/paradisOfficeProtocol.js';
import { ParadisOfficeRemoteSourceResolver } from '../../node/paradisOfficeRemoteBackend.js';
import { ParadisOfficeServerChannel } from '../../node/paradisOfficeServerChannel.js';

const remoteDescriptor: ParadisOfficeSourceDescriptor = {
	kind: 'remote',
	uri: 'vscode-remote://ssh-remote%2Bhost/workspace/book.xlsx',
	revisionHint: 'office-remote-hint:1',
	displayName: 'book.xlsx',
	side: 'modified',
};

function failedResponse(request: ParadisOfficeRequest): ParadisOfficeResponse {
	return {
		version: 1,
		requestId: request.requestId,
		operation: request.operation,
		ok: false,
		outcome: 'failed',
		error: createParadisOfficeError('source', 'notFound', { severity: 'error', retryable: false, recoverable: true, userAction: 'retry' }),
	};
}

function backend(): IParadisOfficeDocumentBackend {
	const fail = (_ownerId: string, request: ParadisOfficeRequest) => Promise.resolve(failedResponse(request));
	return {
		inspect: fail,
		open: fail,
		getViewport: fail,
		compare: fail,
		search: fail,
		getRenderableAsset: fail,
		getPrintModel: fail,
		exportPrint: fail,
		close: fail,
		cancel: fail,
		disconnect: () => { },
	};
}

suite('ParadisOfficeServerChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves same-authority remote files into immutable raw worker bytes', async () => {
		const sourceBytes = Uint8Array.from([80, 75, 3, 4]);
		let openedPath: string | undefined;
		let closed = 0;
		const stat = { dev: 1, ino: 2, ctimeMs: 3, mtimeMs: 4, size: sourceBytes.byteLength, isFile: () => true };
		const resolver = new ParadisOfficeRemoteSourceResolver('ssh-remote+host', {
			openFile: async path => {
				openedPath = path;
				return {
					stat: async () => stat,
					read: async (buffer, offset, length, position) => {
						const bytesRead = Math.max(0, Math.min(length, sourceBytes.byteLength - position));
						buffer.set(sourceBytes.subarray(position, position + bytesRead), offset);
						return { bytesRead };
					},
					close: async () => { closed++; },
				};
			},
		});

		const resolved = await resolver.resolve('remote:owner', remoteDescriptor, CancellationToken.None);

		assert.deepStrictEqual({ openedPath, kind: resolved.kind, bytes: [...resolved.bytes], closed }, {
			openedPath: '/workspace/book.xlsx', kind: 'bytes', bytes: [...sourceBytes], closed: 1,
		});
		assert.ok(resolved.revision.includes('ssh-remote+host'));
		assert.ok(resolved.revision.includes('office-remote-hint:1'));
		assert.ok(resolved.revision.endsWith('9:1:2:3:4:4|64:8dcc7e601606217f3b754766511182a916b17e9a26a94c9d887104eba92e9bb2'));

		await assert.rejects(
			resolver.resolve('remote:owner', { ...remoteDescriptor, uri: 'vscode-remote://another-host/workspace/book.xlsx' }, CancellationToken.None),
			error => error instanceof Error && error.message === 'The Office source could not be resolved.' && error.stack === '',
		);
	});

	test('binds negotiation authority to one connection epoch and cleans up on disconnect', async () => {
		const disconnected = new Emitter<void>();
		const context = { remoteAuthority: 'ssh-remote+host', clientId: 'client-a' };
		let backendDisconnects = 0;
		const serverBackend = backend();
		serverBackend.disconnect = () => { backendDisconnects++; };
		const channel = new ParadisOfficeServerChannel(context, {
			onDidDisconnect: disconnected.event,
			connectionEpoch: 42,
			createBackend: authority => {
				assert.strictEqual(authority, context.remoteAuthority);
				return serverBackend;
			},
		});

		const negotiation = await channel.call<ParadisOfficeV1Negotiation>(context, 'negotiate', { versions: [1] });
		assert.deepStrictEqual({ version: negotiation.version, channel: negotiation.channel, epoch: negotiation.connectionEpoch, capabilityLength: negotiation.ownerCapability?.length }, {
			version: 1, channel: PARADIS_OFFICE_CHANNEL, epoch: 42, capabilityLength: 64,
		});
		disconnected.fire();
		await assert.rejects(channel.call(context, 'negotiate', { versions: [1] }), /disconnected/);
		assert.strictEqual(backendDisconnects, 1);
		channel.dispose();
		disconnected.dispose();
	});
});
