/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP の「読む・待つ」ツール（wait_until / get_text / inspect_element / scroll_to）の
// shared process 側。引数を検証し、ページの中で動かす関数（paradisBrowserQueryPageScript.ts）を
// 内蔵 chrome-devtools-mcp の evaluate_script で短く何度も呼ぶ。マウス・キーの入力は送らない。
//
// 決め事:
// - 1 回の evaluate は長くても約 1 秒（wait_until の 1 区切り）。ページの中で待ち続けないので、
//   入力の barrier を長く塞がない
// - 待っている間の遷移・再読み込み（実行コンテキストの破棄）は「まだ」として待ち続ける
// - evaluate の間に開いたダイアログは閉じる（dismiss）。承認の confirm を勝手に押さないため
// - サービス本体（paradisAgentBrowserService.ts）がペイントークンと ingress lease を確かめてから呼ぶ。
//   await の後は共有が変わっていないかを毎回確かめる

import type { IParadisCursorRect } from '../common/paradisCursorOverlay.js';
import { PARADIS_BROWSER_QUERY_PAGE_SCRIPT } from './paradisBrowserQueryPageScript.js';
import { PARADIS_BROWSER_QUERY_TOOL_NAMES } from './paradisBrowserQueryTools.js';
import type { IParadisNetworkActivitySnapshot } from './paradisCdpNetworkActivity.js';

/** 「読む・待つ」ツールの名前。 */
export const PARADIS_BROWSER_QUERY_TOOL_NAME_SET: ReadonlySet<string> = new Set(PARADIS_BROWSER_QUERY_TOOL_NAMES);

/** ツールの実行中にサービスから借りるもの。 */
export interface IParadisBrowserQueryCall {
	readonly signal?: AbortSignal;
	/**
	 * 内蔵 chrome-devtools-mcp の evaluate_script を呼ぶ。`uids` は関数の引数に渡す要素。
	 * 戻り値は MCP のツールの結果（失敗は isError）。
	 */
	evaluate(functionSource: string, uids: readonly string[]): Promise<unknown>;
	/** ingress lease が古ければ投げる。共有が変わっていたら false。await の後に呼ぶ。 */
	isCurrent(): boolean;
	/**
	 * 共有中のタブの通信の様子（CDP ゲートウェイが数えたもの）。`ignoreOlderThanMs` より長く続く要求は
	 * 数えない。まだ何も数えていなければ undefined。
	 */
	networkActivity?(ignoreOlderThanMs: number): IParadisNetworkActivitySnapshot | undefined;
	/**
	 * 見ている要素（ビューポートの CSS ピクセル）をエージェントのカーソルの枠で示す（q.html Q297 の 3）。
	 * 演出なので待たない。
	 */
	noteLook?(rect: IParadisCursorRect): void;
}

/**
 * ページの関数が返した値から、見ている要素の矩形を取り出す（inspect_element の `rect`、ほかのツールの
 * `element.rect`）。大きさの無いもの・形の違うもの・iframe の中の要素（矩形がその枠の中の座標で、
 * ページの画面とずれる）は undefined。
 */
export function paradisLookedAtRect(value: unknown): IParadisCursorRect | undefined {
	if (!isRecord(value) || value.inMainFrame === false || value.problem === 'iframe' || value.inIframe === true || (isRecord(value.element) && value.element.inIframe === true)) {
		return undefined;
	}
	const rect = isRecord(value.rect) ? value.rect : isRecord(value.element) && isRecord(value.element.rect) ? value.element.rect : undefined;
	if (!rect) {
		return undefined;
	}
	const { x, y, width, height } = rect;
	if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number' || ![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
		return undefined;
	}
	return { x, y, width, height };
}

type ToolResult = unknown;

function text(message: string): ToolResult {
	return { content: [{ type: 'text', text: message }] };
}

function error(message: string): ToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

const BINDING_CHANGED = 'PARA_BROWSER_RETRYABLE: the page shared with this terminal pane changed while the tool was running; check get_shared_page and retry.';

/** wait_until の 1 回の evaluate でページの中に留まる上限。 */
export const PARADIS_WAIT_UNTIL_SLICE_MS = 1000;
/** network idle で、これより長く続く要求（ストリーミング・ロングポーリング）は数えない。 */
export const PARADIS_NETWORK_IDLE_IGNORE_AFTER_MS = 30_000;
const MAX_STRING = 2000;
const MAX_PREDICATE = 20_000;
const DEFAULT_STYLES = ['display', 'visibility', 'opacity', 'position', 'z-index', 'overflow', 'pointer-events', 'cursor', 'transform', 'color', 'background-color', 'font-size'];

/** ページの中で使う引数（JSON にしてページの関数へ埋め込む）。 */
export interface IParadisQuerySpec {
	readonly mode: 'wait' | 'text' | 'inspect' | 'scroll' | 'locate' | 'focusField' | 'selectOption' | 'setValue' | 'readField' | 'rect';
	readonly selector?: string;
	readonly role?: string;
	readonly name?: string;
	readonly text?: string;
	readonly exact?: boolean;
	readonly within?: string;
	/** evaluate の uid 引数のうち、探す要素そのもの。 */
	readonly targetIndex?: number;
	/** evaluate の uid 引数のうち、範囲の要素。 */
	readonly withinIndex?: number;
	readonly [key: string]: unknown;
}

interface ILocator {
	readonly spec: Omit<IParadisQuerySpec, 'mode'>;
	readonly uids: readonly string[];
	readonly given: boolean;
}

/**
 * evaluate_script の結果から、関数が返した値を取り出す。evaluate_script は値を JSON にして
 * ```json フェンスへ入れて返す。読めなければ undefined。
 */
export function paradisParseEvaluateValue(result: unknown): { readonly value: unknown } | undefined {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) {
		return undefined;
	}
	for (const entry of content) {
		const value = (entry as { type?: unknown; text?: unknown } | undefined);
		if (value?.type !== 'text' || typeof value.text !== 'string') {
			continue;
		}
		const match = /```json\r?\n(?<json>[\s\S]*?)\r?\n```/.exec(value.text);
		if (!match?.groups) {
			continue;
		}
		try {
			return { value: JSON.parse(match.groups.json) };
		} catch {
			continue;
		}
	}
	return undefined;
}

/** evaluate の失敗のうち、遷移・再読み込みの途中で起きる（待てば通る）もの。 */
export function paradisIsTransientEvaluateFailure(result: unknown): boolean {
	const content = (result as { content?: unknown } | undefined)?.content;
	const first = Array.isArray(content) ? content.find(item => typeof (item as { text?: unknown })?.text === 'string') as { text: string } | undefined : undefined;
	return first !== undefined && /Execution context was destroyed|Cannot find context|context with specified id|Inspected target navigated|navigat(ed|ing|ion)|Target closed|Session closed|frame was detached|Node is detached|PARA_BROWSER_RETRYABLE/i.test(first.text);
}

/**
 * ページの中で動かす関数のソースを作る。`spec` は JSON で、`predicate` はそのまま埋め込む
 * （evaluate_script と同じく、エージェントが書いた JavaScript をページで動かす）。
 */
export function paradisBuildQueryFunction(spec: IParadisQuerySpec, uidCount: number, predicate?: string): string {
	const params = Array.from({ length: uidCount }, (_, index) => `e${index}`).join(', ');
	const predicateSource = predicate === undefined ? 'undefined' : `() => (${predicate}\n)`;
	return `async (${params}) => (${PARADIS_BROWSER_QUERY_PAGE_SCRIPT})(${JSON.stringify(spec)}, [${params}], ${predicateSource})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(args: Record<string, unknown>, key: string, max = MAX_STRING): string | undefined | { error: string } {
	const value = args[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string' || value.length === 0 || value.length > max) {
		return { error: `"${key}" must be a non-empty string of at most ${max} characters.` };
	}
	return value;
}

function numberIn(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number | { error: string } {
	const value = args[key];
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
		return { error: `"${key}" must be a number from ${min} to ${max}.` };
	}
	return value;
}

function isError(value: unknown): value is { error: string } {
	return isRecord(value) && typeof value.error === 'string';
}

/** {@link paradisParseQueryLocator} が引数の誤りを返したか。 */
export function paradisIsLocatorError(value: ReturnType<typeof paradisParseQueryLocator>): value is { error: string } {
	return isError(value);
}

/** 探す要素の引数（selector / role+name / text / uid と within）を読む。 */
export function paradisParseQueryLocator(args: Record<string, unknown>): ILocator | { error: string } {
	const strings: Record<string, string | undefined> = {};
	for (const key of ['selector', 'role', 'name', 'text', 'uid', 'within', 'within_uid']) {
		const value = optionalString(args, key);
		if (isError(value)) {
			return value;
		}
		strings[key] = value;
	}
	if (args.exact !== undefined && typeof args.exact !== 'boolean') {
		return { error: '"exact" must be true or false.' };
	}
	const { selector, role, name, text: wantedText, uid, within, within_uid: withinUid } = strings;
	if (name !== undefined && role === undefined) {
		return { error: '"name" needs "role" (for example role "button" with name "Save"). To match by visible text alone, use "text".' };
	}
	if (within !== undefined && withinUid !== undefined) {
		return { error: 'Give either "within" or "within_uid", not both.' };
	}
	if (uid !== undefined) {
		if (selector !== undefined || role !== undefined || wantedText !== undefined || within !== undefined || withinUid !== undefined) {
			return { error: '"uid" already names one element; do not combine it with selector, role, text or within.' };
		}
		return { spec: { targetIndex: 0 }, uids: [uid], given: true };
	}
	const given = selector !== undefined || role !== undefined || wantedText !== undefined;
	if (!given && (within !== undefined || withinUid !== undefined)) {
		return { error: '"within" / "within_uid" only narrow a search; also give selector, role or text.' };
	}
	const spec: Record<string, unknown> = {};
	if (selector !== undefined) { spec.selector = selector; }
	if (role !== undefined) { spec.role = role; }
	if (name !== undefined) { spec.name = name; }
	if (wantedText !== undefined) { spec.text = wantedText; }
	if (args.exact === true) { spec.exact = true; }
	if (within !== undefined) { spec.within = within; }
	const uids: string[] = [];
	if (withinUid !== undefined) {
		spec.withinIndex = 0;
		uids.push(withinUid);
	}
	return { spec, uids, given };
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

/** 文字の途中（サロゲートペアの片方）で切らない。 */
function safeEnd(value: string, end: number): number {
	const code = value.charCodeAt(end - 1);
	return end > 0 && end < value.length && code >= 0xD800 && code <= 0xDBFF ? end - 1 : end;
}

export class ParadisBrowserQuery {

	constructor(
		private readonly delay: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) => new Promise<void>(resolve => {
			const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
			const onAbort = () => { clearTimeout(timer); resolve(); };
			signal?.addEventListener('abort', onAbort, { once: true });
		}),
		private readonly now: () => number = Date.now,
	) { }

	isQueryTool(name: string): boolean {
		return PARADIS_BROWSER_QUERY_TOOL_NAME_SET.has(name);
	}

	async call(call: IParadisBrowserQueryCall, name: string, rawArgs: unknown): Promise<ToolResult> {
		const args = isRecord(rawArgs) ? rawArgs : {};
		switch (name) {
			case 'wait_until': return this.waitUntil(call, args);
			case 'get_text': return this.getText(call, args);
			case 'inspect_element': return this.inspect(call, args);
			case 'scroll_to': return this.scrollTo(call, args);
			default: return error(`Unknown tool: ${name}`);
		}
	}

	/** 見ている要素をカーソルの枠で示す（演出なので、結果は何も変えない）。 */
	private look(call: IParadisBrowserQueryCall, value: Record<string, unknown>): void {
		const rect = paradisLookedAtRect(value);
		if (rect) {
			try {
				call.noteLook?.(rect);
			} catch {
				// 演出は道具の結果を変えない。
			}
		}
	}

	/** 1 回 evaluate する。値か、エージェントへ返す失敗。 */
	private async run(call: IParadisBrowserQueryCall, spec: IParadisQuerySpec, uids: readonly string[], predicate?: string): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; result: ToolResult; transient: boolean }> {
		const result = await call.evaluate(paradisBuildQueryFunction(spec, uids.length, predicate), uids);
		if (!call.isCurrent()) {
			return { ok: false, result: error(BINDING_CHANGED), transient: false };
		}
		if ((result as { isError?: unknown } | undefined)?.isError === true) {
			return { ok: false, result, transient: paradisIsTransientEvaluateFailure(result) };
		}
		const parsed = paradisParseEvaluateValue(result);
		if (!parsed || !isRecord(parsed.value)) {
			return { ok: false, result: error('PARA_BROWSER_RETRYABLE: the page did not return a readable result (it may have been navigating). Retry once.'), transient: true };
		}
		return { ok: true, value: parsed.value };
	}

	private async waitUntil(call: IParadisBrowserQueryCall, args: Record<string, unknown>): Promise<ToolResult> {
		const locator = paradisParseQueryLocator(args);
		if (isError(locator)) {
			return error(locator.error);
		}
		const predicate = optionalString(args, 'predicate', MAX_PREDICATE);
		if (isError(predicate)) {
			return error(predicate.error);
		}
		const networkIdleMs = args.network_idle_ms === undefined ? undefined : numberIn(args, 'network_idle_ms', 100, 30_000, 500);
		const maxInflight = numberIn(args, 'network_idle_max_inflight', 0, 10, 0);
		for (const value of [networkIdleMs, maxInflight]) {
			if (isError(value)) {
				return error(value.error);
			}
		}
		if (args.network_idle_max_inflight !== undefined && networkIdleMs === undefined) {
			return error('"network_idle_max_inflight" needs "network_idle_ms".');
		}
		if (!locator.given && predicate === undefined && networkIdleMs === undefined) {
			return error('wait_until needs something to wait for: a locator (selector, role + name, text or uid), a "predicate", "network_idle_ms", or a combination.');
		}
		const state = args.state ?? 'visible';
		if (state !== 'visible' && state !== 'attached' && state !== 'hidden' && state !== 'detached') {
			return error('"state" must be "visible", "attached", "hidden" or "detached".');
		}
		if (state !== 'visible' && !locator.given) {
			return error(`"state": "${state}" needs a locator (selector, role + name, text or uid).`);
		}
		const count = numberIn(args, 'count', 1, 10_000, 1);
		const timeoutSeconds = numberIn(args, 'timeout_seconds', 0.5, 120, 10);
		const intervalMs = numberIn(args, 'interval_ms', 50, 2000, 200);
		for (const value of [count, timeoutSeconds, intervalMs]) {
			if (isError(value)) {
				return error(value.error);
			}
		}
		const startedAt = this.now();
		const deadline = startedAt + (timeoutSeconds as number) * 1000;
		let last: Record<string, unknown> | undefined;
		let lastFailure: ToolResult | undefined;
		let checks = 0;
		let lastNetwork: IParadisNetworkActivitySnapshot | undefined;
		/** 通信が静かか。network idle を頼まれていなければ常に true。 */
		const networkIdle = (): boolean => {
			if (networkIdleMs === undefined) {
				return true;
			}
			lastNetwork = call.networkActivity?.(PARADIS_NETWORK_IDLE_IGNORE_AFTER_MS);
			// まだ何も数えていない（台帳が無い・要求を 1 つも見ていない）ときは、待ち始めてからの時間で測る
			const quietMs = lastNetwork?.quietMs ?? (this.now() - startedAt);
			return (lastNetwork?.inflight ?? 0) <= (maxInflight as number) && quietMs >= (networkIdleMs as number);
		};
		for (; ;) {
			if (call.signal?.aborted) {
				return error('wait_until was cancelled.');
			}
			const remaining = deadline - this.now();
			const sliceMs = Math.max(0, Math.min(PARADIS_WAIT_UNTIL_SLICE_MS, remaining));
			const spec: IParadisQuerySpec = { ...locator.spec, mode: 'wait', state, count: Math.floor(count as number), sliceMs, intervalMs };
			const outcome = await this.run(call, spec, locator.uids, predicate);
			checks++;
			if (outcome.ok) {
				last = outcome.value;
				if (locator.given) {
					this.look(call, outcome.value);
				}
				lastFailure = undefined;
				if (outcome.value.met === true) {
					if (networkIdle()) {
						const elapsed = ((this.now() - startedAt) / 1000).toFixed(1);
						const network = networkIdleMs !== undefined ? { network: { inflight: lastNetwork?.inflight ?? 0, quietMs: lastNetwork?.quietMs, ...(lastNetwork?.longLived ? { longLivedIgnored: lastNetwork.longLived } : {}), ...(lastNetwork?.quietMs === undefined ? { observed: false, note: 'Para Code has not seen any request of this tab yet (requests are counted only while the browser tools are connected), so the quiet time was measured from the start of wait_until.' } : {}) } } : {};
						return text(`Condition met after ${elapsed}s.\n${JSON.stringify({ ...outcome.value, ...network }, null, 2)}`);
					}
					if (this.now() >= deadline) {
						break;
					}
					// 要素・述語は満たしたが通信がまだ。ページの関数はすぐ返るので、ここで間を空ける
					await this.delay(Math.min(intervalMs as number, Math.max(0, deadline - this.now())), call.signal);
					if (!call.isCurrent()) {
						return error(BINDING_CHANGED);
					}
					continue;
				}
			} else if (!outcome.transient) {
				return outcome.result;
			} else {
				lastFailure = outcome.result;
			}
			if (this.now() >= deadline) {
				break;
			}
			if (!outcome.ok) {
				// 遷移の途中。次のページが読めるまで少し待つ。
				await this.delay(Math.min(intervalMs as number, Math.max(0, deadline - this.now())), call.signal);
				if (!call.isCurrent()) {
					return error(BINDING_CHANGED);
				}
			}
		}
		const what = [locator.given ? `${state} ${describeLocator(args)}` : '', predicate !== undefined ? 'predicate truthy' : '', networkIdleMs !== undefined ? `network idle for ${networkIdleMs}ms` : ''].filter(Boolean).join(' and ');
		const network = lastNetwork !== undefined ? `\nNetwork at the last check: ${lastNetwork.inflight} request(s) in flight${lastNetwork.pendingUrls.length > 0 ? ` (${lastNetwork.pendingUrls.join(', ')})` : ''}, quiet for ${lastNetwork.quietMs ?? 0}ms.` : '';
		const seen = (last !== undefined ? `\nLast check: ${JSON.stringify(last, null, 2)}` : lastFailure !== undefined ? '\nThe page was still navigating or reloading at the last check.' : '') + network;
		return error(`Timed out after ${timeoutSeconds}s waiting for ${what} (${checks} checks).${seen}`);
	}

	private async getText(call: IParadisBrowserQueryCall, args: Record<string, unknown>): Promise<ToolResult> {
		const locator = paradisParseQueryLocator(args);
		if (isError(locator)) {
			return error(locator.error);
		}
		if (args.all !== undefined && typeof args.all !== 'boolean') {
			return error('"all" must be true or false.');
		}
		const maxChars = numberIn(args, 'max_chars', 100, 50_000, 4000);
		const offset = numberIn(args, 'offset', 0, Number.MAX_SAFE_INTEGER, 0);
		for (const value of [maxChars, offset]) {
			if (isError(value)) {
				return error(value.error);
			}
		}
		const start = Math.floor(offset as number);
		const spec: IParadisQuerySpec = { ...locator.spec, mode: 'text', all: args.all === true, offset: start, maxChars: Math.floor(maxChars as number) + 1 };
		const outcome = await this.run(call, spec, locator.uids);
		if (!outcome.ok) {
			return outcome.result;
		}
		const value = outcome.value;
		if (locator.given) {
			this.look(call, value);
		}
		if (value.withinMissing === true) {
			return error(`Nothing matches the container (${describeLocator({ within: args.within, within_uid: args.within_uid })}).`);
		}
		if (locator.given && value.matched === 0) {
			return error(`No element matches ${describeLocator(args)}. Check with take_snapshot, or wait for it with wait_until.`);
		}
		const total = typeof value.total === 'number' ? value.total : 0;
		const raw = typeof value.part === 'string' ? value.part : '';
		const part = raw.slice(0, safeEnd(raw, Math.min(raw.length, maxChars as number)));
		const end = start + part.length;
		const head = locator.given
			? `${value.matched} element(s) matched${args.all === true ? `, ${value.returned} returned` : ''}.${value.element !== undefined ? ` Element: ${JSON.stringify(value.element)}` : ''}`
			: 'Text of the whole page.';
		const range = total === 0
			? 'The text is empty.'
			: end < total
				? `Showing characters ${start}-${end} of ${total}. Call get_text again with "offset": ${end} for the next part.`
				: `Showing characters ${start}-${end} of ${total} (end).`;
		if (start > 0 && start >= total && total > 0) {
			return error(`"offset" ${start} is past the end of the text (${total} characters).`);
		}
		return text(`${head}\n${range}\n\n${part}`);
	}

	private async inspect(call: IParadisBrowserQueryCall, args: Record<string, unknown>): Promise<ToolResult> {
		const locator = paradisParseQueryLocator(args);
		if (isError(locator)) {
			return error(locator.error);
		}
		if (!locator.given) {
			return error('inspect_element needs a locator: uid (from take_snapshot), selector, role + name, or text.');
		}
		let styles = DEFAULT_STYLES;
		if (args.styles !== undefined) {
			if (!Array.isArray(args.styles) || args.styles.length > 40 || args.styles.some(style => typeof style !== 'string' || !/^-{0,2}[a-zA-Z][a-zA-Z0-9-]{0,80}$/.test(style))) {
				return error('"styles" must be a list of at most 40 CSS property names, for example ["display", "z-index"].');
			}
			styles = args.styles as string[];
		}
		const index = numberIn(args, 'index', 0, 10_000, 0);
		if (isError(index)) {
			return error(index.error);
		}
		const spec: IParadisQuerySpec = { ...locator.spec, mode: 'inspect', styles, index: Math.floor(index) };
		const outcome = await this.run(call, spec, locator.uids);
		if (!outcome.ok) {
			return outcome.result;
		}
		const value = outcome.value;
		if (value.withinMissing === true) {
			return error(`Nothing matches the container (${describeLocator({ within: args.within, within_uid: args.within_uid })}).`);
		}
		if (value.notFound === true) {
			return error(value.matched === 0
				? `No element matches ${describeLocator(args)}. Check with take_snapshot, or wait for it with wait_until.`
				: `Only ${value.matched} element(s) match, so there is no index ${index}.`);
		}
		this.look(call, value);
		return text(JSON.stringify(value, null, 2));
	}

	private async scrollTo(call: IParadisBrowserQueryCall, args: Record<string, unknown>): Promise<ToolResult> {
		const locator = paradisParseQueryLocator(args);
		if (isError(locator)) {
			return error(locator.error);
		}
		if (!locator.given) {
			return error('scroll_to needs the element to look for: selector, role + name, text or uid.');
		}
		const container = optionalString(args, 'container');
		if (isError(container)) {
			return error(container.error);
		}
		const direction = args.direction ?? 'down';
		if (direction !== 'down' && direction !== 'up' && direction !== 'right' && direction !== 'left') {
			return error('"direction" must be "down", "up", "right" or "left".');
		}
		if (args.from_start !== undefined && typeof args.from_start !== 'boolean') {
			return error('"from_start" must be true or false.');
		}
		const stepPx = numberIn(args, 'step_px', 1, 100_000, 0);
		const maxSteps = numberIn(args, 'max_steps', 1, 200, 40);
		const settleMs = numberIn(args, 'settle_ms', 0, 3000, 250);
		for (const value of [stepPx, maxSteps, settleMs]) {
			if (isError(value)) {
				return error(value.error);
			}
		}
		const base = { ...locator.spec, mode: 'scroll' as const, direction, stepPx, ...(container !== undefined ? { container } : {}) };
		if (args.from_start === true) {
			const reset = await this.run(call, { ...base, reset: true }, locator.uids);
			if (!reset.ok) {
				return reset.result;
			}
			if (reset.value.containerMissing === true) {
				return error(`No element matches "container" ${JSON.stringify(container)}.`);
			}
			await this.delay(settleMs as number, call.signal);
			if (!call.isCurrent()) {
				return error(BINDING_CHANGED);
			}
		}
		let scrolled = 0;
		let steps = 0;
		let lastContainer: unknown;
		for (; ;) {
			if (call.signal?.aborted) {
				return error('scroll_to was cancelled.');
			}
			const atLimit = steps >= (maxSteps as number);
			const outcome = await this.run(call, { ...base, checkOnly: atLimit }, locator.uids);
			if (!outcome.ok) {
				return outcome.result;
			}
			const value = outcome.value;
			if (value.containerMissing === true) {
				return error(`No element matches "container" ${JSON.stringify(container)}.`);
			}
			if (value.withinMissing === true) {
				return error(`Nothing matches the container (${describeLocator({ within: args.within, within_uid: args.within_uid })}).`);
			}
			lastContainer = value.container;
			if (value.found === true) {
				this.look(call, value);
				return text(`Found after ${steps} scroll step(s) (${scrolled}px) in ${String(value.container)}, and scrolled it into view.\n${JSON.stringify({ matched: value.matched, element: value.element }, null, 2)}`);
			}
			const moved = typeof value.moved === 'number' ? value.moved : 0;
			if (atLimit) {
				return error(`Not found after ${steps} scroll step(s) (${scrolled}px) in ${String(lastContainer)}. Raise max_steps, give "container", or check the locator with take_snapshot.`);
			}
			if (moved === 0) {
				// 端に着いた。描画を待ってから最後にもう一度だけ探す。
				await this.delay(settleMs as number, call.signal);
				if (!call.isCurrent()) {
					return error(BINDING_CHANGED);
				}
				const final = await this.run(call, { ...base, checkOnly: true }, locator.uids);
				if (final.ok && final.value.found === true) {
					this.look(call, final.value);
					return text(`Found at the end of ${String(final.value.container)} after ${steps} scroll step(s) (${scrolled}px), and scrolled it into view.\n${JSON.stringify({ matched: final.value.matched, element: final.value.element }, null, 2)}`);
				}
				return error(`Not found: reached the ${direction === 'up' || direction === 'left' ? 'start' : 'end'} of ${String(lastContainer)} after ${steps} scroll step(s) (${scrolled}px). Try "from_start": true, the other direction, or give "container" if the wrong area was scrolled.`);
			}
			steps++;
			scrolled += Math.abs(moved);
			await this.delay(settleMs as number, call.signal);
			if (!call.isCurrent()) {
				return error(BINDING_CHANGED);
			}
		}
	}
}
