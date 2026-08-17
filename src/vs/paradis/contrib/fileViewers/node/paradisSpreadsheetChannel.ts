/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// workbench(renderer) ⇔ shared process 間の Excel パース用IPCチャネル。paradisNotificationsChannel.ts と
// 同じ薄いディスパッチャ方式(switch文でサービスメソッドへ委譲するだけ)。

import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { PARADIS_SPREADSHEET_CHANNEL, type IParadisSpreadsheetService } from '../common/paradisSpreadsheet.js';

export class ParadisSpreadsheetChannel implements IServerChannel<string> {

	private servicePromise: Promise<IParadisSpreadsheetService> | undefined;

	constructor(private readonly serviceFactory: () => Promise<IParadisSpreadsheetService> = async () => {
		const { ParadisSpreadsheetService } = await import('./paradisSpreadsheetService.js');
		return new ParadisSpreadsheetService();
	}) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'parseWorkbook': return this.getService().then(service => service.parseWorkbook(String(args[0]))) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
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
	server.registerChannel(PARADIS_SPREADSHEET_CHANNEL, new ParadisSpreadsheetChannel());
	return Disposable.None;
}
