/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先のシェルの出力を、担当ウィンドウへ頼んで待つ側（shared process）。取り決めは
// common/paradisRemoteShellOutput.ts。頼みはイベントで全ウィンドウへ流し、`ownerId` が一致するウィンドウだけが
// 接続先の REH で読んで {@link ParadisRemoteShellOutputRequests.complete} で返す。

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import {
	IParadisRemoteShellOutputItemRequest,
	IParadisRemoteShellOutputRequest,
	paradisDecodeRemoteShellOutputItems,
	PARADIS_REMOTE_SHELL_OUTPUT_ITEMS_MAX,
	PARADIS_REMOTE_SHELL_OUTPUT_TIMEOUT_MS,
} from '../common/paradisRemoteShellOutput.js';
import { IParadisShellOutputTail, paradisCleanShellOutputLine, ParadisShellOutputError } from './paradisAgentShellOutput.js';

export type ParadisRemoteShellOutputReply = ReadonlyMap<string, IParadisShellOutputTail | ParadisShellOutputError> | 'no-window';

interface IPending {
	readonly ownerId: string;
	readonly ids: readonly string[];
	readonly resolve: (reply: ParadisRemoteShellOutputReply) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

export class ParadisRemoteShellOutputRequests extends Disposable {

	private readonly _onDidRequest = this._register(new Emitter<IParadisRemoteShellOutputRequest>());
	/** 担当ウィンドウへの頼み（接続先に繋いだウィンドウが購読する）。 */
	readonly onDidRequest = this._onDidRequest.event;

	private readonly pending = new Map<string, IPending>();

	constructor(private readonly timeoutMs: number = PARADIS_REMOTE_SHELL_OUTPUT_TIMEOUT_MS) {
		super();
		this._register(toDisposable(() => {
			for (const [requestId, entry] of [...this.pending]) {
				this.settle(requestId, entry, new Map());
			}
		}));
	}

	/**
	 * `ownerId` のウィンドウへ読み取りを頼む。担当が居なければすぐ 'no-window'。時間切れ・接続先で読めなかったものは
	 * 返事に入らない（呼び出し側が unavailable として扱う）。
	 */
	request(ownerId: string | undefined, items: readonly IParadisRemoteShellOutputItemRequest[], sessionId: string, lines: number): Promise<ParadisRemoteShellOutputReply> {
		if (ownerId === undefined) {
			return Promise.resolve('no-window');
		}
		const limited = items.slice(0, PARADIS_REMOTE_SHELL_OUTPUT_ITEMS_MAX);
		if (limited.length === 0) {
			return Promise.resolve(new Map());
		}
		const requestId = generateUuid();
		return new Promise<ParadisRemoteShellOutputReply>(resolve => {
			const timer = setTimeout(() => {
				const entry = this.pending.get(requestId);
				if (entry !== undefined) {
					this.settle(requestId, entry, new Map());
				}
			}, this.timeoutMs);
			this.pending.set(requestId, { ownerId, ids: limited.map(item => item.id), resolve, timer });
			this._onDidRequest.fire({ requestId, ownerId, sessionId, lines, items: limited });
		});
	}

	/** 担当ウィンドウの返事。頼んだウィンドウ以外からのもの・終わった頼みへのものは捨てる。 */
	complete(ownerId: string, requestId: string, value: unknown): void {
		const entry = this.pending.get(requestId);
		if (entry === undefined || entry.ownerId !== ownerId) {
			return;
		}
		const tails = new Map<string, IParadisShellOutputTail | ParadisShellOutputError>();
		for (const [id, item] of paradisDecodeRemoteShellOutputItems(value, entry.ids)) {
			if (item.error !== undefined || item.lines === undefined) {
				tails.set(id, item.error ?? 'unavailable');
				continue;
			}
			// 接続先で整えてあるが、手元でももう一度制御文字を落とす（接続先は乗っ取られうる）
			tails.set(id, { lines: item.lines.map(paradisCleanShellOutputLine), truncated: item.truncated === true, ...(item.ended !== undefined ? { ended: item.ended } : {}) });
		}
		this.settle(requestId, entry, tails);
	}

	private settle(requestId: string, entry: IPending, reply: ParadisRemoteShellOutputReply): void {
		clearTimeout(entry.timer);
		this.pending.delete(requestId);
		entry.resolve(reply);
	}
}
