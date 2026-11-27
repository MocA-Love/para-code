/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentInstructionSection, IParadisCliCatalog, PARADIS_CLI_CATALOG_METHOD, PARADIS_CLI_GROUPS, PARADIS_CLI_META_KEY, PARADIS_CLI_RESERVED_FLAGS, ParadisCliConversations, paradisBuildCliCatalog, paradisCliCallMetaOf, paradisCliCommands, paradisCliGuideText, paradisMcpInstructionsText } from '../../common/paradisCliCatalog.js';
import { PARADIS_READ_ONLY_MCP_TOOL_NAMES } from '../../common/paradisMcpReadOnlyTools.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';
import { PARADIS_MCP_LOCAL_TOOLS } from '../../node/paradisBrowserMcpShimCore.js';
import { PARADIS_SITE_NOTE_TOOLS } from '../../node/paradisBrowserSiteNotes.js';
import { PARADIS_SITE_RECIPE_TOOLS } from '../../node/paradisBrowserSiteRecipes.js';
import { PARADIS_ASK_HUMAN_TOOL_DEFINITION } from '../../../humanAsk/common/paradisAskHumanTool.js';

/**
 * 本物のペインの tools/list に出る道具の名前（2026-11-27）。提供元を持つものは、その提供元が名乗る分野を添える。
 * 道具を足したらここにも足す（分野とコマンド名の重なりをここで見る）。
 */
const TOOLS_BY_PROVIDER_GROUP: Readonly<Record<string, readonly string[]>> = {
	// 提供元なし（paradisBrowserMcpShimCore.ts・サイトメモ・手順・内蔵の chrome-devtools-mcp）と、ブックマーク
	browser: [
		'get_shared_page', 'preview_file', 'get_cdp_endpoint', 'upload_file_to_drop_zone', 'get_session_health', 'list_space_notes', 'read_space_note', 'write_space_note',
		'add_space_note_task', 'check_space_note_task', 'delete_space_note_task', 'open_browser_profile', 'list_browser_profiles', 'create_browser_profile', 'switch_browser_profile',
		'delete_browser_profile', 'open_browser_tab', 'list_browser_tabs', 'select_browser_tab', 'set_viewport', 'list_viewports', 'set_cursor_label', 'close_browser_tab', 'request_browser_page',
		'add_init_script', 'list_init_scripts', 'remove_init_script', 'capture_screenshot', 'click_by', 'fill_by', 'download_by_click', 'read_download', 'get_text', 'inspect_element', 'scroll_to',
		'highlight_element', 'mouse_action', 'run_steps', 'save_page_as_pdf', 'wait_until', 'get_page_network_overrides', 'set_extra_http_headers', 'set_http_credentials', 'set_request_rules',
		'write_site_note', 'list_site_notes', 'delete_site_note', 'save_recipe', 'list_recipes', 'run_recipe', 'delete_recipe',
		'click', 'click_at', 'drag', 'emulate', 'evaluate_script', 'fill', 'fill_form', 'get_console_message', 'get_network_request', 'handle_dialog', 'hover', 'lighthouse_audit',
		'list_console_messages', 'list_network_requests', 'list_pages', 'navigate_page', 'performance_analyze_insight', 'performance_start_trace', 'performance_stop_trace', 'press_key',
		'select_page', 'take_heapsnapshot', 'take_screenshot', 'take_snapshot', 'type_text', 'upload_file', 'wait_for',
		'list_bookmarks', 'edit_bookmarks',
	],
	ide: [
		'read_para_code_guide', 'list_spaces', 'create_space', 'remove_space', 'launch_agent', 'create_scheduled_run',
		'create_space_section', 'update_space_section', 'remove_space_section', 'move_space_to_section',
		'list_terminals', 'read_terminal', 'wait_for_terminal', 'send_terminal_input', 'send_terminal_key', 'create_terminal', 'close_terminal',
		'ask_human',
		'bot_item_list', 'bot_item_show', 'bot_item_add', 'bot_item_update', 'bot_suggest',
		'list_bots', 'create_bot', 'update_bot', 'start_bot', 'stop_bot', 'remove_bot',
	],
	port: ['list_port_forwards', 'forward_port', 'stop_port_forward', 'reforward_port', 'clean_up_port_forwards'],
	doc: ['list_docs', 'adopt_doc', 'read_doc_comments', 'reply_doc_comment'],
	board: ['board_complete_step', 'board_ask_human'],
	mobile: [
		'mobile_fold', 'mobile_gesture', 'mobile_get_attached_device', 'mobile_grant_permission', 'mobile_install_app', 'mobile_launch_app', 'mobile_list_devices', 'mobile_press_button',
		'mobile_read_log', 'mobile_release_device', 'mobile_request_device', 'mobile_rotate', 'mobile_screenshot', 'mobile_swipe', 'mobile_tap', 'mobile_type_text', 'mobile_ui_find', 'mobile_ui_snapshot', 'mobile_ui_tap',
	],
	computer: [
		'computer_activate_app', 'computer_click', 'computer_drag', 'computer_get_app_state', 'computer_hotkey', 'computer_list_apps', 'computer_list_windows', 'computer_paste_text',
		'computer_press_key', 'computer_scroll', 'computer_set_value', 'computer_status', 'computer_type_text',
	],
};

function knownTools(): { tools: { name: string; annotations?: object }[]; providerGroups: Map<string, typeof PARADIS_CLI_GROUPS[number]['name']> } {
	const tools: { name: string; annotations?: object }[] = [];
	const providerGroups = new Map<string, typeof PARADIS_CLI_GROUPS[number]['name']>();
	for (const [group, names] of Object.entries(TOOLS_BY_PROVIDER_GROUP)) {
		for (const name of names) {
			tools.push({ name, ...(PARADIS_READ_ONLY_MCP_TOOL_NAMES.has(name) ? { annotations: { readOnlyHint: true } } : {}) });
			if (group !== 'browser') {
				providerGroups.set(name, group as typeof PARADIS_CLI_GROUPS[number]['name']);
			}
		}
	}
	return { tools, providerGroups };
}

interface ICatalogInternals {
	_dispatch(lease: { token: string }, rpc: { jsonrpc: '2.0'; id: number; method: string; params?: unknown }): Promise<unknown>;
}

function catalogService(overrides: object): ICatalogInternals {
	return Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
		_listDevtoolsTools: async () => [{ name: 'take_snapshot', description: 'Take a snapshot. More words.', inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } } }, annotations: { readOnlyHint: false } }],
		_requireIngressLease: () => { },
		_allToolProviders: () => [],
		_observeSettings: () => ({ settle: false, state: false }),
		_siteNotesEnabled: () => false,
		_siteRecipesEnabled: () => false,
		_paneRemoteAuthorityOf: () => undefined,
		...overrides,
	}) as unknown as ICatalogInternals;
}

suite('paradisCliCatalog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every known tool becomes one command, in the group its name or provider says', () => {
		const { tools, providerGroups } = knownTools();
		const commands = paradisCliCommands(tools, providerGroups);
		const byGroup: Record<string, string[]> = {};
		for (const command of commands) {
			(byGroup[command.group] ??= []).push(command.aliases.length > 0 ? `${command.verb} (${command.aliases.join(', ')})` : command.verb);
		}
		assert.deepStrictEqual({
			count: commands.length === tools.length,
			terminal: byGroup.terminal,
			note: byGroup.note,
			port: byGroup.port,
			ide: byGroup.ide,
			doc: byGroup.doc,
			board: byGroup.board,
			computerFirst: byGroup.computer.slice(0, 2),
			mobileFirst: byGroup.mobile.slice(0, 2),
			browserAliased: byGroup.browser.filter(verb => verb.includes('(')),
			browserCount: byGroup.browser.length,
		}, {
			count: true,
			terminal: ['list-terminals (list)', 'read-terminal (read)', 'wait-for-terminal (wait)', 'send-terminal-input (send)', 'send-terminal-key (key)', 'create-terminal (create)', 'close-terminal (close)'],
			note: ['list-space-notes (list)', 'read-space-note (read)', 'write-space-note (write)', 'add-space-note-task', 'check-space-note-task', 'delete-space-note-task'],
			port: ['list-port-forwards (list)', 'forward-port', 'stop-port-forward', 'reforward-port', 'clean-up-port-forwards'],
			ide: [
				'preview-file', 'read-para-code-guide', 'list-spaces', 'create-space', 'remove-space', 'launch-agent', 'create-scheduled-run',
				'create-space-section', 'update-space-section', 'remove-space-section', 'move-space-to-section', 'ask-human',
				'bot-item-list', 'bot-item-show', 'bot-item-add', 'bot-item-update', 'bot-suggest', 'list-bots', 'create-bot', 'update-bot', 'start-bot', 'stop-bot', 'remove-bot',
			],
			doc: ['list-docs', 'adopt-doc', 'read-doc-comments', 'reply-doc-comment'],
			board: ['complete-step', 'ask-human'],
			computerFirst: ['activate-app', 'click'],
			mobileFirst: ['fold', 'gesture'],
			browserAliased: [
				'get-shared-page (page)', 'open-browser-tab (open)', 'list-browser-tabs (tabs)', 'select-browser-tab (select)', 'set-cursor-label (label)', 'close-browser-tab (close)',
				'capture-screenshot (capture)', 'get-text (text)', 'wait-until (wait)', 'evaluate-script (eval)', 'navigate-page (goto)', 'take-screenshot (screenshot)', 'take-snapshot (snapshot)',
			],
			browserCount: 73,
		});
	});

	test('no two commands of a group share a name or an alias, and an alias never hides a command', () => {
		const { tools, providerGroups } = knownTools();
		const commands = paradisCliCommands(tools, providerGroups);
		const names = commands.flatMap(command => [command.verb, ...command.aliases].map(name => `${command.group} ${name}`));
		// 別名の表に、同じ分野のコマンド名と重なるものを足しても、コマンド名が勝つ
		const shadowed = paradisCliCommands([{ name: 'wait_until' }, { name: 'wait' }, { name: 'wait' }]);
		assert.deepStrictEqual({
			duplicates: names.filter((name, index) => names.indexOf(name) !== index),
			readOnly: commands.filter(command => command.readOnly).length === tools.filter(tool => PARADIS_READ_ONLY_MCP_TOOL_NAMES.has(tool.name)).length,
			shadowed: shadowed.map(command => ({ verb: command.verb, aliases: command.aliases, tool: command.tool })),
		}, {
			duplicates: [],
			readOnly: true,
			shadowed: [{ verb: 'wait-until', aliases: [], tool: 'wait_until' }, { verb: 'wait', aliases: [], tool: 'wait' }],
		});
	});

	test('no argument of the tools defined in this repository has the name of a flag of the CLI itself', () => {
		const collisions: string[] = [];
		for (const tool of [...PARADIS_MCP_LOCAL_TOOLS, ...PARADIS_SITE_NOTE_TOOLS, ...PARADIS_SITE_RECIPE_TOOLS, PARADIS_ASK_HUMAN_TOOL_DEFINITION]) {
			const properties = (tool.inputSchema as { readonly properties?: Record<string, unknown> }).properties ?? {};
			for (const name of Object.keys(properties)) {
				if (PARADIS_CLI_RESERVED_FLAGS.includes(name.replace(/_/g, '-'))) {
					collisions.push(`${tool.name}.${name}`);
				}
			}
		}
		assert.deepStrictEqual(collisions, []);
	});

	test('the guide of a group is the MCP instructions without the sentences that only make sense to an MCP client', () => {
		const sections: IParadisAgentInstructionSection[] = [
			{ group: 'browser', parts: [{ text: 'Load tools with ToolSearch.', mcpOnly: true }, { text: 'Call set_cursor_label first.' }, { text: 'Never submit on shared pages.' }] },
			{ group: 'ide', parts: [{ text: 'Call read_para_code_guide once.' }] },
			{ group: 'browser', parts: [{ text: 'Record a site note.' }] },
		];
		const catalog = paradisBuildCliCatalog([{ name: 'get_text' }, { name: 'board_ask_human' }], sections);
		assert.deepStrictEqual({
			mcp: paradisMcpInstructionsText(sections),
			browser: paradisCliGuideText(sections, 'browser'),
			groups: catalog.groups.map(group => `${group.name}:${group.guide.length > 0}`),
		}, {
			mcp: 'Load tools with ToolSearch. Call set_cursor_label first. Never submit on shared pages.\n\nCall read_para_code_guide once.\n\nRecord a site note.',
			browser: 'Call set_cursor_label first. Never submit on shared pages.\n\nRecord a site note.',
			// 道具は無いが手引きのある ide と、道具だけの board は載る。どちらも無い分野は載らない
			groups: ['browser:true', 'ide:true', 'board:false'],
		});
	});

	test('the server answers the catalog from the same list as tools/list, with every sentence of its instructions in a guide', async () => {
		const provider = {
			cliGroup: 'ide',
			listTools: () => [{ name: 'list_spaces', description: 'List the spaces.', inputSchema: { type: 'object', properties: {} } }, { name: 'read_terminal', description: 'Read a terminal.', inputSchema: { type: 'object', properties: {} } }],
			callTool: async () => undefined,
			instructions: () => 'IDE tools: call read_para_code_guide once.',
		};
		const local = catalogService({ _allToolProviders: () => [provider], _siteNotesEnabled: () => true });
		const remote = catalogService({ _allToolProviders: () => [provider], _paneRemoteAuthorityOf: () => 'ssh-remote+host', _remoteFileFolders: async () => ({}) });
		const catalog = await local._dispatch({ token: 'pane' }, { jsonrpc: '2.0', id: 1, method: PARADIS_CLI_CATALOG_METHOD }) as IParadisCliCatalog;
		const listed = await local._dispatch({ token: 'pane' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { tools: { name: string }[] };
		const initialized = await local._dispatch({ token: 'pane' }, { jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }) as { instructions: string };
		const remoteCatalog = await remote._dispatch({ token: 'pane' }, { jsonrpc: '2.0', id: 4, method: PARADIS_CLI_CATALOG_METHOD }) as IParadisCliCatalog;
		const remoteInitialized = await remote._dispatch({ token: 'pane' }, { jsonrpc: '2.0', id: 5, method: 'initialize', params: {} }) as { instructions: string };
		const guides = (value: IParadisCliCatalog) => value.groups.map(group => group.guide).join('\n\n');
		// MCP の説明の文のうち、CLI の手引きに無いもの（文の頭だけ）
		const missing = (instructions: string, value: IParadisCliCatalog) => instructions.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(sentence => !guides(value).includes(sentence)).map(sentence => sentence.slice(0, 40));
		const command = (tool: string) => catalog.commands.find(candidate => candidate.tool === tool);
		assert.deepStrictEqual({
			sameTools: catalog.commands.map(candidate => candidate.tool).sort().join() === listed.tools.map(tool => tool.name).sort().join(),
			snapshot: [command('take_snapshot')?.group, command('take_snapshot')?.readOnly, command('take_snapshot')?.aliases, Object.keys((command('take_snapshot')?.inputSchema as { properties: object }).properties)],
			providerTools: [command('list_spaces')?.group, command('read_terminal')?.group, command('write_site_note')?.group],
			ideGuide: catalog.groups.find(group => group.name === 'ide')?.guide,
			promises: ['set_cursor_label', 'only when the user asked for it', 'write_site_note', 'tab_id on every browser tool call'].filter(text => !guides(catalog).includes(text)),
			onlyInMcp: missing(initialized.instructions, catalog),
			remoteOnlyInMcp: missing(remoteInitialized.instructions, remoteCatalog),
			remoteGuide: ['This terminal pane runs on a remote machine', 'your own tools can read only the copy'].filter(text => !guides(remoteCatalog).includes(text)),
		}, {
			sameTools: true,
			snapshot: ['browser', true, ['snapshot'], ['verbose', 'tab_id']],
			providerTools: ['ide', 'terminal', 'browser'],
			ideGuide: 'IDE tools: call read_para_code_guide once.',
			promises: [],
			// MCP のクライアントにだけ意味がある文。ここに増えたら、CLI の手引きから約束が落ちている
			onlyInMcp: ['Read a tool\'s description before you cal', 'Para Code MCP server (runs inside the Pa', 'Your MCP client may still run several to'],
			remoteOnlyInMcp: ['Read a tool\'s description before you cal', 'Para Code MCP server (runs inside the Pa', 'Your MCP client may still run several to'],
			remoteGuide: [],
		});
	});

	test('a conversation the pane has not named before starts a conversation once; calls without one never do', async () => {
		const conversations = new ParadisCliConversations();
		const order = [conversations.note('pane', 'a'), conversations.note('pane', 'b'), conversations.note('pane', 'a'), conversations.note('other', 'a')];
		conversations.forget('pane');
		const started: string[] = [];
		const service = catalogService({
			_cliConversations: new ParadisCliConversations(),
			_noteConversationStart: (token: string) => { started.push(token); },
			_callTool: async () => ({ content: [] }),
		});
		const call = (id: number, meta?: unknown) => service._dispatch({ token: 'pane' }, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_text', arguments: {}, ...(meta !== undefined ? { _meta: meta } : {}) } });
		await call(1);
		await call(2, { 'claudecode/toolUseId': 'toolu_1' });
		await call(3, { [PARADIS_CLI_META_KEY]: {} });
		const beforeFirst = started.length;
		await call(4, { [PARADIS_CLI_META_KEY]: { conversation: 'parent' } });
		await call(5, { [PARADIS_CLI_META_KEY]: { conversation: 'parent' } });
		await call(6, { [PARADIS_CLI_META_KEY]: { conversation: 'other-agent' } });
		await call(7, { [PARADIS_CLI_META_KEY]: { conversation: 'parent' } });
		await service._dispatch({ token: 'pane' }, { jsonrpc: '2.0', id: 8, method: PARADIS_CLI_CATALOG_METHOD, params: { _meta: { [PARADIS_CLI_META_KEY]: { conversation: 'third' } } } });
		assert.deepStrictEqual({
			order,
			afterForget: conversations.note('pane', 'a'),
			meta: [paradisCliCallMetaOf(undefined), paradisCliCallMetaOf({ _meta: { [PARADIS_CLI_META_KEY]: { conversation: 'x'.repeat(200) } } }), paradisCliCallMetaOf({ _meta: { [PARADIS_CLI_META_KEY]: { conversation: 'c1' } } })],
			beforeFirst,
			started,
		}, {
			order: [true, true, false, true],
			afterForget: true,
			meta: [undefined, {}, { conversation: 'c1' }],
			beforeFirst: 0,
			started: ['pane', 'pane', 'pane'],
		});
	});
});
