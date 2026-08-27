/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import type { ParadisOfficeSearchResult } from './paradisOfficeProtocol.js';

export const PARADIS_OFFICE_SEARCH_PAGE_SIZE = 200;
export const PARADIS_OFFICE_SEARCH_RESULT_LIMIT = 10_000;

const MAXIMUM_QUERY_LENGTH = 4_096;
const MAXIMUM_IDENTIFIER_LENGTH = 4_096;
const MAXIMUM_LABEL_LENGTH = 4_096;
const MAXIMUM_TEXT_LENGTH = 1_048_576;
const MAXIMUM_TOTAL_TEXT_LENGTH = 67_108_864;
const MAXIMUM_ITEMS = 100_000;
const MAXIMUM_FIELDS_PER_ITEM = 256;
const MAXIMUM_TOTAL_FIELDS = 100_000;
const DEFAULT_MAXIMUM_DURATION_MS = 1_000;
const CHECKPOINT_INTERVAL = 256;
const MAXIMUM_ACTIVE_CURSORS = 128;

export type ParadisOfficeSearchFieldKind =
	| 'formatted'
	| 'raw'
	| 'formula'
	| 'comment'
	| 'link'
	| 'alternativeText'
	| 'placeholder'
	| 'story'
	| 'hidden';

export interface ParadisOfficeSearchField {
	readonly kind: ParadisOfficeSearchFieldKind;
	/** Safe typed UI projection only. Binary payloads, secrets, and opaque XML have no field kind. */
	readonly text: string;
}

export interface ParadisOfficeSearchItem {
	readonly id: string;
	readonly locator: string;
	readonly locationBadge: ParadisOfficeSearchResult['locationBadge'];
	readonly navigableAnchor?: string;
	readonly side?: ParadisOfficeSearchResult['side'];
	readonly fields: readonly ParadisOfficeSearchField[];
}

export interface ParadisOfficeSearchHandle {
	readonly ownerId: string;
	readonly handleId: string;
}

export interface ParadisOfficeSearchSnapshot extends ParadisOfficeSearchHandle {
	readonly revision: string;
	readonly items: readonly ParadisOfficeSearchItem[];
}

export interface ParadisOfficeSearchQuery {
	readonly text: string;
	readonly matchCase?: boolean;
}

export interface ParadisOfficeSearchPage {
	readonly results: readonly ParadisOfficeSearchResult[];
	readonly nextCursor?: string;
	readonly total: number;
	readonly capped: boolean;
}

export type ParadisOfficeSearchErrorCode = 'invalidInput' | 'invalidCursor' | 'wrongOwner' | 'deadline';

export class ParadisOfficeSearchError extends Error {
	constructor(readonly code: ParadisOfficeSearchErrorCode) {
		super('Office search rejected the request.');
		this.name = 'ParadisOfficeSearchError';
	}
}

export interface ParadisOfficeSemanticSearchOptions {
	readonly maximumDurationMs?: number;
	readonly now?: () => number;
	readonly yieldToHost?: () => Promise<void>;
	readonly cursorFactory?: () => string;
}

interface OwnedSearchSnapshot {
	readonly ownerId: string;
	readonly handleId: string;
	readonly revision: string;
	readonly items: readonly ParadisOfficeSearchItem[];
}

interface SearchCursorState {
	readonly revision: string;
	readonly queryKey: string;
	readonly results: readonly ParadisOfficeSearchResult[];
	readonly total: number;
	readonly capped: boolean;
	readonly offset: number;
}

interface DataRecord {
	readonly keys: readonly string[];
	readonly values: ReadonlyMap<string, unknown>;
}

const fieldKinds = new Set<ParadisOfficeSearchFieldKind>([
	'formatted', 'raw', 'formula', 'comment', 'link', 'alternativeText', 'placeholder', 'story', 'hidden',
]);
const badgeKinds = new Set<ParadisOfficeSearchResult['locationBadge']['kind']>(['sheet', 'story', 'object', 'placeholder', 'metadata']);
const sides = new Set<NonNullable<ParadisOfficeSearchResult['side']>>(['original', 'modified', 'combined']);

const fieldLabels: Readonly<Record<ParadisOfficeSearchFieldKind, string>> = Object.freeze({
	formatted: localize('paradis.office.searchField.formatted', "Formatted"),
	raw: localize('paradis.office.searchField.raw', "Raw"),
	formula: localize('paradis.office.searchField.formula', "Formula"),
	comment: localize('paradis.office.searchField.comment', "Comment"),
	link: localize('paradis.office.searchField.link', "Link"),
	alternativeText: localize('paradis.office.searchField.alternativeText', "Alternative Text"),
	placeholder: localize('paradis.office.searchField.placeholder', "Placeholder"),
	story: localize('paradis.office.searchField.story', "Story"),
	hidden: localize('paradis.office.searchField.hidden', "Hidden"),
});

/** Bounded semantic search over caller-owned safe projections. Cursors never contain source identities. */
export class ParadisOfficeSemanticSearch {
	private snapshot: OwnedSearchSnapshot;
	private readonly cursors = new Map<string, SearchCursorState>();
	private readonly maximumDurationMs: number;
	private readonly now: () => number;
	private readonly yieldToHost: () => Promise<void>;
	private readonly cursorFactory: () => string;

	constructor(snapshot: ParadisOfficeSearchSnapshot, options: ParadisOfficeSemanticSearchOptions = {}) {
		this.maximumDurationMs = boundedDuration(options.maximumDurationMs);
		this.now = options.now ?? Date.now;
		this.yieldToHost = options.yieldToHost ?? (() => Promise.resolve());
		this.cursorFactory = options.cursorFactory ?? generateUuid;
		this.snapshot = ownSnapshot(snapshot);
	}

	/** Replaces the indexed revision while preserving owner/handle authority and invalidating every cursor. */
	update(snapshot: ParadisOfficeSearchSnapshot): void {
		const owned = ownSnapshot(snapshot);
		if (owned.ownerId !== this.snapshot.ownerId || owned.handleId !== this.snapshot.handleId) {
			throw new ParadisOfficeSearchError('wrongOwner');
		}
		this.snapshot = owned;
		this.cursors.clear();
	}

	async search(handle: ParadisOfficeSearchHandle, query: ParadisOfficeSearchQuery, cursor?: string, token: CancellationToken = CancellationToken.None): Promise<ParadisOfficeSearchPage> {
		const started = this.now();
		this.checkpoint(token, started);
		const ownedHandle = ownHandle(handle);
		if (ownedHandle.ownerId !== this.snapshot.ownerId || ownedHandle.handleId !== this.snapshot.handleId) {
			throw new ParadisOfficeSearchError('wrongOwner');
		}
		const ownedQuery = ownQuery(query);
		const queryKey = `${ownedQuery.matchCase ? '1' : '0'}:${ownedQuery.text}`;
		if (cursor !== undefined) {
			return this.pageFromCursor(cursor, queryKey, token, started);
		}
		if (!ownedQuery.text) {
			return Object.freeze({ results: Object.freeze([]), total: 0, capped: false });
		}

		const results: ParadisOfficeSearchResult[] = [];
		let capped = false;
		let checkpoints = 0;
		const matcher = new RegExp(escapeRegExpCharacters(ownedQuery.text), ownedQuery.matchCase ? 'gu' : 'giu');
		for (const item of this.snapshot.items) {
			const ordinals = new Map<ParadisOfficeSearchFieldKind, number>();
			for (const field of item.fields) {
				if (++checkpoints % CHECKPOINT_INTERVAL === 0) {
					this.checkpoint(token, started);
					await this.yieldToHost();
					this.checkpoint(token, started);
				}
				const text = field.text.normalize('NFC');
				matcher.lastIndex = 0;
				let ordinal = ordinals.get(field.kind) ?? 0;
				let match: RegExpExecArray | null;
				while ((match = matcher.exec(text))) {
					if (results.length >= PARADIS_OFFICE_SEARCH_RESULT_LIMIT) {
						capped = true;
						break;
					}
					results.push(searchResult(item, field, text, match.index, match[0].length, ordinal++));
				}
				ordinals.set(field.kind, ordinal);
				if (capped) {
					break;
				}
			}
			if (capped) {
				break;
			}
		}
		this.checkpoint(token, started);
		const ownedResults = Object.freeze(results);
		return this.createPage(ownedResults, 0, queryKey, capped);
	}

	private pageFromCursor(cursor: string, queryKey: string, token: CancellationToken, started: number): ParadisOfficeSearchPage {
		if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAXIMUM_IDENTIFIER_LENGTH) {
			throw new ParadisOfficeSearchError('invalidCursor');
		}
		const state = this.cursors.get(cursor);
		this.cursors.delete(cursor);
		if (!state || state.revision !== this.snapshot.revision || state.queryKey !== queryKey) {
			throw new ParadisOfficeSearchError('invalidCursor');
		}
		this.checkpoint(token, started);
		return this.createPage(state.results, state.offset, state.queryKey, state.capped);
	}

	private createPage(results: readonly ParadisOfficeSearchResult[], offset: number, queryKey: string, capped: boolean): ParadisOfficeSearchPage {
		const pageResults = Object.freeze(results.slice(offset, offset + PARADIS_OFFICE_SEARCH_PAGE_SIZE));
		const nextOffset = offset + pageResults.length;
		const nextCursor = nextOffset < results.length ? this.createCursor({
			revision: this.snapshot.revision,
			queryKey,
			results,
			total: results.length,
			capped,
			offset: nextOffset,
		}) : undefined;
		return Object.freeze({ results: pageResults, ...(nextCursor ? { nextCursor } : {}), total: results.length, capped });
	}

	private createCursor(state: SearchCursorState): string {
		for (let attempt = 0; attempt < 8; attempt++) {
			let cursor: string;
			try {
				cursor = this.cursorFactory();
			} catch {
				throw new ParadisOfficeSearchError('invalidInput');
			}
			if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAXIMUM_IDENTIFIER_LENGTH || this.cursors.has(cursor)) {
				continue;
			}
			while (this.cursors.size >= MAXIMUM_ACTIVE_CURSORS) {
				const oldest = this.cursors.keys().next().value;
				if (typeof oldest !== 'string') {
					break;
				}
				this.cursors.delete(oldest);
			}
			this.cursors.set(cursor, Object.freeze(state));
			return cursor;
		}
		throw new ParadisOfficeSearchError('invalidInput');
	}

	private checkpoint(token: CancellationToken, started: number): void {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		if (this.now() - started > this.maximumDurationMs) {
			throw new ParadisOfficeSearchError('deadline');
		}
	}
}

function searchResult(item: ParadisOfficeSearchItem, field: ParadisOfficeSearchField, text: string, index: number, matchLength: number, ordinal: number): ParadisOfficeSearchResult {
	const end = index + matchLength;
	return Object.freeze({
		id: `${item.id}:${field.kind}:${ordinal}`,
		locator: item.locator,
		preview: Object.freeze({
			before: text.slice(Math.max(0, index - 40), index),
			match: text.slice(index, end),
			after: text.slice(end, Math.min(text.length, end + 40)),
		}),
		locationBadge: Object.freeze({ kind: item.locationBadge.kind, label: `${item.locationBadge.label} · ${fieldLabels[field.kind]}` }),
		...(item.navigableAnchor ? { navigableAnchor: item.navigableAnchor } : {}),
		...(item.side ? { side: item.side } : {}),
	});
}

function ownSnapshot(value: ParadisOfficeSearchSnapshot): OwnedSearchSnapshot {
	try {
		const record = ownRecord(value, ['ownerId', 'handleId', 'revision', 'items']);
		const ownerId = boundedString(record.values.get('ownerId'), MAXIMUM_IDENTIFIER_LENGTH);
		const handleId = boundedString(record.values.get('handleId'), MAXIMUM_IDENTIFIER_LENGTH);
		const revision = boundedString(record.values.get('revision'), MAXIMUM_IDENTIFIER_LENGTH);
		const candidates = ownArray(record.values.get('items'), MAXIMUM_ITEMS);
		const items: ParadisOfficeSearchItem[] = [];
		let totalTextLength = ownerId.length + handleId.length + revision.length;
		let totalFields = 0;
		for (const candidate of candidates) {
			const item = ownItem(candidate);
			totalTextLength += item.id.length + item.locator.length + item.locationBadge.label.length + (item.navigableAnchor?.length ?? 0);
			totalFields += item.fields.length;
			if (!Number.isSafeInteger(totalFields) || totalFields > MAXIMUM_TOTAL_FIELDS) {
				throw new ParadisOfficeSearchError('invalidInput');
			}
			for (const field of item.fields) {
				totalTextLength += field.text.length;
			}
			if (!Number.isSafeInteger(totalTextLength) || totalTextLength > MAXIMUM_TOTAL_TEXT_LENGTH) {
				throw new ParadisOfficeSearchError('invalidInput');
			}
			items.push(item);
		}
		return Object.freeze({ ownerId, handleId, revision, items: Object.freeze(items) });
	} catch (error) {
		throw sanitizeError(error);
	}
}

function ownHandle(value: ParadisOfficeSearchHandle): ParadisOfficeSearchHandle {
	try {
		const record = ownRecord(value, ['ownerId', 'handleId']);
		return Object.freeze({
			ownerId: boundedString(record.values.get('ownerId'), MAXIMUM_IDENTIFIER_LENGTH),
			handleId: boundedString(record.values.get('handleId'), MAXIMUM_IDENTIFIER_LENGTH),
		});
	} catch (error) {
		throw sanitizeError(error);
	}
}

function ownQuery(value: ParadisOfficeSearchQuery): Required<ParadisOfficeSearchQuery> {
	try {
		const record = ownRecord(value, ['text', 'matchCase'], ['text']);
		const text = boundedString(record.values.get('text'), MAXIMUM_QUERY_LENGTH, true).normalize('NFC').trim();
		const matchCase = record.values.get('matchCase');
		if (matchCase !== undefined && typeof matchCase !== 'boolean') {
			throw new ParadisOfficeSearchError('invalidInput');
		}
		return Object.freeze({ text, matchCase: matchCase ?? false });
	} catch (error) {
		throw sanitizeError(error);
	}
}

function ownItem(value: unknown): ParadisOfficeSearchItem {
	const record = ownRecord(value, ['id', 'locator', 'locationBadge', 'navigableAnchor', 'side', 'fields'], ['id', 'locator', 'locationBadge', 'fields']);
	const badgeRecord = ownRecord(record.values.get('locationBadge'), ['kind', 'label']);
	const badgeKind = badgeRecord.values.get('kind');
	if (typeof badgeKind !== 'string' || !badgeKinds.has(badgeKind as ParadisOfficeSearchResult['locationBadge']['kind'])) {
		throw new ParadisOfficeSearchError('invalidInput');
	}
	const navigableAnchor = optionalBoundedString(record.values.get('navigableAnchor'), MAXIMUM_IDENTIFIER_LENGTH);
	const side = record.values.get('side');
	if (side !== undefined && (typeof side !== 'string' || !sides.has(side as NonNullable<ParadisOfficeSearchResult['side']>))) {
		throw new ParadisOfficeSearchError('invalidInput');
	}
	const fields = ownArray(record.values.get('fields'), MAXIMUM_FIELDS_PER_ITEM).map(ownField);
	return Object.freeze({
		id: boundedString(record.values.get('id'), MAXIMUM_IDENTIFIER_LENGTH),
		locator: boundedString(record.values.get('locator'), MAXIMUM_IDENTIFIER_LENGTH),
		locationBadge: Object.freeze({
			kind: badgeKind as ParadisOfficeSearchResult['locationBadge']['kind'],
			label: boundedString(badgeRecord.values.get('label'), MAXIMUM_LABEL_LENGTH),
		}),
		...(navigableAnchor ? { navigableAnchor } : {}),
		...(side ? { side: side as NonNullable<ParadisOfficeSearchResult['side']> } : {}),
		fields: Object.freeze(fields),
	});
}

function ownField(value: unknown): ParadisOfficeSearchField {
	const record = ownRecord(value, ['kind', 'text']);
	const kind = record.values.get('kind');
	if (typeof kind !== 'string' || !fieldKinds.has(kind as ParadisOfficeSearchFieldKind)) {
		throw new ParadisOfficeSearchError('invalidInput');
	}
	return Object.freeze({ kind: kind as ParadisOfficeSearchFieldKind, text: boundedString(record.values.get('text'), MAXIMUM_TEXT_LENGTH, true) });
}

function ownRecord(value: unknown, allowedKeys: readonly string[], requiredKeys: readonly string[] = allowedKeys): DataRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ParadisOfficeSearchError('invalidInput');
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ParadisOfficeSearchError('invalidInput');
	}
	const keys = Reflect.ownKeys(value);
	if (keys.some(key => typeof key !== 'string') || keys.length > allowedKeys.length || keys.some(key => !allowedKeys.includes(key as string))) {
		throw new ParadisOfficeSearchError('invalidInput');
	}
	const values = new Map<string, unknown>();
	for (const key of keys as string[]) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			throw new ParadisOfficeSearchError('invalidInput');
		}
		values.set(key, descriptor.value);
	}
	if (requiredKeys.some(key => !values.has(key))) {
		throw new ParadisOfficeSearchError('invalidInput');
	}
	return { keys: keys as string[], values };
}

function ownArray(value: unknown, maximumLength: number): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw new ParadisOfficeSearchError('invalidInput');
	}
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
	const length = lengthDescriptor && Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ? lengthDescriptor.value : undefined;
	if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) {
		throw new ParadisOfficeSearchError('invalidInput');
	}
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			throw new ParadisOfficeSearchError('invalidInput');
		}
		result.push(descriptor.value);
	}
	return result;
}

function boundedString(value: unknown, maximumLength: number, allowEmpty = false): string {
	if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximumLength) {
		throw new ParadisOfficeSearchError('invalidInput');
	}
	return value;
}

function optionalBoundedString(value: unknown, maximumLength: number): string | undefined {
	return value === undefined ? undefined : boundedString(value, maximumLength);
}

function boundedDuration(value: number | undefined): number {
	if (value === undefined) {
		return DEFAULT_MAXIMUM_DURATION_MS;
	}
	if (!Number.isFinite(value) || value < 0 || value > 60_000) {
		throw new ParadisOfficeSearchError('invalidInput');
	}
	return value;
}

function sanitizeError(error: unknown): ParadisOfficeSearchError {
	return error instanceof ParadisOfficeSearchError ? error : new ParadisOfficeSearchError('invalidInput');
}
