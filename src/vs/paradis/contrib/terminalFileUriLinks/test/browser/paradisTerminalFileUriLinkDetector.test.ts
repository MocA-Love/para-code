/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { importAMDNodeModule } from '../../../../../amdX.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITerminalConfigurationService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalBuiltinLinkType } from '../../../../../workbench/contrib/terminalContrib/links/browser/links.js';
import { assertLinkHelper } from '../../../../../workbench/contrib/terminalContrib/links/test/browser/linkTestUtils.js';
import { ParadisTerminalFileUriLinkDetector } from '../../browser/paradisTerminalFileUriLinkDetector.js';
import type { Terminal } from '@xterm/xterm';

suite('ParadisTerminalFileUriLinkDetector', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let xterm: Terminal;

	setup(async () => {
		const TerminalConstructor = (await importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js')).Terminal;
		xterm = new TerminalConstructor({ allowProposedApi: true, cols: 80, rows: 30 });
		disposables.add(xterm);
	});

	function detector(options: { readonly resolves?: boolean; readonly allowFile?: boolean; readonly observed?: URI[] } = {}): ParadisTerminalFileUriLinkDetector {
		return new ParadisTerminalFileUriLinkDetector(
			xterm,
			{ initialCwd: '/workspace', os: OperatingSystem.Linux, remoteAuthority: undefined, userHome: '/home/user' },
			{
				resolveLink: async (_processManager, text, uri) => {
					if (!uri) {
						return null;
					}
					options.observed?.push(uri);
					return options.resolves ? { uri, link: text, isDirectory: false } : null;
				},
			},
			{ config: { allowedLinkSchemes: options.allowFile === false ? ['https'] : ['file'] } } as ITerminalConfigurationService,
		);
	}

	test('offers an unresolved UNC file URI to the existing URL opener', async () => {
		await assertLinkHelper(
			'open file://server/share/report.txt',
			[{ uri: URI.parse('file://server/share/report.txt'), range: [[6, 1], [35, 1]] }],
			detector(),
			TerminalBuiltinLinkType.Url,
		);
	});

	test('leaves mounted and local file URIs to the built-in file detector', async () => {
		await assertLinkHelper('file://server/share/report.txt', [], detector({ resolves: true }), TerminalBuiltinLinkType.Url);
		await assertLinkHelper('file:///home/user/report.txt', [], detector(), TerminalBuiltinLinkType.Url);
	});

	test('respects allowed schemes and does not stat a blocked file URI', async () => {
		const observed: URI[] = [];
		await assertLinkHelper('file://server/share/report.txt', [], detector({ allowFile: false, observed }), TerminalBuiltinLinkType.Url);
		assert.deepStrictEqual(observed, []);
	});

	test('removes line and column suffixes only for resolution', async () => {
		const observed: URI[] = [];
		await assertLinkHelper(
			'file://server/share/report.txt:23:7',
			[{ uri: URI.parse('file://server/share/report.txt'), range: [[1, 1], [35, 1]] }],
			detector({ observed }),
			TerminalBuiltinLinkType.Url,
		);
		assert.deepStrictEqual(observed.map(uri => uri.toString()), ['file://server/share/report.txt']);
	});
});
