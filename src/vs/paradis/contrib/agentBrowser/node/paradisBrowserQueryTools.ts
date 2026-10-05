/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Keep this module free of imports: paradisBrowserMcpShimCore spreads it into the offline tool list,
// and the shim runs as a standalone node script.

/** Names of the read-and-wait browser tools. They run short scripts in the page and send no mouse or key input. */
export const PARADIS_BROWSER_QUERY_TOOL_NAMES = [
	'wait_until',
	'get_text',
	'inspect_element',
	'scroll_to',
] as const;

/** How an element is found. Shared by every tool here; give at least one of them (or none for the whole page where allowed). */
const LOCATOR_PROPERTIES = {
	selector: { type: 'string', description: 'CSS selector. Open shadow roots are searched too.' },
	role: { type: 'string', description: 'ARIA role, explicit (role="...") or implied by the tag, for example "button", "link", "textbox", "checkbox", "heading", "dialog", "row". Combine with "name".' },
	name: { type: 'string', description: 'Accessible name to match with "role" (aria-label, aria-labelledby, label, alt, placeholder or the text). Case-insensitive substring unless "exact" is true.' },
	text: { type: 'string', description: 'Visible text the element contains. Case-insensitive substring unless "exact" is true. Alone, it matches the innermost elements containing the text.' },
	exact: { type: 'boolean', description: 'Match "name" and "text" exactly (after collapsing whitespace) instead of as a case-insensitive substring.' },
	uid: { type: 'string', description: 'uid of the element from a recent take_snapshot, instead of selector / role / text.' },
	within: { type: 'string', description: 'CSS selector of a container; only elements inside its first match are searched.' },
	within_uid: { type: 'string', description: 'uid (from take_snapshot) of a container; only elements inside it are searched.' },
} as const;

/**
 * Tool definitions for reading and waiting on the page shared with this terminal pane. Each call runs
 * short scripts in the page (like evaluate_script) and sends no trusted mouse or keyboard input, so they
 * work while input tools would be refused and do not hold up input from other tools for long.
 */
export const PARADIS_MCP_BROWSER_QUERY_TOOLS = [
	{
		name: 'wait_until',
		description: 'Wait in one call until an element appears, becomes visible, is hidden or is removed, or until a JavaScript condition becomes true, on the page shared with this terminal pane. Use this instead of setTimeout loops in evaluate_script or sleep in the shell. The page is checked in short slices (each at most about one second), so other tools are not held up. It keeps waiting across navigations and reloads. Returns as soon as the condition holds, with the matching element, or an error when timeout_seconds passes (with what was last seen). A JavaScript dialog (alert / confirm) that opens while checking is dismissed. Iframes are not searched unless within_uid points inside one. With network_idle_ms it also waits until the shared tab (with its iframes and workers) has had no request start or finish for that long, like "network idle" in test runners; requests open for more than 30 seconds (streaming, long polling, server-sent events) are not counted, and WebSockets never are. network_idle_ms alone waits only for the network.',
		inputSchema: {
			type: 'object',
			properties: {
				...LOCATOR_PROPERTIES,
				state: { type: 'string', enum: ['visible', 'attached', 'hidden', 'detached'], description: 'visible (default): a match is rendered with a size. attached: a match exists in the DOM. hidden: no match is visible. detached: no match exists.' },
				count: { type: 'number', description: 'visible / attached only: wait until at least this many elements match (default 1).' },
				predicate: { type: 'string', description: 'JavaScript function run in the page, for example "() => document.querySelectorAll(\'.row\').length >= 20" or "() => window.appReady === true". Waits until it returns a truthy value (it may be async; keep it quick). Can be combined with a locator: then both must hold. Exceptions count as "not yet".' },
				timeout_seconds: { type: 'number', description: 'How long to wait (0.5-120, default 10). Keep it below your MCP client\'s tool timeout.' },
				interval_ms: { type: 'number', description: 'How often the condition is checked inside the page (50-2000, default 200).' },
				network_idle_ms: { type: 'number', description: 'Also wait until no request of the shared tab has started or finished for this many milliseconds (100-30000; 500 is typical after a click that loads data).' },
				network_idle_max_inflight: { type: 'number', description: 'With network_idle_ms: how many requests may still be open and count as idle (0-10, default 0; 2 is like "networkidle2").' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'get_text',
		description: 'Read the visible text (innerText) of an element of the page shared with this terminal pane, or of the whole page when no locator is given. Cheaper than take_snapshot when you only need the words. With all: true, returns the text of every match (lists, table rows). Long text is cut at max_chars; pass offset for the next part.',
		inputSchema: {
			type: 'object',
			properties: {
				...LOCATOR_PROPERTIES,
				all: { type: 'boolean', description: 'Return every match (up to 50) instead of the first.' },
				max_chars: { type: 'number', description: 'Maximum characters returned (100-50000, default 4000).' },
				offset: { type: 'number', description: 'Character offset into the text, to read the next part of a long text.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'inspect_element',
		description: 'Describe why an element of the page shared with this terminal pane looks or behaves the way it does, without changing the page: its box (viewport rectangle, in or out of the viewport), whether it is visible and enabled, the element covering its center or corners (sticky headers, overlays), its scrolling ancestors and their scroll positions, whether its content overflows, its ARIA role, name and aria-* attributes, and selected computed styles. Use it instead of getBoundingClientRect / getComputedStyle in evaluate_script, for example when a click lands on the wrong element or nothing seems to happen.',
		inputSchema: {
			type: 'object',
			properties: {
				...LOCATOR_PROPERTIES,
				styles: { type: 'array', items: { type: 'string' }, description: 'CSS properties to report (at most 40), for example ["display", "z-index", "pointer-events"]. Default: display, visibility, opacity, position, z-index, overflow, pointer-events, cursor, transform, color, background-color, font-size.' },
				index: { type: 'number', description: 'Which match to inspect when several match (0-based, default 0). The response says how many matched.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'scroll_to',
		description: 'Scroll the page shared with this terminal pane until an element is found, then bring it into view. Works with virtualized (lazy-rendered) lists that only create rows near the visible area: the scroll container is moved step by step and searched again after each step, until the element appears or the end is reached. Scrolls with scripts (scrollIntoView / scrollBy), not with the mouse wheel, so it works while the user is using the page. Give "container" for the list to scroll; by default the largest scrollable area of the page is used.',
		inputSchema: {
			type: 'object',
			properties: {
				...LOCATOR_PROPERTIES,
				container: { type: 'string', description: 'CSS selector of the scroll container. Default: "within" when it scrolls, otherwise the largest scrollable element, otherwise the page.' },
				direction: { type: 'string', enum: ['down', 'up', 'right', 'left'], description: 'Which way to scroll while searching (default down).' },
				from_start: { type: 'boolean', description: 'Scroll the container back to its start before searching (default false).' },
				step_px: { type: 'number', description: 'Pixels per step (default 80% of the container\'s visible size).' },
				max_steps: { type: 'number', description: 'Maximum number of steps (1-200, default 40).' },
				settle_ms: { type: 'number', description: 'Wait after each step for the list to render new rows (0-3000, default 250).' },
			},
			additionalProperties: false,
		},
	},
] as const;

/** Names of the find-and-act tools. They find the element like the tools above and then send trusted mouse / keyboard input. */
export const PARADIS_BROWSER_ACT_TOOL_NAMES = [
	'click_by',
	'fill_by',
] as const;

const ACT_TARGET_PROPERTIES = {
	...LOCATOR_PROPERTIES,
	index: { type: 'number', description: 'Which match to use when several match (0-based). Default: the first visible, enabled match. The response says how many matched.' },
} as const;

/**
 * Tool definitions that find an element by role / name / text / CSS / uid and act on it with trusted input,
 * the same input path as click and fill (refused while the user is using the page).
 */
export const PARADIS_MCP_BROWSER_ACT_TOOLS = [
	{
		name: 'click_by',
		description: 'Find an element of the page shared with this terminal pane by role + name, visible text, CSS selector or uid (optionally inside "within"), scroll it into view and click its center with trusted mouse input (the same input as click). Use this instead of take_snapshot followed by click, or instead of element.click() in evaluate_script. When the element cannot be clicked, nothing is sent and the reason is returned the way inspect_element describes it: not found (with how many matched), hidden or zero size, disabled, inside an iframe, or covered by another element (with the covering element). Input is refused while the user is using that page.',
		inputSchema: {
			type: 'object',
			properties: {
				...ACT_TARGET_PROPERTIES,
				button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
				double: { type: 'boolean', description: 'Double-click (default false).' },
				modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] }, description: 'Keys held during the click.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'fill_by',
		description: 'Find a form field of the page shared with this terminal pane by role + name (for example role "textbox" with its label), visible text, CSS selector or uid (optionally inside "within") and set its value. Text fields, text areas and contenteditable elements are focused, their content is selected and the value is inserted as trusted text input, so frameworks with controlled inputs (React, MUI, Vue) see a real input event; given a wrapper such as an MUI TextField, the field inside it is used. Selects pick the option by value or label. Date, time, month, week, color and range inputs take the HTML value format (for example "2026-10-06" or "09:30") and get it with input and change events. Checkboxes and radios take "true" / "false" and are clicked only when the state has to change. Returns the value the field has afterwards (only the length for password fields). Use this instead of setting .value with a native setter in evaluate_script. Input is refused while the user is using that page.',
		inputSchema: {
			type: 'object',
			properties: {
				...ACT_TARGET_PROPERTIES,
				value: { type: 'string', description: 'The value to set. An empty string clears a text field. "true" / "false" for checkboxes and radios; the option value or label for selects.' },
				submit: { type: 'boolean', description: 'Press Enter in the field after filling it (default false).' },
			},
			required: ['value'],
			additionalProperties: false,
		},
	},
] as const;

/** run_steps: several page tools in one call. */
export const PARADIS_MCP_BROWSER_RUN_STEPS_TOOLS = [
	{
		name: 'run_steps',
		description: 'Run several tools on the page shared with this terminal pane in one call, in order: act, wait, check and capture, for example [fill_by, fill_by, click_by, wait_until, get_text, take_screenshot]. Each step is checked and run exactly as if it had been called alone, and its result is included. Stops at the first step that fails (unless continue_on_error is true) and says which one. Use it for a known sequence; call tools one by one when the next step depends on reading a result first. Allowed tools: navigate_page, click, click_at, fill, fill_form, hover, press_key, type_text, drag, handle_dialog, wait_for, take_screenshot, take_snapshot, evaluate_script, list_console_messages, list_network_requests, click_by, fill_by, wait_until, get_text, inspect_element, scroll_to, capture_screenshot, mouse_action, highlight_element. Keep the total time below your MCP client\'s tool timeout.',
		inputSchema: {
			type: 'object',
			properties: {
				steps: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							tool: { type: 'string', description: 'Tool name, for example "click_by".' },
							args: { type: 'object', description: 'The arguments of that tool, as when calling it alone.' },
						},
						required: ['tool'],
						additionalProperties: false,
					},
					description: 'At most 30 steps.',
				},
				continue_on_error: { type: 'boolean', description: 'Run the remaining steps after a step fails (default false).' },
			},
			required: ['steps'],
			additionalProperties: false,
		},
	},
] as const;

/** Names of the capture and file tools. */
export const PARADIS_BROWSER_FILE_TOOL_NAMES = [
	'capture_screenshot',
	'read_download',
] as const;

/** Tool definitions for cropped / multiple screenshots and for reading downloaded files. */
export const PARADIS_MCP_BROWSER_FILE_TOOLS = [
	{
		name: 'capture_screenshot',
		description: 'Capture part of the page shared with this terminal pane: a rectangle of the viewport ("rect"), one element (uid, selector, role + name or text) or several elements in one call ("elements", one image each, up to 10), cropped to the element with optional "padding". Elements outside the viewport are captured without scrolling. With "saveTo" the images are written straight to a file on the machine this agent runs on instead of being returned (several images get -1, -2, ... before the extension), so you do not need to crop or fetch them with other tools. For the whole viewport or page use take_screenshot.',
		inputSchema: {
			type: 'object',
			properties: {
				...LOCATOR_PROPERTIES,
				index: { type: 'number', description: 'Which match to capture when several match (0-based). Default: the first visible match.' },
				rect: {
					type: 'object',
					properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
					required: ['x', 'y', 'width', 'height'],
					additionalProperties: false,
					description: 'Rectangle in CSS pixels of the viewport (as in a take_screenshot of the viewport).',
				},
				elements: {
					type: 'array',
					items: { type: 'object', properties: { ...LOCATOR_PROPERTIES, index: { type: 'number' } }, additionalProperties: false },
					description: 'Several elements, each found like the top-level locator, for example [{"uid": "3_4"}, {"role": "dialog"}].',
				},
				padding: { type: 'number', description: 'CSS pixels of margin around each element (0-200, default 0).' },
				format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png).' },
				quality: { type: 'number', description: 'jpeg only: quality 0-100.' },
				saveTo: { type: 'string', description: 'Absolute path of the image file to write, inside the folder of this terminal pane\'s space or the temporary folder. The images are then not returned inline.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'read_download',
		description: 'Read the contents of a file that download_by_click or save_page_as_pdf saved in Para Code\'s download folder, without opening it in another program: for .xlsx / .xlsm the list of sheets and the cells of a range (values as displayed), for .csv / .tsv / .txt the rows of a range (UTF-8 or Shift_JIS). Output is limited by max_cells; pass "range" for another part. PDF text is not supported yet. Only files inside the download folder can be read.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'The path that download_by_click or save_page_as_pdf returned.' },
				sheet: { type: 'string', description: 'xlsx: sheet name. Default: the first sheet.' },
				sheet_number: { type: 'number', description: 'xlsx: sheet by position instead of name (1 for the first).' },
				range: { type: 'string', description: 'Cells to read, for example "A1:H50" (also for csv: rows 1-50, columns A-H). Default: the first 100 rows and 30 columns.' },
				max_cells: { type: 'number', description: 'Maximum number of cells returned (1-20000, default 2000).' },
			},
			required: ['path'],
			additionalProperties: false,
		},
	},
] as const;
