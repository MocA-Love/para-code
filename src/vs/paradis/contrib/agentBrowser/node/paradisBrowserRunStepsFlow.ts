/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// run_steps を小さな手順書にする（para-browser-improvement.html の E6、設定 `paradis.agentBrowser.runStepsFlow`。既定は無効）。
// 今の run_steps（paradisBrowserRunSteps.ts）に次を足す:
//   - 前の手順の結果の参照（`$3.text`・`$3.items`、for_each の中の `$item`・`$index`）
//   - expect（文字が出る・消える・要素が見える・消える・押せる・押せない・URL・JavaScript の条件を、上限まで待って確かめる）
//   - sleep_ms（決まった時間だけ待つ。evaluate_script の中の setTimeout の代わり）
//   - for_each（一覧の項目ごとに同じ手順）・repeat_until（条件が成り立つまで同じ手順。ページ送り）
// 道具の手順は、今の run_steps と同じくサービスの通常の呼び出しへ渡す（確認・入力の通り道は単体で呼んだときと同じ）。
//
// 決め事:
// - 実行する手順は全部で {@link PARADIS_RUN_STEPS_FLOW_MAX_EXECUTED} まで、時間は既定 240 秒（MCP の 300 秒未満）まで
// - 入れ子は 2 段まで。repeat_until は回す前に条件を確かめる（成り立っていれば 1 回も回さない）
// - expect が成り立たなければ、その手順の失敗として止まる（continue_on_error で続ける）
// - スクリプト（evaluate_script の function、predicate）の中の参照は、値に置き換えずに推測できない名前の識別子に
//   置き換え、値は外側の包みの const で束縛する。値は一度もコードとして読まれないので、参照が文字列やコメントの
//   中にあっても注入にならない（その場合は名前の文字が入るだけ）。包めない initScript の中の参照は断る

import { generateUuid } from '../../../../base/common/uuid.js';
import { PARADIS_RUN_STEPS_ALLOWED_TOOLS } from './paradisBrowserRunSteps.js';

/** 実行する手順（ループの中の繰り返しを含む）の合計の上限。 */
export const PARADIS_RUN_STEPS_FLOW_MAX_EXECUTED = 200;
/** 1 つの列（いちばん外、または for_each / repeat_until の steps）に書ける手順の数。 */
const MAX_STEPS_PER_BLOCK = 50;
const MAX_DEPTH = 2;
/** 全体の時間の既定と上限（MCP の道具の上限 300 秒より短く）。 */
const DEFAULT_MAX_SECONDS = 240;
const MAX_MAX_SECONDS = 280;
const DEFAULT_EXPECT_MS = 5000;
const MAX_EXPECT_MS = 60_000;
const MAX_SLEEP_MS = 10_000;
const DEFAULT_ROUNDS = 20;
const MAX_ROUNDS = 100;
/** 1 つの手順の文字の結果のうち、まとめに残す長さと、まとめ全体の長さ。 */
const MAX_STEP_TEXT = 6000;
const MAX_TOTAL_TEXT = 60_000;
const MAX_TOTAL_IMAGES = 10;
/** 参照（`$3.text`）で差し込む文字の長さ。 */
const MAX_REFERENCE_TEXT = 4000;
/** 条件を道具で確かめ直す間隔（expect の disabled / enabled）。 */
const POLL_MS = 250;

const LOCATOR_KEYS = ['selector', 'role', 'name', 'text', 'exact'] as const;

/** 1 回の run_steps でサービスから借りるもの。 */
export interface IParadisRunStepsFlowCall {
	readonly signal?: AbortSignal;
	callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
	now?(): number;
	sleep?(ms: number): Promise<void>;
}

type Locator = Readonly<Record<string, unknown>>;

/** 条件。どれか 1 つ。 */
type Condition =
	| { readonly kind: 'text' | 'text_gone' | 'url_includes' | 'predicate'; readonly value: string }
	| { readonly kind: 'visible' | 'gone' | 'disabled' | 'enabled'; readonly locator: Locator };

type FlowStep =
	| { readonly kind: 'tool'; readonly tool: string; readonly args: Record<string, unknown> }
	| { readonly kind: 'expect'; readonly condition: Condition; readonly timeoutMs: number }
	| { readonly kind: 'sleep'; readonly ms: number }
	| { readonly kind: 'for_each'; readonly source: unknown; readonly steps: readonly FlowStep[]; readonly max: number }
	| { readonly kind: 'repeat_until'; readonly condition: Condition; readonly steps: readonly FlowStep[]; readonly max: number };

interface IContentItem {
	readonly type: string;
	readonly text?: string;
	readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(message: string): unknown {
	return { content: [{ type: 'text', text: message }], isError: true };
}

const CONDITION_KEYS = ['text', 'text_gone', 'url_includes', 'predicate', 'visible', 'gone', 'disabled', 'enabled'] as const;

function parseCondition(raw: unknown, where: string): Condition | string {
	if (!isRecord(raw)) {
		return `${where} must be an object with one of: ${CONDITION_KEYS.join(', ')}.`;
	}
	const keys = Object.keys(raw).filter(key => (CONDITION_KEYS as readonly string[]).includes(key));
	const extra = Object.keys(raw).filter(key => !(CONDITION_KEYS as readonly string[]).includes(key) && key !== 'timeout_ms');
	if (keys.length !== 1 || extra.length > 0) {
		return `${where} must have exactly one of: ${CONDITION_KEYS.join(', ')}${extra.length > 0 ? ` (unknown: ${extra.join(', ')})` : ''}.`;
	}
	const kind = keys[0] as typeof CONDITION_KEYS[number];
	const value = raw[kind];
	if (kind === 'text' || kind === 'text_gone' || kind === 'url_includes' || kind === 'predicate') {
		if (typeof value !== 'string' || value.length === 0 || value.length > 2000) {
			return `${where}: "${kind}" must be a non-empty string.`;
		}
		return { kind, value };
	}
	if (!isRecord(value) || !LOCATOR_KEYS.some(key => value[key] !== undefined) || Object.keys(value).some(key => !(LOCATOR_KEYS as readonly string[]).includes(key))) {
		return `${where}: "${kind}" must be a locator such as {"role": "button", "name": "Next"} or {"selector": "..."} (keys: ${LOCATOR_KEYS.join(', ')}).`;
	}
	return { kind, locator: value };
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number | undefined {
	if (value === undefined) {
		return fallback;
	}
	return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : undefined;
}

function parseBlock(raw: unknown, depth: number, where: string): FlowStep[] | string {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STEPS_PER_BLOCK) {
		return `${where} must be a list of 1 to ${MAX_STEPS_PER_BLOCK} steps.`;
	}
	const steps: FlowStep[] = [];
	for (const [index, step] of raw.entries()) {
		const at = `${where} step ${index + 1}`;
		if (!isRecord(step)) {
			return `${at} must be an object.`;
		}
		if (typeof step.tool === 'string') {
			if (step.args !== undefined && !isRecord(step.args)) {
				return `${at}: "args" must be an object.`;
			}
			if (!PARADIS_RUN_STEPS_ALLOWED_TOOLS.has(step.tool)) {
				return `${at}: "${step.tool}" cannot be used in run_steps. Allowed: ${[...PARADIS_RUN_STEPS_ALLOWED_TOOLS].join(', ')}.`;
			}
			const initScript = isRecord(step.args) ? step.args.initScript : undefined;
			if (step.tool === 'navigate_page' && typeof initScript === 'string' && [...initScript.matchAll(REFERENCE_PATTERN)].some(match => match[0] !== '$$')) {
				// initScript は包むと var や関数の宣言の意味が変わるので、値を束縛して渡せない
				return `${at}: references such as $2.text cannot be used in "initScript". Pass the value in a later evaluate_script instead.`;
			}
			steps.push({ kind: 'tool', tool: step.tool, args: (step.args ?? {}) as Record<string, unknown> });
		} else if (step.expect !== undefined) {
			const condition = parseCondition(step.expect, `${at} "expect"`);
			if (typeof condition === 'string') {
				return condition;
			}
			const timeoutMs = boundedInteger((step.expect as Record<string, unknown>).timeout_ms, 0, MAX_EXPECT_MS, DEFAULT_EXPECT_MS);
			if (timeoutMs === undefined) {
				return `${at}: "expect.timeout_ms" must be 0-${MAX_EXPECT_MS}.`;
			}
			steps.push({ kind: 'expect', condition, timeoutMs });
		} else if (step.sleep_ms !== undefined) {
			const ms = boundedInteger(step.sleep_ms, 0, MAX_SLEEP_MS, 0);
			if (ms === undefined) {
				return `${at}: "sleep_ms" must be 0-${MAX_SLEEP_MS}.`;
			}
			steps.push({ kind: 'sleep', ms });
		} else if (step.for_each !== undefined || step.repeat_until !== undefined) {
			if (depth >= MAX_DEPTH) {
				return `${at}: loops can be nested only ${MAX_DEPTH} deep.`;
			}
			const max = boundedInteger(step.max, 1, MAX_ROUNDS, step.for_each !== undefined ? 50 : DEFAULT_ROUNDS);
			if (max === undefined) {
				return `${at}: "max" must be 1-${MAX_ROUNDS}.`;
			}
			const inner = parseBlock(step.steps, depth + 1, `${at} "steps"`);
			if (typeof inner === 'string') {
				return inner;
			}
			if (step.for_each !== undefined) {
				if (!Array.isArray(step.for_each) && typeof step.for_each !== 'string') {
					return `${at}: "for_each" must be a list or a reference such as "$3.items".`;
				}
				steps.push({ kind: 'for_each', source: step.for_each, steps: inner, max });
			} else {
				const condition = parseCondition(step.repeat_until, `${at} "repeat_until"`);
				if (typeof condition === 'string') {
					return condition;
				}
				steps.push({ kind: 'repeat_until', condition, steps: inner, max });
			}
		} else {
			return `${at} must have "tool", "expect", "sleep_ms", "for_each" or "repeat_until".`;
		}
	}
	return steps;
}

/** 引数を確かめて、手順の木にする。 */
export function paradisParseRunStepsFlow(rawArgs: unknown): { readonly ok: true; readonly steps: readonly FlowStep[]; readonly continueOnError: boolean; readonly maxMs: number } | { readonly ok: false; readonly error: string } {
	const args = isRecord(rawArgs) ? rawArgs : {};
	if (args.continue_on_error !== undefined && typeof args.continue_on_error !== 'boolean') {
		return { ok: false, error: '"continue_on_error" must be true or false.' };
	}
	const maxSeconds = boundedInteger(args.max_seconds, 1, MAX_MAX_SECONDS, DEFAULT_MAX_SECONDS);
	if (maxSeconds === undefined) {
		return { ok: false, error: `"max_seconds" must be 1-${MAX_MAX_SECONDS}.` };
	}
	const steps = parseBlock(args.steps, 0, '"steps"');
	if (typeof steps === 'string') {
		return { ok: false, error: steps };
	}
	return { ok: true, steps, continueOnError: args.continue_on_error === true, maxMs: maxSeconds * 1000 };
}

// --- 結果の参照 --------------------------------------------------------------------------------

/** 道具の結果の文字（text の部分を改行でつなぐ）。 */
function resultText(result: unknown): string {
	const items = isRecord(result) && Array.isArray(result.content) ? result.content as IContentItem[] : [];
	return items.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text as string).join('\n');
}

/**
 * 参照で使う形にする。get_text は見出しの 2 行を除いた本文、all のときは一致ごとの文字を items にする。
 * ほかの道具は結果の文字そのまま、items は空でない行。
 */
export function paradisRunStepsReference(tool: string, result: unknown): { readonly text: string; readonly items: readonly string[] } {
	const raw = resultText(result);
	if (tool === 'get_text') {
		const body = raw.includes('\n\n') ? raw.slice(raw.indexOf('\n\n') + 2) : raw;
		if (/^\[0\] /.test(body)) {
			// all: true の形（"[0] ラベル\n文字\n\n[1] ラベル\n文字"）
			const items = body.split(/\n\n(?=\[\d+\] )/).map(block => block.slice(block.indexOf('\n') + 1).trim()).filter(item => item.length > 0);
			return { text: items.join('\n'), items };
		}
		const text = body.trim();
		return { text, items: text.split('\n').map(line => line.trim()).filter(line => line.length > 0) };
	}
	const text = raw.trim();
	return { text, items: text.split('\n').map(line => line.trim()).filter(line => line.length > 0) };
}

export interface IScope {
	readonly results: Map<number, { readonly text: string; readonly items: readonly string[] }>;
	readonly item?: string;
	readonly index?: number;
}

const REFERENCE_PATTERN = /\$\$|\$(\d+)\.(text|items)\b|\$item\b|\$index\b/g;

/**
 * 文字の中の参照を差し込む。`$$` は `$`。知らない番号は残す（手順は失敗として止める）。
 * `script` のとき（evaluate_script の function、wait_until・expect・repeat_until の predicate）は、値を
 * JavaScript の文字の値（`JSON.stringify`）として入れる。値はページが自由に書ける文字なので、そのまま埋めると
 * 別のページのスクリプトとして動いてしまう。
 */
/** 文字の中の参照を、`insert` が返す文字に置き換える（`$$` は `$`、`$index` は数）。 */
function substitute(value: string, scope: IScope, missing: string[], insert: (text: string) => string = text => text): string {
	return value.replace(REFERENCE_PATTERN, (match, step: string | undefined, field: string | undefined) => {
		if (match === '$$') {
			return '$';
		}
		if (match === '$item') {
			if (scope.item === undefined) {
				missing.push('$item (only inside for_each)');
				return match;
			}
			return insert(scope.item);
		}
		if (match === '$index') {
			if (scope.index === undefined) {
				missing.push('$index (only inside for_each)');
				return match;
			}
			return String(scope.index);
		}
		const ref = scope.results.get(Number(step));
		if (!ref) {
			missing.push(match);
			return match;
		}
		return insert((field === 'items' ? ref.items.join(', ') : ref.text).slice(0, MAX_REFERENCE_TEXT));
	});
}

function substituteDeep(value: unknown, scope: IScope, missing: string[]): unknown {
	if (typeof value === 'string') {
		return substitute(value, scope, missing);
	}
	if (Array.isArray(value)) {
		return value.map(item => substituteDeep(item, scope, missing));
	}
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteDeep(item, scope, missing)]));
	}
	return value;
}

/** 道具の引数のうち、関数を受け取るスクリプトの引数（参照を束縛して包める）。 */
const SCRIPT_ARGUMENTS: Readonly<Record<string, readonly string[]>> = { evaluate_script: ['function'], wait_until: ['predicate'] };

/**
 * 関数のスクリプトの中の参照を、推測できない名前の識別子に置き換え、値はその外側の包みの const で束縛する。
 * 例: `() => document.title === $2.text` は
 * `(...a) => { const __paraRef_<nonce>_0 = "値"; return (() => document.title === __paraRef_<nonce>_0)(...a); }` になる。
 */
function bindScriptReferences(source: string, scope: IScope, missing: string[]): string {
	const nonce = generateUuid().replace(/-/g, '').slice(0, 12);
	const bindings: string[] = [];
	const body = substitute(source, scope, missing, text => {
		const name = `__paraRef_${nonce}_${bindings.length}`;
		bindings.push(`const ${name} = ${JSON.stringify(text)};`);
		return name;
	});
	if (bindings.length === 0) {
		return body;
	}
	const rest = `__paraArgs_${nonce}`;
	return `(...${rest}) => { ${bindings.join(' ')} return (${body})(...${rest}); }`;
}

/** 道具の引数に参照を差し込む（関数のスクリプトの引数では、値を束縛して包む）。 */
export function paradisSubstituteRunStepsArgs(tool: string, args: Record<string, unknown>, scope: IScope, missing: string[]): Record<string, unknown> {
	return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, SCRIPT_ARGUMENTS[tool]?.includes(key) && typeof value === 'string' ? bindScriptReferences(value, scope, missing) : substituteDeep(value, scope, missing)]));
}

// --- 実行 ----------------------------------------------------------------------------------------

class FlowRun {
	readonly content: IContentItem[] = [];
	executed = 0;
	failed = 0;
	images = 0;
	textLength = 0;
	stopped: string | undefined;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly deadline: number;

	constructor(private readonly call: IParadisRunStepsFlowCall, private readonly continueOnError: boolean, maxMs: number) {
		this.now = call.now ?? Date.now;
		this.sleep = call.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
		this.deadline = this.now() + maxMs;
	}

	private push(text: string): void {
		if (this.textLength >= MAX_TOTAL_TEXT) {
			return;
		}
		const room = MAX_TOTAL_TEXT - this.textLength;
		const kept = text.length > room ? `${text.slice(0, room)}\n... (run_steps output limit reached; later step results are left out)` : text;
		this.textLength += kept.length;
		this.content.push({ type: 'text', text: kept });
	}

	/** 手順を 1 つ動かす前に、止める理由が無いかを見る。 */
	private canRun(): boolean {
		if (this.stopped !== undefined) {
			return false;
		}
		if (this.call.signal?.aborted) {
			this.stopped = 'run_steps was cancelled.';
		} else if (this.executed >= PARADIS_RUN_STEPS_FLOW_MAX_EXECUTED) {
			this.stopped = `run_steps stopped after ${PARADIS_RUN_STEPS_FLOW_MAX_EXECUTED} executed steps (the limit).`;
		} else if (this.now() >= this.deadline) {
			this.stopped = 'run_steps stopped at its time limit (max_seconds).';
		}
		return this.stopped === undefined;
	}

	private remainingMs(): number {
		return Math.max(0, this.deadline - this.now());
	}

	/** 待つ道具の待ちの上限を、残りの時間で切る（手順の間だけでなく、待っている途中でも締め切りを守る）。 */
	private clipWait(tool: string, args: Record<string, unknown>): Record<string, unknown> {
		const remaining = this.remainingMs();
		if (tool === 'wait_until') {
			const asked = typeof args.timeout_seconds === 'number' ? args.timeout_seconds : 10;
			return { ...args, timeout_seconds: Math.max(0.5, Math.min(asked, remaining / 1000)) };
		}
		if (tool === 'wait_for') {
			const asked = typeof args.timeout === 'number' ? args.timeout : 5000;
			return { ...args, timeout: Math.max(500, Math.min(asked, remaining)) };
		}
		return args;
	}

	/** 手順の結果を書き、失敗なら止めるかを決める。@returns 続けてよいか。 */
	private record(label: string, ok: boolean, result: unknown): boolean {
		this.push(`--- ${label} ${ok ? 'ok' : 'FAILED'}`);
		const items = isRecord(result) && Array.isArray(result.content) ? result.content as IContentItem[] : [];
		for (const item of items) {
			if (item.type === 'text' && typeof item.text === 'string') {
				this.push(item.text.length > MAX_STEP_TEXT ? `${item.text.slice(0, MAX_STEP_TEXT)}\n... (cut; run the step alone for the full text)` : item.text);
			} else if (item.type === 'image') {
				if (this.images < MAX_TOTAL_IMAGES) {
					this.content.push(item);
				}
				this.images++;
			} else {
				this.content.push(item);
			}
		}
		if (!ok) {
			this.failed++;
			if (!this.continueOnError) {
				this.stopped = `run_steps stopped at the first failure (${label}).`;
				return false;
			}
		}
		return true;
	}

	/** 列を順に動かす。`top` はいちばん外の列か（そのときだけ結果を `$N` で参照できるよう残す）。 */
	async runBlock(steps: readonly FlowStep[], scope: IScope, prefix: string, top: boolean): Promise<void> {
		for (const [index, step] of steps.entries()) {
			if (!this.canRun()) {
				return;
			}
			const label = `Step ${prefix}${index + 1}`;
			const number = index + 1;
			switch (step.kind) {
				case 'tool': {
					const missing: string[] = [];
					const args = this.clipWait(step.tool, paradisSubstituteRunStepsArgs(step.tool, step.args, scope, missing));
					this.executed++;
					if (missing.length > 0) {
						this.record(`${label}: ${step.tool}`, false, failure(`Unknown reference: ${missing.join(', ')}. Refer to an earlier top-level step as $<number>.text or $<number>.items, and to the current item as $item / $index inside for_each.`));
						break;
					}
					const result = await this.call.callTool(step.tool, args);
					const ok = !(isRecord(result) && result.isError === true);
					if (top && ok) {
						scope.results.set(number, paradisRunStepsReference(step.tool, result));
					}
					this.record(`${label}: ${step.tool}`, ok, result);
					break;
				}
				case 'expect': {
					this.executed++;
					const condition = substituteCondition(step.condition, scope);
					const startedAt = this.now();
					const met = await this.waitFor(condition, Math.min(step.timeoutMs, this.remainingMs()));
					const seconds = ((this.now() - startedAt) / 1000).toFixed(1);
					this.record(`${label}: expect ${describeCondition(condition)}`, met.ok, { content: [{ type: 'text', text: met.ok ? `Met after ${seconds} s.` : `Not met within ${(step.timeoutMs / 1000).toFixed(1)} s.${met.detail ? ` ${met.detail}` : ''}` }] });
					break;
				}
				case 'sleep': {
					this.executed++;
					await this.sleep(Math.min(step.ms, this.remainingMs()));
					this.push(`--- ${label}: sleep_ms ${step.ms} ok`);
					break;
				}
				case 'for_each': {
					const items = resolveList(step.source, scope);
					if (typeof items === 'string') {
						this.executed++;
						this.record(`${label}: for_each`, false, failure(items));
						break;
					}
					const rounds = items.slice(0, step.max);
					this.push(`--- ${label}: for_each over ${rounds.length} item(s)${items.length > rounds.length ? ` (of ${items.length}; "max" is ${step.max})` : ''}`);
					for (const [itemIndex, item] of rounds.entries()) {
						if (!this.canRun()) {
							break;
						}
						this.push(`--- ${label} item ${itemIndex + 1}/${rounds.length}: ${JSON.stringify(item.slice(0, 120))}`);
						await this.runBlock(step.steps, { results: scope.results, item, index: itemIndex }, `${prefix}${index + 1}.`, false);
					}
					break;
				}
				case 'repeat_until': {
					const condition = substituteCondition(step.condition, scope);
					let rounds = 0;
					let met = false;
					while (this.canRun()) {
						// 回す前に確かめる（もう成り立っていれば回さない）
						met = await this.check(condition);
						if (met || rounds >= step.max) {
							break;
						}
						rounds++;
						this.push(`--- ${label} round ${rounds}`);
						await this.runBlock(step.steps, scope, `${prefix}${index + 1}.`, false);
					}
					if (this.stopped === undefined) {
						this.record(`${label}: repeat_until ${describeCondition(condition)}`, met, { content: [{ type: 'text', text: met ? `Met after ${rounds} round(s).` : `Not met after ${rounds} round(s) ("max" is ${step.max}).` }] });
					}
					break;
				}
			}
		}
	}

	/** 条件を今 1 回だけ確かめる（待たない）。 */
	async check(condition: Condition): Promise<boolean> {
		switch (condition.kind) {
			case 'text':
			case 'text_gone': {
				const result = await this.call.callTool('get_text', { text: condition.value, max_chars: 100 });
				const present = !(isRecord(result) && result.isError === true);
				return condition.kind === 'text' ? present : !present;
			}
			case 'url_includes':
			case 'predicate': {
				const result = await this.call.callTool('wait_until', { predicate: conditionPredicate(condition), timeout_seconds: 0.5 });
				return !(isRecord(result) && result.isError === true);
			}
			default: {
				const result = await this.call.callTool('inspect_element', { ...condition.locator });
				if (isRecord(result) && result.isError === true) {
					// 一致しない: 消えた・押せない（ページ送りの「次へ」が無くなった）とみなす
					return condition.kind === 'gone' || condition.kind === 'disabled';
				}
				let value: Record<string, unknown> = {};
				try {
					const parsed: unknown = JSON.parse(resultText(result));
					value = isRecord(parsed) ? parsed : {};
				} catch {
					value = {};
				}
				switch (condition.kind) {
					case 'visible': return value.visible === true;
					case 'gone': return value.visible !== true;
					case 'disabled': return value.enabled === false;
					case 'enabled': return value.enabled === true;
				}
			}
		}
	}

	/** 条件が成り立つまで待つ。文字・要素・URL・条件は wait_until に任せ、押せる・押せないは道具で確かめ直す。 */
	private async waitFor(condition: Condition, timeoutMs: number): Promise<{ readonly ok: boolean; readonly detail?: string }> {
		if (condition.kind === 'disabled' || condition.kind === 'enabled') {
			const until = this.now() + timeoutMs;
			for (; ;) {
				if (await this.check(condition)) {
					return { ok: true };
				}
				if (this.now() >= until || this.call.signal?.aborted) {
					return { ok: false };
				}
				await this.sleep(POLL_MS);
			}
		}
		if (timeoutMs < 500) {
			// wait_until は 0.5 秒より短く待てないので、今 1 回だけ確かめる
			return { ok: await this.check(condition) };
		}
		const args: Record<string, unknown> = { timeout_seconds: timeoutMs / 1000 };
		switch (condition.kind) {
			case 'text': Object.assign(args, { text: condition.value, state: 'visible' }); break;
			case 'text_gone': Object.assign(args, { text: condition.value, state: 'hidden' }); break;
			case 'visible': Object.assign(args, { ...condition.locator, state: 'visible' }); break;
			case 'gone': Object.assign(args, { ...condition.locator, state: 'hidden' }); break;
			default: args.predicate = conditionPredicate(condition);
		}
		const result = await this.call.callTool('wait_until', args);
		const ok = !(isRecord(result) && result.isError === true);
		return ok ? { ok } : { ok, detail: resultText(result).slice(0, 500) };
	}
}

function conditionPredicate(condition: Condition): string {
	if (condition.kind === 'url_includes') {
		return `() => location.href.includes(${JSON.stringify(condition.value)})`;
	}
	return condition.kind === 'predicate' ? condition.value : '() => false';
}

/** 文字で書く条件か（ほかは要素の指定で書く）。 */
function isValueCondition(condition: Condition): condition is Extract<Condition, { readonly value: string }> {
	return condition.kind === 'text' || condition.kind === 'text_gone' || condition.kind === 'url_includes' || condition.kind === 'predicate';
}

function substituteCondition(condition: Condition, scope: IScope): Condition {
	const missing: string[] = [];
	if (isValueCondition(condition)) {
		return { kind: condition.kind, value: condition.kind === 'predicate' ? bindScriptReferences(condition.value, scope, missing) : substitute(condition.value, scope, missing) };
	}
	return { kind: condition.kind, locator: substituteDeep(condition.locator, scope, missing) as Locator };
}

function describeCondition(condition: Condition): string {
	return isValueCondition(condition) ? `${condition.kind} ${JSON.stringify(condition.value.slice(0, 80))}` : `${condition.kind} ${JSON.stringify(condition.locator)}`;
}

/** for_each の一覧。配列か、`$N.items`（`$N.text` は行ごと）。 */
function resolveList(source: unknown, scope: IScope): string[] | string {
	if (Array.isArray(source)) {
		return source.map(item => typeof item === 'string' ? item : JSON.stringify(item));
	}
	const match = typeof source === 'string' ? /^\$(?<step>\d+)\.(?<field>items|text)$/.exec(source.trim()) : null;
	if (!match?.groups) {
		return `"for_each" must be a list or a reference to an earlier top-level step such as "$3.items" (got ${JSON.stringify(source)}).`;
	}
	const ref = scope.results.get(Number(match.groups.step));
	if (!ref) {
		return `"for_each": step ${match.groups.step} has no result to use (it has not run, failed, or is not a top-level step).`;
	}
	return match.groups.field === 'items' ? [...ref.items] : ref.text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
}

/** 手順書を動かし、結果を 1 つにまとめる。 */
export async function paradisRunStepsFlow(call: IParadisRunStepsFlowCall, rawArgs: unknown): Promise<unknown> {
	const parsed = paradisParseRunStepsFlow(rawArgs);
	if (!parsed.ok) {
		return failure(parsed.error);
	}
	const run = new FlowRun(call, parsed.continueOnError, parsed.maxMs);
	await run.runBlock(parsed.steps, { results: new Map() }, '', true);
	const summary = `run_steps: ${run.executed} step(s) executed, ${run.failed} failed.${run.stopped !== undefined ? ` ${run.stopped}` : ''}${run.images > MAX_TOTAL_IMAGES ? ` Only the first ${MAX_TOTAL_IMAGES} images are included.` : ''}`;
	const stoppedWithoutFailure = run.stopped !== undefined && run.failed === 0;
	return { content: [{ type: 'text', text: summary }, ...run.content], ...(run.failed > 0 || stoppedWithoutFailure ? { isError: true } : {}) };
}

/** tools/list の run_steps を、手順書を書ける形にする（設定が有効なときだけ）。 */
export function paradisRunStepsFlowDescriptor<T extends { readonly name: string; readonly description?: string; readonly inputSchema?: unknown }>(tool: T): T {
	if (tool.name !== 'run_steps') {
		return tool;
	}
	const description = 'Run a small script of browser steps on the page shared with this terminal pane in one call, in order. A step is one of: '
		+ '{"tool": "click_by", "args": {...}} (a tool, checked and run exactly as if called alone); '
		+ '{"expect": {"text": "Saved"}} (wait until a condition holds, default up to 5 s, "timeout_ms" up to 60000; conditions: text, text_gone, visible / gone / disabled / enabled with a locator such as {"role": "button", "name": "Next"}, url_includes, predicate as a JavaScript function); '
		+ '{"sleep_ms": 500} (fixed wait, use instead of setTimeout in evaluate_script); '
		+ '{"for_each": "$3.items", "steps": [...]} (repeat steps for each item; "$3.items" are the matches of a get_text with all: true at top-level step 3, or a literal list; use $item and $index inside); '
		+ '{"repeat_until": {"disabled": {"role": "button", "name": "Next"}}, "steps": [...], "max": 20} (repeat steps until the condition holds, checked before each round; for paging). '
		+ 'Tool arguments can refer to earlier top-level results: "$2.text" is the text of step 2 (for get_text, just the text), "$$" is a literal $. '
		+ 'Inside a script (the function of evaluate_script, a predicate) a reference stands for a string value: use it where a value goes, for example "() => document.title === $2.text" or `${$2.text}` in a template; inside quotes it is not replaced by the value. References cannot be used in initScript. '
		+ `At most ${PARADIS_RUN_STEPS_FLOW_MAX_EXECUTED} executed steps and "max_seconds" (default ${DEFAULT_MAX_SECONDS}, keep it below your MCP client's tool timeout). Stops at the first failed step or unmet expect (unless continue_on_error). `
		+ `Allowed tools: ${[...PARADIS_RUN_STEPS_ALLOWED_TOOLS].join(', ')}.`;
	return {
		...tool,
		description,
		inputSchema: {
			type: 'object',
			properties: {
				steps: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							tool: { type: 'string', description: 'Tool name, for example "click_by".' },
							args: { type: 'object', description: 'Arguments of that tool, as when calling it alone. Strings may contain $N.text, $N.items, $item, $index.' },
							expect: { type: 'object', description: 'Condition to wait for: one of text, text_gone, visible, gone, disabled, enabled, url_includes, predicate; optional timeout_ms.' },
							sleep_ms: { type: 'number', description: `Wait this long (0-${MAX_SLEEP_MS}).` },
							for_each: { description: 'A list, or "$N.items" / "$N.text" of an earlier top-level step.', anyOf: [{ type: 'array' }, { type: 'string' }] },
							repeat_until: { type: 'object', description: 'Condition (as in expect) checked before each round; the steps repeat until it holds.' },
							steps: { type: 'array', items: { type: 'object' }, description: 'Steps of for_each / repeat_until (loops nest at most 2 deep).' },
							max: { type: 'number', description: `Most rounds of for_each / repeat_until (1-${MAX_ROUNDS}; defaults 50 / ${DEFAULT_ROUNDS}).` },
						},
						additionalProperties: false,
					},
					description: `At most ${MAX_STEPS_PER_BLOCK} steps per list.`,
				},
				continue_on_error: { type: 'boolean', description: 'Run the remaining steps after a step fails (default false).' },
				max_seconds: { type: 'number', description: `Time limit for the whole run (1-${MAX_MAX_SECONDS}, default ${DEFAULT_MAX_SECONDS}).` },
			},
			required: ['steps'],
			additionalProperties: false,
		},
	};
}
