/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StringSHA1 } from '../../../../base/common/hash.js';
import { PARADIS_RESUME_SESSION_ID_PATTERN, type IParadisResumeSession, type ParadisResumeAgent } from '../../sessionResume/common/paradisSessionResume.js';
import { paradisAntigravityResumedConversationId, paradisInteractiveAgentCommand, paradisIsInteractiveAntigravityCommand } from './paradisAgentCliCommand.js';

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
export function paradisAgentSessionKey(agent: ParadisResumeAgent, sessionId: string): string {
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
	/** 古いアプリは `antigravity` の行を読まずに捨てる（一覧の件数 `total` には入ったまま）。 */
	readonly agent: ParadisResumeAgent;
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

/**
 * 「始めた」の記録がこれより古ければ、その再開は途中で止まった（ウィンドウや PC が落ちた）とみなす。再開は
 * 準備を最長 60 秒待つので、それに一覧を引く・起動する時間を足しても十分に長い値にする。
 */
export const PARADIS_RESUME_STALE_START_MS = 5 * 60 * 1000;

/**
 * 同じ id の依頼が届いたときの扱い（台帳の記録 `previous` から決める）。
 * - `run`: 実行する。記録が無い（初めての依頼）、ターミナルを開く前に失敗した、始めたままターミナルを開く前に
 *   長く止まっている（ウィンドウや PC が途中で落ちた）もの
 * - `pending`: 始めたが、まだターミナルを開いていない（別のウィンドウが進めている最中か、落ちてからまだ間が無い）。
 *   `duplicate` を返すとスマホは預かりを消し、依頼が黙って消えるので、エラーで断って預かりのまま残させる
 * - `duplicate`: 再開した、またはターミナルを開いた後に止まった（依頼がそこへ渡った可能性があるので二度実行しない）
 * 同じ会話が PC で開いていれば、`run` でも呼び出し側が `running` で断る。
 */
export function paradisResumeRequestVerdict(previous: IParadisResumeLedgerEntry | undefined, now: number): 'run' | 'pending' | 'duplicate' {
	if (previous === undefined) {
		return 'run';
	}
	if (previous.terminalKey !== undefined) {
		return 'duplicate';
	}
	if (previous.status === 'failed') {
		return 'run';
	}
	if (previous.status === 'started') {
		return now - previous.at >= PARADIS_RESUME_STALE_START_MS ? 'run' : 'pending';
	}
	return 'duplicate';
}

/** Antigravity CLI の会話を写しているペイン（shared process のチャットの控え。agy が終わった後のペインも含む）。 */
export interface IParadisAntigravityPaneSession {
	readonly token: string;
	readonly sessionId: string;
	/**
	 * このペインでこの会話の hook を最後に受けた時刻 (epoch ms)。前回の起動から引き継いだ控えでは、保存してあった値
	 * （実際より古いことがある。保存に無ければ undefined）。
	 */
	readonly lastHookAt?: number;
	/** 前回の起動から引き継いだ控えを、shared process が読み戻した時刻 (epoch ms)。この起動中に hook を受けた控えには無い。 */
	readonly restoredAt?: number;
}

/** ターミナルのシェル統合が記録しているコマンド（Antigravity CLI が終わったか・前面が同じ会話かの手がかり）。 */
export interface IParadisTerminalCommandEvidence {
	/** 終わったコマンド（終わった時刻と終了コード）。ウィンドウの再読み込みの後も、終わった時刻は元のまま戻る。 */
	readonly finished: readonly { readonly at: number; readonly exitCode: number | undefined }[];
	/** 実行中のコマンド。無い・分からないときは undefined。 */
	readonly executing: string | undefined;
}

/** Ctrl+Z で止めただけのコマンドの終了コード（128 + SIGSTOP・SIGTSTP・SIGTTIN・SIGTTOU。macOS と Linux で番号が違う）。 */
function isSuspendedExitCode(exitCode: number | undefined): boolean {
	return exitCode !== undefined && exitCode >= 145 && exitCode <= 150;
}

/** `since` より後に終わったコマンドがあるか。止めただけ（Ctrl+Z）のものが混じっていれば `suspended`。 */
function finishedSince(evidence: IParadisTerminalCommandEvidence, since: number): 'none' | 'finished' | 'suspended' {
	const later = evidence.finished.filter(command => command.at > since);
	return later.length === 0 ? 'none' : later.some(command => isSuspendedExitCode(command.exitCode)) ? 'suspended' : 'finished';
}

/**
 * 控えの会話の agy が、そのペインでもう動いていないと言えるか（true なら「PC で開いています」から外し、再開を許す）。
 *
 * agy は終わりを hook で知らせない。証拠は「最後の hook（無ければ控えを読み戻した時刻）より後に、そのターミナルで
 * コマンドが終わった」こと: agy が前面にいる間は、シェルのコマンドは終わらない。シェル統合のプロンプトの状態は使わない
 * （再読み込み・復元の後は、動いている最中でも入力待ちに戻る）。次のときは動いている扱いにする（二重に起動しない側）:
 * - 時刻が無い・シェル統合が無い・後に終わったコマンドが無い
 * - 後に終わったコマンドに、止めただけ（Ctrl+Z）のものがある（agy は裏で生きている）
 * - 前面でまた agy が動いていて、別の会話を名指しして（`--conversation <別の id>`）いない（素の `agy` や `agy -c` は、
 *   最初の発言まで hook が来ず、同じ会話を開き直していても見分けられない）
 */
export function paradisAntigravityConversationLeftPane(session: IParadisAntigravityPaneSession, evidence: IParadisTerminalCommandEvidence | undefined): boolean {
	// 引き継いだ控えの `lastHookAt` は実際より古いことがあるので、読み戻した時刻があればそちら（新しい方）から見る
	const since = session.restoredAt !== undefined ? Math.max(session.restoredAt, session.lastHookAt ?? 0) : session.lastHookAt;
	if (evidence === undefined || since === undefined || finishedSince(evidence, since) !== 'finished') {
		return false;
	}
	if (evidence.executing === undefined || !paradisIsInteractiveAntigravityCommand(evidence.executing)) {
		return true;
	}
	const named = paradisAntigravityResumedConversationId(evidence.executing);
	return named !== undefined && named !== session.sessionId;
}

/**
 * ペインの前面の agy が、控えの会話を開いていると言えるか（true のときだけ、チャット欄や預かりの文をそのペインへ打つ）。
 * 控えの会話の後に agy を始め直していると、前面は別の会話かもしれない（新しい会話の hook は最初の発言まで来ない）。
 * - 前面のコマンドが控えの会話を名指ししている（`agy --conversation <同じ id>`）なら true
 * - それ以外は、その会話の hook を受けた時刻が分かっていて、それより後に終わったコマンドが無いときだけ true。時刻は
 *   再起動をまたいで引き継ぐ（終わったコマンドの時刻も復元で元のまま戻る）ので、動き続けている agy へは再起動の後も
 *   打てる。引き継いだ時刻が実際より古くても、数えるコマンドが増えるだけ（打たない側）。時刻の無い古い保存では打たない
 */
export function paradisAntigravityPaneHoldsConversation(session: IParadisAntigravityPaneSession | undefined, evidence: IParadisTerminalCommandEvidence | undefined): boolean {
	if (session === undefined || evidence === undefined) {
		return false;
	}
	if (evidence.executing !== undefined && paradisAntigravityResumedConversationId(evidence.executing) === session.sessionId) {
		return true;
	}
	return session.lastHookAt !== undefined && finishedSince(evidence, session.lastHookAt) === 'none';
}

/** {@link paradisLiveSessionTerminalKeys} が見る、今のターミナルの様子。 */
export interface IParadisLiveSessionSources {
	/** hook が報告した各ペインの会話（状態のスナップショットの `paneSessions`）。 */
	readonly paneSessions: readonly { readonly token: string; readonly agent: ParadisResumeAgent; readonly sessionId: string }[];
	/** Antigravity CLI の会話を写しているペイン。 */
	readonly antigravityPaneSessions: readonly IParadisAntigravityPaneSession[];
	/** ペインのターミナルのキー。ターミナルがもう無ければ undefined。 */
	terminalKeyOfPane(token: string): string | undefined;
	/** ペインのターミナルのシェル統合の記録。シェル統合が無ければ undefined（Antigravity CLI のペインは動いている扱いになる）。 */
	commandEvidenceOfPane(token: string): IParadisTerminalCommandEvidence | undefined;
	/** 各ターミナルで実行中のコマンド（シェル統合の記録）と、そのターミナルのキー。 */
	readonly executing: readonly { readonly commandLine: string; terminalKey(): string | undefined }[];
}

/**
 * 今ターミナルで動いている会話（指紋 → そのターミナルのキー）。hook が報告した会話を先に、実行中のコマンド
 * （{@link paradisResumedSessionOfCommand}）を後に見る（同じ会話は先に見つけたターミナルを使う）。
 */
export function paradisLiveSessionTerminalKeys(sources: IParadisLiveSessionSources): Map<string, string> {
	const result = new Map<string, string>();
	const antigravity = sources.antigravityPaneSessions
		.filter(session => !paradisAntigravityConversationLeftPane(session, sources.commandEvidenceOfPane(session.token)))
		.map(session => ({ token: session.token, sessionId: session.sessionId, agent: 'antigravity' as const }));
	for (const session of [...sources.paneSessions, ...antigravity]) {
		const terminalKey = sources.terminalKeyOfPane(session.token);
		if (terminalKey !== undefined) {
			result.set(paradisAgentSessionKey(session.agent, session.sessionId), terminalKey);
		}
	}
	for (const entry of sources.executing) {
		const resumed = paradisResumedSessionOfCommand(entry.commandLine);
		const terminalKey = resumed !== undefined ? entry.terminalKey() : undefined;
		if (resumed !== undefined && terminalKey !== undefined) {
			const key = paradisAgentSessionKey(resumed.agent, resumed.sessionId);
			if (!result.has(key)) {
				result.set(key, terminalKey);
			}
		}
	}
	return result;
}

/** 台帳に入れる（同じ id の古い記録・期限を過ぎたもの・上限を超えたものを捨てる）。 */
export function paradisRecordResumeRequest(ledger: readonly IParadisResumeLedgerEntry[], entry: IParadisResumeLedgerEntry, now: number): IParadisResumeLedgerEntry[] {
	return [...ledger.filter(item => item.id !== entry.id && now - item.at < RESUME_LEDGER_TTL_MS), entry].slice(-RESUME_LEDGER_LIMIT);
}

/**
 * ターミナルで実行中のコマンドが、既存の会話を続ける `claude --resume <id>` / `codex resume <id>` / `agy --conversation <id>`
 * なら、その会話を返す（「PC で今開いている会話」を hook が届く前でも見分けるため。レビュー M6）。複製して始める（fork）ものは
 * 別の会話なので返さない。
 */
export function paradisResumedSessionOfCommand(commandLine: string): { readonly agent: ParadisResumeAgent; readonly sessionId: string } | undefined {
	const antigravity = paradisAntigravityResumedConversationId(commandLine);
	if (antigravity !== undefined) {
		return PARADIS_RESUME_SESSION_ID_PATTERN.test(antigravity) ? { agent: 'antigravity', sessionId: antigravity } : undefined;
	}
	const command = paradisInteractiveAgentCommand(commandLine);
	if (command === undefined || command.mode !== 'resume') {
		return undefined;
	}
	let sessionId = command.sessionId;
	if (command.agent === 'claude') {
		const words = commandLine.trim().split(/\s+/).map(word => word.replace(/^['"]|['"]$/g, ''));
		for (let index = 0; index < words.length && sessionId === undefined; index++) {
			const word = words[index];
			if (word === '--resume' || word === '-r') {
				sessionId = words[index + 1];
			} else if (word.startsWith('--resume=')) {
				sessionId = word.slice('--resume='.length);
			}
		}
	}
	return sessionId !== undefined && PARADIS_RESUME_SESSION_ID_PATTERN.test(sessionId) ? { agent: command.agent, sessionId } : undefined;
}
