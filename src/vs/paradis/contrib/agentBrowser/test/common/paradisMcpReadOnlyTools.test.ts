/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_READ_ONLY_MCP_TOOL_NAMES, paradisWithReadOnlyToolAnnotation } from '../../common/paradisMcpReadOnlyTools.js';

suite('paradisMcpReadOnlyTools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks only the reading tools read-only and keeps their other annotations', () => {
		const tools = [
			{ name: 'get_text', description: 'read' },
			{ name: 'take_snapshot', annotations: { readOnlyHint: false, title: 'Snapshot' } },
			{ name: 'click_by' },
			{ name: 'fill_by', annotations: { destructiveHint: true } },
			{ name: 'check_space_note_task' },
		];
		assert.deepStrictEqual(tools.map(tool => paradisWithReadOnlyToolAnnotation(tool)), [
			{ name: 'get_text', description: 'read', annotations: { readOnlyHint: true } },
			{ name: 'take_snapshot', annotations: { readOnlyHint: true, title: 'Snapshot' } },
			{ name: 'click_by' },
			{ name: 'fill_by', annotations: { destructiveHint: true } },
			{ name: 'check_space_note_task' },
		]);
	});

	test('never lists a tool that operates the page, the browser or the device', () => {
		const operating = ['click', 'click_by', 'click_at', 'fill', 'fill_by', 'fill_form', 'type_text', 'press_key', 'hover', 'drag', 'navigate_page', 'scroll_to',
			'select_page', 'select_browser_tab', 'open_browser_tab', 'close_browser_tab', 'evaluate_script', 'run_steps', 'run_recipe', 'upload_file', 'download_by_click',
			'highlight_element', 'wait_until', 'get_network_request', 'get_cdp_endpoint', 'lighthouse_audit', 'take_heapsnapshot', 'performance_start_trace', 'performance_stop_trace', 'check_space_note_task',
			'write_space_note', 'write_site_note', 'save_recipe', 'set_viewport', 'set_cursor_label', 'emulate', 'handle_dialog', 'mobile_tap', 'mobile_type_text', 'send_terminal_input'];
		assert.deepStrictEqual(operating.filter(name => PARADIS_READ_ONLY_MCP_TOOL_NAMES.has(name)), []);
	});
});
