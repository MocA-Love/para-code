/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StringSHA1 } from '../../../../base/common/hash.js';
import type { IParadisResumeSession } from '../../sessionResume/common/paradisSessionResume.js';

/**
 * 終わった会話をスマホから開き直して続きを頼む（Orca W2-29）の、PC とアプリで共有する取り決め。
 *
 * スマホへはセッション ID もパスも渡さない。渡すのは会話の指紋（{@link paradisAgentSessionKey}）だけで、PC は
 * 手元の一覧を引き直して指紋の合う会話を探す。指紋は PC を再起動しても変わらないので、PC に届かない間に預かった
 * 送信（最大 24 時間）の宛先にも使える（セッション履歴の `catalogId` は一覧を作り直すと変わるので使えない）。
 */

/** capability の名前。PC がこれを広告していれば、アプリは過去の会話の一覧・中身・再開を求められる。 */
export const PARADIS_AGENT_RESUME_CAPABILITY = 'agent.resume.v1';

/** 会話の指紋の形（SHA-1 の 16 進 40 桁）。 */
export const PARADIS_AGENT_SESSION_KEY_PATTERN = /^[0-9a-f]{40}$/;

/** エージェントの種類とセッション ID から、会話の指紋を作る。 */
export function paradisAgentSessionKey(agent: 'claude' | 'codex', sessionId: string): string {
	const sha = new StringSHA1();
	sha.update(`para.agent-session\n${agent}\n${sessionId}`);
	return sha.digest();
}

/** 1 回の一覧で返す件数の上限。 */
export const PARADIS_AGENT_SESSIONS_PAGE_LIMIT = 30;
/** スマホから送る続きの依頼の長さの上限。 */
export const PARADIS_AGENT_RESUME_PROMPT_LIMIT = 20_000;

/** 一覧の文字の長さの上限（通信量を抑える）。 */
const TITLE_LIMIT = 200;
const PREVIEW_LIMIT = 300;
/** 再開の依頼の台帳の上限。 */
const RESUME_LEDGER_LIMIT = 500;
/** スマホが預かるのは 24 時間まで。台帳はそれより少し長く残す。 */
const RESUME_LEDGER_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** 再開の依頼の台帳の 1 件（PC の再起動をまたいで同じ依頼を二度実行しないため）。 */
export interface IParadisResumeLedgerEntry {
	readonly id: string;
	readonly at: number;
	readonly status: 'started' | 'resumed' | 'failed';
	readonly terminalKey?: string;
	readonly delivered?: boolean;
}

/** スマホへ返す過去の会話 1 件。 */
export interface IParadisMobileAgentSession {
	readonly key: string;
	readonly agent: 'claude' | 'codex';
	readonly title: string;
	readonly preview?: string;
	readonly previewRole?: 'user' | 'assistant';
	readonly updatedAt: number;
	readonly createdAt?: number;
	readonly branch?: string;
	/** PC で今この会話を開いているターミナル（あれば再開せずにそのタブを開く）。 */
	readonly terminalKey?: string;
}

/** 改行と空白を 1 つに均し、長ければ切る。 */
export function paradisClipAgentSessionText(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	// allow-any-unicode-next-line
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** セッション履歴の 1 件をスマホへ返す形にする（パスとセッション ID は載せない）。 */
export function paradisMobileAgentSessionView(session: IParadisResumeSession, terminalKey: string | undefined): IParadisMobileAgentSession {
	const preview = session.latestMessage?.text ?? session.preview;
	return {
		key: paradisAgentSessionKey(session.agent, session.id),
		agent: session.agent,
		title: paradisClipAgentSessionText(session.title, TITLE_LIMIT),
		...(preview.trim().length > 0 ? { preview: paradisClipAgentSessionText(preview, PREVIEW_LIMIT) } : {}),
		...(session.latestMessage !== undefined ? { previewRole: session.latestMessage.role } : {}),
		updatedAt: session.updatedAt,
		...(session.createdAt !== undefined ? { createdAt: session.createdAt } : {}),
		...(session.gitBranch !== undefined ? { branch: paradisClipAgentSessionText(session.gitBranch, TITLE_LIMIT) } : {}),
		...(terminalKey !== undefined ? { terminalKey } : {}),
	};
}

/** 一覧の絞り込み（題名・最後の発言・ブランチに、空白で区切った語がすべて含まれるもの）。 */
export function paradisMobileAgentSessionMatches(session: IParadisMobileAgentSession, query: string | undefined): boolean {
	const words = (query ?? '').toLowerCase().split(/\s+/).filter(word => word.length > 0);
	const haystack = `${session.title}\n${session.preview ?? ''}\n${session.branch ?? ''}`.toLowerCase();
	return words.every(word => haystack.includes(word));
}

/** 台帳に入れる（同じ id の古い記録・期限を過ぎたもの・上限を超えたものを捨てる）。 */
export function paradisRecordResumeRequest(ledger: readonly IParadisResumeLedgerEntry[], entry: IParadisResumeLedgerEntry, now: number): IParadisResumeLedgerEntry[] {
	return [...ledger.filter(item => item.id !== entry.id && now - item.at < RESUME_LEDGER_TTL_MS), entry].slice(-RESUME_LEDGER_LIMIT);
}
