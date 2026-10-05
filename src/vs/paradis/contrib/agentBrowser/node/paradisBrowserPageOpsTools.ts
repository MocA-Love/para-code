/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Keep this module free of imports: paradisBrowserMcpShimCore spreads it into the offline tool list,
// and the shim runs as a standalone node script.

/** Names of the extra browser operations (B7). The server verifies the caller process for all of them. */
export const PARADIS_PAGE_OPS_TOOL_NAMES = [
	'mouse_action',
	'save_page_as_pdf',
	'set_extra_http_headers',
	'set_http_credentials',
	'set_request_rules',
	'get_page_network_overrides',
	'download_by_click',
	'highlight_element',
	'add_init_script',
	'remove_init_script',
	'list_init_scripts',
] as const;

const TARGET_PROPERTIES = {
	uid: { type: 'string', description: 'uid of the element from a recent take_snapshot. Its center is used. Give either uid or x/y.' },
	x: { type: 'number', description: 'X coordinate in CSS pixels of the page viewport (as in a take_screenshot of the viewport).' },
	y: { type: 'number', description: 'Y coordinate in CSS pixels of the page viewport.' },
} as const;

/**
 * Tool definitions for the extra browser operations. They act only on the page shared with this
 * terminal pane (the same one the chrome-devtools tools act on).
 */
export const PARADIS_MCP_PAGE_OPS_TOOLS = [
	{
		name: 'mouse_action',
		description: 'Low-level mouse input on the page shared with this terminal pane, for what the chrome-devtools click / click_at / hover / drag tools cannot do: right-click (context_click), middle-click, moving the pointer to coordinates (hover at x/y), pressing and releasing a button separately, a pointer drag between coordinates (sliders, canvas; the chrome-devtools drag tool is for HTML drag-and-drop between elements), and the mouse wheel. For a plain left click or double click use click (uid) or click_at (x/y) with dblClick instead. Input is refused while the user is using that page.',
		inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['move', 'down', 'up', 'context_click', 'middle_click', 'drag', 'wheel'], description: 'move: move the pointer (hover). down / up: press / release a button at the point (the pointer stays pressed between them, and move then drags). context_click: right-click. middle_click: middle-click. drag: press at the point, move to the to_ point and release. wheel: scroll with the wheel over the point.' },
				...TARGET_PROPERTIES,
				to_uid: { type: 'string', description: 'drag only: uid of the element to drop on.' },
				to_x: { type: 'number', description: 'drag only: X coordinate to release at.' },
				to_y: { type: 'number', description: 'drag only: Y coordinate to release at.' },
				button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'down / up only: which button (default left).' },
				delta_x: { type: 'number', description: 'wheel only: horizontal scroll in CSS pixels (positive scrolls right).' },
				delta_y: { type: 'number', description: 'wheel only: vertical scroll in CSS pixels (positive scrolls down).' },
				modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] }, description: 'Keys held during the action.' },
				steps: { type: 'number', description: 'move / drag: number of intermediate pointer moves (1-50, default 5).' },
			},
			required: ['action'],
			additionalProperties: false,
		},
	},
	{
		name: 'save_page_as_pdf',
		description: 'Print the page shared with this terminal pane to a PDF file. The file is saved in the Para Code download folder (the same place as browser downloads; an existing file is never overwritten, a number is added instead) and appears in the download list marked as saved by an agent. Returns the saved path.',
		inputSchema: {
			type: 'object',
			properties: {
				file_name: { type: 'string', description: 'File name for the PDF (no folders). Defaults to the page title.' },
				landscape: { type: 'boolean', description: 'Landscape orientation (default false).' },
				print_background: { type: 'boolean', description: 'Include background colors and images (default true).' },
				paper_format: { type: 'string', enum: ['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid'], description: 'Paper size (default A4).' },
				scale: { type: 'number', description: 'Scale of the page rendering, 0.1-2 (default 1).' },
				page_ranges: { type: 'string', description: 'Pages to include, for example "1-5, 8". Default all pages.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'set_extra_http_headers',
		description: 'Send extra HTTP request headers from the page shared with this terminal pane (for example a feature-flag header of a test environment). By default they are sent only to the origin of the page at the time of the call (never to CDNs, analytics or other sites the page loads); pass "origins" to name the origins yourself. Only works on a tab whose browser storage this terminal pane uses alone: a tab opened with open_browser_tab and "private": true, or a profile this pane created that nobody else uses. Other tabs (tabs the user opened or shared, your ordinary agent tabs whose storage all agents of the workspace share) are refused, because the effect would stay in that storage for the other tabs. The headers apply only to that tab, replace any headers set before, and are removed when the tab is closed or no longer shared with this pane. Pass an empty object to remove them. Cookie headers cannot be set (agents cannot read or write cookies in Para Code). While headers are set, the browser cache and service workers are bypassed for that tab. Header values are not shown again by get_page_network_overrides.',
		inputSchema: {
			type: 'object',
			properties: {
				headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Header name to value, for example {"X-Feature-Flag": "new-checkout"}. Empty object removes all extra headers.' },
				origins: { type: 'array', items: { type: 'string' }, description: 'Origins that receive the headers, for example ["https://staging.example.com"] (at most 10). Default: the origin of the page now.' },
			},
			required: ['headers'],
			additionalProperties: false,
		},
	},
	{
		name: 'set_http_credentials',
		description: 'Answer HTTP authentication (Basic / Digest) prompts of one site in the page shared with this terminal pane with the given user name and password, instead of the login prompt. Only prompts from that exact origin are answered (never proxy prompts), only in that browser tab, and a wrong password is not retried in a loop. Only works on a tab whose browser storage this terminal pane uses alone: a tab opened with open_browser_tab and "private": true, or a profile this pane created that nobody else uses. Other tabs (tabs the user opened or shared, your ordinary agent tabs whose storage all agents of the workspace share) are refused, because the effect would stay in that storage for the other tabs. The credentials are kept in memory only, are never shown again, and are removed when the tab is closed or no longer shared with this pane. Pass clear: true to remove them.',
		inputSchema: {
			type: 'object',
			properties: {
				origin: { type: 'string', description: 'The site that asks for the login, for example "https://intranet.example.com" (https only; plain http only for localhost).' },
				username: { type: 'string' },
				password: { type: 'string' },
				clear: { type: 'boolean', description: 'Remove the credentials set before (other fields are ignored).' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'set_request_rules',
		description: 'Block or rewrite requests of the page shared with this terminal pane. Rules are checked in order and the first rule whose url_pattern matches is used ("*" matches any characters, "?" exactly one; for example "*://*.analytics.example.com/*"). Actions: block (the request fails), set_headers (add, replace or remove request headers; cookie headers cannot be touched), redirect (the browser is redirected to redirect_url and follows it as a normal request, so the agent network restrictions still apply), respond (answer with the given status and text body without contacting the server; Set-Cookie and headers the browser would remember are refused, and the response is never cached). Only works on a tab whose browser storage this terminal pane uses alone: a tab opened with open_browser_tab and "private": true, or a profile this pane created that nobody else uses. Other tabs (tabs the user opened or shared, your ordinary agent tabs whose storage all agents of the workspace share) are refused, because the effect would stay in that storage for the other tabs. The rules apply only to that browser tab (not to cross-origin iframes), replace the rules set before, and are removed when the tab is closed or no longer shared with this pane. Pass an empty array to remove all rules. While rules are set, the browser cache and service workers are bypassed for that tab.',
		inputSchema: {
			type: 'object',
			properties: {
				rules: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							url_pattern: { type: 'string' },
							action: { type: 'string', enum: ['block', 'set_headers', 'redirect', 'respond'] },
							set_headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'set_headers: headers to add or replace.' },
							remove_headers: { type: 'array', items: { type: 'string' }, description: 'set_headers: header names to remove. Headers the browser adds later in the network stack (such as Accept-Language, Accept-Encoding, User-Agent client hints) cannot be removed this way.' },
							redirect_url: { type: 'string', description: 'redirect: absolute http(s) URL.' },
							status: { type: 'number', description: 'respond: HTTP status (200-299 or 400-599, default 200).' },
							body: { type: 'string', description: 'respond: response body text (max 256 KiB).' },
							response_headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'respond: Content-Type, Content-Language, Content-Disposition, Vary, Access-Control-* or X-* headers.' },
						},
						required: ['url_pattern', 'action'],
						additionalProperties: false,
					},
					description: 'At most 20 rules. Empty array removes all rules.',
				},
			},
			required: ['rules'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_page_network_overrides',
		description: 'Show what set_extra_http_headers, set_http_credentials and set_request_rules currently apply to the page shared with this terminal pane: the extra header names (not their values) and the origins they are sent to, the origin that gets credentials (not the password), and each request rule with how many requests it matched.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'download_by_click',
		description: 'Click an element (or coordinates) of the page shared with this terminal pane that starts a file download, and wait for the download. The file is saved in the Para Code download folder like any browser download, marked as downloaded by an agent (the user can show it in its folder, but it is not offered to be opened), and never overwrites an existing file. Returns the saved path and state. For a link you already know the URL of, navigating to it also downloads, but this tool tells you where the file went.',
		inputSchema: {
			type: 'object',
			properties: {
				...TARGET_PROPERTIES,
				timeout_seconds: { type: 'number', description: 'How long to wait for the download to start and finish (5-50, default 30). A download still running after that is reported as in progress.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'highlight_element',
		description: 'Draw a highlight box over an element (or a rectangle) of the page shared with this terminal pane, so the user can see what you are referring to. The page itself is not changed. The highlight disappears after duration_seconds, when another highlight is drawn, or with clear: true.',
		inputSchema: {
			type: 'object',
			properties: {
				uid: { type: 'string', description: 'uid of the element from a recent take_snapshot. Give either uid or x/y/width/height.' },
				x: { type: 'number', description: 'Left edge in CSS pixels of the viewport.' },
				y: { type: 'number', description: 'Top edge in CSS pixels of the viewport.' },
				width: { type: 'number' },
				height: { type: 'number' },
				duration_seconds: { type: 'number', description: 'How long to show it (1-30, default 3).' },
				clear: { type: 'boolean', description: 'Remove the current highlight instead.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'add_init_script',
		description: 'Add JavaScript that runs at the start of every document the page shared with this terminal pane loads from now on (navigations and reloads, in every frame, before the page\'s own scripts), for example to install window.__ hooks, record events or mask personal data for screenshots. Unlike navigate_page "initScript", it stays until removed. It works on any shared tab, including tabs the user opened, and also runs while the user browses in that tab, so keep it small and harmless. It is removed automatically when the tab is closed or is no longer shared with this pane. When you have finished checking, call remove_init_script to take it off again. Returns the script id.',
		inputSchema: {
			type: 'object',
			properties: {
				source: { type: 'string', description: 'JavaScript source to run (at most 100000 characters). It runs in the page\'s main world, so it can define window properties the page and evaluate_script can see.' },
				label: { type: 'string', description: 'Short name shown by list_init_scripts (at most 80 characters).' },
				run_now: { type: 'boolean', description: 'Also run it once in the document that is open now (default false: only from the next navigation or reload).' },
			},
			required: ['source'],
			additionalProperties: false,
		},
	},
	{
		name: 'remove_init_script',
		description: 'Remove a script added with add_init_script from the page shared with this terminal pane, by its id, or all of your scripts on that tab with all: true. Documents already loaded keep what the script did until they reload.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Script id from add_init_script or list_init_scripts (for example "s3").' },
				all: { type: 'boolean', description: 'Remove all of your scripts on this tab.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'list_init_scripts',
		description: 'List the scripts you added with add_init_script that are still active on the page shared with this terminal pane (id, label, size, when added), and how many other panes have scripts there. Use it to check that nothing is left behind after you finish.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
] as const;
