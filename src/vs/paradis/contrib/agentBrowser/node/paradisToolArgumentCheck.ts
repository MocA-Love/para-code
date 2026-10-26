/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser の道具の引数を、tools/list で見せたスキーマと突き合わせる（q.html Q461 の 1 の A）。
// 道具の説明を読み込まずに呼んだエージェントは、引数の名前と型を推測で渡す（wait_until の `timeout: "30000"` など）。
// 知らない引数を黙って捨てると、既定の値で動いて何が悪いかが伝わらないので、呼ぶ前に断って正しい名前と型を返す。
// 見るのは一番上の引数の名前と型だけ（中の配列・オブジェクトの形、値の範囲、必須かは各道具が見る）。
// null は「渡さなかった」として通す（任意の引数に null を渡す呼び方は今も動いている）。

import { PARADIS_TAB_ID_ARGUMENT } from '../common/paradisAgentTabScope.js';

/** 断るときに添える、受け付ける引数の名前の数の上限。 */
const MAX_LISTED_ARGUMENTS = 30;

/** 断るときに添える、引数の説明の長さの上限。 */
const MAX_DESCRIPTION_CHARS = 160;

type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';

interface IPropertySchema {
	readonly type?: unknown;
	readonly description?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 値の JSON の型。 */
function jsonTypeOf(value: unknown): JsonType | undefined {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'array';
	}
	switch (typeof value) {
		case 'string': return 'string';
		case 'boolean': return 'boolean';
		case 'number': return Number.isInteger(value) ? 'integer' : 'number';
		case 'object': return 'object';
		default: return undefined;
	}
}

/** スキーマの `type`（1 つか配列）が値の型を受けるか。`type` が無い（anyOf など）ときは受ける。 */
function typeAccepts(type: unknown, actual: JsonType): boolean {
	const types = typeof type === 'string' ? [type] : Array.isArray(type) && type.every(item => typeof item === 'string') ? type as string[] : undefined;
	if (types === undefined) {
		return true;
	}
	return types.some(expected => expected === actual || (expected === 'number' && actual === 'integer'));
}

function typeLabel(type: unknown): string {
	const types = typeof type === 'string' ? [type] : Array.isArray(type) ? type.filter(item => typeof item === 'string') : [];
	return types.map(item => item === 'integer' ? 'a whole number' : item === 'array' ? 'an array' : item === 'object' ? 'an object' : `a ${item}`).join(' or ');
}

function shortDescription(property: IPropertySchema | undefined): string | undefined {
	if (typeof property?.description !== 'string' || property.description.length === 0) {
		return undefined;
	}
	const firstSentence = /^(?<sentence>.+?[.)])(\s|$)/.exec(property.description)?.groups?.sentence ?? property.description;
	return firstSentence.length > MAX_DESCRIPTION_CHARS ? `${firstSentence.slice(0, MAX_DESCRIPTION_CHARS - 1)}...` : firstSentence;
}

function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		let diagonal = previous[0];
		previous[0] = i;
		for (let j = 1; j <= right.length; j++) {
			const above = previous[j];
			previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return previous[right.length];
}

function words(name: string): string[] {
	return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-\s]+/).filter(Boolean);
}

/** 知らない引数の名前に近い、受け付ける引数（`timeout` → `timeout_seconds`、`tabId` → `tab_id`）。 */
function closestArgument(unknown: string, known: readonly string[]): string | undefined {
	const normalized = (name: string) => name.toLowerCase().replace(/[_\-]/g, '');
	const exact = known.find(name => normalized(name) === normalized(unknown));
	if (exact !== undefined) {
		return exact;
	}
	// 単位の語（ms・seconds）を除いた語が重なるもの
	const units = new Set(['ms', 'msec', 'millis', 'milliseconds', 's', 'sec', 'secs', 'seconds']);
	const meaningful = (name: string) => words(name).filter(word => !units.has(word));
	const unknownWords = new Set(meaningful(unknown));
	const sharing = known.filter(name => meaningful(name).some(word => unknownWords.has(word)));
	if (sharing.length === 1) {
		return sharing[0];
	}
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const name of sharing.length > 1 ? sharing : known) {
		const distance = editDistance(normalized(unknown), normalized(name));
		if (distance < bestDistance) {
			best = name;
			bestDistance = distance;
		}
	}
	return best !== undefined && (sharing.length > 1 || bestDistance <= Math.max(2, Math.floor(unknown.length / 3))) ? best : undefined;
}

/** `timeout_ms: 30000` を `timeout_seconds` へ直すときなど、単位の違いを 1 文で伝える。 */
function unitHint(unknown: string, suggested: string, value: unknown): string | undefined {
	const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined;
	const unknownWords = words(unknown);
	const suggestedWords = words(suggested);
	const fromMs = unknownWords.some(word => word === 'ms' || word === 'millis' || word === 'milliseconds') || (unknownWords.length === 1 && unknownWords[0] === 'timeout' && number !== undefined && number >= 1000);
	if (suggestedWords.includes('seconds') && fromMs) {
		return number !== undefined ? `It is in seconds: ${number} ms is ${number / 1000}.` : 'It is in seconds, not milliseconds.';
	}
	if (suggestedWords.includes('seconds')) {
		return 'It is in seconds.';
	}
	if (suggestedWords.includes('ms')) {
		return 'It is in milliseconds.';
	}
	return undefined;
}

function shownValue(value: unknown): string {
	const text = JSON.stringify(value) ?? String(value);
	return text.length > 40 ? `${text.slice(0, 39)}...` : text;
}

/**
 * 引数がスキーマに合わなければ、断る英文（何が違うか、正しい名前と型）を返す。合えば undefined。
 * スキーマが読めない・引数がオブジェクトでないときは見ない（各道具が今までどおり扱う）。
 * 知らない引数は、スキーマが `additionalProperties: false` のときだけ断る。
 */
export function paradisToolArgumentProblem(toolName: string, inputSchema: unknown, args: unknown): string | undefined {
	if (!isRecord(inputSchema) || !isRecord(inputSchema.properties) || !isRecord(args)) {
		return undefined;
	}
	const properties = inputSchema.properties as Record<string, IPropertySchema | undefined>;
	const known = Object.keys(properties);
	const problems: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (!Object.hasOwn(properties, key)) {
			// tab_id は instructions が「どの道具にも渡す」と勧めている。受けない道具（サイトメモなど）でも今までどおり
			// 通す（使われないだけ）。タブを `tabId` で受ける道具では取り違えなので断る
			if (inputSchema.additionalProperties !== false || (key === PARADIS_TAB_ID_ARGUMENT && !Object.hasOwn(properties, 'tabId'))) {
				continue;
			}
			const suggested = closestArgument(key, known);
			if (suggested === undefined) {
				problems.push(`${toolName} has no argument "${key}".`);
				continue;
			}
			const description = shortDescription(properties[suggested]);
			const hint = unitHint(key, suggested, value);
			const explained = description !== undefined ? `: ${description.replace(/[.]$/, '')}` : '';
			problems.push(`${toolName} has no argument "${key}"; use "${suggested}" instead${explained}.${hint !== undefined ? ` ${hint}` : ''}`);
			continue;
		}
		const property = properties[key];
		const actual = jsonTypeOf(value);
		if (actual === undefined || actual === 'null' || !isRecord(property) || typeAccepts(property.type, actual)) {
			continue;
		}
		const expected = typeLabel(property.type);
		let hint = '';
		if (actual === 'string' && typeof value === 'string' && (typeAccepts(property.type, 'number') || typeAccepts(property.type, 'integer')) && value.trim() !== '' && Number.isFinite(Number(value))) {
			hint = ` Pass ${Number(value)} without quotes.`;
		} else if (actual === 'string' && typeof value === 'string' && (typeAccepts(property.type, 'boolean')) && (value === 'true' || value === 'false')) {
			hint = ` Pass ${value} without quotes.`;
		} else if (actual === 'string' && (property.type === 'array' || property.type === 'object')) {
			hint = ` Pass the JSON ${property.type} itself, not a string.`;
		}
		problems.push(`"${key}" of ${toolName} must be ${expected}, not ${actual === 'integer' ? 'a number' : typeLabel(actual)} (${shownValue(value)}).${hint}`);
	}
	if (problems.length === 0) {
		return undefined;
	}
	const listed = known.length > MAX_LISTED_ARGUMENTS ? `${known.slice(0, MAX_LISTED_ARGUMENTS).join(', ')}, ...` : known.join(', ');
	return `${toolName} was not run: ${problems.join(' ')} Arguments ${toolName} takes: ${listed.length > 0 ? listed : '(none)'}. Call it again with these names and types (in Claude Code, load the tool with ToolSearch first to read its full description).`;
}
