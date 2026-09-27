/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// セッション履歴の行末「…」と右クリックで出すメニュー（コピー4種と開く3種）。
//
// ログのパスと最初の依頼の全文は一覧の電文に載せていないので、メニューを選んだときに shared process
// （SSH 先の会話なら接続先）へ聞きに行く。Finder で表示・作業フォルダを開くは手元の会話だけ。

import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Schemas } from '../../../../base/common/network.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisResumeSession } from '../common/paradisSessionResume.js';
import { paradisResumeCommandLine } from '../common/paradisSessionResumeListOptions.js';
import { ParadisSessionResumeClient } from './paradisSessionResumeClient.js';

/**
 * メニューの層。HTML のコンテキストメニューの z-index は `2575 + layer` で、セッション履歴のモーダル
 * （z-index 2700）と同じコンテナに入る。layer を渡さないとモーダルの下に描かれて見えないので、
 * モーダルより上（2775）へ出す。
 */
const PARADIS_SESSION_RESUME_MENU_LAYER = 200;

export class ParadisSessionResumeRowMenu {

	constructor(
		private readonly client: ParadisSessionResumeClient,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IEditorService private readonly editorService: IEditorService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileService private readonly fileService: IFileService,
	) { }

	/** メニューを開く。`anchor` はボタン要素か、右クリックした位置。 */
	show(anchor: HTMLElement | { x: number; y: number }, session: IParadisResumeSession, onHide?: () => void): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => this.actions(session),
			onHide,
			layer: PARADIS_SESSION_RESUME_MENU_LAYER,
		});
	}

	actions(session: IParadisResumeSession): IAction[] {
		const local = this.client.isLocal(session.catalogId);
		const run = (task: () => Promise<void>) => () => task().catch(error => this.notificationService.error(error));
		return [
			toAction({ id: 'paradis.sessionResume.copyResumeCommand', label: localize('paradis.sessionResume.copyResumeCommand', "再開コマンドをコピー"), run: run(() => this.clipboardService.writeText(paradisResumeCommandLine(session, local ? isWindows : false))) }),
			toAction({ id: 'paradis.sessionResume.copySessionId', label: localize('paradis.sessionResume.copySessionId', "セッションIDをコピー"), run: run(() => this.clipboardService.writeText(session.id)) }),
			toAction({ id: 'paradis.sessionResume.copyLogPath', label: localize('paradis.sessionResume.copyLogPath', "ログのパスをコピー"), run: run(async () => this.clipboardService.writeText((await this.client.details(session.catalogId)).transcriptPath)) }),
			toAction({
				id: 'paradis.sessionResume.copyFirstPrompt', label: localize('paradis.sessionResume.copyFirstPrompt', "最初の依頼をコピー"), enabled: session.empty !== true, run: run(async () => {
					const details = await this.client.details(session.catalogId);
					if (!details.firstPrompt) {
						this.notificationService.info(localize('paradis.sessionResume.noFirstPrompt', "この会話には依頼が見つかりませんでした。"));
						return;
					}
					await this.clipboardService.writeText(details.firstPrompt);
				})
			}),
			new Separator(),
			toAction({
				id: 'paradis.sessionResume.openLog', label: localize('paradis.sessionResume.openLog', "ログを開く"), run: run(async () => {
					const { transcriptPath } = await this.client.details(session.catalogId);
					await this.editorService.openEditor({ resource: this.resourceFor(transcriptPath, local), options: { pinned: true } });
				})
			}),
			toAction({
				id: 'paradis.sessionResume.revealLog', label: isWindows ? localize('paradis.sessionResume.revealLogWindows', "エクスプローラーで表示") : localize('paradis.sessionResume.revealLog', "Finder で表示"), enabled: local, run: run(async () => {
					const { transcriptPath } = await this.client.details(session.catalogId);
					await this.nativeHostService.showItemInFolder(transcriptPath);
				})
			}),
			toAction({
				id: 'paradis.sessionResume.openFolder', label: localize('paradis.sessionResume.openFolder', "作業フォルダを開く"), enabled: local, run: run(async () => {
					// 会話ログに書かれた作業フォルダは、そのまま外部で開くとアプリ（.app / .command など）を起動しかねない。
					// ディレクトリであることを確かめてから開く。
					const folder = URI.file(session.cwd);
					const stat = await this.fileService.stat(folder).catch(() => undefined);
					if (!stat?.isDirectory) {
						this.notificationService.info(localize('paradis.sessionResume.folderMissing', "作業フォルダが見つかりません: {0}", session.cwd));
						return;
					}
					await this.nativeHostService.openExternal(folder.toString(true));
				})
			}),
		];
	}

	private resourceFor(path: string, local: boolean): URI {
		const remoteAuthority = local ? undefined : this.remoteAgentService.getConnection()?.remoteAuthority;
		return remoteAuthority ? URI.from({ scheme: Schemas.vscodeRemote, authority: remoteAuthority, path }) : URI.file(path);
	}
}
