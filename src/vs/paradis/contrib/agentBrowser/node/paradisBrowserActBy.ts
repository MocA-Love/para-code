/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP の「探して操作する」ツール（click_by / fill_by）の shared process 側。
// 要素を探すのは「読む・待つ」ツールと同じページの関数（paradisBrowserQueryPageScript.ts）を
// evaluate_script で、押す・入力するのは既存の入力の通り道（CDP 入力キュー、ユーザーが使っている間は断る）で行う。
//
// 決め事:
// - 押せない理由（見つからない・見えない・無効・iframe の中・被っている）が分かったら何も送らずに返す
// - fill の文字は「中身を選択してから Input.insertText」で入れる。value を直接書き換えない（React などの
//   制御された input が変化に気づかないため）。空にするときは選択して Backspace
// - 探した要素は同じ呼び出しの次の evaluate でも同じものを使う（ページ側の WeakRef を nonce で引く）
// - サービス本体がペイントークン・ingress lease・接続元を確かめてから呼ぶ。await の後は共有が変わって
//   いないかを毎回確かめる

import { generateUuid } from '../../../../base/common/uuid.js';
import { IParadisCdpInputDispatchResult } from '../common/paradisAgentBrowser.js';
import { IParadisQuerySpec, paradisBuildQueryFunction, paradisIsLocatorError, paradisIsTransientEvaluateFailure, paradisParseEvaluateValue, paradisParseQueryLocator } from './paradisBrowserQuery.js';
import { PARADIS_BROWSER_ACT_TOOL_NAMES } from './paradisBrowserQueryTools.js';

/** 「探して操作する」ツールの名前。 */
export const PARADIS_BROWSER_ACT_TOOL_NAME_SET: ReadonlySet<string> = new Set(PARADIS_BROWSER_ACT_TOOL_NAMES);

/** ツールの実行中にサービスから借りるもの。 */
export interface IParadisBrowserActCall {
	readonly signal?: AbortSignal;
	/** 内蔵 chrome-devtools-mcp の evaluate_script を呼ぶ。戻り値は MCP のツールの結果。 */
	evaluate(functionSource: string, uids: readonly string[]): Promise<unknown>;
	/** 既存の入力の通り道で 1 つ送る。 */
	dispatch(method: string, params: Record<string, unknown>): Promise<IParadisCdpInputDispatchResult>;
	/** ingress lease が古ければ投げる。共有が変わっていたら false。await の後に呼ぶ。 */
	isCurrent(): boolean;
}

type ToolResult = unknown;

function text(message: string): ToolResult {
	return { content: [{ type: 'text', text: message }] };
}

function error(message: string): ToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

const BINDING_CHANGED = 'PARA_BROWSER_RETRYABLE: the page shared with this terminal pane changed while the tool was running; check get_shared_page and retry.';
const MAX_VALUE = 100_000;
const MODIFIER_BITS: Readonly<Record<string, number>> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const BUTTON_BITS: Readonly<Record<string, number>> = { left: 1, right: 2, middle: 4 };

interface ILocated {
	readonly matched: number;
	readonly element?: Record<string, unknown>;
	readonly kind?: string;
	readonly visible?: boolean;
	readonly enabled?: boolean;
	readonly readOnly?: boolean;
	readonly focused?: boolean;
	readonly value?: string;
	readonly x?: number;
	readonly y?: number;
	readonly problem?: string;
	readonly coveredBy?: Record<string, unknown>;
	readonly options?: readonly { value: string; label: string }[];
	readonly withinMissing?: boolean;
	readonly noIndex?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeLocator(args: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const key of ['uid', 'selector', 'role', 'name', 'text', 'within', 'within_uid']) {
		if (typeof args[key] === 'string') {
			parts.push(`${key} ${JSON.stringify(args[key])}`);
		}
	}
	return parts.join(', ');
}

/** 押せない理由の文。押せるなら undefined。`needsPointer` は click（fill の文字入力は focus で足りる）。 */
export function paradisActProblem(tool: string, located: ILocated, needsPointer: boolean): string | undefined {
	const element = located.element !== undefined ? ` Element: ${JSON.stringify(located.element)}.` : '';
	if (located.problem === 'iframe') {
		return `${tool}: the element is inside an iframe, which this tool does not reach. Use take_snapshot and click / fill with its uid instead.${element}`;
	}
	if (located.enabled === false) {
		return `${tool}: the element is disabled (disabled, aria-disabled="true" or inside an inert area), so nothing was sent. Wait for it to become enabled with wait_until (predicate), or check why with inspect_element.${element}`;
	}
	if (!needsPointer) {
		return undefined;
	}
	if (located.visible === false || located.problem === 'zero-size') {
		return `${tool}: the element is not visible (hidden, zero size or not rendered), so nothing was sent. Wait for it with wait_until, or check why with inspect_element.${element}`;
	}
	switch (located.problem) {
		case 'outside-viewport':
			return `${tool}: the element is still outside the viewport after scrolling it into view (a fixed-size or clipped container), so nothing was sent. Try scroll_to, or check its scrolling ancestors with inspect_element.${element}`;
		case 'covered':
			return `${tool}: the element is covered at its center by another element, so the click would land on that one and nothing was sent. Covered by: ${JSON.stringify(located.coveredBy)}. Close the overlay (dialog, toast, sticky header) first, or check with inspect_element.${element}`;
		case 'nothing-at-point':
			return `${tool}: nothing receives the pointer at the center of the element, so nothing was sent.${element}`;
	}
	return undefined;
}

export class ParadisBrowserActBy {

	constructor(private readonly newRef: () => string = generateUuid) { }

	isActTool(name: string): boolean {
		return PARADIS_BROWSER_ACT_TOOL_NAME_SET.has(name);
	}

	async call(call: IParadisBrowserActCall, name: string, rawArgs: unknown): Promise<ToolResult> {
		const args = isRecord(rawArgs) ? rawArgs : {};
		switch (name) {
			case 'click_by': return this.clickBy(call, args);
			case 'fill_by': return this.fillBy(call, args);
			default: return error(`Unknown tool: ${name}`);
		}
	}

	/** 1 回 evaluate する。値か、エージェントへ返す失敗。 */
	private async run(call: IParadisBrowserActCall, spec: IParadisQuerySpec, uids: readonly string[]): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; result: ToolResult }> {
		const result = await call.evaluate(paradisBuildQueryFunction(spec, uids.length), uids);
		if (!call.isCurrent()) {
			return { ok: false, result: error(BINDING_CHANGED) };
		}
		if ((result as { isError?: unknown } | undefined)?.isError === true) {
			return { ok: false, result: paradisIsTransientEvaluateFailure(result) ? error('PARA_BROWSER_RETRYABLE: the page was navigating or reloading while the element was looked up. Retry once.') : result };
		}
		const parsed = paradisParseEvaluateValue(result);
		if (!parsed || !isRecord(parsed.value)) {
			return { ok: false, result: error('PARA_BROWSER_RETRYABLE: the page did not return a readable result (it may have been navigating). Retry once.') };
		}
		return { ok: true, value: parsed.value };
	}

	/** 探して、見つからない理由をエージェントへ返す形にする。 */
	private async locate(call: IParadisBrowserActCall, tool: string, args: Record<string, unknown>, purpose: 'click' | 'fill', ref: string): Promise<{ ok: true; located: ILocated; uids: readonly string[] } | { ok: false; result: ToolResult }> {
		const locator = paradisParseQueryLocator(args);
		if (paradisIsLocatorError(locator)) {
			return { ok: false, result: error(locator.error) };
		}
		if (!locator.given) {
			return { ok: false, result: error(`${tool} needs the element: role + name, text, selector or uid (from take_snapshot).`) };
		}
		let index: number | undefined;
		if (args.index !== undefined) {
			if (typeof args.index !== 'number' || !Number.isInteger(args.index) || args.index < 0 || args.index > 10_000) {
				return { ok: false, result: error('"index" must be an integer from 0 to 10000.') };
			}
			index = args.index;
		}
		const spec: IParadisQuerySpec = { ...locator.spec, mode: 'locate', purpose, ref, ...(index !== undefined ? { index } : {}) };
		const outcome = await this.run(call, spec, locator.uids);
		if (!outcome.ok) {
			return outcome;
		}
		const located = outcome.value as unknown as ILocated;
		if (located.withinMissing === true) {
			return { ok: false, result: error(`${tool}: nothing matches the container (${describeLocator({ within: args.within, within_uid: args.within_uid })}).`) };
		}
		if (located.matched === 0) {
			return { ok: false, result: error(`${tool}: no element matches ${describeLocator(args)}. Check with take_snapshot or get_text, wait for it with wait_until, or bring it into view with scroll_to.`) };
		}
		if (located.noIndex === true) {
			return { ok: false, result: error(`${tool}: only ${located.matched} element(s) match ${describeLocator(args)}, so there is no index ${index}.`) };
		}
		return { ok: true, located, uids: locator.uids };
	}

	private async send(call: IParadisBrowserActCall, method: string, params: Record<string, unknown>): Promise<string | undefined> {
		const result = await call.dispatch(method, params);
		if (!call.isCurrent()) {
			return BINDING_CHANGED;
		}
		return result.status === 'success' ? undefined : result.message;
	}

	/** 押して離す。押せたのに離せなかったら、もう一度だけ離しに行く。 */
	private async click(call: IParadisBrowserActCall, x: number, y: number, button: string, clickCount: number, modifiers: number): Promise<string | undefined> {
		const base = { x, y, ...(modifiers !== 0 ? { modifiers } : {}) };
		const moved = await this.send(call, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', buttons: 0 });
		if (moved !== undefined) {
			return moved;
		}
		for (let count = 1; count <= clickCount; count++) {
			const pressed = await this.send(call, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', button, buttons: BUTTON_BITS[button], clickCount: count });
			if (pressed !== undefined) {
				return pressed;
			}
			const release = { ...base, type: 'mouseReleased', button, buttons: 0, clickCount: count };
			const released = await this.send(call, 'Input.dispatchMouseEvent', release);
			if (released !== undefined) {
				const again = call.isCurrent() ? await this.send(call, 'Input.dispatchMouseEvent', release) : released;
				if (again !== undefined) {
					return `the button was pressed but could not be released (${released})`;
				}
			}
		}
		return undefined;
	}

	private async clickBy(call: IParadisBrowserActCall, args: Record<string, unknown>): Promise<ToolResult> {
		const button = args.button ?? 'left';
		if (button !== 'left' && button !== 'right' && button !== 'middle') {
			return error('"button" must be "left", "right" or "middle".');
		}
		if (args.double !== undefined && typeof args.double !== 'boolean') {
			return error('"double" must be true or false.');
		}
		let modifiers = 0;
		if (args.modifiers !== undefined) {
			if (!Array.isArray(args.modifiers) || args.modifiers.some(modifier => typeof modifier !== 'string' || MODIFIER_BITS[modifier] === undefined)) {
				return error('"modifiers" must be an array of "Alt", "Control", "Meta", "Shift".');
			}
			modifiers = args.modifiers.reduce((bits: number, modifier: string) => bits | MODIFIER_BITS[modifier], 0);
		}
		const found = await this.locate(call, 'click_by', args, 'click', this.newRef());
		if (!found.ok) {
			return found.result;
		}
		const located = found.located;
		const problem = paradisActProblem('click_by', located, true);
		if (problem !== undefined) {
			return error(problem);
		}
		const failure = await this.click(call, located.x!, located.y!, button, args.double === true ? 2 : 1, modifiers);
		if (failure !== undefined) {
			return error(`click_by found the element but the click was not completed: ${failure}`);
		}
		const which = located.matched > 1 ? ` (${located.matched} elements matched${args.index === undefined ? '; used the first visible, enabled one' : `; used index ${args.index}`})` : '';
		return text(`${args.double === true ? 'Double-clicked' : button === 'left' ? 'Clicked' : `${button === 'right' ? 'Right' : 'Middle'}-clicked`} at (${Math.round(located.x!)}, ${Math.round(located.y!)})${which}.\nElement: ${JSON.stringify(located.element)}`);
	}

	private async fillBy(call: IParadisBrowserActCall, args: Record<string, unknown>): Promise<ToolResult> {
		const value = args.value;
		if (typeof value !== 'string' || value.length > MAX_VALUE) {
			return error(`"value" must be a string of at most ${MAX_VALUE} characters.`);
		}
		if (args.submit !== undefined && typeof args.submit !== 'boolean') {
			return error('"submit" must be true or false.');
		}
		const ref = this.newRef();
		const found = await this.locate(call, 'fill_by', args, 'fill', ref);
		if (!found.ok) {
			return found.result;
		}
		const located = found.located;
		const kind = located.kind;
		const problem = paradisActProblem('fill_by', located, kind === 'checkbox' || kind === 'radio');
		if (problem !== undefined) {
			return error(problem);
		}
		const which = located.matched > 1 ? ` (${located.matched} elements matched${args.index === undefined ? '; used the first visible, enabled one' : `; used index ${args.index}`})` : '';
		let outcome: string;
		switch (kind) {
			case 'checkbox':
			case 'radio': {
				const wanted = value.trim().toLowerCase();
				if (wanted !== 'true' && wanted !== 'false') {
					return error(`fill_by: the element is a ${kind}; give "value": "true" or "false".`);
				}
				if (kind === 'radio' && wanted === 'false' && located.value === 'true') {
					return error('fill_by: a radio button cannot be turned off by itself; choose another radio button of the group instead.');
				}
				if (located.value !== wanted) {
					const failure = await this.click(call, located.x!, located.y!, 'left', 1, 0);
					if (failure !== undefined) {
						return error(`fill_by found the ${kind} but the click was not completed: ${failure}`);
					}
				}
				outcome = located.value === wanted ? `The ${kind} was already ${wanted === 'true' ? 'checked' : 'unchecked'}; nothing was sent` : `Clicked the ${kind}`;
				break;
			}
			case 'select': {
				const chosen = await this.run(call, { mode: 'selectOption', ref, value }, []);
				if (!chosen.ok) {
					return chosen.result;
				}
				if (chosen.value.lost === true) {
					return error('PARA_BROWSER_RETRYABLE: the select element was removed from the page before an option could be chosen. Retry.');
				}
				if (chosen.value.noOption === true) {
					return error(`fill_by: the select has no option with the value or label ${JSON.stringify(value)}. Options: ${JSON.stringify(chosen.value.options)}`);
				}
				outcome = `Chose ${JSON.stringify(chosen.value.label)} in the select (the page saw input and change events)`;
				break;
			}
			case 'text': {
				if (located.readOnly === true) {
					return error(`fill_by: the field is read-only, so nothing was sent. Element: ${JSON.stringify(located.element)}`);
				}
				let focus = await this.run(call, { mode: 'focusField', ref }, []);
				if (!focus.ok) {
					return focus.result;
				}
				if (focus.value.focused !== true && focus.value.lost !== true && !paradisActProblem('fill_by', located, true)) {
					// focus() was not enough (a widget that takes focus only on a pointer press): click it once.
					const failure = await this.click(call, located.x!, located.y!, 'left', 1, 0);
					if (failure !== undefined) {
						return error(`fill_by could not focus the field: ${failure}`);
					}
					focus = await this.run(call, { mode: 'focusField', ref }, []);
					if (!focus.ok) {
						return focus.result;
					}
				}
				if (focus.value.lost === true) {
					return error('PARA_BROWSER_RETRYABLE: the field was removed from the page before it could be filled (the page re-rendered). Retry.');
				}
				if (focus.value.focused !== true) {
					return error(`fill_by: the field did not take the keyboard focus, so nothing was typed. Check it with inspect_element. Element: ${JSON.stringify(located.element)}`);
				}
				const failure = value.length > 0
					? await this.send(call, 'Input.insertText', { text: value })
					: focus.value.empty === true ? undefined : await this.pressKey(call, 'Backspace', 'Backspace', 8);
				if (failure !== undefined) {
					return error(`fill_by focused the field but the text could not be entered: ${failure}`);
				}
				outcome = value.length > 0 ? 'Selected the old content and inserted the text as trusted input' : 'Cleared the field';
				break;
			}
			default:
				return error(`fill_by: the element is not a text field, text area, contenteditable, select, checkbox or radio (and has none inside it). Use click_by to open it, then fill_by on the field that appears, or type_text. Element: ${JSON.stringify(located.element)}`);
		}
		if (args.submit === true) {
			const failure = await this.pressKey(call, 'Enter', 'Enter', 13, '\r');
			if (failure !== undefined) {
				return error(`fill_by filled the field but could not press Enter: ${failure}`);
			}
		}
		const read = await this.run(call, { mode: 'readField', ref }, []);
		const after = read.ok && read.value.lost !== true ? read.value.value : undefined;
		const lines = [`${outcome}${args.submit === true ? ', then pressed Enter' : ''}${which}.`];
		if (typeof after === 'string') {
			lines.push(`Value now: ${JSON.stringify(after)}`);
			if (kind === 'text' && args.submit !== true && after !== value) {
				lines.push('The value differs from what was given: the page may format, limit (maxlength) or mask the input, or autocomplete may have changed it. Check with take_snapshot or get_text.');
			}
		} else {
			lines.push('The field could not be read afterwards (the page re-rendered or navigated).');
		}
		lines.push(`Element: ${JSON.stringify(located.element)}`);
		return text(lines.join('\n'));
	}

	private async pressKey(call: IParadisBrowserActCall, key: string, code: string, keyCode: number, keyText?: string): Promise<string | undefined> {
		const down = keyText !== undefined
			? { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text: keyText, unmodifiedText: keyText }
			: { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode };
		const pressed = await this.send(call, 'Input.dispatchKeyEvent', down);
		if (pressed !== undefined) {
			return pressed;
		}
		return this.send(call, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
	}
}
