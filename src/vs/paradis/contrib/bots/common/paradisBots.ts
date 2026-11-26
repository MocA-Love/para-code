/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の台帳（名前・専用フォルダ・エージェントを持って動き続ける担当）の形と、I/O を持たない更新の関数。
//
// Bot の実体は、専用フォルダを cwd にしたターミナルのペインで動くエージェント（Claude Code・Codex など）。
// 台帳は shared process が持ち、`<userData>/paradis/bots/bots.json` に保存する。専用フォルダの場所は
// 名前（{@link IParadisBot.folder}）だけを保存し、パスは保存しない（外を指せないようにするため）。
// 秘密（トークン・ペイントークン）は台帳に書かない。

import { isRecord } from '../../../common/paradisGuards.js';
import { PARADIS_AGENT_KINDS, ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';

/** 保存の版。今より大きい版のファイルは読み取り専用で開く（新しい Para Code が書いたものを壊さない）。 */
export const PARADIS_BOTS_VERSION = 1;

export const PARADIS_BOT_LIMITS = Object.freeze({
	/** Bot の数。 */
	bots: 50,
	name: 64,
	folder: 40,
	/** モデル・強さ・権限の id。 */
	id: 200,
});

/** 顔の色（8 色。画面が色の値へ引き直す。保存するのは名前だけ）。 */
export const PARADIS_BOT_FACE_COLORS = ['blue', 'teal', 'green', 'amber', 'pink', 'violet', 'red', 'orange'] as const;
export type ParadisBotFaceColor = typeof PARADIS_BOT_FACE_COLORS[number];
/** 顔の形（6 種）。 */
export const PARADIS_BOT_FACE_SHAPES = ['circle', 'squircle', 'hex', 'blob', 'drop', 'penta'] as const;
export type ParadisBotFaceShape = typeof PARADIS_BOT_FACE_SHAPES[number];

function faceColor(value: unknown): ParadisBotFaceColor | undefined {
	return PARADIS_BOT_FACE_COLORS.find(color => color === value);
}

function faceShape(value: unknown): ParadisBotFaceShape | undefined {
	return PARADIS_BOT_FACE_SHAPES.find(shape => shape === value);
}

/** 選んでいないときの顔。名前から決まる（同じ名前なら毎回同じ）。 */
export function paradisBotDefaultFace(name: string): { readonly faceColor: ParadisBotFaceColor; readonly faceShape: ParadisBotFaceShape } {
	// FNV-1a（32 ビット）。色と形で別の桁を使い、同じ色の Bot が同じ形に揃わないようにする
	let hash = 0x811c9dc5;
	for (let index = 0; index < name.length; index++) {
		hash = Math.imul(hash ^ name.charCodeAt(index), 0x01000193) >>> 0;
	}
	return {
		faceColor: PARADIS_BOT_FACE_COLORS[hash % PARADIS_BOT_FACE_COLORS.length],
		faceShape: PARADIS_BOT_FACE_SHAPES[Math.floor(hash / PARADIS_BOT_FACE_COLORS.length) % PARADIS_BOT_FACE_SHAPES.length],
	};
}

export interface IParadisBot {
	readonly id: string;
	readonly name: string;
	/** 専用フォルダの名前（`~/.para-code/bots/<folder>`）。作成時に予約し、名前を変えても変えない。 */
	readonly folder: string;
	readonly agent: ParadisAgentKind;
	readonly modelId?: string;
	readonly effortId?: string;
	readonly permissionId?: string;
	/** 一時停止。止めている間は起動せず、問いも「あなたの番」に出さない。 */
	readonly paused: boolean;
	/** ピン留め。Bot の帯を閉じていても見える（どのウィンドウ・スマホでも同じ）。古い保存は false として読む。 */
	readonly pinned: boolean;
	/** 顔の色と形。古い保存・選んでいない Bot は名前から決まる既定（{@link paradisBotDefaultFace}）。 */
	readonly faceColor: ParadisBotFaceColor;
	readonly faceShape: ParadisBotFaceShape;
	readonly createdAt: number;
	readonly updatedAt: number;
	/**
	 * 新しい Para Code が足した欄を持っていた（この版の知らない欄）。読んだ値をそのまま持ち、書き戻すときも
	 * そのまま書く。この Bot は読み取り専用（{@link paradisBotUpdate} が断る）。
	 */
	readonly preserved?: Readonly<Record<string, unknown>>;
}

export interface IParadisBotsState {
	readonly version: number;
	readonly bots: readonly IParadisBot[];
	/**
	 * この版の知らないエージェントの Bot（新しい Para Code が作ったもの）。一覧には出さず、読んだ値をそのまま
	 * 書き戻す。フォルダの名前と id は使用中に数える。
	 */
	readonly unknown?: readonly Readonly<Record<string, unknown>>[];
}

/** この版が知っている Bot の欄。ほかの欄があれば、その Bot は読み取り専用。 */
const KNOWN_BOT_KEYS: ReadonlySet<string> = new Set(['id', 'name', 'folder', 'agent', 'modelId', 'effortId', 'permissionId', 'paused', 'pinned', 'faceColor', 'faceShape', 'createdAt', 'updatedAt']);

function unknownFolders(state: IParadisBotsState): string[] {
	return (state.unknown ?? []).map(value => value.folder).filter((folder): folder is string => typeof folder === 'string');
}

function unknownIds(state: IParadisBotsState): string[] {
	return (state.unknown ?? []).map(value => value.id).filter((id): id is string => typeof id === 'string');
}

export const EMPTY_PARADIS_BOTS_STATE: IParadisBotsState = Object.freeze({ version: PARADIS_BOTS_VERSION, bots: Object.freeze([]) });

export type ParadisBotErrorCode = 'not_found' | 'invalid_argument' | 'limit' | 'read_only';

export type ParadisBotsResult =
	| { readonly ok: true; readonly state: IParadisBotsState; readonly bot: IParadisBot }
	| { readonly ok: false; readonly code: ParadisBotErrorCode; readonly message: string };

function refuse(code: ParadisBotErrorCode, message: string): { readonly ok: false; readonly code: ParadisBotErrorCode; readonly message: string } {
	return { ok: false, code, message };
}

// ---- 名前とフォルダ -----------------------------------------------------------------------------

/**
 * Bot の名前を検める。前後の空白を落とし、空・長すぎ・制御文字入りは undefined。
 * 名前は専用フォルダの指示文に書き込むので、改行を許すとその構造を偽れる。
 */
export function paradisSanitizeBotName(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const name = value.trim();
	return name.length > 0 && name.length <= PARADIS_BOT_LIMITS.name && !/\p{Cc}/u.test(name) ? name : undefined;
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)$/;
const FOLDER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 専用フォルダの名前として正しいか（英小文字・数字・間のハイフンだけ。パスの区切りも `..` も入らない）。 */
export function paradisIsBotFolderName(value: unknown): value is string {
	return typeof value === 'string' && value.length <= PARADIS_BOT_LIMITS.folder + 8 && FOLDER_PATTERN.test(value) && !WINDOWS_RESERVED_NAME.test(value);
}

/** 名前から、どのファイルシステムでも使えるフォルダ名を作る。英数字が残らない名前（日本語だけ等）は `bot`。 */
export function paradisBotFolderName(name: string): string {
	const slug = name
		.normalize('NFKD')
		.toLowerCase()
		// NFKD の後に残る結合文字（アクセント）は消し、ほかの英数字以外はハイフンにまとめる
		.replace(/\p{M}+/gu, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, PARADIS_BOT_LIMITS.folder)
		.replace(/-+$/, '');
	if (slug.length === 0) {
		return 'bot';
	}
	return WINDOWS_RESERVED_NAME.test(slug) ? `${slug}-bot` : slug;
}

/** まだ使われていないフォルダ名を決める（`release`、`release-2`、`release-3`…）。 */
export function paradisReserveBotFolder(name: string, taken: readonly string[]): string {
	const base = paradisBotFolderName(name);
	const used = new Set(taken);
	let folder = base;
	for (let n = 2; used.has(folder); n++) {
		folder = `${base}-${n}`;
	}
	return folder;
}

/**
 * 専用フォルダの中の相対パスを字面で検める。通れば `/` 区切りに揃えた相対パス、外を指しうるものは undefined
 * （絶対パス・ドライブ名・`..`・空の区切り・NUL）。symlink は字面では分からないので、実際に読み書きする側が
 * realpath の後にもう一度包含を確かめる。
 */
export function paradisBotHomeRelativePath(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length === 0 || value.length > 1000 || value.includes('\0')) {
		return undefined;
	}
	const unified = value.replace(/\\/g, '/');
	if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified) || unified.startsWith('~')) {
		return undefined;
	}
	const segments = unified.split('/').filter(segment => segment !== '.');
	if (segments.length === 0 || segments.some(segment => segment.length === 0 || segment === '..')) {
		return undefined;
	}
	return segments.join('/');
}

// ---- 台帳の更新 ---------------------------------------------------------------------------------

export interface IParadisBotCreateInput {
	readonly id: string;
	readonly name: unknown;
	readonly agent: unknown;
	readonly modelId?: unknown;
	readonly effortId?: unknown;
	readonly permissionId?: unknown;
	/** 顔。渡さなければ名前から決まる既定。 */
	readonly faceColor?: unknown;
	readonly faceShape?: unknown;
	/**
	 * 台帳に無くても「使用中」に数えるフォルダ名（ディスクにもうあるフォルダ）。Bot を消してもフォルダは残るので、
	 * 数えないと、消した Bot の人格と記憶のフォルダを新しい Bot が引き継いでしまう。
	 */
	readonly takenFolders?: readonly string[];
}

export interface IParadisBotPatch {
	readonly name?: unknown;
	readonly agent?: unknown;
	/** `null` は「指定なし」へ戻す。 */
	readonly modelId?: unknown;
	readonly effortId?: unknown;
	readonly permissionId?: unknown;
	readonly paused?: unknown;
	readonly pinned?: unknown;
	readonly faceColor?: unknown;
	readonly faceShape?: unknown;
}

function agentKind(value: unknown): ParadisAgentKind | undefined {
	return PARADIS_AGENT_KINDS.find(kind => kind === value);
}

/** 任意の id。undefined は「触らない」、null は「消す」、形が違えば false。 */
function optionalId(value: unknown): string | null | undefined | false {
	if (value === undefined || value === null) {
		return value;
	}
	return typeof value === 'string' && value.length > 0 && value.length <= PARADIS_BOT_LIMITS.id && !/\p{Cc}/u.test(value) ? value : false;
}

function withOptionalIds(bot: IParadisBot, patch: Pick<IParadisBotPatch, 'modelId' | 'effortId' | 'permissionId'>): IParadisBot | undefined {
	const next: { -readonly [K in keyof IParadisBot]: IParadisBot[K] } = { ...bot };
	for (const key of ['modelId', 'effortId', 'permissionId'] as const) {
		const value = optionalId(patch[key]);
		if (value === false) {
			return undefined;
		}
		if (value === null) {
			delete next[key];
		} else if (value !== undefined) {
			next[key] = value;
		}
	}
	return next;
}

function writable(state: IParadisBotsState): boolean {
	return state.version === PARADIS_BOTS_VERSION;
}

export function paradisBotCreate(state: IParadisBotsState, input: IParadisBotCreateInput, now: number): ParadisBotsResult {
	if (!writable(state)) {
		return refuse('read_only', 'The bot list was written by a newer Para Code, so this version does not change it.');
	}
	const name = paradisSanitizeBotName(input.name);
	const agent = agentKind(input.agent);
	if (name === undefined || agent === undefined || input.id.length === 0 || state.bots.some(bot => bot.id === input.id) || unknownIds(state).includes(input.id)
		|| (input.faceColor !== undefined && faceColor(input.faceColor) === undefined) || (input.faceShape !== undefined && faceShape(input.faceShape) === undefined)) {
		return refuse('invalid_argument', `A bot needs a name of up to ${PARADIS_BOT_LIMITS.name} characters and one of these agents: ${PARADIS_AGENT_KINDS.join(', ')}.`);
	}
	if (state.bots.length + (state.unknown?.length ?? 0) >= PARADIS_BOT_LIMITS.bots) {
		return refuse('limit', `There are already ${PARADIS_BOT_LIMITS.bots} bots. Remove one first.`);
	}
	const bot = withOptionalIds({
		id: input.id,
		name,
		folder: paradisReserveBotFolder(name, [...state.bots.map(existing => existing.folder), ...unknownFolders(state), ...(input.takenFolders ?? [])]),
		agent,
		paused: false,
		pinned: false,
		faceColor: faceColor(input.faceColor) ?? paradisBotDefaultFace(name).faceColor,
		faceShape: faceShape(input.faceShape) ?? paradisBotDefaultFace(name).faceShape,
		createdAt: now,
		updatedAt: now,
	}, input);
	if (bot === undefined) {
		return refuse('invalid_argument', 'The model, effort or permission id is not valid.');
	}
	return { ok: true, state: { ...state, bots: [...state.bots, bot] }, bot };
}

export function paradisBotUpdate(state: IParadisBotsState, id: string, patch: IParadisBotPatch, now: number): ParadisBotsResult {
	if (!writable(state)) {
		return refuse('read_only', 'The bot list was written by a newer Para Code, so this version does not change it.');
	}
	const current = state.bots.find(bot => bot.id === id);
	if (current === undefined) {
		return refuse('not_found', 'There is no such bot.');
	}
	if (current.preserved !== undefined) {
		return refuse('read_only', 'This bot was changed by a newer Para Code, so this version does not change it.');
	}
	const name = patch.name === undefined ? current.name : paradisSanitizeBotName(patch.name);
	const agent = patch.agent === undefined ? current.agent : agentKind(patch.agent);
	const next = withOptionalIds(current, patch);
	if (name === undefined || agent === undefined || next === undefined || (patch.paused !== undefined && typeof patch.paused !== 'boolean') || (patch.pinned !== undefined && typeof patch.pinned !== 'boolean')
		|| (patch.faceColor !== undefined && faceColor(patch.faceColor) === undefined) || (patch.faceShape !== undefined && faceShape(patch.faceShape) === undefined)) {
		return refuse('invalid_argument', 'The change to the bot is not valid.');
	}
	const bot: IParadisBot = {
		...next,
		name,
		agent,
		paused: typeof patch.paused === 'boolean' ? patch.paused : current.paused,
		pinned: typeof patch.pinned === 'boolean' ? patch.pinned : current.pinned,
		faceColor: faceColor(patch.faceColor) ?? current.faceColor,
		faceShape: faceShape(patch.faceShape) ?? current.faceShape,
		updatedAt: now,
	};
	return { ok: true, state: { ...state, bots: state.bots.map(existing => existing.id === id ? bot : existing) }, bot };
}

/** 台帳から外す。専用フォルダは消さない（人格メモと記憶は利用者のもの）。 */
export function paradisBotRemove(state: IParadisBotsState, id: string): ParadisBotsResult {
	if (!writable(state)) {
		return refuse('read_only', 'The bot list was written by a newer Para Code, so this version does not change it.');
	}
	const bot = state.bots.find(existing => existing.id === id);
	if (bot === undefined) {
		return refuse('not_found', 'There is no such bot.');
	}
	return { ok: true, state: { ...state, bots: state.bots.filter(existing => existing.id !== id) }, bot };
}

// ---- 保存した値の読み込み ------------------------------------------------------------------------

/** 読んだ 1 件。この版の知らないエージェントなら `unknown`（読んだ値のまま残す）。 */
function storedBot(value: unknown): { readonly kind: 'bot'; readonly bot: IParadisBot } | { readonly kind: 'unknown'; readonly value: Readonly<Record<string, unknown>>; readonly id: string; readonly folder: string } | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (agentKind(value.agent) === undefined && typeof value.agent === 'string' && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= PARADIS_BOT_LIMITS.id && paradisIsBotFolderName(value.folder)) {
		return { kind: 'unknown', value, id: value.id, folder: value.folder };
	}
	const name = paradisSanitizeBotName(value.name);
	const agent = agentKind(value.agent);
	const time = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
	const createdAt = time(value.createdAt);
	const updatedAt = time(value.updatedAt);
	if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > PARADIS_BOT_LIMITS.id || name === undefined || agent === undefined
		|| !paradisIsBotFolderName(value.folder) || typeof value.paused !== 'boolean' || createdAt === undefined || updatedAt === undefined) {
		return undefined;
	}
	// ピン留めは後から足した欄なので、無い（古い保存）・形の違う値は false として読む
	// 顔も後から足した欄なので、無い・選べる値でないときは名前から決まる既定として読む
	const face = paradisBotDefaultFace(name);
	const bot = withOptionalIds({
		id: value.id,
		name,
		folder: value.folder,
		agent,
		paused: value.paused,
		pinned: value.pinned === true,
		faceColor: faceColor(value.faceColor) ?? face.faceColor,
		faceShape: faceShape(value.faceShape) ?? face.faceShape,
		createdAt,
		updatedAt,
	}, {
		modelId: value.modelId ?? undefined,
		effortId: value.effortId ?? undefined,
		permissionId: value.permissionId ?? undefined,
	});
	if (bot === undefined) {
		return undefined;
	}
	return { kind: 'bot', bot: Object.keys(value).some(key => !KNOWN_BOT_KEYS.has(key)) ? { ...bot, preserved: value } : bot };
}

/** 書き出す形。知らない欄を持っていた Bot と知らないエージェントの Bot は、読んだ値をそのまま書く。 */
export function paradisBotsToStored(state: IParadisBotsState): unknown {
	return { version: state.version, bots: [...state.bots.map(bot => bot.preserved ?? bot), ...(state.unknown ?? [])] };
}

/**
 * 読んだ JSON を台帳の形へ直す。形の違う 1 件・id やフォルダが重なる 1 件は捨てる（1 件の破損で全部を失わない）。
 * 全体の形が違えば undefined（呼び出し側が別名へ退避する）。今より新しい版は、版の番号を保って返す
 * （{@link paradisBotCreate} などが書き込みを断る）。
 */
export function paradisParseBotsState(value: unknown): IParadisBotsState | undefined {
	if (!isRecord(value) || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1 || !Array.isArray(value.bots)) {
		return undefined;
	}
	const bots: IParadisBot[] = [];
	const unknown: Readonly<Record<string, unknown>>[] = [];
	const ids = new Set<string>();
	const folders = new Set<string>();
	for (const candidate of value.bots) {
		const read = storedBot(candidate);
		const key = read?.kind === 'bot' ? read.bot : read;
		if (read === undefined || key === undefined || ids.has(key.id) || folders.has(key.folder) || bots.length + unknown.length >= PARADIS_BOT_LIMITS.bots) {
			continue;
		}
		ids.add(key.id);
		folders.add(key.folder);
		if (read.kind === 'unknown') {
			unknown.push(read.value);
		} else {
			bots.push(read.bot);
		}
	}
	return { version: value.version, bots, ...(unknown.length > 0 ? { unknown } : {}) };
}
