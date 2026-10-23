/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// The task board writes these tool names into the Codex and Claude Code settings as "always allow".
// A name that is not a real para-browser tool would never match, and the screenshot step would keep
// stopping at the permission prompt without any error, so check every name against the tool lists.

import assert from 'assert';
import { readdirSync, readFileSync } from 'fs';
import { FileAccess } from '../../../../../base/common/network.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_MCP_LOCAL_TOOLS } from '../../../agentBrowser/node/paradisBrowserMcpShimCore.js';
import { PARADIS_TASK_BOARD_SCREENSHOT_TOOLS } from '../../common/paradisTaskBoardToolApprovals.js';

const VENDORED_TOOLS = FileAccess.asFileUri('vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/build/src/tools').fsPath;

/** The tool names of the vendored chrome-devtools-mcp (served by para-browser under the same names). */
function vendoredToolNames(): Set<string> {
	const names = new Set<string>();
	for (const file of readdirSync(VENDORED_TOOLS).filter(name => name.endsWith('.js'))) {
		for (const match of readFileSync(join(VENDORED_TOOLS, file), 'utf8').matchAll(/\bname: '(?<name>[a-z0-9_]+)'/g)) {
			names.add(match.groups!.name);
		}
	}
	return names;
}

suite('ParadisTaskBoardToolApprovals', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every screenshot tool the board may always allow is a para-browser tool', () => {
		const known = new Set([...PARADIS_MCP_LOCAL_TOOLS.map(tool => tool.name), ...vendoredToolNames()]);
		assert.deepStrictEqual(PARADIS_TASK_BOARD_SCREENSHOT_TOOLS.filter(name => !known.has(name)), []);
	});
});
