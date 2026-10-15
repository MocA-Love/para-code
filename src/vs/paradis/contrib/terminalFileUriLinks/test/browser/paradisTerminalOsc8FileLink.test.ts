/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TerminalCapabilityStore } from '../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import { ITerminalLogService } from '../../../../../platform/terminal/common/terminal.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ITerminalLinkOpener, ITerminalLinkResolver, ITerminalSimpleLink, TerminalBuiltinLinkType, TerminalLinkType } from '../../../../../workbench/contrib/terminalContrib/links/browser/links.js';
import { paradisOpenOsc8FileLink, paradisOsc8FileCandidates, paradisParseOsc8FileTarget } from '../../browser/paradisTerminalOsc8FileLink.js';

suite('Para Code terminal OSC 8 file links', () => {

	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	test('reads link targets as paths, leaving URLs and hosts to upstream', () => {
		// Targets as Claude Code 2.1.300 emits them for `[x](<...>)`, plus URLs that must stay URLs.
		const inputs = [
			'a.md',
			'backend/x.ts:12',
			'./i.md:3:4',
			'src/f.ts#L5-L9',
			'README.md#install',
			'Makefile:3',
			'~/g.md',
			'/home/u/a.md:7',
			'file:///home/u/c.md#L3',
			'file:///home/u/e.md:12',
			'file:///home/u/%E6%97%A5%E6%9C%AC%20%E8%AA%9E.md',
			'file:///home/u/d.md#L2C4-L5C1',
			'file://server/share/x.md',
			'https://example.com/a.md',
			'mailto:someone@example.com',
			'vscode://file/home/u/a.md',
			'tel:5551234',
			'sms:5551234',
			'localhost:3000',
			'C:\\work\\a.md:4',
		];
		assert.deepStrictEqual(Object.fromEntries(inputs.map(input => [input, paradisParseOsc8FileTarget(input, OperatingSystem.Linux) ?? null])), {
			'a.md': { path: 'a.md', selection: undefined },
			'backend/x.ts:12': { path: 'backend/x.ts', selection: { startLineNumber: 12, startColumn: 1, endLineNumber: undefined, endColumn: undefined } },
			'./i.md:3:4': { path: './i.md', selection: { startLineNumber: 3, startColumn: 4, endLineNumber: undefined, endColumn: undefined } },
			'src/f.ts#L5-L9': { path: 'src/f.ts', selection: { startLineNumber: 5, startColumn: 1, endLineNumber: 9, endColumn: undefined } },
			'README.md#install': { path: 'README.md', selection: undefined },
			'Makefile:3': { path: 'Makefile', selection: { startLineNumber: 3, startColumn: 1, endLineNumber: undefined, endColumn: undefined } },
			'~/g.md': { path: '~/g.md', selection: undefined },
			'/home/u/a.md:7': { path: '/home/u/a.md', selection: { startLineNumber: 7, startColumn: 1, endLineNumber: undefined, endColumn: undefined } },
			'file:///home/u/c.md#L3': { path: '/home/u/c.md', selection: { startLineNumber: 3, startColumn: 1, endLineNumber: undefined, endColumn: undefined } },
			'file:///home/u/e.md:12': { path: '/home/u/e.md', selection: { startLineNumber: 12, startColumn: 1, endLineNumber: undefined, endColumn: undefined } },
			'file:///home/u/%E6%97%A5%E6%9C%AC%20%E8%AA%9E.md': { path: '/home/u/日本 語.md', selection: undefined },
			'file:///home/u/d.md#L2C4-L5C1': { path: '/home/u/d.md', selection: { startLineNumber: 2, startColumn: 4, endLineNumber: 5, endColumn: 1 } },
			'file://server/share/x.md': null,
			'https://example.com/a.md': null,
			'mailto:someone@example.com': null,
			'vscode://file/home/u/a.md': null,
			'tel:5551234': null,
			'sms:5551234': null,
			'localhost:3000': null,
			// A drive letter means nothing on a Linux host.
			'C:\\work\\a.md:4': null,
		});
	});

	test('reads Windows drive paths on a Windows host', () => {
		assert.deepStrictEqual([
			paradisParseOsc8FileTarget('C:\\work\\a.md:4', OperatingSystem.Windows),
			paradisParseOsc8FileTarget('file:///c:/work/a.md', OperatingSystem.Windows),
		], [
			{ path: 'C:\\work\\a.md', selection: { startLineNumber: 4, startColumn: 1, endLineNumber: undefined, endColumn: undefined } },
			{ path: 'c:/work/a.md', selection: undefined },
		]);
	});

	test('tries the line cwd, then the initial cwd, then workspace folders', () => {
		assert.deepStrictEqual({
			absolute: paradisOsc8FileCandidates('/home/u/a.md', OperatingSystem.Linux, ['/ignored/a.md'], ['/home/u/proj']),
			home: paradisOsc8FileCandidates('~/a.md', OperatingSystem.Linux, undefined, ['/home/u/proj']),
			lineCwd: paradisOsc8FileCandidates('backend/x.ts', OperatingSystem.Linux, ['/home/u/proj/backend/x.ts'], ['/home/u/proj', '/home/u/other']),
			initialCwd: paradisOsc8FileCandidates('backend/x.ts', OperatingSystem.Linux, undefined, ['/home/u/proj']),
		}, {
			absolute: ['/home/u/a.md'],
			home: ['~/a.md'],
			lineCwd: ['/home/u/proj/backend/x.ts', '/home/u/other/backend/x.ts'],
			initialCwd: ['backend/x.ts', '/home/u/proj/backend/x.ts'],
		});
	});

	test('opens the remote file, searches when missing, and leaves URLs alone', async () => {
		const remoteAuthority = 'ssh-remote+example';
		const remote = (path: string) => URI.from({ scheme: Schemas.vscodeRemote, authority: remoteAuthority, path });
		const existing = new Set(['/home/u/proj/backend/x.ts', '/home/u/c.md']);
		const resolved: string[] = [];
		const linkResolver: ITerminalLinkResolver = {
			async resolveLink(_processInfo, link) {
				resolved.push(link);
				return existing.has(link) ? { uri: remote(link), link, isDirectory: false } : null;
			}
		};
		const opened: { type: TerminalLinkType; text: string; uri: string | undefined; selection: ITerminalSimpleLink['selection'] }[] = [];
		const recordingOpener: ITerminalLinkOpener = {
			async open(link) {
				opened.push({ type: link.type, text: link.text, uri: link.uri?.toString(), selection: link.selection });
			}
		};
		const openers = new Map<TerminalLinkType, ITerminalLinkOpener>([
			[TerminalBuiltinLinkType.LocalFile, recordingOpener],
			[TerminalBuiltinLinkType.Search, recordingOpener],
		]);

		const allowedLinkSchemes = ['file', 'http', 'https'];
		const configurationService = new TestConfigurationService({ terminal: { integrated: { enableFileLinks: 'on', allowedLinkSchemes } } });
		const instantiationService = ds.add(new TestInstantiationService());
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(ITerminalLogService, new NullLogService());
		instantiationService.stub(IUriIdentityService, { extUri });
		instantiationService.stub(IWorkspaceContextService, new TestContextService(testWorkspace(remote('/home/u/proj'))));
		const capabilities = ds.add(new TerminalCapabilityStore());
		const open = (text: string) => instantiationService.invokeFunction(paradisOpenOsc8FileLink, {
			text,
			range: { start: { x: 1, y: 1 }, end: { x: 10, y: 1 } },
			processInfo: { remoteAuthority, os: OperatingSystem.Linux, initialCwd: '/home/u/elsewhere', userHome: '/home/u' },
			capabilities,
			linkResolver,
			openers,
		});

		const handled = [
			await open('backend/x.ts:12'),
			await open('file:///home/u/c.md#L3'),
			await open('missing.md:2'),
			await open('https://example.com/'),
		];
		// Without `file` in allowedLinkSchemes, upstream asks before a file: link opens.
		await configurationService.setUserConfiguration('terminal', { integrated: { enableFileLinks: 'on', allowedLinkSchemes: ['http', 'https'] } });
		handled.push(await open('file:///home/u/c.md#L3'));
		await configurationService.setUserConfiguration('terminal', { integrated: { enableFileLinks: 'off', allowedLinkSchemes } });
		handled.push(await open('backend/x.ts:12'));

		assert.deepStrictEqual({ handled, resolved, opened }, {
			handled: [true, true, true, false, false, false],
			resolved: ['backend/x.ts', '/home/u/proj/backend/x.ts', '/home/u/c.md', 'missing.md', '/home/u/proj/missing.md'],
			opened: [
				{ type: TerminalBuiltinLinkType.LocalFile, text: '/home/u/proj/backend/x.ts', uri: remote('/home/u/proj/backend/x.ts').toString(), selection: { startLineNumber: 12, startColumn: 1, endLineNumber: undefined, endColumn: undefined } },
				{ type: TerminalBuiltinLinkType.LocalFile, text: '/home/u/c.md', uri: remote('/home/u/c.md').toString(), selection: { startLineNumber: 3, startColumn: 1, endLineNumber: undefined, endColumn: undefined } },
				{ type: TerminalBuiltinLinkType.Search, text: 'missing.md:2', uri: undefined, selection: undefined },
			],
		});
	});
});
