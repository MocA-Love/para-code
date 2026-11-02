/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser の道具の待ち時間の引数は秒に揃えた（q.html Q535 の 2 の B）。前の名前（ミリ秒の `settle_ms`・
// `interval_ms`・`network_idle_ms`・run_steps の `sleep_ms` と expect の `timeout_ms`、内蔵 chrome-devtools-mcp の
// `timeout`）は、保存済みの手順（save_recipe）や前からのエージェントの呼び出しが壊れないよう、スキーマには載せずに
// 黙って受けて新しい名前と単位へ読み替える。読み替えは引数の突き合わせ（paradisToolArgumentCheck.ts）より前に行う。
// 両方を渡されたら新しい名前を使う。数でない値は読み替えない（前の名前のまま残し、突き合わせが正しい名前を案内する）。

import { PARADIS_SETTLE_TOOLS } from './paradisBrowserObserve.js';
import { isRecord } from '../../../common/paradisGuards.js';

/** 内蔵 chrome-devtools-mcp の、ミリ秒の `timeout` を秒の `timeout_seconds` として見せる道具。 */
export const PARADIS_DEVTOOLS_SECONDS_TIMEOUT_TOOLS: ReadonlySet<string> = new Set(['evaluate_script', 'navigate_page', 'wait_for']);

/** 道具ごとの、前の名前（ミリ秒）→ 新しい名前（秒）。 */
const MILLISECOND_RENAMES: ReadonlyMap<string, readonly (readonly [string, string])[]> = new Map<string, readonly (readonly [string, string])[]>([
	['scroll_to', [['settle_ms', 'step_wait_seconds']]],
	['wait_until', [['interval_ms', 'interval_seconds'], ['network_idle_ms', 'network_idle_seconds']]],
	...[...PARADIS_DEVTOOLS_SECONDS_TIMEOUT_TOOLS].map((tool): [string, readonly (readonly [string, string])[]] => [tool, [['timeout', 'timeout_seconds']]]),
]);

/** run_steps の手順・save_recipe の手順の中で、前の名前（ミリ秒）→ 新しい名前（秒）。 */
const STEP_RENAMES: readonly (readonly [string, string])[] = [['sleep_ms', 'sleep_seconds']];
/** expect・repeat_until・done_when の条件の中で。 */
const CONDITION_RENAMES: readonly (readonly [string, string])[] = [['timeout_ms', 'timeout_seconds']];

/** 手順の入れ子の深さの上限（run_steps は 2 段までだが、壊れた入力で深く潜らない）。 */
const MAX_STEP_DEPTH = 4;

/** 前の名前をミリ秒から秒に読み替える。変えたら新しいオブジェクトを、変えなければ元を返す。 */
function renamed(args: Record<string, unknown>, renames: readonly (readonly [string, string])[]): Record<string, unknown> {
	let result = args;
	for (const [legacy, current] of renames) {
		if (!Object.hasOwn(result, legacy)) {
			continue;
		}
		const value = result[legacy];
		if (Object.hasOwn(result, current)) {
			const { [legacy]: _dropped, ...rest } = result;
			result = rest;
		} else if (typeof value === 'number' && Number.isFinite(value)) {
			const { [legacy]: _moved, ...rest } = result;
			result = { ...rest, [current]: value / 1000 };
		}
	}
	return result;
}

function normalizedCondition(value: unknown): unknown {
	return isRecord(value) ? renamed(value, CONDITION_RENAMES) : value;
}

function normalizedSteps(steps: unknown, depth: number): unknown {
	if (!Array.isArray(steps) || depth > MAX_STEP_DEPTH) {
		return steps;
	}
	let changed = false;
	const result = steps.map(step => {
		const next = normalizedStep(step, depth);
		changed ||= next !== step;
		return next;
	});
	return changed ? result : steps;
}

function normalizedStep(step: unknown, depth: number): unknown {
	if (!isRecord(step)) {
		return step;
	}
	let result = renamed(step, STEP_RENAMES);
	const replace = (key: string, value: unknown) => {
		if (value !== result[key]) {
			result = { ...result, [key]: value };
		}
	};
	if (typeof result.tool === 'string' && isRecord(result.args)) {
		replace('args', paradisNormalizeLegacyToolArguments(result.tool, result.args, depth + 1));
	}
	for (const key of ['expect', 'repeat_until']) {
		if (Object.hasOwn(result, key)) {
			replace(key, normalizedCondition(result[key]));
		}
	}
	if (Object.hasOwn(result, 'steps')) {
		replace('steps', normalizedSteps(result.steps, depth + 1));
	}
	return result;
}

/**
 * 前の名前・単位の引数を、今のスキーマの名前（秒）へ読み替える。読み替えるものが無ければ `args` をそのまま返す。
 * run_steps と save_recipe は、手順（と手順の中の道具の引数）も読み替える。
 */
export function paradisNormalizeLegacyToolArguments(toolName: string, args: unknown, depth = 0): unknown {
	if (!isRecord(args)) {
		return args;
	}
	let result = args;
	if (PARADIS_SETTLE_TOOLS.has(toolName)) {
		result = renamed(result, [['settle_ms', 'settle_seconds']]);
	}
	const renames = MILLISECOND_RENAMES.get(toolName);
	if (renames !== undefined) {
		result = renamed(result, renames);
	}
	if ((toolName === 'run_steps' || toolName === 'save_recipe') && Object.hasOwn(result, 'steps')) {
		const steps = normalizedSteps(result.steps, depth);
		if (steps !== result.steps) {
			result = { ...result, steps };
		}
	}
	if (toolName === 'save_recipe' && Object.hasOwn(result, 'done_when')) {
		const doneWhen = normalizedCondition(result.done_when);
		if (doneWhen !== result.done_when) {
			result = { ...result, done_when: doneWhen };
		}
	}
	return result;
}

/**
 * 内蔵 chrome-devtools-mcp へ渡す前に、秒の `timeout_seconds` を子が受けるミリ秒の `timeout` に戻す（子のスキーマは上流のまま）。
 * 0 と、丸めて 0 以下になる値は渡さない（既定の待ち時間にする）。上流の `timeoutSchema` は 0 を素通しし、navigate_page の
 * `goto` / `reload` が `{ timeout: 0 }` で上限なしに待ってタブを止めるため。前の名前の `timeout`（ミリ秒）の 0 も同じ。
 */
export function paradisDevtoolsArgumentsForChild(toolName: string, args: unknown): unknown {
	if (!PARADIS_DEVTOOLS_SECONDS_TIMEOUT_TOOLS.has(toolName) || !isRecord(args) || (!Object.hasOwn(args, 'timeout_seconds') && !Object.hasOwn(args, 'timeout'))) {
		return args;
	}
	const { timeout_seconds: seconds, timeout: legacyMs, ...rest } = args;
	const ms = typeof seconds === 'number' && Number.isFinite(seconds) ? Math.round(seconds * 1000) : typeof legacyMs === 'number' && Number.isFinite(legacyMs) ? Math.round(legacyMs) : undefined;
	return ms !== undefined && ms > 0 ? { ...rest, timeout: ms } : rest;
}

/**
 * {@link paradisNormalizeLegacyToolArguments} が一番上の引数で読み替えた名前（前の名前 → 今の名前）。範囲のエラーは今の名前で
 * 出るので、エージェントが自分の送った名前と結び付けられるよう、エラー文に元の名前を添えるのに使う。
 */
export function paradisRenamedLegacyArguments(toolName: string, sent: unknown, normalized: unknown): readonly (readonly [string, string])[] {
	if (!isRecord(sent) || !isRecord(normalized) || sent === normalized) {
		return [];
	}
	const renames = [...(PARADIS_SETTLE_TOOLS.has(toolName) ? [['settle_ms', 'settle_seconds'] as const] : []), ...(MILLISECOND_RENAMES.get(toolName) ?? [])];
	return renames.filter(([legacy, current]) => Object.hasOwn(sent, legacy) && !Object.hasOwn(sent, current) && !Object.hasOwn(normalized, legacy) && Object.hasOwn(normalized, current));
}

/** 失敗した結果の文の `"今の名前"` に `(sent as 前の名前, in milliseconds)` を添える。読み替えが無い・失敗でなければそのまま。 */
export function paradisMentionLegacyArgumentNames(result: unknown, renames: readonly (readonly [string, string])[]): unknown {
	if (renames.length === 0 || !isRecord(result) || result.isError !== true || !Array.isArray(result.content)) {
		return result;
	}
	let changed = false;
	const content = result.content.map(item => {
		if (!isRecord(item) || typeof item.text !== 'string') {
			return item;
		}
		let text = item.text;
		for (const [legacy, current] of renames) {
			text = text.split(`"${current}"`).join(`"${current}" (sent as "${legacy}" in milliseconds)`);
		}
		changed ||= text !== item.text;
		return text !== item.text ? { ...item, text } : item;
	});
	return changed ? { ...result, content } : result;
}
