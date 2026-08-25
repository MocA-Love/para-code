/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import { ParadisOfficePackageError } from '../office/paradisOfficeArchive.js';

export interface ParadisFormattedCellValue {
	readonly text: string;
	readonly status: 'exact' | 'approximated';
	readonly unsupportedTokens: readonly string[];
}

export interface ParadisSpreadsheetNumberFormatLimits {
	readonly formatCharacters: number;
	readonly sections: number;
	readonly tokens: number;
	readonly inputCharacters: number;
	readonly outputCharacters: number;
}

export interface ParadisSpreadsheetNumberFormatContext {
	readonly date1904?: boolean;
	readonly workbookLocale?: string;
	readonly applicationLocale?: string;
	readonly cancellationToken?: CancellationToken;
	readonly now?: () => number;
	readonly deadlineMilliseconds?: number;
	readonly limits?: Partial<ParadisSpreadsheetNumberFormatLimits>;
}

const defaultLimits: ParadisSpreadsheetNumberFormatLimits = {
	formatCharacters: 4096,
	sections: 4,
	tokens: 512,
	inputCharacters: 1024 * 1024,
	outputCharacters: 64 * 1024,
};
const limitKeys: readonly (keyof ParadisSpreadsheetNumberFormatLimits)[] = [
	'formatCharacters', 'sections', 'tokens', 'inputCharacters', 'outputCharacters',
];
const contextKeys = new Set(['date1904', 'workbookLocale', 'applicationLocale', 'cancellationToken', 'now', 'deadlineMilliseconds', 'limits']);
const maximumDeadlineMilliseconds = 60_000;

interface OwnedFormatContext {
	readonly date1904: boolean;
	readonly workbookLocale?: string;
	readonly applicationLocale?: string;
	readonly cancellationToken?: CancellationToken;
	readonly now: () => number;
	readonly deadlineMilliseconds: number;
	readonly limits: ParadisSpreadsheetNumberFormatLimits;
}

interface FormatRuntime {
	readonly context: OwnedFormatContext;
	readonly hardDeadline: StopWatch;
	readonly started: number;
	lastClock: number;
	checks: number;
}

interface LocaleProfile {
	readonly locale: string;
	readonly decimal: string;
	readonly group: string;
	readonly currency: string;
	readonly monthsShort: readonly string[];
	readonly monthsLong: readonly string[];
	readonly weekdaysShort: readonly string[];
	readonly weekdaysLong: readonly string[];
	readonly am: string;
	readonly pm: string;
}

const englishProfile: LocaleProfile = {
	locale: 'en-US', decimal: '.', group: ',', currency: '$',
	monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
	monthsLong: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
	weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
	weekdaysLong: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
	am: 'AM', pm: 'PM',
};

const localeProfiles: Readonly<Record<string, LocaleProfile>> = {
	'en-us': englishProfile,
	'de-de': { ...englishProfile, locale: 'de-DE', decimal: ',', group: '.', currency: '€', monthsShort: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'], monthsLong: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'] },
	'fr-fr': { ...englishProfile, locale: 'fr-FR', decimal: ',', group: '\u202f', currency: '€', monthsShort: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'], monthsLong: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'] },
	'ja-jp': { ...englishProfile, locale: 'ja-JP', currency: '¥', monthsShort: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'], monthsLong: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'], weekdaysShort: ['日', '月', '火', '水', '木', '金', '土'], weekdaysLong: ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'], am: '午前', pm: '午後' },
	'ko-kr': { ...englishProfile, locale: 'ko-KR', currency: '₩', monthsShort: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'], monthsLong: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'], weekdaysShort: ['일', '월', '화', '수', '목', '금', '토'], weekdaysLong: ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'], am: '오전', pm: '오후' },
	'zh-cn': { ...englishProfile, locale: 'zh-CN', currency: '¥', monthsShort: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'], monthsLong: ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'], weekdaysShort: ['日', '一', '二', '三', '四', '五', '六'], weekdaysLong: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'], am: '上午', pm: '下午' },
	'zh-tw': { ...englishProfile, locale: 'zh-TW', currency: 'NT$', monthsShort: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'], monthsLong: ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'], weekdaysShort: ['日', '一', '二', '三', '四', '五', '六'], weekdaysLong: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'], am: '上午', pm: '下午' },
};

type FormatToken =
	| { readonly kind: 'literal'; readonly text: string }
	| { readonly kind: 'character'; readonly text: string }
	| { readonly kind: 'date'; readonly text: string }
	| { readonly kind: 'elapsed'; readonly text: 'h' | 'm' | 's' }
	| { readonly kind: 'condition'; readonly operator: '<' | '<=' | '=' | '<>' | '>=' | '>'; readonly value: number }
	| { readonly kind: 'locale'; readonly locale?: string; readonly currency?: string }
	| { readonly kind: 'metadata' };

interface ParsedSection {
	readonly raw: string;
	readonly tokens: readonly FormatToken[];
	readonly condition?: Extract<FormatToken, { readonly kind: 'condition' }>;
	readonly unsupported: readonly string[];
	readonly profile?: LocaleProfile;
}

interface ResolvedFormat {
	readonly code: string;
	readonly label: string;
	readonly unsupported: readonly string[];
}

/** Deterministically formats an Excel stored/cached value without constructing a host Date. */
export function formatSpreadsheetValue(
	value: unknown,
	format: number | string,
	context: ParadisSpreadsheetNumberFormatContext = {},
): ParadisFormattedCellValue {
	try {
		const owned = ownFormatContext(context);
		const started = readClock(owned.now);
		const runtime: FormatRuntime = { context: owned, hardDeadline: StopWatch.create(true), started, lastClock: started, checks: 0 };
		checkpoint(runtime, true);
		const ownedValue = ownFormatValue(value, owned.limits.inputCharacters, runtime);
		const locale = resolveLocaleProfile(owned.workbookLocale ?? owned.applicationLocale);
		const localeIssue = locale.unsupported;
		const resolved = resolveFormat(format, locale.profile, owned.limits, runtime);
		if (resolved.unsupported.length > 0) {
			const general = generalText(ownedValue.value);
			return boundedResult(`${general} ⟦${resolved.label}⟧`, [...ownedValue.unsupported, ...localeIssue, ...resolved.unsupported], true, runtime);
		}
		const rawSections = splitSections(resolved.code, owned.limits, runtime);
		const sections = rawSections.map(section => tokenizeSection(section, locale.profile, owned.limits, runtime));
		const selected = selectSection(sections, ownedValue.value);
		if (!selected) {
			return boundedResult('', [...ownedValue.unsupported, ...localeIssue], false, runtime);
		}
		const effectiveProfile = selected.profile ?? locale.profile;
		const automaticNegative = typeof ownedValue.value === 'number' && ownedValue.value < 0
			&& (sections.some(section => section.condition !== undefined) || sections.length < 2);
		const applyTextSection = typeof ownedValue.value !== 'number' && sections.length >= 4 && selected === sections[3];
		let rendered = renderSection(ownedValue.value, selected, effectiveProfile, owned.date1904, automaticNegative, applyTextSection, runtime);
		const unsupported = uniqueStrings([...ownedValue.unsupported, ...localeIssue, ...selected.unsupported]);
		// Fill alignment is a recognized token, but exact repetition depends on the eventual cell width.
		// Keep it approximated without treating it as an unknown-code fallback.
		const appendRaw = selected.unsupported.some(token => !token.startsWith('*'));
		if (appendRaw && rendered.length === 0) {
			rendered = generalText(ownedValue.value);
		}
		return boundedResult(appendRaw ? `${rendered} ⟦${selected.raw}⟧` : rendered, unsupported, appendRaw, runtime);
	} catch (error) {
		if (error instanceof ParadisOfficePackageError) {
			throw new ParadisOfficePackageError(error.code);
		}
		throw new ParadisOfficePackageError('unsafe');
	}
}

function ownFormatContext(value: unknown): OwnedFormatContext {
	const record = ownRecord(value, contextKeys);
	const limitsRecord = record.limits === undefined ? undefined : ownRecord(record.limits, new Set(limitKeys));
	const limits = { ...defaultLimits };
	for (const key of limitKeys) {
		const candidate = limitsRecord?.[key];
		if (candidate !== undefined) {
			if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > defaultLimits[key]) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			limits[key] = candidate as number;
		}
	}
	const date1904 = record.date1904 ?? false;
	if (typeof date1904 !== 'boolean') {
		throw new ParadisOfficePackageError('unsafe');
	}
	for (const key of ['workbookLocale', 'applicationLocale'] as const) {
		const locale = record[key];
		if (locale !== undefined && typeof locale !== 'string') {
			throw new ParadisOfficePackageError('unsafe');
		}
		if (typeof locale === 'string' && locale.length > 128) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
	}
	const now = record.now ?? Date.now;
	if (typeof now !== 'function') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const deadlineMilliseconds = record.deadlineMilliseconds ?? maximumDeadlineMilliseconds;
	if (!Number.isSafeInteger(deadlineMilliseconds) || (deadlineMilliseconds as number) < 0 || (deadlineMilliseconds as number) > maximumDeadlineMilliseconds) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const cancellationToken = record.cancellationToken;
	if (cancellationToken !== undefined && (!cancellationToken || typeof cancellationToken !== 'object')) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return {
		date1904,
		...(record.workbookLocale !== undefined ? { workbookLocale: record.workbookLocale as string } : {}),
		...(record.applicationLocale !== undefined ? { applicationLocale: record.applicationLocale as string } : {}),
		...(cancellationToken !== undefined ? { cancellationToken: cancellationToken as CancellationToken } : {}),
		now: now as () => number,
		deadlineMilliseconds: deadlineMilliseconds as number,
		limits,
	};
}

function ownRecord(value: unknown, allowedKeys: ReadonlySet<string>): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	try {
		const keys = Reflect.ownKeys(value);
		if (keys.length > allowedKeys.size) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const result: Record<string, unknown> = Object.create(null);
		for (const key of keys) {
			if (typeof key !== 'string' || !allowedKeys.has(key)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
				throw new ParadisOfficePackageError('unsafe');
			}
			result[key] = descriptor.value;
		}
		return result;
	} catch (error) {
		if (error instanceof ParadisOfficePackageError) {
			throw error;
		}
		throw new ParadisOfficePackageError('unsafe');
	}
}

function checkpoint(runtime: FormatRuntime, force = false): void {
	runtime.checks++;
	if (!force && (runtime.checks & 0x0f) !== 0) {
		return;
	}
	try {
		if (runtime.context.cancellationToken?.isCancellationRequested) {
			throw new ParadisOfficePackageError('cancelled');
		}
	} catch (error) {
		if (error instanceof ParadisOfficePackageError) {
			throw error;
		}
		throw new ParadisOfficePackageError('unsafe');
	}
	if (runtime.hardDeadline.elapsed() > runtime.context.deadlineMilliseconds) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const clock = readClock(runtime.context.now);
	if (clock < runtime.lastClock) {
		throw new ParadisOfficePackageError('unsafe');
	}
	runtime.lastClock = clock;
	if (clock - runtime.started > runtime.context.deadlineMilliseconds) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
}

function readClock(now: () => number): number {
	try {
		const value = now();
		if (!Number.isFinite(value)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		return value;
	} catch (error) {
		if (error instanceof ParadisOfficePackageError) {
			throw error;
		}
		throw new ParadisOfficePackageError('unsafe');
	}
}

function ownFormatValue(value: unknown, maximumCharacters: number, runtime: FormatRuntime): { readonly value: number | string | boolean | null; readonly unsupported: readonly string[] } {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new ParadisOfficePackageError('invalid');
		}
		return { value, unsupported: [] };
	}
	if (typeof value === 'string') {
		if (value.length > maximumCharacters) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const sanitized = sanitizeUnicode(value, runtime);
		return { value: sanitized.text, unsupported: sanitized.changed ? ['unicode'] : [] };
	}
	if (typeof value === 'boolean' || value === null || value === undefined) {
		return { value: value ?? null, unsupported: [] };
	}
	throw new ParadisOfficePackageError('unsafe');
}

function sanitizeUnicode(value: string, runtime: FormatRuntime): { readonly text: string; readonly changed: boolean } {
	let result = '';
	let changed = false;
	for (let index = 0; index < value.length; index++) {
		if ((index & 0xff) === 0) {
			checkpoint(runtime, true);
		}
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				result += value[index] + value[++index];
			} else {
				result += '\uFFFD';
				changed = true;
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			result += '\uFFFD';
			changed = true;
		} else {
			result += value[index];
		}
	}
	return { text: result, changed };
}

function resolveLocaleProfile(locale: string | undefined): { readonly profile: LocaleProfile; readonly unsupported: readonly string[] } {
	if (locale === undefined || locale === '') {
		return { profile: englishProfile, unsupported: [] };
	}
	const lower = asciiLower(locale);
	if (!isSafeLocale(lower)) {
		return { profile: englishProfile, unsupported: [`locale:${locale}`] };
	}
	const direct = localeProfiles[lower];
	if (direct) {
		return { profile: direct, unsupported: [] };
	}
	const language = lower.split('-')[0];
	const fallbackKey = language === 'de' ? 'de-de' : language === 'fr' ? 'fr-fr' : language === 'ja' ? 'ja-jp' : language === 'ko' ? 'ko-kr' : language === 'zh' ? 'zh-cn' : language === 'en' ? 'en-us' : undefined;
	return fallbackKey ? { profile: localeProfiles[fallbackKey], unsupported: [] } : { profile: englishProfile, unsupported: [`locale:${locale}`] };
}

function isSafeLocale(value: string): boolean {
	if (value.length < 2 || value.length > 128 || value[0] === '-' || value[value.length - 1] === '-') {
		return false;
	}
	let segmentLength = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 45) {
			if (segmentLength < 1 || segmentLength > 8) {
				return false;
			}
			segmentLength = 0;
		} else if (code >= 97 && code <= 122 || code >= 48 && code <= 57) {
			segmentLength++;
		} else {
			return false;
		}
	}
	return segmentLength >= 1 && segmentLength <= 8;
}

function asciiLower(value: string): string {
	let result = '';
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		result += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value[index];
	}
	return result;
}

function resolveFormat(format: number | string, profile: LocaleProfile, limits: ParadisSpreadsheetNumberFormatLimits, runtime: FormatRuntime): ResolvedFormat {
	checkpoint(runtime, true);
	if (typeof format === 'number') {
		if (!Number.isSafeInteger(format) || format < 0 || format > 49) {
			throw new ParadisOfficePackageError('invalid');
		}
		const code = builtInFormat(format, profile);
		return code === undefined
			? { code: '', label: `built-in:${format}`, unsupported: [`built-in:${format}`] }
			: { code, label: `built-in:${format}`, unsupported: [] };
	}
	if (typeof format !== 'string') {
		throw new ParadisOfficePackageError('unsafe');
	}
	if (format.length > limits.formatCharacters) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const sanitized = sanitizeUnicode(format, runtime);
	return { code: sanitized.text, label: sanitized.text, unsupported: sanitized.changed ? ['unicode'] : [] };
}

function builtInFormat(id: number, profile: LocaleProfile): string | undefined {
	const currency = `"${profile.currency}"`;
	const invariant: Readonly<Record<number, string>> = {
		0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
		5: `${currency}#,##0_);(${currency}#,##0)`, 6: `${currency}#,##0_);[Red](${currency}#,##0)`,
		7: `${currency}#,##0.00_);(${currency}#,##0.00)`, 8: `${currency}#,##0.00_);[Red](${currency}#,##0.00)`,
		9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
		14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM',
		20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm',
		37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00 ;(#,##0.00)', 40: '#,##0.00 ;[Red](#,##0.00)',
		41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)', 42: `_(${currency}* #,##0_);_(${currency}* (#,##0);_(${currency}* "-"_);_(@_)`,
		43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)', 44: `_(${currency}* #,##0.00_);_(${currency}* (#,##0.00);_(${currency}* "-"??_);_(@_)`,
		45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
	};
	if (Object.hasOwn(invariant, id)) {
		return invariant[id];
	}
	if (id < 27 || id > 36) {
		return undefined;
	}
	const family = profile.locale.toLowerCase();
	const localized: Readonly<Record<string, readonly string[]>> = {
		'ja-jp': ['yyyy/m/d', 'yyyy"年"m"月"d"日"', 'yyyy"年"m"月"d"日"', 'm/d/yy', 'yyyy"年"m"月"d"日"', 'h"時"mm"分"', 'h"時"mm"分"ss"秒"', 'yyyy"年"m"月"', 'm"月"d"日"', 'yyyy/m/d'],
		'ko-kr': ['yyyy/m/d', 'yyyy"년" m"월" d"일"', 'yyyy"년" m"월" d"일"', 'm-d-yy', 'yyyy"년" m"월" d"일"', 'h"시" mm"분"', 'h"시" mm"분" ss"초"', 'yyyy-mm-dd', 'yyyy-mm-dd', 'yyyy/m/d'],
		'zh-cn': ['yyyy/m/d', 'yyyy"年"m"月"d"日"', 'm"月"d"日"', 'm-d-yy', 'yyyy"年"m"月"d"日"', 'h"时"mm"分"', 'h"时"mm"分"ss"秒"', 'yyyy"年"m"月"', 'm"月"d"日"', 'yyyy/m/d'],
		'zh-tw': ['yyyy/m/d', 'yyyy"年"m"月"d"日"', 'yyyy"年"m"月"d"日"', 'm/d/yy', 'yyyy"年"m"月"d"日"', 'h"時"mm"分"', 'h"時"mm"分"ss"秒"', 'yyyy"年"m"月"', 'm"月"d"日"', 'yyyy/m/d'],
	};
	return (localized[family] ?? ['yyyy/m/d', 'yyyy-mm-dd', 'yyyy-mm-dd', 'm-d-yy', 'yyyy-mm-dd', 'h:mm', 'h:mm:ss', 'yyyy-mm', 'm-d', 'yyyy/m/d'])[id - 27];
}

function splitSections(code: string, limits: ParadisSpreadsheetNumberFormatLimits, runtime: FormatRuntime): readonly string[] {
	const result: string[] = [];
	let current = '';
	let quote = false;
	let bracket = false;
	for (let index = 0; index < code.length; index++) {
		checkpoint(runtime);
		const character = code[index];
		if (character === '\\' && !quote) {
			current += character;
			if (index + 1 < code.length) {
				current += code[++index];
			}
			continue;
		}
		if (character === '"' && !bracket) {
			quote = !quote;
			current += character;
			continue;
		}
		if (!quote && character === '[') {
			bracket = true;
		} else if (!quote && character === ']') {
			bracket = false;
		}
		if (character === ';' && !quote && !bracket) {
			result.push(current);
			current = '';
			if (result.length >= limits.sections) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
		} else {
			current += character;
		}
	}
	result.push(current);
	if (result.length > limits.sections) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return result;
}

function tokenizeSection(raw: string, defaultProfile: LocaleProfile, limits: ParadisSpreadsheetNumberFormatLimits, runtime: FormatRuntime): ParsedSection {
	const tokens: FormatToken[] = [];
	const unsupported: string[] = [];
	let profile: LocaleProfile | undefined;
	const push = (token: FormatToken): void => {
		if (tokens.length >= limits.tokens) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		tokens.push(token);
	};
	for (let index = 0; index < raw.length;) {
		checkpoint(runtime);
		const character = raw[index];
		if (character === '"') {
			let literal = '';
			let closed = false;
			index++;
			while (index < raw.length) {
				checkpoint(runtime);
				if (raw[index] === '"') {
					if (raw[index + 1] === '"') {
						literal += '"';
						index += 2;
						continue;
					}
					index++;
					closed = true;
					break;
				}
				literal += raw[index++];
			}
			push({ kind: 'literal', text: literal });
			if (!closed) {
				unsupported.push('"');
			}
			continue;
		}
		if (character === '\\' || character === '_') {
			if (index + 1 >= raw.length) {
				unsupported.push(character);
				index++;
			} else {
				push({ kind: 'literal', text: character === '_' ? ' ' : raw[index + 1] });
				index += 2;
			}
			continue;
		}
		if (character === '*') {
			const rawToken = raw.slice(index, Math.min(index + 2, raw.length));
			unsupported.push(rawToken);
			push({ kind: 'literal', text: raw[index + 1] ?? '' });
			index += rawToken.length;
			continue;
		}
		if (character === '[') {
			const end = raw.indexOf(']', index + 1);
			if (end < 0) {
				unsupported.push(raw.slice(index));
				push({ kind: 'literal', text: raw.slice(index) });
				break;
			}
			const bracket = raw.slice(index, end + 1);
			const body = raw.slice(index + 1, end);
			const directive = bracketDirective(body, defaultProfile);
			if (directive.token) {
				push(directive.token);
				if (directive.profile) {
					profile = directive.profile;
				}
			} else {
				unsupported.push(bracket);
			}
			index = end + 1;
			continue;
		}
		const upperRest = asciiUpper(raw.slice(index));
		if (upperRest.startsWith('AM/PM')) {
			push({ kind: 'date', text: raw.slice(index, index + 5) });
			index += 5;
			continue;
		}
		if (upperRest.startsWith('A/P')) {
			push({ kind: 'date', text: raw.slice(index, index + 3) });
			index += 3;
			continue;
		}
		const lower = asciiLower(character);
		if ('ymdhs'.includes(lower)) {
			let end = index + 1;
			while (end < raw.length && asciiLower(raw[end]) === lower) {
				end++;
			}
			push({ kind: 'date', text: raw.slice(index, end) });
			index = end;
			continue;
		}
		push({ kind: 'character', text: character });
		index++;
	}
	const condition = tokens.find((token): token is Extract<FormatToken, { readonly kind: 'condition' }> => token.kind === 'condition');
	return { raw, tokens, ...(condition ? { condition } : {}), unsupported: uniqueStrings(unsupported), ...(profile ? { profile } : {}) };
}

function bracketDirective(body: string, defaultProfile: LocaleProfile): { readonly token?: FormatToken; readonly profile?: LocaleProfile } {
	const lower = asciiLower(body);
	if (lower === 'h' || lower === 'm' || lower === 's') {
		return { token: { kind: 'elapsed', text: lower } };
	}
	if (isColorDirective(lower)) {
		return { token: { kind: 'metadata' } };
	}
	const condition = parseCondition(body);
	if (condition) {
		return { token: condition };
	}
	if (body.startsWith('$')) {
		const dash = body.lastIndexOf('-');
		const currency = dash < 0 ? body.slice(1) : body.slice(1, dash);
		const lcid = dash < 0 ? '' : asciiLower(body.slice(dash + 1));
		const locale = localeFromLcid(lcid);
		if (lcid && !locale) {
			return {};
		}
		const profile = locale ? localeProfiles[locale] : defaultProfile;
		return { token: { kind: 'locale', ...(locale ? { locale } : {}), ...(currency ? { currency } : {}) }, profile };
	}
	return {};
}

function isColorDirective(value: string): boolean {
	if (['black', 'blue', 'cyan', 'green', 'magenta', 'red', 'white', 'yellow'].includes(value)) {
		return true;
	}
	if (!value.startsWith('color')) {
		return false;
	}
	const number = value.slice(5);
	return number.length > 0 && number.length <= 2 && [...number].every(character => character >= '0' && character <= '9') && Number(number) >= 1 && Number(number) <= 56;
}

function parseCondition(value: string): Extract<FormatToken, { readonly kind: 'condition' }> | undefined {
	const operators = ['<=', '<>', '>=', '<', '=', '>'] as const;
	const operator = operators.find(candidate => value.startsWith(candidate));
	if (!operator) {
		return undefined;
	}
	const rawValue = value.slice(operator.length);
	if (rawValue.length === 0 || rawValue.length > 64 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(rawValue)) {
		return undefined;
	}
	const numeric = Number(rawValue);
	return Number.isFinite(numeric) ? { kind: 'condition', operator, value: numeric } : undefined;
}

function localeFromLcid(value: string): string | undefined {
	switch (value.replace(/^0+/, '')) {
		case '409': return 'en-us';
		case '407': return 'de-de';
		case '40c': return 'fr-fr';
		case '411': return 'ja-jp';
		case '412': return 'ko-kr';
		case '804': return 'zh-cn';
		case '404': return 'zh-tw';
		default: return undefined;
	}
}

function selectSection(sections: readonly ParsedSection[], value: number | string | boolean | null): ParsedSection | undefined {
	if (typeof value !== 'number') {
		return sections[3] ?? sections[0];
	}
	if (sections.some(section => section.condition)) {
		for (const section of sections) {
			if (section.condition ? evaluateCondition(value, section.condition) : true) {
				return section;
			}
		}
		return undefined;
	}
	if (value > 0) {
		return sections[0];
	}
	if (value < 0) {
		return sections[1] ?? sections[0];
	}
	return sections[2] ?? sections[0];
}

function evaluateCondition(value: number, condition: Extract<FormatToken, { readonly kind: 'condition' }>): boolean {
	switch (condition.operator) {
		case '<': return value < condition.value;
		case '<=': return value <= condition.value;
		case '=': return value === condition.value;
		case '<>': return value !== condition.value;
		case '>=': return value >= condition.value;
		case '>': return value > condition.value;
	}
}

function renderSection(value: number | string | boolean | null, section: ParsedSection, profile: LocaleProfile, date1904: boolean, automaticNegative: boolean, applyTextSection: boolean, runtime: FormatRuntime): string {
	const significant = section.tokens.filter(token => token.kind === 'character').map(token => token.text).join('');
	if (asciiLower(significant) === 'general') {
		return generalText(value);
	}
	if (typeof value !== 'number') {
		return applyTextSection ? renderText(value, section.tokens, profile) : generalText(value);
	}
	if (section.tokens.some(token => token.kind === 'date' || token.kind === 'elapsed')) {
		return renderDate(value, section.tokens, profile, date1904, runtime);
	}
	if (significant.includes('E') || significant.includes('e')) {
		return renderScientific(value, section.tokens, profile, automaticNegative);
	}
	if (significant.includes('/')) {
		return renderFraction(value, section.tokens, profile, automaticNegative);
	}
	return renderNumber(value, section.tokens, profile, automaticNegative);
}

function renderText(value: string | boolean | null, tokens: readonly FormatToken[], profile: LocaleProfile): string {
	const text = generalText(value);
	let result = '';
	for (const token of tokens) {
		switch (token.kind) {
			case 'literal': result += token.text; break;
			case 'character': result += token.text === '@' ? text : isNumericSyntax(token.text) ? '' : token.text; break;
			case 'locale': result += token.currency ?? ''; break;
			case 'date': result += token.text; break;
			case 'elapsed': result += `[${token.text}]`; break;
			case 'condition': case 'metadata': break;
		}
	}
	return result || text;
}

function renderNumber(value: number, tokens: readonly FormatToken[], profile: LocaleProfile, automaticNegative: boolean): string {
	const displayTokens = tokens.filter(token => token.kind !== 'condition' && token.kind !== 'metadata');
	const placeholderIndexes = displayTokens.flatMap((token, index) => token.kind === 'character' && (token.text === '0' || token.text === '#' || token.text === '?') ? [index] : []);
	if (placeholderIndexes.length === 0) {
		return literalTokens(displayTokens, profile);
	}
	const first = placeholderIndexes[0];
	const last = placeholderIndexes[placeholderIndexes.length - 1];
	const core = displayTokens.slice(first, last + 1);
	const pattern = core.map(token => token.kind === 'character' ? token.text : '').join('');
	const decimalIndex = pattern.indexOf('.');
	const integerPattern = decimalIndex < 0 ? pattern : pattern.slice(0, decimalIndex);
	const fractionPattern = decimalIndex < 0 ? '' : pattern.slice(decimalIndex + 1);
	const percentCount = displayTokens.filter(token => token.kind === 'character' && token.text === '%').length;
	let scaleCommas = 0;
	for (let index = last + 1; index < displayTokens.length; index++) {
		const token = displayTokens[index];
		if (token.kind === 'character' && token.text === ',') {
			scaleCommas++;
		} else {
			break;
		}
	}
	let scaled = Math.abs(value);
	for (let index = 0; index < percentCount; index++) {
		scaled *= 100;
	}
	for (let index = 0; index < scaleCommas; index++) {
		scaled /= 1000;
	}
	const maximumDecimals = countPlaceholders(fractionPattern);
	if (maximumDecimals > 30) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const minimumDecimals = countCharacter(fractionPattern, '0');
	const questionDecimals = countCharacter(fractionPattern, '?');
	let [integer, fraction = ''] = scaled.toFixed(maximumDecimals).split('.');
	while (fraction.length > minimumDecimals && fractionPattern[fraction.length - 1] === '#' && fraction.endsWith('0')) {
		fraction = fraction.slice(0, -1);
	}
	if (questionDecimals > 0 && fraction.length < maximumDecimals) {
		fraction += ' '.repeat(maximumDecimals - fraction.length);
	}
	const minimumInteger = countCharacter(integerPattern, '0');
	integer = integer.padStart(minimumInteger, '0');
	if (integerPattern.includes(',')) {
		integer = groupDigits(integer, profile.group);
	}
	let numeric = integer + (maximumDecimals > 0 && (fraction.length > 0 || minimumDecimals > 0) ? profile.decimal + fraction : '');
	const prefix = literalTokens(displayTokens.slice(0, first), profile);
	const suffix = literalTokens(displayTokens.slice(last + 1), profile);
	const selectedNegativeSection = value < 0 && (prefix.includes('(') || suffix.includes(')') || prefix.includes('-'));
	if (value < 0 && !selectedNegativeSection && automaticNegative) {
		numeric = `-${numeric}`;
	}
	return prefix + numeric + suffix;
}

function renderScientific(value: number, tokens: readonly FormatToken[], profile: LocaleProfile, automaticNegative: boolean): string {
	const displayTokens = tokens.filter(token => token.kind !== 'condition' && token.kind !== 'metadata');
	const placeholderIndexes = displayTokens.flatMap((token, index) => token.kind === 'character' && (token.text === '0' || token.text === '#' || token.text === '?') ? [index] : []);
	if (placeholderIndexes.length === 0) {
		return literalTokens(displayTokens, profile);
	}
	const first = placeholderIndexes[0];
	const last = placeholderIndexes[placeholderIndexes.length - 1];
	const pattern = displayTokens.slice(first, last + 1).filter(token => token.kind === 'character').map(token => token.text).join('');
	const exponentIndex = Math.max(pattern.indexOf('E'), pattern.indexOf('e'));
	const mantissa = pattern.slice(0, exponentIndex);
	const exponentPattern = pattern.slice(exponentIndex + 1);
	const decimals = mantissa.includes('.') ? countPlaceholders(mantissa.slice(mantissa.indexOf('.') + 1)) : 0;
	if (decimals > 30) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const raw = Math.abs(value).toExponential(decimals);
	const [rawMantissa, rawExponent] = raw.split('e');
	const exponent = Number(rawExponent);
	const exponentDigits = Math.max(1, countPlaceholders(exponentPattern));
	const sign = exponent < 0 ? '-' : exponentPattern.includes('+') ? '+' : '';
	let formatted = `${rawMantissa.replace('.', profile.decimal)}E${sign}${Math.abs(exponent).toString().padStart(exponentDigits, '0')}`;
	const prefix = literalTokens(displayTokens.slice(0, first), profile);
	const suffix = literalTokens(displayTokens.slice(last + 1), profile);
	if (value < 0 && automaticNegative && !prefix.includes('-') && !prefix.includes('(') && !suffix.includes(')')) {
		formatted = `-${formatted}`;
	}
	return prefix + formatted + suffix;
}

function renderFraction(value: number, tokens: readonly FormatToken[], profile: LocaleProfile, automaticNegative: boolean): string {
	const displayTokens = tokens.filter(token => token.kind !== 'condition' && token.kind !== 'metadata');
	const placeholderIndexes = displayTokens.flatMap((token, index) => token.kind === 'character' && (token.text === '0' || token.text === '#' || token.text === '?') ? [index] : []);
	if (placeholderIndexes.length === 0) {
		return literalTokens(displayTokens, profile);
	}
	const first = placeholderIndexes[0];
	let last = placeholderIndexes[placeholderIndexes.length - 1];
	const slashTokenIndex = displayTokens.findIndex(token => token.kind === 'character' && token.text === '/');
	if (slashTokenIndex >= 0) {
		for (let index = slashTokenIndex + 1; index < displayTokens.length; index++) {
			const token = displayTokens[index];
			if (token.kind === 'character' && /^[0-9#?]$/.test(token.text)) {
				last = index;
			} else {
				break;
			}
		}
	}
	const pattern = displayTokens.slice(first, last + 1).filter(token => token.kind === 'character' || token.kind === 'literal').map(token => token.text).join('');
	const slash = pattern.indexOf('/');
	const numeratorPattern = pattern.slice(0, slash).match(/[0#?]+$/)?.[0] ?? '?';
	const denominatorPattern = pattern.slice(slash + 1).match(/^(?:[0#?]+|[1-9][0-9]*)/)?.[0] ?? '?';
	const fixedDenominator = /^\d+$/.test(denominatorPattern) ? Number(denominatorPattern) : undefined;
	const maximumDenominator = fixedDenominator ?? Math.min(999, 10 ** denominatorPattern.length - 1);
	const absolute = Math.abs(value);
	let whole = Math.floor(absolute);
	const fraction = absolute - whole;
	let denominator = fixedDenominator ?? 1;
	let numerator = fixedDenominator ? Math.round(fraction * fixedDenominator) : 0;
	if (!fixedDenominator) {
		let bestError = Number.POSITIVE_INFINITY;
		for (let candidate = 1; candidate <= maximumDenominator; candidate++) {
			const candidateNumerator = Math.round(fraction * candidate);
			const error = Math.abs(fraction - candidateNumerator / candidate);
			if (error < bestError) {
				bestError = error;
				numerator = candidateNumerator;
				denominator = candidate;
			}
		}
	}
	if (numerator >= denominator) {
		whole += Math.floor(numerator / denominator);
		numerator %= denominator;
	}
	const numeratorText = numerator.toString().padStart(numeratorPattern.length, numeratorPattern.includes('?') ? ' ' : '0');
	const denominatorText = denominator.toString().padStart(denominatorPattern.length, denominatorPattern.includes('?') ? ' ' : '0');
	const wholePattern = pattern.slice(0, Math.max(0, slash - numeratorPattern.length)).match(/[0#?]+/)?.[0];
	let result = numerator === 0 ? whole.toString() : `${wholePattern ? whole.toString() + ' ' : ''}${numeratorText}/${denominatorText}`;
	const prefix = literalTokens(displayTokens.slice(0, first), profile);
	const suffix = literalTokens(displayTokens.slice(last + 1), profile);
	if (value < 0 && automaticNegative && !prefix.includes('-') && !prefix.includes('(') && !suffix.includes(')')) {
		result = `-${result}`;
	}
	return prefix + result + suffix;
}

interface ExcelDateParts {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly weekday: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
	readonly millisecond: number;
	readonly totalMilliseconds: number;
}

function renderDate(serial: number, tokens: readonly FormatToken[], profile: LocaleProfile, date1904: boolean, runtime: FormatRuntime): string {
	if (serial < 0 || serial > 3_000_000) {
		return '#'.repeat(10);
	}
	const parts = excelDateParts(serial, date1904);
	const hasCalendar = tokens.some(token => token.kind === 'date' && /[yd]/i.test(token.text));
	const hasTime = tokens.some(token => token.kind === 'elapsed' || token.kind === 'date' && /[hs]/i.test(token.text));
	const minuteOnly = hasTime && !hasCalendar;
	const twelveHour = tokens.some(token => token.kind === 'date' && ['AM/PM', 'A/P'].includes(asciiUpper(token.text)));
	let result = '';
	for (let index = 0; index < tokens.length; index++) {
		checkpoint(runtime);
		const token = tokens[index];
		switch (token.kind) {
			case 'literal': result += token.text; break;
			case 'character': {
				const previous = tokens[index - 1];
				if (token.text === '0' && previous?.kind === 'character' && previous.text === '.') {
					let count = 1;
					let next = tokens[index + 1];
					while (next?.kind === 'character' && next.text === '0') {
						count++;
						index++;
						next = tokens[index + 1];
					}
					result += parts.millisecond.toString().padStart(3, '0').slice(0, count);
				} else {
					result += token.text;
				}
				break;
			}
			case 'locale': result += token.currency ?? ''; break;
			case 'condition': case 'metadata': break;
			case 'elapsed': {
				const divisor = token.text === 'h' ? 3_600_000 : token.text === 'm' ? 60_000 : 1000;
				result += Math.floor(parts.totalMilliseconds / divisor).toString();
				break;
			}
			case 'date': {
				const lower = asciiLower(token.text);
				const upper = asciiUpper(token.text);
				if (upper === 'AM/PM' || upper === 'A/P') {
					const marker = parts.hour < 12 ? profile.am : profile.pm;
					result += upper === 'A/P' ? marker[0] : marker;
				} else if (lower[0] === 'y') {
					result += lower.length <= 2 ? pad(parts.year % 100, 2) : pad(parts.year, lower.length);
				} else if (lower[0] === 'd') {
					result += lower.length === 1 ? `${parts.day}` : lower.length === 2 ? pad(parts.day, 2) : lower.length === 3 ? profile.weekdaysShort[parts.weekday] : profile.weekdaysLong[parts.weekday];
				} else if (lower[0] === 'h') {
					const hour = twelveHour ? (parts.hour % 12 || 12) : parts.hour;
					result += lower.length === 1 ? `${hour}` : pad(hour, 2);
				} else if (lower[0] === 's') {
					result += lower.length === 1 ? `${parts.second}` : pad(parts.second, 2);
				} else if (lower[0] === 'm') {
					const minuteContext = minuteOnly || nearestTimeToken(tokens, index);
					if (minuteContext) {
						result += lower.length === 1 ? `${parts.minute}` : pad(parts.minute, 2);
					} else {
						result += lower.length === 1 ? `${parts.month}` : lower.length === 2 ? pad(parts.month, 2) : lower.length === 3 ? profile.monthsShort[parts.month - 1] : lower.length === 4 ? profile.monthsLong[parts.month - 1] : profile.monthsLong[parts.month - 1][0];
					}
				}
				break;
			}
		}
	}
	return result;
}

function nearestTimeToken(tokens: readonly FormatToken[], index: number): boolean {
	for (let cursor = index - 1; cursor >= 0; cursor--) {
		const token = tokens[cursor];
		if (token.kind === 'date') {
			return /h/i.test(token.text);
		}
		if (token.kind === 'character' && ![':', ' '].includes(token.text) || token.kind === 'literal' && token.text.trim()) {
			break;
		}
	}
	for (let cursor = index + 1; cursor < tokens.length; cursor++) {
		const token = tokens[cursor];
		if (token.kind === 'date') {
			return /s/i.test(token.text);
		}
		if (token.kind === 'character' && ![':', ' '].includes(token.text) || token.kind === 'literal' && token.text.trim()) {
			break;
		}
	}
	return false;
}

function excelDateParts(serial: number, date1904: boolean): ExcelDateParts {
	let day = Math.floor(serial);
	let milliseconds = Math.round((serial - day) * 86_400_000);
	if (milliseconds >= 86_400_000) {
		day++;
		milliseconds -= 86_400_000;
	}
	const totalMilliseconds = Math.round(serial * 86_400_000);
	let year: number;
	let month: number;
	let date: number;
	let weekday: number;
	if (!date1904 && day === 60) {
		year = 1900;
		month = 2;
		date = 29;
		weekday = 4;
	} else {
		const epoch = date1904 ? daysFromCivil(1904, 1, 1) : daysFromCivil(1899, 12, 31);
		const absolute = epoch + day - (!date1904 && day > 60 ? 1 : 0);
		({ year, month, day: date } = civilFromDays(absolute));
		weekday = modulo(absolute + 4, 7);
	}
	const hour = Math.floor(milliseconds / 3_600_000);
	milliseconds -= hour * 3_600_000;
	const minute = Math.floor(milliseconds / 60_000);
	milliseconds -= minute * 60_000;
	const second = Math.floor(milliseconds / 1000);
	return { year, month, day: date, weekday, hour, minute, second, millisecond: milliseconds - second * 1000, totalMilliseconds };
}

function daysFromCivil(year: number, month: number, day: number): number {
	const adjustedYear = year - (month <= 2 ? 1 : 0);
	const era = Math.floor(adjustedYear / 400);
	const yearOfEra = adjustedYear - era * 400;
	const adjustedMonth = month + (month > 2 ? -3 : 9);
	const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
	const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
	return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(days: number): { readonly year: number; readonly month: number; readonly day: number } {
	const shifted = days + 719468;
	const era = Math.floor(shifted / 146097);
	const dayOfEra = shifted - era * 146097;
	const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
	let year = yearOfEra + era * 400;
	const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
	const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
	const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
	const month = monthPrime + (monthPrime < 10 ? 3 : -9);
	year += month <= 2 ? 1 : 0;
	return { year, month, day };
}

function literalTokens(tokens: readonly FormatToken[], profile: LocaleProfile): string {
	let result = '';
	for (const token of tokens) {
		switch (token.kind) {
			case 'literal': result += token.text; break;
			case 'locale': result += token.currency ?? ''; break;
			case 'character': if (token.text === '%' || !isNumericSyntax(token.text)) { result += token.text; } break;
			case 'date': result += token.text; break;
			case 'elapsed': result += `[${token.text}]`; break;
			case 'condition': case 'metadata': break;
		}
	}
	return result.replace(/\$/g, profile.currency);
}

function isNumericSyntax(value: string): boolean {
	return '0#?.,/%Ee+-@'.includes(value);
}

function groupDigits(value: string, separator: string): string {
	let result = '';
	for (let index = 0; index < value.length; index++) {
		if (index > 0 && (value.length - index) % 3 === 0) {
			result += separator;
		}
		result += value[index];
	}
	return result;
}

function countPlaceholders(value: string): number {
	let count = 0;
	for (const character of value) {
		if (character === '0' || character === '#' || character === '?') {
			count++;
		}
	}
	return count;
}

function countCharacter(value: string, character: string): number {
	let count = 0;
	for (const candidate of value) {
		if (candidate === character) {
			count++;
		}
	}
	return count;
}

function generalText(value: number | string | boolean | null): string {
	if (value === null) {
		return '';
	}
	if (typeof value === 'boolean') {
		return value ? 'TRUE' : 'FALSE';
	}
	return String(value);
}

function boundedResult(text: string, unsupported: readonly string[], appendRaw: boolean, runtime: FormatRuntime): ParadisFormattedCellValue {
	checkpoint(runtime, true);
	if (text.length > runtime.context.limits.outputCharacters) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const unique = uniqueStrings(unsupported);
	return { text, status: unique.length > 0 || appendRaw ? 'approximated' : 'exact', unsupportedTokens: unique };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (!seen.has(value)) {
			seen.add(value);
			result.push(value);
		}
	}
	return result;
}

function pad(value: number, length: number): string {
	return value.toString().padStart(length, '0');
}

function modulo(value: number, divisor: number): number {
	return (value % divisor + divisor) % divisor;
}

function asciiUpper(value: string): string {
	let result = '';
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		result += code >= 97 && code <= 122 ? String.fromCharCode(code - 32) : value[index];
	}
	return result;
}
