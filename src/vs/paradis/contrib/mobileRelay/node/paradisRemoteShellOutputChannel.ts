/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（REH）で、Claude Code のバックグラウンドのシェルの出力の末尾を読むチャネルの実体。登録は
// paradisRemoteShellOutput.server.ts。取り決めは common/paradisRemoteShellOutput.ts。

import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IParadisRemoteShellOutputItem, paradisIsValidRemoteShellOutputItems } from '../common/paradisRemoteShellOutput.js';
import { paradisReadRemoteShellOutputTail } from './paradisAgentShellOutput.js';

/**
 * `readTails`: `[items, sessionId, lines]` の各シェルの末尾を、1 つずつ読む。
 * 形の検査と、パスの形・持ち主の検査は {@link paradisReadRemoteShellOutputTail} が持つ。
 */
export class ParadisRemoteShellOutputChannel<TContext> implements IServerChannel<TContext> {

	constructor(private readonly fallbackRoots?: readonly string[]) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		if (command !== 'readTails') {
			throw new Error(`Method not found: ${command}`);
		}
		const [items, sessionId, lines] = Array.isArray(arg) ? arg : [];
		if (!paradisIsValidRemoteShellOutputItems(items)) {
			return [] as T;
		}
		const result: IParadisRemoteShellOutputItem[] = [];
		for (const item of items) {
			const tail = await paradisReadRemoteShellOutputTail(item.outputFile, sessionId, item.id, lines, this.fallbackRoots);
			result.push(typeof tail === 'string'
				? { id: item.id, error: tail === 'not-found' ? 'not-found' : 'unavailable' }
				: { id: item.id, lines: tail.lines, truncated: tail.truncated, ...(tail.ended !== undefined ? { ended: tail.ended } : {}) });
		}
		return result as T;
	}
}
