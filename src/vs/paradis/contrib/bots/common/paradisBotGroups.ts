/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot グループの台帳（名前・メンバーの Bot・返事をする Bot の決め方）と、グループの記録（あなたが送った・
// Bot が別の Bot に聞いた・伝えた）の形と、I/O を持たない更新の関数。
//
// 台帳は shared process が `<userData>/paradis/bots/groups.json` に持つ（Bot の台帳とは別のファイル。Bot の台帳に
// 欄を足すと、古い Para Code がその Bot を読み取り専用にしてしまうため）。グループは案 B（Bot のペインを並べて、
// 上の 1 行から名指しで送る）で始め、後で部屋のページ（案 A）でも同じ台帳と記録を使う。

import { isRecord } from '../../../common/paradisGuards.js';
import type { IParadisBotInboxEntry } from './paradisBotMessages.js';

/** 保存の版。今より大きい版のファイルは読み取り専用で開く。 */
export const PARADIS_BOT_GROUPS_VERSION = 1;

export const PARADIS_BOT_GROUP_LIMITS = Object.freeze({
	groups: 20,
	/** 1 つのグループの Bot の数（ペインを並べて読める数）。 */
	members: 4,
	name: 64,
	/** 記録はグループをまたいで新しい方からこの数だけ残す（まだ読まれていない Bot 同士の伝言は数を超えても残す）。 */
	records: 300,
	/** 記録の 1 件の本文（長い文は切って残す。送る文そのものは切らない）。 */
	recordText: 2000,
	id: 200,
});

/**
 * 返事をする Bot の決め方。名指しの無い投稿を、`mentioned` は送らない（「@名前」を求める）、`all` は全員へ送る。
 * 「@全員」はどちらでも全員。
 */
export type ParadisBotGroupReplyMode = 'mentioned' | 'all';
export const PARADIS_BOT_GROUP_REPLY_MODES: readonly ParadisBotGroupReplyMode[] = ['mentioned', 'all'];

export interface IParadisBotGroup {
	readonly id: string;
	readonly name: string;
	/** メンバーの Bot の id（並べる順）。消えた Bot は画面の側で除いて見せる（{@link paradisBotGroupMembers}）。 */
	readonly members: readonly string[];
	readonly replyMode: ParadisBotGroupReplyMode;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/**
 * 記録の種類。`sent` はあなたがグループの入力欄から送った、`asked` は Bot が別の Bot に聞いた、`told` は Bot が
 * 別の Bot に伝えた（Bot 同士の伝言の道具が書く）。
 */
export type ParadisBotGroupRecordKind = 'sent' | 'asked' | 'told';
export const PARADIS_BOT_GROUP_RECORD_KINDS: readonly ParadisBotGroupRecordKind[] = ['sent', 'asked', 'told'];

/** 記録の送り手が「あなた」であることを表す値（Bot の id とは重ならない）。 */
export const PARADIS_BOT_GROUP_OWNER = 'owner';

export interface IParadisBotGroupRecord {
	readonly id: number;
	readonly groupId: string;
	readonly kind: ParadisBotGroupRecordKind;
	/** あなた（{@link PARADIS_BOT_GROUP_OWNER}）か、送った Bot の id。 */
	readonly from: string;
	/**
	 * 宛先の Bot の id。あなたの `sent` は実際に届いた Bot だけを入れる。Bot 同士の伝言（`asked`・`told`）は宛先の受け箱に
	 * 入り、宛先が読んだら {@link readAt} が付く。
	 */
	readonly to: readonly string[];
	readonly text: string;
	readonly at: number;
	/** 宛先の Bot が受け箱から読んだ時刻（{@link paradisBotGroupMarkRead}）。 */
	readonly readAt?: number;
	/**
	 * 読まれる前に宛先の Bot がグループから外れた・消えた時刻。記録は部屋に残し（「読まれなかった」）、受け箱と未読の数からは
	 * 外す。上限で刈るときは既読と同じに扱う。
	 */
	readonly droppedAt?: number;
}

export interface IParadisBotGroupsState {
	readonly version: number;
	readonly groups: readonly IParadisBotGroup[];
	readonly records: readonly IParadisBotGroupRecord[];
	readonly nextRecordId: number;
}

export const EMPTY_PARADIS_BOT_GROUPS_STATE: IParadisBotGroupsState = Object.freeze({ version: PARADIS_BOT_GROUPS_VERSION, groups: Object.freeze([]), records: Object.freeze([]), nextRecordId: 1 });

export type ParadisBotGroupErrorCode = 'not_found' | 'invalid_argument' | 'limit' | 'read_only' | 'not_a_member';

export type ParadisBotGroupsResult<T> =
	| { readonly ok: true; readonly state: IParadisBotGroupsState; readonly value: T }
	| { readonly ok: false; readonly code: ParadisBotGroupErrorCode; readonly message: string };

function refuse(code: ParadisBotGroupErrorCode, message: string): { readonly ok: false; readonly code: ParadisBotGroupErrorCode; readonly message: string } {
	return { ok: false, code, message };
}

function writable(state: IParadisBotGroupsState): boolean {
	return state.version === PARADIS_BOT_GROUPS_VERSION;
}

const READ_ONLY = 'The bot groups were written by a newer Para Code, so this version does not change them.';

/** グループの名前を検める。前後の空白を落とし、空・長すぎ・制御文字入りは undefined。 */
export function paradisSanitizeBotGroupName(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const name = value.trim();
	return name.length > 0 && name.length <= PARADIS_BOT_GROUP_LIMITS.name && !/\p{Cc}/u.test(name) ? name : undefined;
}

function isId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= PARADIS_BOT_GROUP_LIMITS.id && !/\p{Cc}/u.test(value);
}

/** メンバーの並びを検める。重なりを除き、2 人以上・上限以下でなければ undefined。 */
function memberList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every(isId)) {
		return undefined;
	}
	const members = [...new Set(value)];
	return members.length >= 2 && members.length <= PARADIS_BOT_GROUP_LIMITS.members ? members : undefined;
}

function replyMode(value: unknown): ParadisBotGroupReplyMode | undefined {
	return PARADIS_BOT_GROUP_REPLY_MODES.find(mode => mode === value);
}

export interface IParadisBotGroupInput {
	readonly name: unknown;
	readonly members: unknown;
	readonly replyMode?: unknown;
}

export function paradisBotGroupCreate(state: IParadisBotGroupsState, id: string, input: IParadisBotGroupInput, now: number): ParadisBotGroupsResult<IParadisBotGroup> {
	if (!writable(state)) {
		return refuse('read_only', READ_ONLY);
	}
	const name = paradisSanitizeBotGroupName(input.name);
	const members = memberList(input.members);
	const mode = input.replyMode === undefined ? 'mentioned' : replyMode(input.replyMode);
	if (!isId(id) || state.groups.some(group => group.id === id) || name === undefined || members === undefined || mode === undefined) {
		return refuse('invalid_argument', `A group needs a name of up to ${PARADIS_BOT_GROUP_LIMITS.name} characters and 2 to ${PARADIS_BOT_GROUP_LIMITS.members} bots.`);
	}
	if (state.groups.length >= PARADIS_BOT_GROUP_LIMITS.groups) {
		return refuse('limit', `There are already ${PARADIS_BOT_GROUP_LIMITS.groups} groups. Remove one first.`);
	}
	const group: IParadisBotGroup = { id, name, members, replyMode: mode, createdAt: now, updatedAt: now };
	return { ok: true, state: { ...state, groups: [...state.groups, group] }, value: group };
}

export function paradisBotGroupUpdate(state: IParadisBotGroupsState, id: string, patch: Partial<IParadisBotGroupInput>, now: number): ParadisBotGroupsResult<IParadisBotGroup> {
	if (!writable(state)) {
		return refuse('read_only', READ_ONLY);
	}
	const current = state.groups.find(group => group.id === id);
	if (current === undefined) {
		return refuse('not_found', 'There is no such group.');
	}
	const name = patch.name === undefined ? current.name : paradisSanitizeBotGroupName(patch.name);
	const members = patch.members === undefined ? current.members : memberList(patch.members);
	const mode = patch.replyMode === undefined ? current.replyMode : replyMode(patch.replyMode);
	if (name === undefined || members === undefined || mode === undefined) {
		return refuse('invalid_argument', 'The change to the group is not valid.');
	}
	const group: IParadisBotGroup = { ...current, name, members, replyMode: mode, updatedAt: now };
	// 外した Bot 宛てのまだ読まれていない伝言は「読まれなかった」にする（入れ直したときに古い未読が受け箱へ戻らないように。
	// 記録は部屋に残す）
	const removed = new Set(current.members.filter(member => !members.includes(member)));
	const records = removed.size === 0 ? state.records : state.records.map(record => record.groupId === id && isUnreadOnlyFor(record, removed) ? { ...record, droppedAt: now } : record);
	return { ok: true, state: { ...state, groups: state.groups.map(existing => existing.id === id ? group : existing), records }, value: group };
}

/**
 * 消した Bot 宛てのまだ読まれていない伝言を、すべてのグループで「読まれなかった」にする（消した Bot は読めず、メンバーの
 * 並びには id が残るので、そのままでは上限で刈る対象にも入らない）。記録は部屋に残す。印を付けた数を返す。付ける物が
 * 無ければ書かない（`not_found`）。メンバーの並びは変えない（2 人のグループが 1 人になると読み込みで捨てられるため。
 * 画面は {@link paradisBotGroupMembers} で除いて見せる）。
 */
export function paradisBotGroupForgetBot(state: IParadisBotGroupsState, botId: string, now: number): ParadisBotGroupsResult<number> {
	if (!writable(state)) {
		return refuse('read_only', READ_ONLY);
	}
	const removed = new Set([botId]);
	let count = 0;
	const records = state.records.map(record => {
		if (!isUnreadOnlyFor(record, removed)) {
			return record;
		}
		count++;
		return { ...record, droppedAt: now };
	});
	return count === 0 ? refuse('not_found', 'There is no unread message for the bot.') : { ok: true, state: { ...state, records }, value: count };
}

/** まだ読まれていない Bot 同士の伝言で、宛先（1 つ以上）がすべて `botIds` の中か。 */
function isUnreadOnlyFor(record: IParadisBotGroupRecord, botIds: ReadonlySet<string>): boolean {
	return record.kind !== 'sent' && record.readAt === undefined && record.droppedAt === undefined && record.to.length > 0 && record.to.every(id => botIds.has(id));
}

/** グループと、その記録を消す（Bot と Bot の専用フォルダには触れない）。 */
export function paradisBotGroupRemove(state: IParadisBotGroupsState, id: string): ParadisBotGroupsResult<IParadisBotGroup> {
	if (!writable(state)) {
		return refuse('read_only', READ_ONLY);
	}
	const group = state.groups.find(existing => existing.id === id);
	if (group === undefined) {
		return refuse('not_found', 'There is no such group.');
	}
	return { ok: true, state: { ...state, groups: state.groups.filter(existing => existing.id !== id), records: state.records.filter(record => record.groupId !== id) }, value: group };
}

export interface IParadisBotGroupRecordInput {
	readonly kind: ParadisBotGroupRecordKind;
	readonly from: string;
	readonly to: readonly string[];
	readonly text: string;
}

/**
 * 記録を 1 件足す。送り手はあなたかメンバーの Bot、宛先は 1 人以上のメンバー（送り手自身は宛先にできない）。
 * あなたの記録は `sent` だけ、Bot の記録は `asked`・`told` だけ。本文は {@link PARADIS_BOT_GROUP_LIMITS.recordText}
 * 字で切って残し、古い記録は上限を超えた分から捨てる。
 */
export function paradisBotGroupAppendRecord(state: IParadisBotGroupsState, groupId: string, input: IParadisBotGroupRecordInput, now: number): ParadisBotGroupsResult<IParadisBotGroupRecord> {
	if (!writable(state)) {
		return refuse('read_only', READ_ONLY);
	}
	const group = state.groups.find(existing => existing.id === groupId);
	if (group === undefined) {
		return refuse('not_found', 'There is no such group.');
	}
	const fromOwner = input.from === PARADIS_BOT_GROUP_OWNER;
	if (!PARADIS_BOT_GROUP_RECORD_KINDS.includes(input.kind) || fromOwner !== (input.kind === 'sent') || typeof input.text !== 'string' || input.text.trim().length === 0
		|| !Array.isArray(input.to) || input.to.length === 0) {
		return refuse('invalid_argument', 'The record is not valid.');
	}
	const to = [...new Set(input.to)];
	if ((!fromOwner && !group.members.includes(input.from)) || to.some(id => !group.members.includes(id) || id === input.from)) {
		return refuse('not_a_member', 'Only the bots in the group can send or receive messages in it.');
	}
	const record: IParadisBotGroupRecord = { id: state.nextRecordId, groupId, kind: input.kind, from: input.from, to, text: input.text.slice(0, PARADIS_BOT_GROUP_LIMITS.recordText), at: now };
	const records = [...state.records, record];
	return { ok: true, state: { ...state, records: trimRecords(records, state.groups), nextRecordId: state.nextRecordId + 1 }, value: record };
}

/**
 * 記録を上限（{@link PARADIS_BOT_GROUP_LIMITS.records}）までに刈る。捨てるのは古い方からで、まだ読まれていない Bot 同士の
 * 伝言（宛先が今もそのグループのメンバー）は捨てない（未読は宛先ごとに伝言の道具が数で抑える）。あなたの `sent`・既読の
 * 伝言・メンバーから外れた Bot 宛ての未読を先に捨てる。
 */
function trimRecords(records: readonly IParadisBotGroupRecord[], groups: readonly IParadisBotGroup[]): IParadisBotGroupRecord[] {
	let excess = records.length - PARADIS_BOT_GROUP_LIMITS.records;
	if (excess <= 0) {
		return [...records];
	}
	const members = new Map(groups.map(group => [group.id, group.members]));
	return records.filter(record => {
		if (excess > 0 && !isUnreadBotMessage(record, members.get(record.groupId) ?? [])) {
			excess--;
			return false;
		}
		return true;
	});
}

/** まだ読まれていない Bot 同士の伝言で、宛先が今もグループのメンバーか。 */
function isUnreadBotMessage(record: IParadisBotGroupRecord, members: readonly string[]): boolean {
	return record.kind !== 'sent' && record.readAt === undefined && record.droppedAt === undefined && record.to.some(id => members.includes(id));
}

/** 台帳に残っている Bot だけのメンバー（消した Bot を並べない）。 */
export function paradisBotGroupMembers(group: Pick<IParadisBotGroup, 'members'>, botIds: ReadonlySet<string>): string[] {
	return group.members.filter(id => botIds.has(id));
}

// ---- 名指し ---------------------------------------------------------------------------------------

/** 「@全員」に使える語（どちらも全員。同じ名前の Bot がいても全員を指す）。 */
const EVERYONE_WORDS: readonly string[] = ['全員', 'all', 'everyone'];

function nameKey(name: string): string {
	return name.normalize('NFKC').toLowerCase();
}

export type ParadisBotGroupMentionResult =
	| { readonly ok: true; readonly targets: readonly string[]; readonly everyone: boolean }
	| { readonly ok: false; readonly problem: 'empty' | 'no_target' } | { readonly ok: false; readonly problem: 'unknown_name'; readonly name: string };

/**
 * 投稿の文から宛先を決める。`@` は行頭か空白の後のものだけを名指しと読み（メールアドレスなどは読まない）、
 * メンバーの名前のうち一番長く合うものを取る（「レビュー係」と「レビュー係 2」が両方いても取り違えない）。
 * 名前と比べるときは全角・半角と大文字・小文字をそろえる。合う名前が無い `@…` は打ち間違いとして断る
 * （黙って全員へ送らない）。名指しが無ければ、`mentioned` は断り、`all` は全員。
 */
export function paradisResolveBotGroupMentions(text: string, members: readonly { readonly id: string; readonly name: string }[], mode: ParadisBotGroupReplyMode): ParadisBotGroupMentionResult {
	if (text.trim().length === 0) {
		return { ok: false, problem: 'empty' };
	}
	const normalized = text.normalize('NFKC');
	const candidates = [
		...EVERYONE_WORDS.map(word => ({ key: nameKey(word), id: undefined as string | undefined })),
		...members.map(member => ({ key: nameKey(member.name), id: member.id as string | undefined })),
	].sort((a, b) => b.key.length - a.key.length);
	const targets = new Set<string>();
	let everyone = false;
	for (let index = normalized.indexOf('@'); index >= 0; index = normalized.indexOf('@', index + 1)) {
		if (index > 0 && !/\s/u.test(normalized[index - 1])) {
			continue;
		}
		const rest = normalized.slice(index + 1).toLowerCase();
		// 日本語は語の間に空白が無いので「@リリース係は」も名指しに読む。英数字で終わる名前の直後に英数字が続くときだけ、
		// 別の語とみなす（「@rel」の Bot が「@release」に当たらない）
		const hit = candidates.find(candidate => rest.startsWith(candidate.key) && !(/[a-z0-9]$/.test(candidate.key) && /^[a-z0-9]/.test(rest.slice(candidate.key.length))));
		if (hit === undefined) {
			const word = /^[^\s@]+/u.exec(rest)?.[0];
			if (word !== undefined) {
				return { ok: false, problem: 'unknown_name', name: word };
			}
			continue;
		}
		if (hit.id === undefined) {
			everyone = true;
		} else {
			targets.add(hit.id);
		}
	}
	if (everyone || (targets.size === 0 && mode === 'all')) {
		return { ok: true, targets: members.map(member => member.id), everyone: true };
	}
	if (targets.size === 0) {
		return { ok: false, problem: 'no_target' };
	}
	// 並べた順（メンバーの順）にそろえる
	return { ok: true, targets: members.filter(member => targets.has(member.id)).map(member => member.id), everyone: false };
}

// ---- Bot 同士の伝言（受け箱） ---------------------------------------------------------------------

/** その Bot の受け箱にある伝言か（Bot からの伝言で、宛先にその Bot がいて、まだ読まれていない）。 */
function inInbox(record: IParadisBotGroupRecord, botId: string): boolean {
	return record.kind !== 'sent' && record.to.includes(botId) && record.readAt === undefined && record.droppedAt === undefined;
}

/** その Bot の受け箱にある伝言の数（帯と Bot のページに出す）。 */
export function paradisBotGroupUnreadCount(state: Pick<IParadisBotGroupsState, 'groups' | 'records'>, botId: string): number {
	return paradisBotGroupInbox(state, botId).length;
}

/** その Bot の受け箱（古い順）。今もその Bot が入っているグループの伝言だけ。 */
export function paradisBotGroupInbox(state: Pick<IParadisBotGroupsState, 'groups' | 'records'>, botId: string): IParadisBotInboxEntry[] {
	const groups = new Set(state.groups.filter(group => group.members.includes(botId)).map(group => group.id));
	return state.records
		.filter(record => groups.has(record.groupId) && inInbox(record, botId))
		.map(record => ({ recordId: String(record.id), groupId: record.groupId, kind: record.kind === 'asked' ? 'asked' : 'told', from: record.from, text: record.text, at: record.at }));
}

/**
 * その Bot が読んだ伝言を既読にする。その Bot の受け箱にある記録だけを直し（ほかの Bot 宛て・あなたの `sent`・知らない id は
 * 変えない）、直した数を返す。1 件も直らなければ断る（書かない）。
 */
export function paradisBotGroupMarkRead(state: IParadisBotGroupsState, botId: string, recordIds: readonly string[], now: number): ParadisBotGroupsResult<number> {
	if (!writable(state)) {
		return refuse('read_only', READ_ONLY);
	}
	const ids = new Set(recordIds.filter(id => /^[1-9]\d{0,15}$/u.test(id)).map(Number));
	let count = 0;
	const records = state.records.map(record => {
		if (ids.has(record.id) && inInbox(record, botId)) {
			count++;
			return { ...record, readAt: now };
		}
		return record;
	});
	return count === 0 ? refuse('not_found', 'There is no such message.') : { ok: true, state: { ...state, records }, value: count };
}

// ---- 保存した値の読み込み ------------------------------------------------------------------------

function storedGroup(value: unknown): IParadisBotGroup | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const name = paradisSanitizeBotGroupName(value.name);
	const members = memberList(value.members);
	const mode = replyMode(value.replyMode);
	const time = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
	const createdAt = time(value.createdAt);
	const updatedAt = time(value.updatedAt);
	if (!isId(value.id) || name === undefined || members === undefined || mode === undefined || createdAt === undefined || updatedAt === undefined) {
		return undefined;
	}
	return { id: value.id, name, members, replyMode: mode, createdAt, updatedAt };
}

function storedRecord(value: unknown, groups: ReadonlySet<string>): IParadisBotGroupRecord | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const kind = PARADIS_BOT_GROUP_RECORD_KINDS.find(candidate => candidate === value.kind);
	if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1 || typeof value.groupId !== 'string' || !groups.has(value.groupId) || kind === undefined
		|| !isId(value.from) || !Array.isArray(value.to) || !value.to.every(isId) || typeof value.text !== 'string' || typeof value.at !== 'number' || !Number.isFinite(value.at)) {
		return undefined;
	}
	const record: IParadisBotGroupRecord = { id: value.id, groupId: value.groupId, kind, from: value.from, to: value.to, text: value.text.slice(0, PARADIS_BOT_GROUP_LIMITS.recordText), at: value.at };
	const time = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
	const readAt = kind !== 'sent' ? time(value.readAt) : undefined;
	const droppedAt = kind !== 'sent' && readAt === undefined ? time(value.droppedAt) : undefined;
	return readAt !== undefined ? { ...record, readAt } : droppedAt !== undefined ? { ...record, droppedAt } : record;
}

/**
 * 読んだ JSON を台帳の形へ直す。形の違う 1 件・id の重なる 1 件は捨てる。全体の形が違えば undefined（呼び出し側が
 * 別名へ退避する）。今より新しい版は版の番号を保って返す（更新の関数が書き込みを断る）。
 */
export function paradisParseBotGroupsState(value: unknown): IParadisBotGroupsState | undefined {
	if (!isRecord(value) || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1 || !Array.isArray(value.groups) || !Array.isArray(value.records)) {
		return undefined;
	}
	const groups: IParadisBotGroup[] = [];
	for (const candidate of value.groups) {
		const group = storedGroup(candidate);
		if (group !== undefined && !groups.some(existing => existing.id === group.id) && groups.length < PARADIS_BOT_GROUP_LIMITS.groups) {
			groups.push(group);
		}
	}
	const groupIds = new Set(groups.map(group => group.id));
	const records: IParadisBotGroupRecord[] = [];
	for (const candidate of value.records) {
		const record = storedRecord(candidate, groupIds);
		if (record !== undefined && !records.some(existing => existing.id === record.id)) {
			records.push(record);
		}
	}
	const kept = trimRecords(records, groups);
	const highest = kept.reduce((max, record) => Math.max(max, record.id), 0);
	const next = typeof value.nextRecordId === 'number' && Number.isSafeInteger(value.nextRecordId) && value.nextRecordId > highest ? value.nextRecordId : highest + 1;
	return { version: value.version, groups, records: kept, nextRecordId: next };
}
