/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 実行したコマンドの記録（Q372）を、スペースの履歴フォルダの `commands.jsonl` に読み書きする。
//
// - フォルダはシェル統合スクリプトが本人だけ読める形（700）で作る。Para Code はフォルダを作らず、
//   無ければ書かない（作ると誰でも読めるフォルダになり、コマンドの中の秘密が見える）
// - 書き込みはフォルダごとに 1 秒まとめ、順番に行う。IFileService に追記が無いので、読み直して
//   足して書き直す（別のウィンドウが同じフォルダへ書いた分も消さない）
// - 接続先（SSH）では接続先の `~/.para-code/terminal-history` に書く（パスの変換は履歴の提供元と同じ）
// - スペースの履歴フォルダを持たないターミナル（スペースごとの履歴がオフ、下部パネルの共通ターミナル）の
//   記録は、このマシンのユーザーデータの `paradis/terminalCommands.jsonl` に書く

import { RunOnceScheduler, Sequencer } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisTerminalHistoryProvider } from '../../terminalHistorySuggest/browser/paradisTerminalHistoryCompletion.contribution.js';
import { IParadisCommandRecord, PARADIS_COMMAND_RECORDS_FILE, paradisAppendCommandRecords, paradisParseCommandRecords, paradisSerializeCommandRecord } from '../common/paradisTerminalCommandRecords.js';

/** 読んだ記録を使い回す時間。 */
const READ_TTL_MS = 30_000;
/** 書き込みをまとめる時間。 */
const FLUSH_DELAY_MS = 1_000;
/** スペースの履歴フォルダを持たないターミナルの記録（ユーザーデータの中）。 */
const COMMON_RECORDS_PATH = ['paradis', 'terminalCommands.jsonl'];
/** {@link COMMON_RECORDS_PATH} の記録を表すキー（シェルから見たパスは空にならない）。 */
const COMMON_KEY = '';

export const IParadisTerminalCommandRecordService = createDecorator<IParadisTerminalCommandRecordService>('paradisTerminalCommandRecordService');

export interface IParadisTerminalCommandRecordService {
	readonly _serviceBrand: undefined;
	/**
	 * `directory`（シェルから見たスペースの履歴フォルダ）へ記録を 1 件足す。書くのは少し後。
	 * undefined なら、スペースの履歴フォルダを持たないターミナルの共通の記録へ足す。
	 */
	record(directory: string | undefined, record: IParadisCommandRecord): void;
	/** `directory` の記録（書いた順）。まだ書いていない分も含める。undefined は共通の記録。 */
	read(directory: string | undefined, token: CancellationToken): Promise<readonly IParadisCommandRecord[]>;
}

class DirectoryRecords extends Disposable {
	cached: { readonly records: readonly IParadisCommandRecord[]; readonly readAt: number } | undefined;
	pending: IParadisCommandRecord[] = [];
	readonly flushScheduler: RunOnceScheduler;

	constructor(flush: () => void) {
		super();
		this.flushScheduler = this._register(new RunOnceScheduler(flush, FLUSH_DELAY_MS));
	}
}

export class ParadisTerminalCommandRecordService extends Disposable implements IParadisTerminalCommandRecordService {
	declare readonly _serviceBrand: undefined;

	private readonly _directories = this._register(new DisposableMap<string, DirectoryRecords>());
	private readonly _sequencer = new Sequencer();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
	) {
		super();
	}

	record(directory: string | undefined, record: IParadisCommandRecord): void {
		const state = this._state(directory ?? COMMON_KEY);
		state.pending.push(record);
		state.flushScheduler.schedule();
	}

	async read(directory: string | undefined, token: CancellationToken): Promise<readonly IParadisCommandRecord[]> {
		const key = directory ?? COMMON_KEY;
		const state = this._state(key);
		if (state.cached === undefined || Date.now() - state.cached.readAt > READ_TTL_MS) {
			const resource = await this._recordsResource(key, token);
			if (resource === undefined || token.isCancellationRequested) {
				return state.pending.slice();
			}
			const records = await this._readFile(resource);
			state.cached = { records, readAt: Date.now() };
		}
		return state.pending.length > 0 ? state.cached.records.concat(state.pending) : state.cached.records;
	}

	private _state(key: string): DirectoryRecords {
		let state = this._directories.get(key);
		if (!state) {
			state = new DirectoryRecords(() => this._flush(key));
			this._directories.set(key, state);
		}
		return state;
	}

	private _flush(key: string): void {
		void this._sequencer.queue(async () => {
			const state = this._directories.get(key);
			if (!state || state.pending.length === 0) {
				return;
			}
			const added = state.pending;
			state.pending = [];
			try {
				const resource = await this._recordsResource(key, CancellationToken.None);
				if (resource === undefined) {
					return;
				}
				const folder = dirname(resource);
				if (key !== COMMON_KEY && !await this._fileService.exists(folder)) {
					// シェル統合がまだフォルダを作っていない（作ると権限が広くなるので、こちらでは作らない）。
					return;
				}
				const existing = await this._readFile(resource);
				const next = paradisAppendCommandRecords(existing, added);
				await this._fileService.writeFile(resource, VSBuffer.fromString(next.map(paradisSerializeCommandRecord).join('\n') + '\n'));
				state.cached = { records: next, readAt: Date.now() };
			} catch (error) {
				this._logService.trace('[paradisTerminalCommandRecords] could not write the command records', error);
			}
		});
	}

	private async _readFile(resource: URI): Promise<readonly IParadisCommandRecord[]> {
		try {
			const content = await this._fileService.readFile(resource);
			return paradisParseCommandRecords(content.value.toString());
		} catch (error) {
			if (!(error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				this._logService.trace('[paradisTerminalCommandRecords] could not read the command records', error);
			}
			return [];
		}
	}

	private async _recordsResource(key: string, token: CancellationToken): Promise<URI | undefined> {
		if (key === COMMON_KEY) {
			return joinPath(this._environmentService.userRoamingDataHome, ...COMMON_RECORDS_PATH);
		}
		const folder = await paradisTerminalHistoryProvider()?.toResource(key, token);
		return folder === undefined ? undefined : joinPath(folder, PARADIS_COMMAND_RECORDS_FILE);
	}
}

registerSingleton(IParadisTerminalCommandRecordService, ParadisTerminalCommandRecordService, InstantiationType.Delayed);
