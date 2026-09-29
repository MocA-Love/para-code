/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// The list of local path arguments that remote callers may not pass is written by hand from the
// vendored chrome-devtools-mcp tools. This test reads the vendored `verifyFilesSchema` of every tool
// so that updating the vendored copy cannot silently add a path argument the list does not know.

import assert from 'assert';
import { readdirSync, readFileSync } from 'fs';
import { FileAccess } from '../../../../../base/common/network.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_DEVTOOLS_LOCAL_PATH_ARGUMENTS } from '../../node/paradisDevtoolsPathPolicy.js';

const VENDORED_TOOLS = FileAccess.asFileUri('vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/build/src/tools').fsPath;

/** Tool name -> the argument names of its `verifyFilesSchema`, for every tool that has any. */
function vendoredPathArguments(): Record<string, string[]> {
	const found: Record<string, string[]> = {};
	for (const file of readdirSync(VENDORED_TOOLS).filter(name => name.endsWith('.js')).sort()) {
		const source = readFileSync(join(VENDORED_TOOLS, file), 'utf8');
		// Each tool definition starts with `name: '<tool>'` and has exactly one `verifyFilesSchema: [...]`.
		const definitions = source.split(/\bname: '/).slice(1);
		for (const definition of definitions) {
			const name = /^(?<name>[a-z0-9_]+)'/.exec(definition)?.groups?.name;
			const schema = /verifyFilesSchema: \[(?<keys>[^\]]*)\]/.exec(definition)?.groups?.keys;
			if (name === undefined || schema === undefined) {
				continue;
			}
			const keys = [...schema.matchAll(/'(?<key>[A-Za-z0-9_]+)'/g)].map(match => match.groups!.key);
			if (keys.length > 0) {
				found[name] = keys;
			}
		}
	}
	return found;
}

suite('ParadisDevtoolsPathArgumentsSync', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the hand-written path argument list matches the vendored verifyFilesSchema of every tool', () => {
		const vendored = vendoredPathArguments();
		assert.ok(Object.keys(vendored).length > 0, 'no vendored tool definitions were found');
		assert.deepStrictEqual(Object.fromEntries([...PARADIS_DEVTOOLS_LOCAL_PATH_ARGUMENTS].map(([name, keys]) => [name, [...keys]]).sort(([a], [b]) => String(a).localeCompare(String(b)))), Object.fromEntries(Object.entries(vendored).sort(([a], [b]) => a.localeCompare(b))));
	});
});
