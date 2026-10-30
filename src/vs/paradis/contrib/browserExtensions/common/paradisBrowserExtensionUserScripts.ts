/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// chrome.userScripts（P9b）の、main と詰め物が共に使う決まり（形の確かめ・保存の形・上限）。Electron に無いので Para Code が作る。
// 形と文は Chromium の user_scripts の API（extensions/browser/api/user_scripts）に合わせる。

/** preload との約束（../electron-browser/paradisUserScriptsPreload.ts と同じ名前。テストが一致を確かめる）。 */
export const PARADIS_USER_SCRIPTS_QUERY = 'paradis:userScriptsQuery';
export const PARADIS_USER_SCRIPTS_RECHECK = 'paradis:userScriptsRecheck';
export const PARADIS_USER_SCRIPTS_CALL = 'paradis:userScriptsCall';
export const PARADIS_USER_SCRIPTS_EVENT = 'paradis:userScriptsEvent';

/** 注入する時。 */
export type ParadisUserScriptRunAt = 'document_start' | 'document_end' | 'document_idle';
/** 注入する world。 */
export type ParadisUserScriptWorld = 'USER_SCRIPT' | 'MAIN';

/** 1 つの js（中身か、拡張機能の中のファイル）。 */
export interface IParadisUserScriptSource {
	readonly code?: string;
	readonly file?: string;
}

/** 登録したユーザースクリプト（chrome.userScripts.RegisteredUserScript）。 */
export interface IParadisRegisteredUserScript {
	readonly id: string;
	readonly matches: readonly string[];
	readonly excludeMatches?: readonly string[];
	readonly includeGlobs?: readonly string[];
	readonly excludeGlobs?: readonly string[];
	readonly js: readonly IParadisUserScriptSource[];
	readonly runAt: ParadisUserScriptRunAt;
	readonly allFrames: boolean;
	readonly world: ParadisUserScriptWorld;
	/** USER_SCRIPT の world を分ける名前（無ければ既定の world）。 */
	readonly worldId?: string;
}

/** USER_SCRIPT の world の設定（chrome.userScripts.WorldProperties）。 */
export interface IParadisUserScriptWorldConfig {
	/** 無ければ既定の world。 */
	readonly worldId?: string;
	readonly csp?: string;
	readonly messaging?: boolean;
}

/** 1 つの拡張機能の、1 つの場所での登録。 */
export interface IParadisUserScriptRegistrations {
	readonly scripts: readonly IParadisRegisteredUserScript[];
	readonly worlds: readonly IParadisUserScriptWorldConfig[];
}

/** 1 つの拡張機能の登録の上限（保存の形は JSON で、注入のたびに main が読む）。 */
export const PARADIS_USER_SCRIPTS_MAX_SCRIPTS = 5_000;
/** 1 つの拡張機能・1 つの場所の `code` の合計の上限（文字）。 */
export const PARADIS_USER_SCRIPTS_MAX_CODE_CHARS = 32 * 1024 * 1024;
/** world の設定の上限（Chromium も world の数に上限がある）。 */
export const PARADIS_USER_SCRIPTS_MAX_WORLDS = 100;
const MAX_ID_CHARS = 1_000;
const MAX_PATTERNS = 1_000;
const MAX_PATTERN_CHARS = 2_048;
const MAX_CSP_CHARS = 10_000;

/** USER_SCRIPT の既定の world の CSP（Chromium の MV3 の isolated world の既定と同じ）。 */
export const PARADIS_USER_SCRIPTS_DEFAULT_CSP = 'script-src \'self\' \'wasm-unsafe-eval\'; object-src \'self\';';

/** 断るときに投げる（文は拡張機能へ届く）。 */
export class ParadisUserScriptsError extends Error { }

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Chrome の match pattern として読めるか（当たるかは main の paradisMatchesUrlPattern が見る）。 */
export function paradisIsUserScriptMatchPattern(pattern: string): boolean {
	return pattern === '<all_urls>' || /^(\*|https?|wss?|file|ftp|urn):\/\/(\*|\*\.[^/*]+|[^/*]+)?\/.*$/.test(pattern);
}

/** include・exclude の glob（`*` は何文字でも、`?` は 1 文字）に URL が当たるか。 */
export function paradisMatchesUserScriptGlob(glob: string, url: string): boolean {
	const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
	return new RegExp(`^${source}$`, 's').test(url);
}

function stringList(script: Record<string, unknown>, key: string, id: string, patterns: boolean): string[] | undefined {
	const value = script[key];
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.length > MAX_PATTERNS || value.some(entry => typeof entry !== 'string' || entry.length > MAX_PATTERN_CHARS)) {
		throw new ParadisUserScriptsError(`Script with ID '${id}' has an invalid value for '${key}'.`);
	}
	const list = value as string[];
	if (patterns) {
		const index = list.findIndex(pattern => !paradisIsUserScriptMatchPattern(pattern));
		if (index !== -1) {
			throw new ParadisUserScriptsError(`Script with ID '${id}' has invalid value for ${key}[${index}]: Invalid scheme or missing path.`);
		}
	}
	return [...list];
}

function sources(script: Record<string, unknown>, id: string): IParadisUserScriptSource[] | undefined {
	const value = script.js;
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new ParadisUserScriptsError(`Script with ID '${id}' has an invalid value for 'js'.`);
	}
	return value.map(entry => {
		const source = isRecord(entry) ? entry : {};
		const hasCode = typeof source.code === 'string';
		const hasFile = typeof source.file === 'string';
		if (hasCode === hasFile) {
			throw new ParadisUserScriptsError(`User script with ID '${id}' must specify exactly one of 'code' or 'file' as a js source.`);
		}
		return hasCode ? { code: source.code as string } : { file: source.file as string };
	});
}

function worldIdOf(value: unknown, what: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
		throw new ParadisUserScriptsError(`${what}: invalid worldId.`);
	}
	if (value.startsWith('_')) {
		throw new ParadisUserScriptsError(`${what}: worldId must not start with '_'.`);
	}
	return value;
}

/** register・update の 1 件を読む（update では書いていない項目を undefined のままにする）。 */
function readScript(value: unknown, mode: 'register' | 'update'): Partial<IParadisRegisteredUserScript> & { readonly id: string } {
	const script = isRecord(value) ? value : {};
	const id = script.id;
	if (typeof id !== 'string' || id.length === 0) {
		throw new ParadisUserScriptsError('Script\'s ID must not be empty');
	}
	if (id.length > MAX_ID_CHARS) {
		throw new ParadisUserScriptsError(`Script with ID '${id.slice(0, 40)}...' has a too long ID.`);
	}
	if (id.startsWith('_')) {
		throw new ParadisUserScriptsError(`Script's ID '${id}' must not start with '_'`);
	}
	const runAt = script.runAt;
	if (runAt !== undefined && runAt !== 'document_start' && runAt !== 'document_end' && runAt !== 'document_idle') {
		throw new ParadisUserScriptsError(`Script with ID '${id}' has an invalid value for 'runAt'.`);
	}
	const world = script.world;
	if (world !== undefined && world !== 'USER_SCRIPT' && world !== 'MAIN') {
		throw new ParadisUserScriptsError(`Script with ID '${id}' has an invalid value for 'world'.`);
	}
	if (script.allFrames !== undefined && typeof script.allFrames !== 'boolean') {
		throw new ParadisUserScriptsError(`Script with ID '${id}' has an invalid value for 'allFrames'.`);
	}
	const worldId = worldIdOf(script.worldId, `Script with ID '${id}'`);
	if (worldId !== undefined && world === 'MAIN') {
		throw new ParadisUserScriptsError(`Script with ID '${id}': worldId can only be used with the USER_SCRIPT world.`);
	}
	const matches = stringList(script, 'matches', id, true);
	const js = sources(script, id);
	if (mode === 'register') {
		if (!matches || matches.length === 0) {
			throw new ParadisUserScriptsError(`Script with ID '${id}' must specify at least one match.`);
		}
		if (!js || js.length === 0) {
			throw new ParadisUserScriptsError(`Script with ID '${id}' must specify at least one js source.`);
		}
	}
	const read: { -readonly [K in keyof IParadisRegisteredUserScript]?: IParadisRegisteredUserScript[K] } & { id: string } = { id };
	if (matches) {
		read.matches = matches;
	}
	const excludeMatches = stringList(script, 'excludeMatches', id, true);
	if (excludeMatches) {
		read.excludeMatches = excludeMatches;
	}
	const includeGlobs = stringList(script, 'includeGlobs', id, false);
	if (includeGlobs) {
		read.includeGlobs = includeGlobs;
	}
	const excludeGlobs = stringList(script, 'excludeGlobs', id, false);
	if (excludeGlobs) {
		read.excludeGlobs = excludeGlobs;
	}
	if (js) {
		read.js = js;
	}
	if (runAt !== undefined) {
		read.runAt = runAt;
	}
	if (world !== undefined) {
		read.world = world;
	}
	if (typeof script.allFrames === 'boolean') {
		read.allFrames = script.allFrames;
	}
	if (worldId !== undefined) {
		read.worldId = worldId;
	}
	return read;
}

function codeChars(scripts: readonly IParadisRegisteredUserScript[]): number {
	let total = 0;
	for (const script of scripts) {
		for (const source of script.js) {
			total += source.code?.length ?? 0;
		}
	}
	return total;
}

function checkLimits(scripts: readonly IParadisRegisteredUserScript[]): void {
	if (scripts.length > PARADIS_USER_SCRIPTS_MAX_SCRIPTS) {
		throw new ParadisUserScriptsError(`Para Code keeps at most ${PARADIS_USER_SCRIPTS_MAX_SCRIPTS} user scripts per extension.`);
	}
	if (codeChars(scripts) > PARADIS_USER_SCRIPTS_MAX_CODE_CHARS) {
		throw new ParadisUserScriptsError('The user scripts of this extension are too large for Para Code.');
	}
}

function ensureUniqueIds(list: readonly { readonly id: string }[]): void {
	const seen = new Set<string>();
	for (const { id } of list) {
		if (seen.has(id)) {
			throw new ParadisUserScriptsError(`Duplicate script ID '${id}'`);
		}
		seen.add(id);
	}
}

/** chrome.userScripts.register: 今の登録に足した結果（同じ id があれば断る）。 */
export function paradisRegisterUserScripts(current: readonly IParadisRegisteredUserScript[], input: unknown): IParadisRegisteredUserScript[] {
	if (!Array.isArray(input)) {
		throw new ParadisUserScriptsError('Invalid arguments');
	}
	const added = input.map(value => readScript(value, 'register'));
	ensureUniqueIds(added);
	const existing = new Set(current.map(script => script.id));
	const clash = added.find(script => existing.has(script.id));
	if (clash) {
		throw new ParadisUserScriptsError(`Duplicate script ID '${clash.id}'`);
	}
	const next = [...current, ...added.map(script => ({
		id: script.id,
		matches: script.matches!,
		...(script.excludeMatches ? { excludeMatches: script.excludeMatches } : {}),
		...(script.includeGlobs ? { includeGlobs: script.includeGlobs } : {}),
		...(script.excludeGlobs ? { excludeGlobs: script.excludeGlobs } : {}),
		js: script.js!,
		runAt: script.runAt ?? 'document_idle',
		allFrames: script.allFrames ?? false,
		world: script.world ?? 'USER_SCRIPT',
		...(script.worldId !== undefined ? { worldId: script.worldId } : {}),
	} satisfies IParadisRegisteredUserScript))];
	checkLimits(next);
	return next;
}

/** chrome.userScripts.update: 書いた項目だけを替えた結果（無い id は断る）。 */
export function paradisUpdateUserScripts(current: readonly IParadisRegisteredUserScript[], input: unknown): IParadisRegisteredUserScript[] {
	if (!Array.isArray(input)) {
		throw new ParadisUserScriptsError('Invalid arguments');
	}
	const changes = input.map(value => readScript(value, 'update'));
	ensureUniqueIds(changes);
	const byId = new Map(changes.map(change => [change.id, change]));
	const missing = changes.find(change => !current.some(script => script.id === change.id));
	if (missing) {
		throw new ParadisUserScriptsError(`Script with ID '${missing.id}' does not exist or is not fully registered`);
	}
	const next = current.map(script => {
		const change = byId.get(script.id);
		if (!change) {
			return script;
		}
		const merged = { ...script, ...change };
		if (merged.world === 'MAIN' && merged.worldId !== undefined) {
			throw new ParadisUserScriptsError(`Script with ID '${script.id}': worldId can only be used with the USER_SCRIPT world.`);
		}
		if (merged.matches.length === 0) {
			throw new ParadisUserScriptsError(`Script with ID '${script.id}' must specify at least one match.`);
		}
		if (merged.js.length === 0) {
			throw new ParadisUserScriptsError(`Script with ID '${script.id}' must specify at least one js source.`);
		}
		return merged;
	});
	checkLimits(next);
	return next;
}

/** UserScriptFilter（`ids` が無ければすべて）。 */
export function paradisUserScriptFilterIds(filter: unknown): ReadonlySet<string> | undefined {
	if (filter === undefined || filter === null) {
		return undefined;
	}
	if (!isRecord(filter)) {
		throw new ParadisUserScriptsError('Invalid arguments');
	}
	if (filter.ids === undefined) {
		return undefined;
	}
	if (!Array.isArray(filter.ids) || filter.ids.some(id => typeof id !== 'string')) {
		throw new ParadisUserScriptsError('Invalid arguments');
	}
	return new Set(filter.ids as string[]);
}

/** chrome.userScripts.configureWorld: world の設定を置き換えた結果。 */
export function paradisConfigureUserScriptWorld(current: readonly IParadisUserScriptWorldConfig[], input: unknown): IParadisUserScriptWorldConfig[] {
	if (!isRecord(input)) {
		throw new ParadisUserScriptsError('Invalid arguments');
	}
	const worldId = worldIdOf(input.worldId, 'configureWorld');
	if (input.csp !== undefined && (typeof input.csp !== 'string' || input.csp.length > MAX_CSP_CHARS)) {
		throw new ParadisUserScriptsError('configureWorld: invalid csp.');
	}
	if (input.messaging !== undefined && typeof input.messaging !== 'boolean') {
		throw new ParadisUserScriptsError('configureWorld: invalid messaging.');
	}
	const config: IParadisUserScriptWorldConfig = {
		...(worldId !== undefined ? { worldId } : {}),
		...(typeof input.csp === 'string' ? { csp: input.csp } : {}),
		...(typeof input.messaging === 'boolean' ? { messaging: input.messaging } : {}),
	};
	const next = [...current.filter(world => world.worldId !== worldId), config];
	if (next.length > PARADIS_USER_SCRIPTS_MAX_WORLDS) {
		throw new ParadisUserScriptsError(`Para Code keeps at most ${PARADIS_USER_SCRIPTS_MAX_WORLDS} user script worlds per extension.`);
	}
	return next;
}

/**
 * world の、今効いている設定。名前の付いた world に設定が無ければ、既定の world の設定を使う（Chromium と同じ）。
 */
export function paradisEffectiveUserScriptWorld(worlds: readonly IParadisUserScriptWorldConfig[], worldId: string | undefined): { readonly csp: string; readonly messaging: boolean } {
	const own = worldId !== undefined ? worlds.find(world => world.worldId === worldId) : undefined;
	const fallback = worlds.find(world => world.worldId === undefined);
	const config = own ?? fallback;
	return { csp: config?.csp ?? PARADIS_USER_SCRIPTS_DEFAULT_CSP, messaging: config?.messaging ?? false };
}

/** 保存した登録を読む（形の違うものは捨てる。保存したのは main が確かめたものなので、壊れたときだけ捨てる）。 */
export function paradisParseUserScriptRegistrations(value: unknown): IParadisUserScriptRegistrations {
	const record = isRecord(value) ? value : {};
	let scripts: IParadisRegisteredUserScript[] = [];
	try {
		scripts = paradisRegisterUserScripts([], Array.isArray(record.scripts) ? record.scripts : []);
	} catch {
		scripts = [];
	}
	let worlds: IParadisUserScriptWorldConfig[] = [];
	for (const world of Array.isArray(record.worlds) ? record.worlds : []) {
		try {
			worlds = paradisConfigureUserScriptWorld(worlds, world);
		} catch {
			// 壊れた設定は捨てる
		}
	}
	return { scripts, worlds };
}

/** そのフレームの URL に当たる登録か（`matches` で当たり、`excludeMatches` で外れず、glob の条件も満たす）。 */
export function paradisUserScriptApplies(script: IParadisRegisteredUserScript, url: string, isTopFrame: boolean, matchesPattern: (pattern: string, url: string) => boolean): boolean {
	if (!isTopFrame && !script.allFrames) {
		return false;
	}
	if (!script.matches.some(pattern => matchesPattern(pattern, url))) {
		return false;
	}
	if (script.excludeMatches?.some(pattern => matchesPattern(pattern, url))) {
		return false;
	}
	if (script.includeGlobs?.length && !script.includeGlobs.some(glob => paradisMatchesUserScriptGlob(glob, url))) {
		return false;
	}
	return !script.excludeGlobs?.some(glob => paradisMatchesUserScriptGlob(glob, url));
}

/**
 * ユーザースクリプトを入れない URL。http・https 以外（拡張機能のページ・file・data など）と、Chrome ウェブストア
 * （Chrome も拡張機能のスクリプトを入れない。Para Code はそこにストアの橋を出す）。
 */
export function paradisIsUserScriptTargetUrl(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return false;
	}
	const host = url.hostname.toLowerCase();
	if (host === 'chromewebstore.google.com' || (host === 'chrome.google.com' && (url.pathname === '/webstore' || url.pathname.startsWith('/webstore/')))) {
		return false;
	}
	return url.origin !== 'null';
}
