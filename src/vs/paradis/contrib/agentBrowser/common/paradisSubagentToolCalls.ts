/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code のサブエージェント（Agent ツールで起こした子）からの para-browser の呼び出しを見分ける。
//
// Claude Code は main の会話の MCP の呼び出しが 2 分を超えると裏に回し、エージェントには「まだ動いている」としか
// 返らない（q.html Q395）。そのため待つ道具の上限は main に合わせて短い（wait_until 100 秒など）。子の呼び出しは
// 裏に回されず、サーバーごとの `timeout`（Para Code は 300 秒を書く）まで 1 回で待てる（Claude Code の公式の資料、
// 2.1.309 で実測）。子からと確かめられた呼び出しにだけ、長い上限を使う。
//
// 見分け方: Claude Code はどの MCP の `tools/call` にも `_meta["claudecode/toolUseId"]`（tool_use の id）を付ける。
// ツールを呼ぶ前には PreToolUse の hook を走らせ、その終わりを待ってから呼ぶ。Para Code の hook は全ツールに
// 登録してあり、子の中のツールなら payload に `agent_id` が付く。hook のスクリプトは送り終わるまで待つので、
// 「同じペインから agent_id 付きの PreToolUse が届いた tool_use_id」なら子からの呼び出しと言える。
// hook が届かない・遅れた・id が無い（Codex、古い版、SSH で hook のトンネルが無いなど）ときは main として扱う。

/** Claude Code が MCP の `tools/call` の `_meta` に付ける tool_use の id のキー。 */
export const PARADIS_CLAUDE_TOOL_USE_ID_META_KEY = 'claudecode/toolUseId';

/**
 * main の会話（と、子からと確かめられない呼び出し）の待ちの上限（秒）。Claude Code は main の会話の呼び出しを 120 秒で
 * 裏に回すので、その手前にする。
 */
export const PARADIS_MAIN_WAIT_MAX_SECONDS = 100;

/**
 * 子からの呼び出しで使う待ちの上限（秒）。Para Code が Claude Code に書くサーバーごとの `timeout`（300 秒、
 * paradisMcpSetupEncoding.ts）と、ページの関数 1 回分の待ちに余裕を残す。
 */
export const PARADIS_SUBAGENT_WAIT_MAX_SECONDS = 280;

/** 覚えておく時間。PreToolUse から `tools/call` までは通常すぐなので、長く残す必要はない。 */
const REMEMBER_MS = 15 * 60_000;

/** 覚えておく件数の上限（古いものから捨てる）。 */
const MAX_ENTRIES = 4096;

/** tool_use の id として受け付ける形（印字できる ASCII、空白なし）。 */
const TOOL_USE_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

/** `tools/call` の params から Claude Code の tool_use の id を取り出す。無い・形が違えば undefined。 */
export function paradisToolUseIdOfCall(params: unknown): string | undefined {
	if (typeof params !== 'object' || params === null) {
		return undefined;
	}
	const meta = (params as { _meta?: unknown })._meta;
	if (typeof meta !== 'object' || meta === null) {
		return undefined;
	}
	const value = (meta as Record<string, unknown>)[PARADIS_CLAUDE_TOOL_USE_ID_META_KEY];
	return typeof value === 'string' && TOOL_USE_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * agent_id 付きの PreToolUse が届いた tool_use の id を、ペインごとに覚える。
 * 覚えていない呼び出しは main として扱う（安全側）。
 */
export class ParadisSubagentToolUses {

	private readonly _entries = new Map<string, number>();

	constructor(private readonly _now: () => number = Date.now) { }

	/** hook を 1 つ受けた。子の中の PreToolUse だけを覚える。 */
	noteHook(paneToken: string, event: string | undefined, toolUseId: string | undefined, fromSubagent: boolean): void {
		if (event !== 'PreToolUse' || !fromSubagent || toolUseId === undefined || !TOOL_USE_ID_PATTERN.test(toolUseId)) {
			return;
		}
		const key = this._key(paneToken, toolUseId);
		this._entries.delete(key);
		this._entries.set(key, this._now());
		while (this._entries.size > MAX_ENTRIES) {
			const oldest = this._entries.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this._entries.delete(oldest);
		}
	}

	/** その呼び出しが子からと確かめられたか。id が無い・覚えていない・古いときは false。 */
	isFromSubagent(paneToken: string, toolUseId: string | undefined): boolean {
		if (toolUseId === undefined) {
			return false;
		}
		const key = this._key(paneToken, toolUseId);
		const at = this._entries.get(key);
		if (at === undefined) {
			return false;
		}
		if (this._now() - at > REMEMBER_MS) {
			this._entries.delete(key);
			return false;
		}
		return true;
	}

	/** ペインの記録を捨てる（ペインの終わり）。 */
	forget(paneToken: string): void {
		const prefix = `${paneToken}\n`;
		for (const key of [...this._entries.keys()]) {
			if (key.startsWith(prefix)) {
				this._entries.delete(key);
			}
		}
	}

	private _key(paneToken: string, toolUseId: string): string {
		return `${paneToken}\n${toolUseId}`;
	}
}
