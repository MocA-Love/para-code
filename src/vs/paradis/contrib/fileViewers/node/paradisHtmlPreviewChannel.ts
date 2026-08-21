/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// workbench(renderer) ⇔ shared process 間の、HTML プレビュー配信サーバ用IPCチャネル。
// paradisSpreadsheetChannel.ts と同じ薄いディスパッチャ方式。サーバは最初の mount まで立てない。

import { Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { PARADIS_HTML_PREVIEW_CHANNEL, type IParadisHtmlPreviewService } from '../common/paradisHtmlPreview.js';
import { ParadisHtmlPreviewServer } from './paradisHtmlPreviewServer.js';

export class ParadisHtmlPreviewChannel<TContext = string> implements IServerChannel<TContext> {

	private service: (IParadisHtmlPreviewService & IDisposable) | undefined;

	// サーバを作るだけでは待ち受けは始まらない（最初の mount まで listen しない）ので、
	// 起動時にここへ来ても費用はかからない。
	constructor(private readonly serviceFactory: () => IParadisHtmlPreviewService & IDisposable = () => new ParadisHtmlPreviewServer()) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	// async にしておくと、サーバの生成でこけた場合も同期例外ではなく拒否された Promise になる。
	async call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'mount': return await this.getService().mount(String(args[0])) as T;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}

	dispose(): void {
		this.service?.dispose();
		this.service = undefined;
	}

	private getService(): IParadisHtmlPreviewService {
		return this.service ??= this.serviceFactory();
	}
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 */
export function registerParadisHtmlPreview<TContext>(server: IPCServer<TContext>): IDisposable {
	const channel = new ParadisHtmlPreviewChannel<TContext>();
	server.registerChannel(PARADIS_HTML_PREVIEW_CHANNEL, channel);
	return toDisposable(() => channel.dispose());
}

/**
 * SSH 先で動くサーバ（REH）用。serverServices.ts の PARA-PATCH 点から1行で呼べる。
 *
 * 中身は手元と同じで、**そのマシンのファイルをそのマシンの 127.0.0.1 に配る**だけ。手元の
 * webview から見えるようにするのは呼び出し側（renderer）のポート転送の役目。
 */
export function registerParadisHtmlPreviewForServer<TContext>(server: IPCServer<TContext>): IDisposable {
	return registerParadisHtmlPreview(server);
}
