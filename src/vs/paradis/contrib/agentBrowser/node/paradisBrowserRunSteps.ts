/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP の run_steps（操作・待機・検証・撮影を 1 回の呼び出しで順に行う）。
// 各手順はサービス本体の通常のツール呼び出し（_callTool）へそのまま渡すので、接続元の確認・パスの
// 確認・入力の通り道はどれも単体で呼んだときと同じ。ここでは並べて呼ぶ・止める・結果をまとめるだけ。

/** run_steps の中で呼べるツール。共有中のページを操作・待機・検証・撮影するものだけ（承認やタブ・IDE の操作は入れない）。 */
export const PARADIS_RUN_STEPS_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
	'navigate_page', 'click', 'click_at', 'fill', 'fill_form', 'hover', 'press_key', 'type_text', 'drag', 'handle_dialog', 'wait_for',
	'take_screenshot', 'take_snapshot', 'evaluate_script', 'list_console_messages', 'list_network_requests',
	'click_by', 'fill_by', 'wait_until', 'get_text', 'inspect_element', 'scroll_to', 'capture_screenshot',
	'mouse_action', 'highlight_element',
]);

export const PARADIS_RUN_STEPS_MAX_STEPS = 30;
/** 1 つの手順の文字の結果のうち、まとめに残す長さ。 */
const MAX_STEP_TEXT = 6000;
const MAX_TOTAL_IMAGES = 10;

/** 1 回の run_steps でサービスから借りるもの。 */
export interface IParadisRunStepsCall {
	readonly signal?: AbortSignal;
	/** 通常のツール呼び出し。戻り値は MCP のツールの結果。 */
	callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

interface IContentItem {
	readonly type: string;
	readonly text?: string;
	readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function error(message: string): unknown {
	return { content: [{ type: 'text', text: message }], isError: true };
}

/** 引数を確かめて、手順の列にする。 */
export function paradisParseRunSteps(rawArgs: unknown): { readonly ok: true; readonly steps: readonly { readonly tool: string; readonly args: Record<string, unknown> }[]; readonly continueOnError: boolean } | { readonly ok: false; readonly error: string } {
	const args = isRecord(rawArgs) ? rawArgs : {};
	if (!Array.isArray(args.steps) || args.steps.length === 0 || args.steps.length > PARADIS_RUN_STEPS_MAX_STEPS) {
		return { ok: false, error: `"steps" must be a list of 1 to ${PARADIS_RUN_STEPS_MAX_STEPS} steps, each {"tool": "...", "args": {...}}.` };
	}
	if (args.continue_on_error !== undefined && typeof args.continue_on_error !== 'boolean') {
		return { ok: false, error: '"continue_on_error" must be true or false.' };
	}
	const steps: { tool: string; args: Record<string, unknown> }[] = [];
	for (const [index, step] of args.steps.entries()) {
		if (!isRecord(step) || typeof step.tool !== 'string' || (step.args !== undefined && !isRecord(step.args))) {
			return { ok: false, error: `Step ${index + 1} must be {"tool": "...", "args": {...}}.` };
		}
		if (!PARADIS_RUN_STEPS_ALLOWED_TOOLS.has(step.tool)) {
			return { ok: false, error: `Step ${index + 1}: "${step.tool}" cannot be used in run_steps. Allowed: ${[...PARADIS_RUN_STEPS_ALLOWED_TOOLS].join(', ')}.` };
		}
		steps.push({ tool: step.tool, args: (step.args ?? {}) as Record<string, unknown> });
	}
	return { ok: true, steps, continueOnError: args.continue_on_error === true };
}

/** 手順を順に呼び、結果を 1 つにまとめる。失敗した手順で止まる（continue_on_error で続ける）。 */
export async function paradisRunSteps(call: IParadisRunStepsCall, rawArgs: unknown): Promise<unknown> {
	const parsed = paradisParseRunSteps(rawArgs);
	if (!parsed.ok) {
		return error(parsed.error);
	}
	const content: IContentItem[] = [];
	let images = 0;
	let failed = 0;
	let ran = 0;
	for (const [index, step] of parsed.steps.entries()) {
		if (call.signal?.aborted) {
			content.push({ type: 'text', text: `run_steps was cancelled before step ${index + 1}.` });
			break;
		}
		// 共有やペインが無くなった（ingress lease の失効など）の例外は、そのまま呼び出し全体の失敗にする
		const result = await call.callTool(step.tool, step.args);
		ran++;
		const isError = isRecord(result) && result.isError === true;
		const items = isRecord(result) && Array.isArray(result.content) ? result.content as IContentItem[] : [];
		content.push({ type: 'text', text: `--- Step ${index + 1}: ${step.tool} ${isError ? 'FAILED' : 'ok'}` });
		for (const item of items) {
			if (item.type === 'text' && typeof item.text === 'string') {
				content.push({ type: 'text', text: item.text.length > MAX_STEP_TEXT ? `${item.text.slice(0, MAX_STEP_TEXT)}\n... (cut; run the step alone for the full text)` : item.text });
			} else if (item.type === 'image') {
				if (images < MAX_TOTAL_IMAGES) {
					content.push(item);
				}
				images++;
			} else {
				content.push(item);
			}
		}
		if (isError) {
			failed++;
			if (!parsed.continueOnError) {
				break;
			}
		}
	}
	const skipped = parsed.steps.length - ran;
	const summary = `run_steps: ${ran} of ${parsed.steps.length} step(s) ran, ${failed} failed${skipped > 0 ? `, ${skipped} not run (stopped at the first failure)` : ''}.${images > MAX_TOTAL_IMAGES ? ` Only the first ${MAX_TOTAL_IMAGES} images are included.` : ''}`;
	return { content: [{ type: 'text', text: summary }, ...content], ...(failed > 0 ? { isError: true } : {}) };
}
