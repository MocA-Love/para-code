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
import { PARADIS_SPREADSHEET_CHANNEL } from '../common/paradisSpreadsheet.js';
import { ParadisSpreadsheetService } from './paradisSpreadsheetService.js';

export class ParadisSpreadsheetChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisSpreadsheetService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'parseWorkbook': return this.service.parseWorkbook(String(args[0])) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 */
export function registerParadisSpreadsheet(server: IPCServer<string>): IDisposable {
	server.registerChannel(PARADIS_SPREADSHEET_CHANNEL, new ParadisSpreadsheetChannel(new ParadisSpreadsheetService()));
	return Disposable.None;
}
