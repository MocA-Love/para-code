/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 資料の台帳を hook から育てるサービス（shared process）。
//  - ペイン → 会話: hook のバスから自分で控える（ParadisAgentBrowserService の控えはプロバイダへ渡る口が無い）
//  - ファイル → 会話: Claude Code の PostToolUse（Write・Edit・NotebookEdit）と Codex の PostToolUse（apply_patch）で、
//    書いた会話を持ち主にする
//  - 会話の終わり: SessionEnd と、ペインの終了（TerminalExit。会話の ID は載らないので控えから引く）
//  - preview_file で開いた html・md: 持ち主がいなければ開いたペインの会話の資料にする
// 持ち主の取り違えを避けるため、発信元のプロセスでペインの持ち主と確かめられなかった hook（ownerUnverified）は、
// SSH の窓の hook（接続先の pid は手元で辿れないので、必ずこの印が付く）を「会話の ID と会話の記録のパスの組」で
// 確かめられたときだけ使う（accepts）。手元のペインの確かめられなかった hook は使わない。
// 入れ子の子エージェントの hook は別の知らせ（onParadisAgentNestedHookEvent）に流れるので、ここには来ない。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { paradisAgentHookRemoteHostId } from '../../agentBrowser/common/paradisAgentHooks.js';
import { paradisHookAgentKindForTranscript } from '../../agentBrowser/node/paradisAgentHookOwnership.js';
import type { IParadisPreviewFileOpened } from '../../agentBrowser/node/paradisPreviewFileObservers.js';
import type { ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';
import { IParadisDocOwner, ParadisDocOwnerLiveness, paradisDocHookNamesTranscript, paradisDocKind, paradisDocPatchWrites, paradisNormalizeDocPath } from '../common/paradisAgentDocs.js';
import { ParadisAgentDocsLedger } from './paradisAgentDocsLedger.js';

/** ペインで動いている会話。 */
export interface IParadisDocPaneSession {
	readonly agent: ParadisAgentKind;
	readonly session: string;
	/** その会話で最初に報告された作業ディレクトリ。 */
	readonly cwd?: string;
	/** hook が名乗った接続先の印（手元は空文字）。 */
	readonly hostId: string;
	/** その会話の記録（transcript）のパス（hook が書いた綴り。接続先のペインでは接続先のパス）。 */
	readonly transcriptPath?: string;
}

/** 台帳に載せる書き込みのツール（Claude Code）。パスの欄の名前。 */
const WRITE_TOOLS: ReadonlyMap<string, string> = new Map([['Write', 'file_path'], ['Edit', 'file_path'], ['NotebookEdit', 'notebook_path']]);
const SESSION_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export class ParadisAgentDocsService extends Disposable {

	private readonly _paneSessions = new Map<string, IParadisDocPaneSession>();
	/** この起動で生きているのを見た会話（終了の印を外す処理を hook ごとに繰り返さないため）。 */
	private readonly _seenAlive = new Set<string>();

	private readonly _onDidChangeSessions = this._register(new Emitter<void>());
	/** ペインで動いている会話が変わった（持ち主の「動作中」の表示が変わる）。 */
	readonly onDidChangeSessions: Event<void> = this._onDidChangeSessions.event;

	private readonly _onHook = this._register(new Emitter<IParadisAgentHookEvent>());
	/**
	 * 台帳が受けた後の hook。{@link accepts} で確かめた SSH の窓の hook からは ownerUnverified を外してあるので、
	 * 資料のコメントの届け方と「編集中」の印は、台帳と同じ hook を信じる。
	 */
	readonly onHook: Event<IParadisAgentHookEvent> = this._onHook.event;

	constructor(
		readonly ledger: ParadisAgentDocsLedger,
		hookEvents: Event<IParadisAgentHookEvent>,
	) {
		super();
		this._register(hookEvents(event => {
			const accepted = this.accepts(event);
			if (accepted) {
				this._handleAccepted(event);
			}
			if (accepted && event.ownerUnverified) {
				const { ownerUnverified: _ownerUnverified, ...verified } = event;
				this._onHook.fire(verified);
			} else {
				this._onHook.fire(event);
			}
		}));
	}

	/**
	 * その hook を、ペインの会話のものとして使ってよいか。発信元のプロセスで確かめられた hook はそのまま使う。
	 * 確かめられなかった hook（ownerUnverified）は、接続先の hook（`remoteHostId` 付き）で、次をすべて満たすときだけ:
	 *  - 会話の ID と会話の記録のパスが同じ会話を指す（{@link paradisDocHookNamesTranscript}）
	 *  - そのペインにまだ会話が結ばれていないか、結ばれている会話と ID・記録・接続先が同じ。別の会話へ結び替えるのは、
	 *    SessionEnd を送らない種類（Codex など）の、サブエージェントのものでない SessionStart だけ。Claude Code は
	 *    SessionEnd で結びが外れてから次の会話を結ぶので、`/fork` で分かれた会話（別の ID・別の記録）の hook が
	 *    同じペインのトークンで届いても結び替えない
	 *  - その会話が別のペインで生きていない（コメントの届け先を、名乗っただけのペインへ増やさない）
	 */
	accepts(event: IParadisAgentHookEvent): boolean {
		if (!event.ownerUnverified || event.event === 'TerminalExit') {
			return true;
		}
		const session = event.sessionId;
		const hostId = event.remoteHostId;
		if (hostId === undefined || session === undefined || !SESSION_PATTERN.test(session) || event.transcriptPath === undefined) {
			return false;
		}
		const agent = event.agentKind ?? paradisHookAgentKindForTranscript(event.transcriptPath);
		if (!paradisDocHookNamesTranscript(agent, session, event.transcriptPath)) {
			return false;
		}
		const previous = this._paneSessions.get(event.token);
		if (previous !== undefined) {
			if (previous.hostId !== hostId) {
				return false;
			}
			if (previous.session === session) {
				return previous.agent === agent && (previous.transcriptPath === undefined || previous.transcriptPath === event.transcriptPath);
			}
			if (agent === 'claude' || previous.agent !== agent || event.event !== 'SessionStart' || event.payload?.agent_id !== undefined) {
				return false;
			}
		}
		for (const [token, pane] of this._paneSessions) {
			if (token !== event.token && pane.session === session) {
				return false;
			}
		}
		return true;
	}

	/** そのペインで動いている会話。hook がまだ届いていなければ undefined。 */
	sessionOf(token: string): IParadisDocPaneSession | undefined {
		return this._paneSessions.get(token);
	}

	/** その会話が動いているペインのトークン（hook が名乗った順）。 */
	tokensOf(session: string): string[] {
		return [...this._paneSessions.entries()].filter(([, pane]) => pane.session === session).map(([token]) => token);
	}

	/** 持ち主の会話の状態。 */
	livenessOf(owner: IParadisDocOwner): ParadisDocOwnerLiveness {
		for (const pane of this._paneSessions.values()) {
			if (pane.session === owner.session) {
				return 'live';
			}
		}
		return owner.ended !== undefined ? 'ended' : 'unknown';
	}

	private _handleAccepted(event: IParadisAgentHookEvent): void {
		const token = event.token;
		if (event.event === 'TerminalExit' || event.event === 'SessionEnd') {
			const pane = this._paneSessions.get(token);
			const session = event.event === 'SessionEnd' && event.sessionId !== undefined && SESSION_PATTERN.test(event.sessionId) ? event.sessionId : pane?.session;
			if (this._paneSessions.delete(token)) {
				this._onDidChangeSessions.fire();
			}
			if (session !== undefined && !this._isLive(session)) {
				this._seenAlive.delete(session);
				void this.ledger.ready.then(() => this.ledger.markSessionEnded(session));
			}
			return;
		}
		const pane = this._recordPane(event);
		if (pane === undefined) {
			return;
		}
		if (!this._seenAlive.has(pane.session)) {
			this._seenAlive.add(pane.session);
			void this.ledger.ready.then(() => this.ledger.markSessionAlive(pane.session));
		}
		if (event.event !== 'PostToolUse' || event.toolName === undefined) {
			return;
		}
		const tool = event.toolName;
		const input = event.payload?.tool_input ?? event.toolInput;
		let paths: string[] = [];
		if (pane.agent === 'claude') {
			const pathField = WRITE_TOOLS.get(tool);
			const path = paradisNormalizeDocPath(pathField !== undefined && typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[pathField] : undefined);
			paths = path !== undefined && paradisDocKind(path) !== undefined ? [path] : [];
		} else if (pane.agent === 'codex' && tool === 'apply_patch') {
			// Codex のパッチのパスは、その hook の作業ディレクトリからの相対パス
			paths = paradisDocPatchWrites(input, event.payload?.tool_response, event.cwd ?? pane.cwd);
		}
		if (paths.length === 0) {
			return;
		}
		const toolUseId = event.toolUseId;
		const hostId = event.remoteHostId ?? pane.hostId;
		void this.ledger.ready.then(() => paths.forEach(path => this.ledger.recordWrite(hostId, path, pane, { at: event.at, tool, ...(toolUseId !== undefined ? { toolUseId } : {}) })));
	}

	/** preview_file が開いた・予約した後に呼ばれる。結果の文に足す英文を返す。 */
	async onPreviewFileOpened(opened: IParadisPreviewFileOpened): Promise<string | undefined> {
		const path = paradisNormalizeDocPath(opened.path);
		if (path === undefined || paradisDocKind(path) === undefined) {
			return undefined;
		}
		const pane = this._paneSessions.get(opened.token);
		if (pane === undefined) {
			// どの会話のペインか分からないうちは登録しない（開くだけ）
			return undefined;
		}
		const hostId = opened.remoteAuthority !== undefined ? paradisAgentHookRemoteHostId(opened.remoteAuthority) ?? pane.hostId : pane.hostId;
		await this.ledger.ready;
		switch (this.ledger.registerPreview(hostId, path, pane)) {
			case 'registered':
				return 'It is now a document of this session (list_docs shows it). The user\'s comments on it will be typed into this terminal.';
			case 'other':
				return 'Another session owns this document. Call adopt_doc if the user asked you to take it over.';
			default:
				return undefined;
		}
	}

	private _isLive(session: string): boolean {
		for (const pane of this._paneSessions.values()) {
			if (pane.session === session) {
				return true;
			}
		}
		return false;
	}

	private _recordPane(event: IParadisAgentHookEvent): IParadisDocPaneSession | undefined {
		const previous = this._paneSessions.get(event.token);
		const session = event.sessionId;
		if (session === undefined || !SESSION_PATTERN.test(session)) {
			return previous;
		}
		const agent = event.agentKind ?? (event.transcriptPath !== undefined ? paradisHookAgentKindForTranscript(event.transcriptPath) : previous?.agent);
		if (agent === undefined) {
			return previous;
		}
		if (previous !== undefined && previous.session === session && previous.agent === agent) {
			return previous;
		}
		// 同じ会話の間は最初に報告された作業ディレクトリを使う（後の hook の cwd はツールが cd した先になりうる）
		const cwd = event.cwd !== undefined ? paradisNormalizeDocPath(event.cwd) : undefined;
		const next: IParadisDocPaneSession = { agent, session, ...(cwd !== undefined ? { cwd } : {}), hostId: event.remoteHostId ?? '', ...(event.transcriptPath !== undefined ? { transcriptPath: event.transcriptPath } : {}) };
		this._paneSessions.set(event.token, next);
		this._onDidChangeSessions.fire();
		return next;
	}
}
