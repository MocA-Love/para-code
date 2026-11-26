/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「資料」ビュー（ウィンドウ）から shared process の台帳を読む・頼むチャネル。台帳を書くのはここ（資料のサービス）だけ。
// 渡されたパスと接続先の印は検査してから使う。ペインの会話はウィンドウが自分のペインのトークンを渡したときだけ返す
// （ほかのウィンドウのペインのトークンは渡さない）。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { PARADIS_DOC_MAX_RECORDS, paradisDocKind, paradisIsVcsInternalPath, paradisParseDocFingerprint, paradisIsWatchableDocPath, paradisNormalizeDocPath } from '../common/paradisAgentDocs.js';
import { IParadisDocPaneSessionInfo, IParadisDocViewRecord, PARADIS_AGENT_DOCS_VIEW_ON_DID_CHANGE, ParadisAgentDocsViewCall, ParadisDocAssignResult, paradisDocViewRecord } from '../common/paradisAgentDocsView.js';
import { paradisCountOpenDocComments } from '../common/paradisDocComments.js';
import { ParadisAgentDocsService } from './paradisAgentDocsService.js';
import { ParadisDocCommentsStore } from './paradisDocCommentsStore.js';

const HOST_ID_PATTERN = /^[A-Za-z0-9._-]{0,64}$/;
/** 一度に問えるペインの数。 */
const MAX_TOKENS = 500;
/** 変わった知らせをまとめる時間（hook が続けて来ても一覧の取り直しを 1 回にする）。 */
const CHANGE_DELAY_MS = 150;

/** 受け取った接続先の印とパスを検査する。資料でない・バージョン管理の中のパスは undefined。 */
function docTarget(rawHostId: unknown, rawPath: unknown): { hostId: string; path: string } | undefined {
	const path = paradisNormalizeDocPath(rawPath);
	if (typeof rawHostId !== 'string' || !HOST_ID_PATTERN.test(rawHostId) || path === undefined || paradisDocKind(path) === undefined || paradisIsVcsInternalPath(path)) {
		return undefined;
	}
	return { hostId: rawHostId, path };
}

export class ParadisAgentDocsViewChannel extends Disposable implements IServerChannel<unknown> {

	private readonly _onDidChange = this._register(new Emitter<void>());
	private readonly _changeScheduler = this._register(new RunOnceScheduler(() => this._onDidChange.fire(), CHANGE_DELAY_MS));

	constructor(
		private readonly _service: ParadisAgentDocsService,
		private readonly _comments: ParadisDocCommentsStore,
	) {
		super();
		this._register(_service.ledger.onDidChange(() => this._changeScheduler.schedule()));
		// 未回答のコメントの数（一覧の行とアイコンのバッジ）も変わる
		this._register(_comments.onDidChange(() => this._changeScheduler.schedule()));
		this._register(_service.onDidChangeSessions(() => this._changeScheduler.schedule()));
	}

	listen<T>(_ctx: unknown, event: string): Event<T> {
		if (event === PARADIS_AGENT_DOCS_VIEW_ON_DID_CHANGE) {
			return this._onDidChange.event as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		await Promise.all([this._service.ledger.ready, this._comments.ready]);
		switch (command) {
			case ParadisAgentDocsViewCall.List:
				return this.list() as T;
			case ParadisAgentDocsViewCall.PaneSessions:
				return this.paneSessions(args[0]) as T;
			case ParadisAgentDocsViewCall.RegisterOpened: {
				const target = docTarget(args[0], args[1]);
				return (target !== undefined && this._service.ledger.registerUserOpened(target.hostId, target.path)) as T;
			}
			case ParadisAgentDocsViewCall.Remove: {
				const target = docTarget(args[0], args[1]);
				return (target !== undefined && this._service.ledger.remove(target.hostId, target.path)) as T;
			}
			case ParadisAgentDocsViewCall.RemoveMany: {
				let removed = 0;
				for (const rawPath of Array.isArray(args[1]) ? args[1].slice(0, PARADIS_DOC_MAX_RECORDS) : []) {
					const target = docTarget(args[0], rawPath);
					if (target !== undefined && this._service.ledger.remove(target.hostId, target.path)) {
						removed++;
					}
				}
				return removed as T;
			}
			case ParadisAgentDocsViewCall.SetFingerprints: {
				const updates = [];
				for (const raw of Array.isArray(args[1]) ? args[1].slice(0, PARADIS_DOC_MAX_RECORDS) : []) {
					const item = typeof raw === 'object' && raw !== null ? raw as { path?: unknown; fingerprint?: unknown } : {};
					const target = docTarget(args[0], item.path);
					const fingerprint = paradisParseDocFingerprint(item.fingerprint);
					if (target !== undefined && fingerprint !== undefined) {
						updates.push({ path: target.path, fingerprint });
					}
				}
				if (updates.length > 0 && typeof args[0] === 'string') {
					this._service.ledger.setFingerprints(args[0], updates);
				}
				return undefined as T;
			}
			case ParadisAgentDocsViewCall.Relocate:
				return this.relocate(args[0], args[1], args[2], args[3]) as T;
			case ParadisAgentDocsViewCall.SetMissing: {
				const target = docTarget(args[0], args[1]);
				if (target !== undefined && typeof args[2] === 'boolean') {
					this._service.ledger.setMissing(target.hostId, target.path, args[2]);
				}
				return undefined as T;
			}
			case ParadisAgentDocsViewCall.Assign:
				return this.assign(args[0], args[1], args[2]) as T;
			case ParadisAgentDocsViewCall.NoteChanged: {
				const target = docTarget(args[0], args[1]);
				if (target !== undefined && paradisIsWatchableDocPath(target.path) && Array.isArray(args[2])) {
					this._service.noteFileChanged(target.hostId, target.path, args[2].slice(0, MAX_TOKENS).filter((token): token is string => typeof token === 'string'));
				}
				return undefined as T;
			}
		}
		throw new Error(`Call not found: ${command}`);
	}

	list(): IParadisDocViewRecord[] {
		return this._service.ledger.all().map(record => paradisDocViewRecord(
			record,
			record.owner !== undefined ? this._service.livenessOf(record.owner) : undefined,
			paradisCountOpenDocComments(this._comments.peek(record.hostId, record.path)?.threads ?? []),
		));
	}

	paneSessions(rawTokens: unknown): IParadisDocPaneSessionInfo[] {
		if (!Array.isArray(rawTokens)) {
			return [];
		}
		const sessions: IParadisDocPaneSessionInfo[] = [];
		for (const token of rawTokens.slice(0, MAX_TOKENS)) {
			const pane = typeof token === 'string' ? this._service.sessionOf(token) : undefined;
			if (pane !== undefined) {
				sessions.push({ token: token as string, agent: pane.agent, session: pane.session, hostId: pane.hostId });
			}
		}
		return sessions;
	}

	/** 記録の場所を移動先へ書き換え、コメントも移す。移動先は見張りが拾うパス（依存・バージョン管理の中でない）だけ。 */
	relocate(rawHostId: unknown, rawFrom: unknown, rawTo: unknown, rawHash: unknown): boolean {
		const from = docTarget(rawHostId, rawFrom);
		const to = docTarget(rawHostId, rawTo);
		if (from === undefined || to === undefined || typeof rawHash !== 'string' || !paradisIsWatchableDocPath(to.path) || !this._service.ledger.relocate(from.hostId, from.path, to.path, rawHash)) {
			return false;
		}
		// 失敗は保存係が自分で知らせる
		this._comments.move(from.hostId, from.path, to.path).catch(() => undefined);
		return true;
	}

	assign(rawHostId: unknown, rawPath: unknown, rawToken: unknown): ParadisDocAssignResult {
		const target = docTarget(rawHostId, rawPath);
		if (target === undefined) {
			return 'unknown';
		}
		const pane = typeof rawToken === 'string' ? this._service.sessionOf(rawToken) : undefined;
		if (pane === undefined) {
			return 'sessionUnknown';
		}
		if (pane.hostId !== target.hostId) {
			return 'hostMismatch';
		}
		return this._service.ledger.assignOwner(target.hostId, target.path, pane);
	}
}
