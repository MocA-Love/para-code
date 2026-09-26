/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { suite, test } from 'node:test';
import { copyResources, getResourcePaths } from '../resources.ts';
import { isParadisVerbatimResource } from '../paradisResources.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

suite('Para Code production resources', () => {
	test('ships every fork resource group with the desktop build only', async () => {
		const desktop = await getResourcePaths(path.join(repoRoot, 'src'), 'desktop');
		const groups = {
			sounds: 'vs/paradis/contrib/notifications/browser/media/sounds/',
			changelog: 'vs/paradis/contrib/releaseNotes/electron-browser/media/',
			reactDevtools: 'vs/paradis/contrib/browserExtensions/electron-main/media/',
			pdfjs: 'vs/paradis/contrib/fileViewers/electron-browser/media/pdfjs/',
			docxPreview: 'vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/',
			mermaid: 'vs/paradis/contrib/fileViewers/browser/media/mermaid/',
			chromeDevtoolsMcp: 'vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/',
		};
		const present = Object.fromEntries(Object.entries(groups).map(([name, prefix]) => [name, desktop.some(file => file.startsWith(prefix))]));
		const serverWeb = await getResourcePaths(path.join(repoRoot, 'src'), 'server-web');

		assert.deepStrictEqual(
			{ present, leakedToServerWeb: serverWeb.filter(file => file.startsWith('vs/paradis/')) },
			{ present: Object.fromEntries(Object.keys(groups).map(name => [name, true])), leakedToServerWeb: [] }
		);
	});

	test('copies vendored scripts byte-for-byte when minifying', async t => {
		const srcDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paradis-resources-src-'));
		const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paradis-resources-out-'));
		t.after(() => Promise.all([srcDir, outDir].map(dir => fs.promises.rm(dir, { recursive: true, force: true }))));

		// A sourceMappingURL to a map that is not vendored is a hard error for the resource minifier.
		const file = 'vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/build/src/index.js';
		const script = '// vendored\nexport const answer = 42;\n//# sourceMappingURL=index.js.map\n';
		await fs.promises.mkdir(path.dirname(path.join(srcDir, file)), { recursive: true });
		await fs.promises.writeFile(path.join(srcDir, file), script);

		await copyResources(srcDir, outDir, 'desktop', true);

		assert.deepStrictEqual(
			{ verbatim: isParadisVerbatimResource(file), output: await fs.promises.readFile(path.join(outDir, file), 'utf8') },
			{ verbatim: true, output: script }
		);
	});
});
