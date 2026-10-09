/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// workbench(renderer) ⇔ shared process 間の Excel パース用IPCチャネル。paradisNotificationsChannel.ts と
// 同じ薄いディスパッチャ方式(switch文でサービスメソッドへ委譲するだけ)。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { PARADIS_SPREADSHEET_CHANNEL, type IParadisSemanticDiagnosticsSummary, type IParadisSpreadsheetService } from '../common/paradisSpreadsheet.js';

/** 詳しい解析を受け持つ口（テストで差し替えられるように）。 */
export interface IParadisSpreadsheetDiagnosticsBackend {
	collect(bytes: Uint8Array, token: CancellationToken): Promise<IParadisSemanticDiagnosticsSummary>;
}

/** ビューアが読む上限（PARADIS_SPREADSHEET_MAX_BYTES）と同じ。これより大きいものは worker へ送らない。 */
const MAX_DIAGNOSTICS_BYTES = 20 * 1024 * 1024;

function unavailable(reason: string): IParadisSemanticDiagnosticsSummary {
	return {
		available: false, terminal: false, expectedParts: 0, parsedParts: 0, expectedSheets: 0, parsedSheets: 0,
		expectedCells: 0, parsedCells: 0, unknownElements: 0, unresolvedReferences: 0, mismatchCount: 0, unavailableReason: reason,
	};
}

/**
 * 詳しい解析は worker（別スレッド・ヒープの上限つき）で行う。shared process 本体を止めず、壊れたブックで
 * 本体ごと落ちないようにするため。worker で解析できないときも、本体では解析せずに理由だけを返す。
 */
async function createWorkerBackend(): Promise<IParadisSpreadsheetDiagnosticsBackend & IDisposable> {
	const { ParadisSpreadsheetSemanticWorkerBackend } = await import('./spreadsheet/paradisSpreadsheetSemanticWorkerBackend.js');
	const workerPath = FileAccess.asFileUri('vs/paradis/contrib/fileViewers/node/spreadsheet/paradisSpreadsheetSemanticWorkerMain.js').fsPath;
	return new ParadisSpreadsheetSemanticWorkerBackend(ParadisSpreadsheetSemanticWorkerBackend.workerFactory(workerPath));
}

export class ParadisSpreadsheetChannel implements IServerChannel<string>, IDisposable {

	private servicePromise: Promise<IParadisSpreadsheetService> | undefined;
	private diagnosticsPromise: Promise<IParadisSpreadsheetDiagnosticsBackend & Partial<IDisposable>> | undefined;
	private disposed = false;

	constructor(
		private readonly serviceFactory: () => Promise<IParadisSpreadsheetService> = async () => {
			const { ParadisSpreadsheetService } = await import('./paradisSpreadsheetService.js');
			return new ParadisSpreadsheetService();
		},
		private readonly diagnosticsFactory: () => Promise<IParadisSpreadsheetDiagnosticsBackend & Partial<IDisposable>> = createWorkerBackend,
	) { }

	dispose(): void {
		this.disposed = true;
		void this.diagnosticsPromise?.then(backend => backend.dispose?.(), () => undefined);
	}

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown, cancellationToken: CancellationToken = CancellationToken.None): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			// 表示の投影だけを返す。第 2 引数は画像の画素の上限（数でなければ既定値）。診断の指定は通さない。
			case 'parseWorkbook': return this.getService().then(service => service.parseWorkbook(String(args[0]), typeof args[1] === 'number' ? args[1] : undefined)) as Promise<T>;
			case 'collectSemanticDiagnostics': return this.collectSemanticDiagnostics(args[0], cancellationToken) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}

	private async collectSemanticDiagnostics(value: unknown, token: CancellationToken): Promise<IParadisSemanticDiagnosticsSummary> {
		const bytes = value instanceof VSBuffer ? value.buffer : value instanceof Uint8Array ? value : undefined;
		if (!bytes) {
			return unavailable('invalid');
		}
		if (bytes.byteLength > MAX_DIAGNOSTICS_BYTES) {
			return unavailable('tooLarge');
		}
		if (this.disposed) {
			return unavailable('cancelled');
		}
		let backend: IParadisSpreadsheetDiagnosticsBackend;
		try {
			backend = await (this.diagnosticsPromise ??= this.diagnosticsFactory());
		} catch {
			this.diagnosticsPromise = undefined;
			return unavailable('failed');
		}
		return backend.collect(bytes, token);
	}

	private getService(): Promise<IParadisSpreadsheetService> {
		const servicePromise = this.servicePromise ??= this.serviceFactory();
		return servicePromise.catch(error => {
			if (this.servicePromise === servicePromise) {
				this.servicePromise = undefined;
			}
			throw error;
		});
	}
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 */
export function registerParadisSpreadsheet(server: IPCServer<string>): IDisposable {
	const channel = new ParadisSpreadsheetChannel();
	server.registerChannel(PARADIS_SPREADSHEET_CHANNEL, channel);
	return toDisposable(() => channel.dispose());
}
