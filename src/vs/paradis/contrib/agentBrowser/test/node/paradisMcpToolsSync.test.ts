/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para固有の静的MCPツール定義は、以前は shared process側 (paradisAgentBrowserService.ts の
// `TOOLS`) と、Para Code未起動時／ペイン外起動時にオフライン応答するstdioシム
// (paradisBrowserMcpShim.ts の `LOCAL_TOOLS`) の2箇所へ手で複製しており、3回連続で
// 更新漏れの指摘を受けた。`paradisBrowserMcpShimCore.ts` の `PARADIS_MCP_LOCAL_TOOLS` へ
// 一本化し、両ファイルとも同じ配列を参照するようにした。このテストは、その一本化が
// 将来のリファクタで再び分裂しないことを機械的に検査する。

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_MCP_LOCAL_TOOLS } from '../../node/paradisBrowserMcpShimCore.js';
import { TOOLS as PARADIS_AGENT_BROWSER_TOOLS } from '../../node/paradisAgentBrowserService.js';

suite('paradisMcpToolsSync', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shared process TOOLS and the offline shim tool list are the exact same array', () => {
		// 単一ソース化した本体を指していることを確認する（分裂の再発を検知する一番強い検査）。
		assert.strictEqual(PARADIS_AGENT_BROWSER_TOOLS, PARADIS_MCP_LOCAL_TOOLS);
	});

	test('every para-specific tool has a name, a non-empty description, and an object inputSchema', () => {
		assert.ok(PARADIS_AGENT_BROWSER_TOOLS.length > 0);
		for (const tool of PARADIS_AGENT_BROWSER_TOOLS) {
			assert.strictEqual(typeof tool.name, 'string');
			assert.ok(tool.name.length > 0);
			assert.strictEqual(typeof tool.description, 'string');
			assert.ok(tool.description.length > 0);
			assert.strictEqual(typeof tool.inputSchema, 'object');
		}
		// 名前は重複していないこと
		const names = PARADIS_AGENT_BROWSER_TOOLS.map(tool => tool.name);
		assert.strictEqual(new Set(names).size, names.length);
	});

	test('includes the tools this task added, so a future split of the array cannot silently drop them', () => {
		const names = PARADIS_AGENT_BROWSER_TOOLS.map(tool => tool.name);
		assert.ok(names.includes('upload_file_to_drop_zone'));
		assert.ok(names.includes('get_session_health'));
	});
});
