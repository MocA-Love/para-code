/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { RemoteTerminalChannelClient } from '../../common/remote/remoteTerminalChannel.js';

/**
 * Pins the arguments a window sends a remote host when it asks which terminal an old id names now.
 *
 * The server answers this request with `getRevivedPtyNewId.apply(service, args)` — it spreads the
 * array straight onto `IPtyService.getRevivedPtyNewId(workspaceId, id, nonce)`. So the array here
 * and the parameter list there are one contract with nothing checking it: send one element and the
 * id lands where the workspace goes, the id itself comes through as `undefined`, and the lookup can
 * never hit. The caller then falls back to attaching by the id it already had, which after ids are
 * handed out afresh names a different terminal — on a remote host, somebody else's live shell.
 */
suite('Para Code remote revived pty id', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the arguments line up with what the server spreads them onto', async () => {
		const sent: unknown[] = [];
		const client = Object.create(RemoteTerminalChannelClient.prototype) as RemoteTerminalChannelClient;
		(client as unknown as { _channel: IChannel })._channel = {
			call: async <T>(_command: string, arg?: unknown) => { sent.push(arg); return undefined as T; },
			listen: () => { throw new Error('not used'); },
		};

		await client.getRevivedPtyNewId('workspace-1', 31, 'nonce-of-the-tab');

		// Spread the way `remoteTerminalChannel.ts` on the server does, and read off what the pty host
		// would actually have been called with.
		const received: { workspaceId?: unknown; id?: unknown; nonce?: unknown } = {};
		((workspaceId: unknown, id: unknown, nonce: unknown) => {
			received.workspaceId = workspaceId;
			received.id = id;
			received.nonce = nonce;
		})(...(sent[0] as [unknown, unknown, unknown]));

		assert.deepStrictEqual(received, { workspaceId: 'workspace-1', id: 31, nonce: 'nonce-of-the-tab' });
	});
});
