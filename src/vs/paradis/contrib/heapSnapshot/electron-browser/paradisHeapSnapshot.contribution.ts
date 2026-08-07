/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// main プロセスのヒープスナップショットを取るコマンド。診断専用。
//
// コマンドパレットに出す（`f1: true`）のは意図的。リークは**長時間稼働した実機でしか現れない**
// ので、開発ビルドを別に立ち上げる方式では再現に辿り着けない。普段使っているウィンドウから
// そのまま叩けることが、この機能の存在意義そのもの。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IParadisHeapSnapshotMainService, PARADIS_HEAP_SNAPSHOT_CHANNEL } from '../common/paradisHeapSnapshot.js';

function formatGigabytes(bytes: number): string {
	// main 側は大きさを読めなかったときに -1 を返す。そこを「0.00 GB」と出すと、
	// 空のファイルができたのか大きさが分からないのかを取り違える。
	return bytes < 0
		? localize('paradis.writeHeapSnapshot.unknownSize', "サイズ不明")
		: `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

class ParadisWriteHeapSnapshotAction extends Action2 {

	constructor() {
		super({
			id: 'paradis.writeHeapSnapshot',
			title: localize2('paradis.writeHeapSnapshot', "Write Main Process Heap Snapshot"),
			category: localize2('paradis.diagnostics.category', "Para Code"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const dialogService = accessor.get(IDialogService);
		const mainProcessService = accessor.get(IMainProcessService);
		const nativeHostService = accessor.get(INativeHostService);
		const notificationService = accessor.get(INotificationService);

		// 書き出しは同期でブロックする。何も知らせずに数十秒フリーズさせるのは、
		// ユーザーから見れば「アプリが固まった」としか区別がつかない。
		const { confirmed } = await dialogService.confirm({
			type: Severity.Warning,
			message: localize('paradis.writeHeapSnapshot.confirm', "ヒープスナップショットを書き出しますか?"),
			detail: localize('paradis.writeHeapSnapshot.detail', "書き出しの間、Para Code 全体が数秒から数十秒のあいだ反応しなくなります。ファイルは数 GB になることがあります。"),
			primaryButton: localize('paradis.writeHeapSnapshot.confirmButton', "書き出す")
		});
		if (!confirmed) {
			return;
		}

		const service = ProxyChannel.toService<IParadisHeapSnapshotMainService>(
			mainProcessService.getChannel(PARADIS_HEAP_SNAPSHOT_CHANNEL));

		try {
			const result = await service.writeSnapshot();
			notificationService.notify({
				severity: Severity.Info,
				message: localize('paradis.writeHeapSnapshot.done',
					"ヒープスナップショットを書き出しました ({0}、{1} 秒、稼働 {2} 分)。{3}",
					formatGigabytes(result.bytes),
					Math.round(result.durationMs / 1000),
					Math.round(result.uptimeMs / 60_000),
					result.path),
				actions: {
					primary: [{
						id: 'paradis.writeHeapSnapshot.reveal',
						label: localize('paradis.writeHeapSnapshot.reveal', "フォルダーに表示"),
						tooltip: '',
						class: undefined,
						enabled: true,
						run: () => nativeHostService.showItemInFolder(result.path)
					}]
				}
			});
		} catch (error) {
			notificationService.error(localize('paradis.writeHeapSnapshot.failed',
				"ヒープスナップショットを書き出せませんでした: {0}", String(error)));
		}
	}
}

registerAction2(ParadisWriteHeapSnapshotAction);
