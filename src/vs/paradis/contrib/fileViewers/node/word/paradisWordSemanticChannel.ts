/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// workbench(renderer) ⇔ shared process 間の Word 解析用 IPC チャネル。paradisSpreadsheetChannel.ts と同じ
// 薄いディスパッチャで、サービス本体は最初の呼び出しまで読み込まない（起動を重くしない）。

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { IPCServer, IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { PARADIS_WORD_SEMANTIC_CHANNEL, type IParadisWordAnalysisResult, type IParadisWordComparisonResult } from '../../common/word/paradisWordSemanticSummary.js';

/** チャネルが使うサービスの形（テストで差し替えられるように）。 */
export interface IParadisWordSemanticBackend {
	analyze(bytes: Uint8Array, token: CancellationToken): Promise<IParadisWordAnalysisResult>;
	compare(original: Uint8Array, modified: Uint8Array, token: CancellationToken): Promise<IParadisWordComparisonResult>;
}

const invalidArgument: IParadisWordAnalysisResult = Object.freeze({ ok: false, code: 'invalid' });

function bytesArgument(value: unknown): Uint8Array | undefined {
	if (value instanceof VSBuffer) {
		return value.buffer;
	}
	return value instanceof Uint8Array ? value : undefined;
}

/** shared process の中で解析する（worker を起動できないときの代わり）。 */
async function createInProcessBackend(): Promise<IParadisWordSemanticBackend> {
	const { ParadisWordSemanticService } = await import('./paradisWordSemanticService.js');
	return new ParadisWordSemanticService();
}

/** 解析は worker（別スレッド）で行う。shared process 本体を数秒止めないため。 */
async function createWorkerBackend(): Promise<IParadisWordSemanticBackend & IDisposable> {
	const { ParadisWordSemanticWorkerBackend } = await import('./paradisWordSemanticWorkerBackend.js');
	const workerPath = FileAccess.asFileUri('vs/paradis/contrib/fileViewers/node/word/paradisWordSemanticWorkerMain.js').fsPath;
	let inProcess: Promise<IParadisWordSemanticBackend> | undefined;
	return new ParadisWordSemanticWorkerBackend(ParadisWordSemanticWorkerBackend.workerFactory(workerPath), () => inProcess ??= createInProcessBackend());
}

export class ParadisWordSemanticChannel implements IServerChannel<string>, IDisposable {

	private backendPromise: Promise<IParadisWordSemanticBackend & Partial<IDisposable>> | undefined;
	private disposed = false;

	constructor(private readonly backendFactory: () => Promise<IParadisWordSemanticBackend & Partial<IDisposable>> = createWorkerBackend) { }

	dispose(): void {
		this.disposed = true;
		void this.backendPromise?.then(backend => backend.dispose?.(), () => undefined);
	}

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown, cancellationToken: CancellationToken = CancellationToken.None): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'analyze': {
				const bytes = bytesArgument(args[0]);
				if (!bytes) {
					return Promise.resolve(invalidArgument as T);
				}
				return this.getBackend().then(backend => backend.analyze(bytes, cancellationToken)) as Promise<T>;
			}
			case 'compare': {
				const original = bytesArgument(args[0]);
				const modified = bytesArgument(args[1]);
				if (!original || !modified) {
					return Promise.resolve(invalidArgument as T);
				}
				return this.getBackend().then(backend => backend.compare(original, modified, cancellationToken)) as Promise<T>;
			}
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}

	private getBackend(): Promise<IParadisWordSemanticBackend> {
		if (this.disposed) {
			return Promise.reject(new Error('The Word semantic channel has been disposed.'));
		}
		const backendPromise = this.backendPromise ??= this.backendFactory();
		return backendPromise.catch(error => {
			if (this.backendPromise === backendPromise) {
				this.backendPromise = undefined;
			}
			throw error;
		});
	}
}

/** sharedProcessMain.ts の PARA-PATCH 点から 1 行で呼べるファクトリ。 */
export function registerParadisWordSemantic(server: IPCServer<string>): IDisposable {
	const channel = new ParadisWordSemanticChannel();
	server.registerChannel(PARADIS_WORD_SEMANTIC_CHANNEL, channel);
	return toDisposable(() => channel.dispose());
}
