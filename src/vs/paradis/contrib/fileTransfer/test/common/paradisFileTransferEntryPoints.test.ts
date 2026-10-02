/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import {
	paradisHostLabelFromAuthority,
	paradisIsUnknownChannelError,
	paradisShouldOpenFromPending,
	paradisShowsTitleBarEntry,
	paradisSideForResource,
	paradisToMachineFileUri,
	PARADIS_FILE_TRANSFER_PENDING_OPEN_TTL_MS,
} from '../../common/paradisFileTransfer.js';
import { PARADIS_FILE_TRANSFER_EXPLORER_WHEN, PARADIS_FILE_TRANSFER_TITLE_BAR_WHEN } from '../../common/paradisFileTransferEntryPoints.js';

function context(values: Record<string, unknown>): IContext {
	return { getValue: <T>(key: string) => values[key] as T };
}

const AUTHORITY = 'ssh-remote+dev-server';

suite('Paradis file transfer - entry points', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the title bar button appears only when the activity bar is not on the side', () => {
		const locations = ['default', 'top', 'bottom', 'hidden'];
		assert.deepStrictEqual({
			function: locations.map(paradisShowsTitleBarEntry),
			when: locations.map(location => PARADIS_FILE_TRANSFER_TITLE_BAR_WHEN.evaluate(context({ 'config.workbench.activityBar.location': location }))),
			unset: paradisShowsTitleBarEntry(undefined),
		}, {
			function: [false, true, true, true],
			when: [false, true, true, true],
			unset: false,
		});
	});

	test('the explorer menu appears for local and remote folders only', () => {
		const cases: Array<[boolean, string]> = [[true, 'file'], [true, 'vscode-remote'], [false, 'file'], [true, 'vscode-userdata'], [true, 'untitled']];
		assert.deepStrictEqual(
			cases.map(([isFolder, scheme]) => PARADIS_FILE_TRANSFER_EXPLORER_WHEN?.evaluate(context({ explorerResourceIsFolder: isFolder, resourceScheme: scheme }))),
			[true, true, false, false, false],
		);
	});

	test('a folder opens on the side of the machine it belongs to', () => {
		const local = URI.file('/Users/example/web-app');
		const remote = URI.from({ scheme: 'vscode-remote', authority: AUTHORITY, path: '/home/example/web-app' });
		const otherRemote = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+staging', path: '/srv' });
		assert.deepStrictEqual({
			sshWindow: [local, remote, otherRemote].map(resource => paradisSideForResource(resource, AUTHORITY)),
			localWindow: [local, remote].map(resource => paradisSideForResource(resource, undefined)),
			virtual: paradisSideForResource(URI.from({ scheme: 'vscode-userdata', path: '/settings.json' }), AUTHORITY),
		}, {
			sshWindow: ['local', 'remote', undefined],
			localWindow: ['local', undefined],
			virtual: undefined,
		});
	});

	test('a "connect and open" note is honoured only by the matching, fresh window', () => {
		const now = 10_000_000;
		const note = (authority: string, at: number) => JSON.stringify({ authority, at });
		assert.deepStrictEqual([
			paradisShouldOpenFromPending(note(AUTHORITY, now - 1000), AUTHORITY, now),
			paradisShouldOpenFromPending(note(AUTHORITY, now - PARADIS_FILE_TRANSFER_PENDING_OPEN_TTL_MS - 1), AUTHORITY, now),
			paradisShouldOpenFromPending(note('ssh-remote+staging', now), AUTHORITY, now),
			paradisShouldOpenFromPending(note(AUTHORITY, now), undefined, now),
			paradisShouldOpenFromPending('{broken', AUTHORITY, now),
			paradisShouldOpenFromPending(undefined, AUTHORITY, now),
		], [true, false, false, false, false, false]);
	});

	test('only an "Unknown channel" error means the server has no file modes channel', () => {
		const unknown = new Error('Channel name paradisFileModes timed out after 1000ms');
		unknown.name = 'Unknown channel';
		const timeout = new Error('Connection timed out');
		assert.deepStrictEqual([unknown, timeout, new Error('Canceled'), 'Unknown channel'].map(paradisIsUnknownChannelError), [true, false, false, false]);
	});

	test('labels and machine paths', () => {
		const remote = URI.from({ scheme: 'vscode-remote', authority: AUTHORITY, path: '/home/example/a b' });
		assert.deepStrictEqual({
			labels: [paradisHostLabelFromAuthority(AUTHORITY), paradisHostLabelFromAuthority('wsl+Ubuntu'), paradisHostLabelFromAuthority('plain')],
			machine: paradisToMachineFileUri(remote).toString(),
			local: paradisToMachineFileUri(URI.file('/tmp/x')).toString(),
		}, {
			labels: ['dev-server', 'Ubuntu', 'plain'],
			machine: 'file:///home/example/a%20b',
			local: 'file:///tmp/x',
		});
	});
});
