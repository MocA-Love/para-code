/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペースの履歴フォルダを持たないターミナルの、実行したコマンドの記録（Q372）のファイルを、main プロセスに
// 本人だけが読める形（フォルダ 700・ファイル 600）で用意させる。renderer の IFileService では権限を
// 指定できず 644 で作られるため。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisTerminalPrivateFiles, PARADIS_TERMINAL_PRIVATE_FILES_CHANNEL } from '../../terminalPrivateFiles/common/paradisTerminalPrivateFiles.js';
import { paradisRegisterCommonCommandRecordsFile } from '../browser/paradisTerminalCommandRecordService.js';

class ParadisTerminalCommandRecordsFileContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisTerminalCommandRecordsFile';

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService logService: ILogService,
	) {
		super();
		const files = ProxyChannel.toService<IParadisTerminalPrivateFiles>(mainProcessService.getChannel(PARADIS_TERMINAL_PRIVATE_FILES_CHANNEL));
		this._register(paradisRegisterCommonCommandRecordsFile(async () => {
			try {
				return URI.file(await files.ensureCommandRecordsFile());
			} catch (error) {
				logService.trace('[paradisTerminalCommandRecords] could not prepare the command records file', error);
				return undefined;
			}
		}));
	}
}

registerWorkbenchContribution2(ParadisTerminalCommandRecordsFileContribution.ID, ParadisTerminalCommandRecordsFileContribution, WorkbenchPhase.BlockRestore);
