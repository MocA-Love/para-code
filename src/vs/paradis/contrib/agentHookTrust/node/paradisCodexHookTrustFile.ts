/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex の hook の信頼を、`codex app-server` を使わずに config.toml へ直接書く（SSH の接続先用）。
//
// 手元では Codex 自身に計算と書き込みをさせている（paradisCodexHookTrust.ts の `hooks/list` →
// `config/batchWrite`）。接続先の REH は利用者のログインシェルの PATH を持たず、codex を起こせるとは
// 限らないので、ここでは Codex と同じ計算でハッシュを作り、`hooks.state` の該当の節だけを書き換える。
//
// ハッシュの根拠（openai/codex 9d2b60303e83 = 2026-10-02 の main）:
//  - codex-rs/hooks/src/engine/discovery.rs の `hook_hash`: `{ event_name: <小文字の名前>, matcher?, hooks: [<正規化した handler>] }`
//    を TOML の値にしてから `version_for_toml` に渡す。正規化は `command`・`timeout`（既定 600 秒、
//    SessionEnd と Interrupt は既定 1 秒で 1〜3 秒に収める）・`async`・`statusMessage`・
//    `additionalContextLimit`（既定値なら省く）。`commandWindows` は常に省く。None の項目は TOML に出ない
//  - codex-rs/config/src/fingerprint.rs の `version_for_toml`: JSON にしてキーを並べ替え、空白なしで
//    直列化した UTF-8 の SHA-256 を `sha256:<16進>` にする
//  - matcher を持てないイベント（UserPromptSubmit・Stop・Interrupt）は matcher を省く（events/common.rs）
//  - 鍵は `<CODEX_HOME の実体>/hooks.json:<小文字の名前>:<定義の位置>:<hook の位置>`（hooks/src/lib.rs の `hook_key`）
//
// 書き換えるのは Para Code が置いた hook（コマンドが完全一致するもの）の `trusted_hash` だけ。
// `enabled = false`（利用者が止めた hook）はそのまま残す。config.toml の書き方が曖昧で、節を足すと
// 同じ表を二重に定義しかねないとき（`[hooks.state]` の表やインラインの表がある等）は何も書かない。
// Codex が設定ごと読めなくなるくらいなら、信頼が付かない方がまし（利用者は Codex の /hooks で付けられる）。

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import { paradisWriteRollingBackup } from '../../../node/paradisRollingFileBackup.js';
import { encodeParadisTomlBasicString, MultilineDelimiter, parseTomlKeyPath, scanTomlLine } from '../../agentBrowser/common/paradisMcpSetupEncoding.js';
import { IParadisCodexHookListing, IParadisCodexHookTrustGrantResult, IParadisCodexHookTrustStatus } from '../common/paradisCodexHookTrust.js';

/** hooks.json のイベント名 → Codex が鍵とハッシュに使う小文字の名前（hooks/src/lib.rs の `hook_event_key_label`）。 */
const CODEX_HOOK_EVENT_LABELS: Readonly<Record<string, string>> = {
	PreToolUse: 'pre_tool_use',
	PermissionRequest: 'permission_request',
	PostToolUse: 'post_tool_use',
	PreCompact: 'pre_compact',
	PostCompact: 'post_compact',
	SessionStart: 'session_start',
	SessionEnd: 'session_end',
	UserPromptSubmit: 'user_prompt_submit',
	SubagentStart: 'subagent_start',
	SubagentStop: 'subagent_stop',
	Stop: 'stop',
	Interrupt: 'interrupt',
};

/** matcher を持てないイベント（hooks/src/events/common.rs の `matcher_pattern_for_event`）。 */
const EVENTS_WITHOUT_MATCHER = new Set(['user_prompt_submit', 'stop', 'interrupt']);

/** additionalContext を返せるイベント。それ以外では additionalContextLimit を捨てる（discovery.rs）。 */
const EVENTS_WITH_ADDITIONAL_CONTEXT = new Set(['pre_tool_use', 'post_tool_use', 'session_start', 'user_prompt_submit', 'subagent_start']);

/** 既定のタイムアウトが短いイベント（SessionEnd と Interrupt は既定 1 秒、上限 3 秒）。 */
const SHORT_TIMEOUT_EVENTS = new Set(['session_end', 'interrupt']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** キーを並べ替えた JSON（serde_json の `sort_all_objects` + `to_vec` と同じ、空白なし）。 */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

/** Codex の `version_for_toml` と同じ指紋（`sha256:<16進>`）。 */
export function paradisCodexTomlFingerprint(value: unknown): string {
	return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

/** hooks.json の command の hook 1 件のうち、ハッシュに入るところ。 */
export interface IParadisCodexCommandHook {
	readonly command: string;
	readonly timeout?: number;
	readonly async?: boolean;
	readonly statusMessage?: string;
}

/**
 * Codex が hook の信頼に使うハッシュ（discovery.rs の `hook_hash`）。
 *
 * additionalContextLimit を持つ hook は正規化を再現しないので、呼び出し側（{@link paradisListManagedCodexHookTrustEntries}）が除く。
 *
 * @param eventLabel 小文字の名前（`stop` など）
 */
export function paradisCodexHookTrustHash(eventLabel: string, matcher: string | undefined, hook: IParadisCodexCommandHook): string {
	const shortTimeout = SHORT_TIMEOUT_EVENTS.has(eventLabel);
	const timeout = shortTimeout
		? Math.min(3, Math.max(1, hook.timeout ?? 1))
		: Math.max(1, hook.timeout ?? 600);
	const handler: Record<string, unknown> = {
		type: 'command',
		command: hook.command,
		timeout,
		async: hook.async ?? false,
	};
	if (hook.statusMessage !== undefined) {
		handler.statusMessage = hook.statusMessage;
	}
	const identity: Record<string, unknown> = { event_name: eventLabel, hooks: [handler] };
	if (matcher !== undefined && !EVENTS_WITHOUT_MATCHER.has(eventLabel)) {
		identity.matcher = matcher;
	}
	return paradisCodexTomlFingerprint(identity);
}

/** 信頼を付ける対象の hook 1 件。 */
export interface IParadisCodexHookTrustEntry {
	/** `hooks.state` の鍵。 */
	readonly key: string;
	/** hooks.json のイベント名（`Stop` など）。 */
	readonly eventName: string;
	/** Codex と同じ計算で出したハッシュ。 */
	readonly hash: string;
}

/**
 * hooks.json から Para Code が置いた hook を探し、鍵とハッシュを出す。
 *
 * @param keySourcePath 鍵の先頭（`<CODEX_HOME の実体>/hooks.json`）
 * @param managedCommand Para Code が書くコマンド文字列（完全一致で判定する。利用者の hook は触らない）
 * @returns 読めない・形が違う hooks.json なら undefined
 */
export function paradisListManagedCodexHookTrustEntries(hooksJson: string, keySourcePath: string, managedCommand: string): IParadisCodexHookTrustEntry[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(hooksJson);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) {
		return undefined;
	}
	const hooks = parsed.hooks;
	if (!isRecord(hooks)) {
		return [];
	}
	const entries: IParadisCodexHookTrustEntry[] = [];
	for (const [eventName, groups] of Object.entries(hooks)) {
		const label = CODEX_HOOK_EVENT_LABELS[eventName];
		if (label === undefined || !Array.isArray(groups)) {
			continue;
		}
		groups.forEach((group, groupIndex) => {
			if (!isRecord(group) || !Array.isArray(group.hooks)) {
				return;
			}
			const matcher = typeof group.matcher === 'string' ? group.matcher : undefined;
			group.hooks.forEach((hook, handlerIndex) => {
				if (!isRecord(hook) || hook.type !== 'command' || hook.command !== managedCommand) {
					return;
				}
				const timeout = hook.timeout;
				const isAsync = hook.async;
				const statusMessage = hook.statusMessage;
				// こちらが正規化を再現しない項目を持つ hook は計算しない（違うハッシュを書かない）
				if ((timeout !== undefined && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 0))
					|| (isAsync !== undefined && typeof isAsync !== 'boolean')
					|| (statusMessage !== undefined && typeof statusMessage !== 'string')
					|| (hook.additionalContextLimit !== undefined && EVENTS_WITH_ADDITIONAL_CONTEXT.has(label))) {
					return;
				}
				entries.push({
					key: `${keySourcePath}:${label}:${groupIndex}:${handlerIndex}`,
					eventName,
					hash: paradisCodexHookTrustHash(label, matcher, { command: managedCommand, timeout, async: isAsync, statusMessage }),
				});
			});
		});
	}
	return entries;
}

/** config.toml の `[hooks.state."<鍵>"]` の節 1 つ。 */
interface IHookStateBlock {
	/** 見出しの行。 */
	readonly headerLine: number;
	/** `trusted_hash = …` の行（無ければ undefined）。 */
	trustedHashLine?: number;
	/** 今の trusted_hash（文字列で読めたときだけ）。 */
	trustedHash?: string;
}

/** `hooks.state` の読み取り結果。書き方が曖昧なら undefined。 */
interface IHookStateScan {
	readonly lines: string[];
	readonly blocks: Map<string, IHookStateBlock>;
}

function decodeTomlString(source: string): string | undefined {
	const value = source.trim();
	if (value.startsWith('"')) {
		try {
			const decoded: unknown = JSON.parse(value);
			return typeof decoded === 'string' ? decoded : undefined;
		} catch {
			return undefined;
		}
	}
	if (value.length >= 2 && value.startsWith('\x27') && value.endsWith('\x27') && !value.slice(1, -1).includes('\x27')) {
		return value.slice(1, -1);
	}
	return undefined;
}

function assignmentIndex(code: string): number {
	let quote: '"' | '\x27' | undefined;
	for (let index = 0; index < code.length; index++) {
		const char = code[index];
		if (quote !== undefined) {
			if (quote === '"' && char === '\\') {
				index++;
			} else if (char === quote) {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === '\x27') {
			quote = char;
		} else if (char === '=') {
			return index;
		}
	}
	return -1;
}

function startsWithPath(path: readonly string[], prefix: readonly string[]): boolean {
	return prefix.every((segment, index) => path[index] === segment);
}

/**
 * config.toml の `hooks.state` を読む。TOML 全体は解釈せず、行ごとに見出しと代入だけを拾う。
 * `[hooks.state."<鍵>"]` の節以外の形で `hooks.state` に触れているもの（`[hooks.state]` の表、
 * インラインの表、点で繋いだ代入、配列の表など）があれば、足すと二重定義になりうるので undefined。
 */
function scanHookState(source: string): IHookStateScan | undefined {
	const lines = source.split('\n');
	const blocks = new Map<string, IHookStateBlock>();
	let table: readonly string[] = [];
	let block: IHookStateBlock | undefined;
	let stateHeaderSeen = false;
	let multiline: MultilineDelimiter | undefined;
	for (let index = 0; index < lines.length; index++) {
		const startsInString = multiline !== undefined;
		const scanned = scanTomlLine(lines[index].replace(/\r$/, ''), multiline);
		multiline = scanned.multiline;
		const code = scanned.code.trim();
		if (startsInString || code.length === 0) {
			continue;
		}
		if (code.startsWith('[')) {
			const isArray = code.startsWith('[[');
			const close = isArray ? code.lastIndexOf(']]') : code.lastIndexOf(']');
			if (close <= 0 || code.slice(close + (isArray ? 2 : 1)).trim().length > 0) {
				return undefined;
			}
			const path = parseTomlKeyPath(code.slice(isArray ? 2 : 1, close));
			if (path === undefined) {
				return undefined;
			}
			table = path;
			block = undefined;
			if (startsWithPath(path, ['hooks', 'state'])) {
				// Codex（toml_edit）は鍵ごとの節の前に、中身の無い `[hooks.state]` の見出しを 1 つ書く。
				// それ自体は節を足しても衝突しない。直下の代入は下の「表の外から hooks.state を作る」で拒む
				if (!isArray && path.length === 2 && !stateHeaderSeen) {
					stateHeaderSeen = true;
					continue;
				}
				if (isArray || path.length !== 3 || blocks.has(path[2])) {
					return undefined;
				}
				block = { headerLine: index };
				blocks.set(path[2], block);
			}
			continue;
		}
		const equals = assignmentIndex(code);
		const keyPath = equals >= 0 ? parseTomlKeyPath(code.slice(0, equals)) : undefined;
		if (keyPath === undefined) {
			// 配列やインラインの表の続きの行。`hooks` に触れていそうなら曖昧として止まる
			if (/\bhooks\b/.test(code) && table.length === 0) {
				return undefined;
			}
			continue;
		}
		const fullPath = [...table, ...keyPath];
		if (block !== undefined) {
			if (keyPath.length !== 1) {
				return undefined;
			}
			if (keyPath[0] === 'trusted_hash') {
				block.trustedHashLine = index;
				block.trustedHash = decodeTomlString(code.slice(equals + 1));
			}
			continue;
		}
		// 表の外から hooks / hooks.state を代入で作っている
		if ((fullPath.length === 1 && fullPath[0] === 'hooks') || startsWithPath(fullPath, ['hooks', 'state'])) {
			return undefined;
		}
	}
	return multiline === undefined ? { lines, blocks } : undefined;
}

/** config.toml に書いてある、各鍵の trusted_hash。読めない書き方なら undefined。 */
export function paradisReadCodexHookTrustedHashes(configToml: string): ReadonlyMap<string, string | undefined> | undefined {
	const scan = scanHookState(configToml);
	if (scan === undefined) {
		return undefined;
	}
	return new Map([...scan.blocks].map(([key, block]) => [key, block.trustedHash]));
}

/**
 * config.toml の `hooks.state` に、渡した鍵の trusted_hash を書き込んだ中身を返す。
 * ほかの行（利用者の設定・コメント・`enabled`）は1文字も変えない。
 *
 * @returns 書き換えた中身。変える必要が無ければ元のまま。書き方が曖昧で安全に書けなければ undefined
 */
export function paradisUpsertCodexHookTrust(configToml: string, entries: readonly IParadisCodexHookTrustEntry[]): string | undefined {
	const scan = scanHookState(configToml);
	if (scan === undefined) {
		return undefined;
	}
	const lines = [...scan.lines];
	// 改行の書き方（CRLF / LF）を保つ
	const crlf = configToml.includes('\r\n');
	const lineEnd = crlf ? '\r' : '';
	const appended: string[] = [];
	// 行番号がずれないよう、後ろの行から差し替える
	const edits: { readonly line: number; readonly insert: boolean; readonly text: string }[] = [];
	for (const entry of entries) {
		const hashLine = `trusted_hash = ${encodeParadisTomlBasicString(entry.hash)}`;
		const block = scan.blocks.get(entry.key);
		if (block === undefined) {
			appended.push(`[hooks.state.${encodeParadisTomlBasicString(entry.key)}]`, hashLine, '');
		} else if (block.trustedHash !== entry.hash) {
			if (block.trustedHashLine !== undefined) {
				const indent = /^[ \t]*/.exec(lines[block.trustedHashLine])?.[0] ?? '';
				edits.push({ line: block.trustedHashLine, insert: false, text: `${indent}${hashLine}${lineEnd}` });
			} else {
				edits.push({ line: block.headerLine + 1, insert: true, text: `${hashLine}${lineEnd}` });
			}
		}
	}
	if (edits.length === 0 && appended.length === 0) {
		return configToml;
	}
	for (const edit of edits.sort((a, b) => b.line - a.line)) {
		if (edit.insert) {
			lines.splice(edit.line, 0, edit.text);
		} else {
			lines[edit.line] = edit.text;
		}
	}
	let result = lines.join('\n');
	if (appended.length > 0) {
		const eol = crlf ? '\r\n' : '\n';
		const separator = result.length === 0 ? '' : result.endsWith(`${eol}${eol}`) ? '' : result.endsWith(eol) ? eol : `${eol}${eol}`;
		result = `${result}${separator}${appended.join(eol)}`;
	}
	return result;
}

// ---------- 1 つの CODEX_HOME を調べる・信頼を付ける ----------

async function readOptionalText(path: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

interface IHomeTrustState {
	readonly hooksPath: string;
	readonly configPath: string;
	readonly entries: readonly IParadisCodexHookTrustEntry[];
	readonly configText: string | undefined;
	readonly trustedHashes: ReadonlyMap<string, string | undefined> | undefined;
}

async function readHomeTrustState(codexHome: string, managedCommand: string): Promise<IHomeTrustState | 'nothing-installed' | 'unreadable'> {
	const hooksPath = join(codexHome, 'hooks.json');
	const hooksText = await readOptionalText(hooksPath);
	if (hooksText === undefined) {
		return 'nothing-installed';
	}
	// Codex は CODEX_HOME を実体のパスへ直して鍵に使う（hooks.json の名前は直さない）
	const realHome = await fs.realpath(codexHome).catch(() => codexHome);
	const entries = paradisListManagedCodexHookTrustEntries(hooksText, join(realHome, 'hooks.json'), managedCommand);
	if (entries === undefined) {
		return 'unreadable';
	}
	if (entries.length === 0) {
		return 'nothing-installed';
	}
	const configPath = join(codexHome, 'config.toml');
	const configText = await readOptionalText(configPath);
	return { hooksPath, configPath, entries, configText, trustedHashes: paradisReadCodexHookTrustedHashes(configText ?? '') };
}

function listingsOf(state: IHomeTrustState): IParadisCodexHookListing[] {
	return state.entries.map(entry => {
		const trusted = state.trustedHashes?.get(entry.key);
		return {
			key: entry.key,
			eventName: entry.eventName,
			trustStatus: trusted === undefined ? 'untrusted' : trusted === entry.hash ? 'trusted' : 'modified',
			currentHash: entry.hash,
		};
	});
}

/** その CODEX_HOME の Para Code の hook の信頼の状態（何も書かない）。 */
export async function paradisInspectCodexHookTrustFile(codexHome: string, managedCommand: string): Promise<IParadisCodexHookTrustStatus> {
	const base = { codexHome, hooksPath: join(codexHome, 'hooks.json') };
	try {
		const state = await readHomeTrustState(codexHome, managedCommand);
		if (state === 'nothing-installed') {
			return { ...base, supported: true, pending: [], managedCount: 0 };
		}
		if (state === 'unreadable') {
			return { ...base, supported: false, pending: [], managedCount: 0, error: 'hooks.json is not valid JSON' };
		}
		if (state.trustedHashes === undefined) {
			return { ...base, supported: false, pending: [], managedCount: state.entries.length, error: 'config.toml defines hooks.state in a form Para Code does not edit' };
		}
		const listings = listingsOf(state);
		return { ...base, supported: true, pending: listings.filter(listing => listing.trustStatus !== 'trusted'), managedCount: listings.length };
	} catch (error) {
		return { ...base, supported: false, pending: [], managedCount: 0, error: String(error instanceof Error ? error.message : error) };
	}
}

/**
 * その CODEX_HOME の Para Code の hook に信頼を付ける。例外は投げない。
 *
 * 読んでから書くまでに config.toml が変わっていたら（Codex の TUI が書いた等）、置き換えずに
 * 読み直してやり直す（3 回まで）。書く前の中身は `config.toml.paradis.bak` に 1 つだけ控える。
 * 書き込みは同じフォルダの一時ファイルから rename で置き換え、元の権限と symlink を保つ。
 */
export async function paradisGrantCodexHookTrustFile(codexHome: string, managedCommand: string): Promise<IParadisCodexHookTrustGrantResult> {
	const base = { codexHome, hooksPath: join(codexHome, 'hooks.json') };
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			const state = await readHomeTrustState(codexHome, managedCommand);
			if (state === 'nothing-installed') {
				return { ...base, outcome: 'nothing-installed', grantedEvents: [] };
			}
			if (state === 'unreadable') {
				return { ...base, outcome: 'failed', grantedEvents: [], detail: 'hooks.json is not valid JSON' };
			}
			const pending = listingsOf(state).filter(listing => listing.trustStatus !== 'trusted');
			if (pending.length === 0) {
				return { ...base, outcome: 'already-trusted', grantedEvents: [] };
			}
			const updated = paradisUpsertCodexHookTrust(state.configText ?? '', state.entries);
			if (updated === undefined) {
				return { ...base, outcome: 'unsupported', grantedEvents: [], detail: 'config.toml defines hooks.state in a form Para Code does not edit' };
			}
			if (state.configText !== undefined) {
				await paradisWriteRollingBackup(state.configPath).catch(() => false);
			}
			let changedMeanwhile = false;
			await paradisWriteFileAtomic(state.configPath, updated, {
				// 新しく作るときは Codex が作るのと同じく利用者だけが読める権限にする
				newFileMode: 0o600,
				beforeReplace: async () => {
					if (await readOptionalText(state.configPath) !== state.configText) {
						changedMeanwhile = true;
						throw new Error('config.toml changed while it was being updated');
					}
				},
			}).catch(error => {
				if (!changedMeanwhile) {
					throw error;
				}
			});
			if (changedMeanwhile) {
				continue;
			}
			// 書いたものを読み直して確かめる
			const verified = await readHomeTrustState(codexHome, managedCommand);
			if (typeof verified === 'string' || listingsOf(verified).some(listing => listing.trustStatus !== 'trusted')) {
				return { ...base, outcome: 'verify-failed', grantedEvents: [], detail: 'the trust was not found after the write' };
			}
			return { ...base, outcome: 'granted', grantedEvents: pending.map(listing => listing.eventName) };
		}
		return { ...base, outcome: 'failed', grantedEvents: [], detail: 'config.toml kept changing while it was being updated' };
	} catch (error) {
		return { ...base, outcome: 'failed', grantedEvents: [], detail: String(error instanceof Error ? error.message : error) };
	}
}
