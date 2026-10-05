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
		description: 'Wait in one call until an element appears, becomes visible, is hidden or is removed, or until a JavaScript condition becomes true, on the page shared with this terminal pane. Use this instead of setTimeout loops in evaluate_script or sleep in the shell. The page is checked in short slices (each at most about one second), so other tools are not held up. It keeps waiting across navigations and reloads. Returns as soon as the condition holds, with the matching element, or an error when timeout_seconds passes (with what was last seen). A JavaScript dialog (alert / confirm) that opens while checking is dismissed. Iframes are not searched unless within_uid points inside one.',
		inputSchema: {
			type: 'object',
			properties: {
				...LOCATOR_PROPERTIES,
				state: { type: 'string', enum: ['visible', 'attached', 'hidden', 'detached'], description: 'visible (default): a match is rendered with a size. attached: a match exists in the DOM. hidden: no match is visible. detached: no match exists.' },
				count: { type: 'number', description: 'visible / attached only: wait until at least this many elements match (default 1).' },
				predicate: { type: 'string', description: 'JavaScript function run in the page, for example "() => document.querySelectorAll(\'.row\').length >= 20" or "() => window.appReady === true". Waits until it returns a truthy value (it may be async; keep it quick). Can be combined with a locator: then both must hold. Exceptions count as "not yet".' },
				timeout_seconds: { type: 'number', description: 'How long to wait (0.5-120, default 10). Keep it below your MCP client\'s tool timeout.' },
				interval_ms: { type: 'number', description: 'How often the condition is checked inside the page (50-2000, default 200).' },
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
