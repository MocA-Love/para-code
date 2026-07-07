/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// MCPの `preview_file` ツールの受け口。shared process の ParadisAgentBrowserService が
// 「呼び出し元ペインを所有するウィンドウ」だけへctxフィルタでルーティングして呼ぶため、
// ここでは受け取ったパスをこのウィンドウのエディタで開くだけでよい（ウィンドウ取り違えの
// 防止はshared process側のルーティングで保証済み）。
// 拡張子ごとの分岐は行わない: Markdown/HTML/PDF/Excel等のリッチビューアは fileViewers が
// EditorResolver（exclusive優先度）で登録済みなので、openEditor だけで自動的に選ばれる。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IParadisPreviewFileResult, PARADIS_AGENT_PREVIEW_CHANNEL } from '../common/paradisAgentBrowser.js';

class ParadisAgentPreviewChannel implements IServerChannel {

	constructor(
		private readonly editorService: IEditorService,
		private readonly fileService: IFileService,
	) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		if (command === 'previewFile') {
			const args = Array.isArray(arg) ? arg : [];
			return this._previewFile(String(args[0])) as Promise<T>;
		}
		throw new Error(`Method not found: ${command}`);
	}

	private async _previewFile(path: string): Promise<IParadisPreviewFileResult> {
		const resource = URI.file(path);
		try {
			const stat = await this.fileService.stat(resource);
			if (stat.isDirectory) {
				return { ok: false, error: `The path is a directory, not a file: ${path}` };
			}
		} catch {
			return { ok: false, error: `The file does not exist or is not readable: ${path}` };
		}
		try {
			// preserveFocus: ユーザーは大抵ターミナルでエージェントとやり取り中なので、
			// 入力フォーカスは奪わずエディタを開いて見せるだけにする。
			const editor = await this.editorService.openEditor({ resource, options: { preserveFocus: true } });
			if (!editor) {
				return { ok: false, error: `Para Code did not open an editor for: ${path}` };
			}
			return { ok: true };
		} catch (error) {
			return { ok: false, error: `Failed to open the file: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
}

/**
 * shared process の IPCServer へ、このウィンドウ宛の {@link PARADIS_AGENT_PREVIEW_CHANNEL}
 * を登録する。登録はウィンドウの生存期間ずっと有効（接続断で自動的に消える）。
 */
class ParadisAgentPreviewContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisAgentPreview';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IEditorService editorService: IEditorService,
		@IFileService fileService: IFileService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_AGENT_PREVIEW_CHANNEL, new ParadisAgentPreviewChannel(editorService, fileService));
	}
}

registerWorkbenchContribution2(ParadisAgentPreviewContribution.ID, ParadisAgentPreviewContribution, WorkbenchPhase.AfterRestored);
