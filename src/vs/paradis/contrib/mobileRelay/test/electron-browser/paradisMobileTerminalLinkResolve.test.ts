/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { ParadisMobileWorkspaceProvider } from '../../electron-browser/paradisMobileWorkspaceProvider.js';

interface ITerminalLinkFixture {
	resolveTerminalRelativeLink(ws: string, root: URI, terminalKey: unknown, rawPath: string): Promise<string | undefined>;
}

/** スマホのターミナルで押した相対パスを、そのターミナルの作業フォルダを基準に解く（W2-31）。 */
suite('ParadisMobileWorkspaceProvider terminal link resolution', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const root = URI.file('/repo');
	const files = new Set(['/repo/packages/app/src/index.ts', '/repo/src/index.ts', '/repo/README.md']);

	function createFixture(cwd: URI | undefined): ITerminalLinkFixture {
		return Object.assign(Object.create(ParadisMobileWorkspaceProvider.prototype) as object, {
			terminalIdentityService: { getInstanceId: (key: string) => key === 'term-1' ? 1 : undefined },
			allInstances: () => [{ instanceId: 1, getCwdResource: async () => cwd }],
			resolveWorkspacePathReal: async (_ws: string, relative: string) => URI.joinPath(root, relative),
			fileService: {
				stat: async (uri: URI) => {
					if (!files.has(uri.path)) {
						throw new Error('not found');
					}
					return { isDirectory: false };
				},
			},
		}) as unknown as ITerminalLinkFixture;
	}

	test('resolves from the terminal cwd, and leaves the rest to the workspace root', async () => {
		const inPackage = createFixture(URI.file('/repo/packages/app'));
		const outside = createFixture(URI.file('/elsewhere'));
		const results = await Promise.all([
			inPackage.resolveTerminalRelativeLink('ws', root, 'term-1', 'src/index.ts'),
			inPackage.resolveTerminalRelativeLink('ws', root, 'term-1', '../../README.md'),
			inPackage.resolveTerminalRelativeLink('ws', root, 'term-1', '../../../etc/passwd'),
			inPackage.resolveTerminalRelativeLink('ws', root, 'term-1', 'missing.ts'),
			inPackage.resolveTerminalRelativeLink('ws', root, 'unknown-terminal', 'src/index.ts'),
			inPackage.resolveTerminalRelativeLink('ws', root, undefined, 'src/index.ts'),
			outside.resolveTerminalRelativeLink('ws', root, 'term-1', 'src/index.ts'),
			createFixture(undefined).resolveTerminalRelativeLink('ws', root, 'term-1', 'src/index.ts'),
		]);
		assert.deepStrictEqual(results, ['packages/app/src/index.ts', 'README.md', undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('resolves a remote terminal from its shell-integration cwd without checking the path on this machine', async () => {
		const remoteRoot = URI.from({ scheme: Schemas.vscodeRemote, authority: 'ssh-remote+example', path: '/home/example/repo' });
		const remoteFiles = new Set(['/home/example/repo/packages/app/src/index.ts']);
		const localLookups: string[] = [];
		const fixture = Object.assign(Object.create(ParadisMobileWorkspaceProvider.prototype) as object, {
			terminalIdentityService: { getInstanceId: (key: string) => key === 'term-1' ? 1 : undefined },
			allInstances: () => [{
				instanceId: 1,
				remoteAuthority: 'ssh-remote+example',
				capabilities: { get: (capability: TerminalCapability) => capability === TerminalCapability.CwdDetection ? { getCwd: () => '/home/example/repo/packages/app' } : undefined },
				// upstream の getCwdResource は接続先の cwd を file: にして手元で exists する
				getCwdResource: async () => { localLookups.push('getCwdResource'); return undefined; },
			}],
			resolveWorkspacePathReal: async (_ws: string, relative: string) => URI.joinPath(remoteRoot, relative),
			fileService: {
				stat: async (uri: URI) => {
					if (uri.scheme !== Schemas.vscodeRemote) {
						localLookups.push(`stat:${uri.scheme}`);
					}
					if (!remoteFiles.has(uri.path)) {
						throw new Error('not found');
					}
					return { isDirectory: false };
				},
			},
		}) as unknown as ITerminalLinkFixture;

		assert.deepStrictEqual({
			resolved: await fixture.resolveTerminalRelativeLink('ws', remoteRoot, 'term-1', 'src/index.ts'),
			localLookups,
		}, { resolved: 'packages/app/src/index.ts', localLookups: [] });
	});
});
