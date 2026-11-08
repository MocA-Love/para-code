/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentIdeGuide } from '../../../agentIde/common/paradisAgentIdeGuide.js';
import { paradisFormatTabId, paradisParseTabId, paradisTabIdFilePath } from '../../common/paradisTabId.js';

suite('Paradis tab id', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats one line per kind and reads it back', () => {
		const ids = [
			{ kind: 'terminal', value: 't_1a2b3c4d5e6f' },
			{ kind: 'browser', value: '0f8c2e1a-7d3b-4c5e-9a6f-1b2c3d4e5f60' },
			{ kind: 'simulator', value: 'ios:core-simulator:6B1E0E2A-3C4D-4E5F-8A9B-0C1D2E3F4A5B' },
			{ kind: 'simulator', value: 'android:serial:emulator-5554' },
			{ kind: 'file', value: 'src/my file.ts' },
		] as const;
		const lines = ids.map(id => paradisFormatTabId(id));
		assert.deepStrictEqual({
			lines,
			parsed: lines.map(line => paradisParseTabId(`  ${line}\n`)),
		}, {
			lines: [
				'paraTabId: terminal:t_1a2b3c4d5e6f',
				'paraTabId: browser:0f8c2e1a-7d3b-4c5e-9a6f-1b2c3d4e5f60',
				'paraTabId: simulator:ios:core-simulator:6B1E0E2A-3C4D-4E5F-8A9B-0C1D2E3F4A5B',
				'paraTabId: simulator:android:serial:emulator-5554',
				'paraTabId: file:src/my file.ts',
			],
			parsed: ids,
		});
	});

	test('refuses values that would break the single line, and lines of another shape', () => {
		assert.deepStrictEqual({
			newline: paradisFormatTabId({ kind: 'file', value: 'a\nb.ts' }),
			empty: paradisFormatTabId({ kind: 'browser', value: '' }),
			unknownKind: paradisParseTabId('paraTabId: editor:abc'),
			noValue: paradisParseTabId('paraTabId: terminal:'),
			otherPrefix: paradisParseTabId('orcaTabId: terminal:t_1'),
			twoLines: paradisParseTabId('paraTabId: terminal:t_1\nparaTabId: browser:x'),
		}, {
			newline: undefined,
			empty: undefined,
			unknownKind: undefined,
			noValue: undefined,
			otherPrefix: undefined,
			twoLines: undefined,
		});
	});

	test('file tabs: relative inside the space folder, absolute outside it, nothing for paths that are not on disk', () => {
		const folder = URI.file('/Users/example/app');
		const remoteFolder = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+dev', path: '/home/example/app' });
		assert.deepStrictEqual({
			inside: paradisTabIdFilePath(URI.file('/Users/example/app/src/a.ts'), folder),
			outside: paradisTabIdFilePath(URI.file('/Users/example/other/b.ts'), undefined),
			remoteInside: paradisTabIdFilePath(URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+dev', path: '/home/example/app/server.ts' }), remoteFolder),
			remoteOutside: paradisTabIdFilePath(URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+dev', path: '/etc/hosts' }), undefined),
			untitled: paradisTabIdFilePath(URI.from({ scheme: 'untitled', path: 'Untitled-1' }), undefined),
			git: paradisTabIdFilePath(URI.from({ scheme: 'git', path: '/Users/example/app/src/a.ts' }), folder),
		}, {
			inside: 'src/a.ts',
			outside: URI.file('/Users/example/other/b.ts').fsPath,
			remoteInside: 'server.ts',
			remoteOutside: '/etc/hosts',
			untitled: undefined,
			git: undefined,
		});
	});

	test('the guide tells agents which tool takes each kind', () => {
		const guide = paradisAgentIdeGuide({ actionsEnabled: true, actionScope: 'space', readOtherSpaces: false, shellCommands: false });
		assert.deepStrictEqual(
			['paraTabId: terminal:', '- terminal:<id>', '- browser:<tabId>', '- simulator:<device id>', '- file:<path>', 'request_browser_page', 'mobile_request_device'].filter(text => !guide.includes(text)),
			[],
		);
	});
});
