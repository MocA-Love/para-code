/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IParadisWorktreeCreateJobSnapshot, IParadisWorktreeCreateProgressStore } from '../common/paradisWorktreeCreate.js';

/**
 * IParadisWorktreeCreateProgressStore の実装 (単純なインメモリストア)。
 * 書き込み元は electron-browser のキューサービス (paradisWorktreeCreateQueue.ts)。
 * Web ビルドではキューサービスが存在しないため常に空 = 「作成中」行なし、で安全に成立する
 * (ParadisAgentStatusStore と同じ構成)。
 */
export class ParadisWorktreeCreateProgressStore extends Disposable implements IParadisWorktreeCreateProgressStore {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeJobs = this._register(new Emitter<void>());
	readonly onDidChangeJobs = this._onDidChangeJobs.event;

	private _jobs: readonly IParadisWorktreeCreateJobSnapshot[] = [];

	get jobs(): readonly IParadisWorktreeCreateJobSnapshot[] {
		return this._jobs;
	}

	setJobs(jobs: readonly IParadisWorktreeCreateJobSnapshot[]): void {
		this._jobs = [...jobs];
		this._onDidChangeJobs.fire();
	}
}
