/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話の全文索引の後始末。設定でオフにしたら索引を消し、コマンドからも消せるようにする。
//
// 索引は会話のコピーなので、「オフ」は「索引が残っていない」ことと同じ意味にする（オフにしたのに
// 秘密情報を含むファイルが残り続けることがないように）。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { PARADIS_SESSION_INDEX_DELETE_COMMAND_ID, PARADIS_SESSION_INDEX_SETTING_ENABLED } from '../common/paradisSessionIndex.js';
import { ParadisAgentActivityClient } from './paradisAgentActivityClient.js';

class ParadisSessionIndexCleanupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisSessionIndexCleanup';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
	) {
		super();
		const client = instantiationService.createInstance(ParadisAgentActivityClient);
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PARADIS_SESSION_INDEX_SETTING_ENABLED) && configurationService.getValue<boolean>(PARADIS_SESSION_INDEX_SETTING_ENABLED) === false) {
				client.indexDelete().catch(error => logService.warn('[ParadisSessionIndex] unable to delete the full-text index', error));
			}
		}));
	}
}

registerWorkbenchContribution2(ParadisSessionIndexCleanupContribution.ID, ParadisSessionIndexCleanupContribution, WorkbenchPhase.AfterRestored);

class ParadisDeleteSessionIndexAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_SESSION_INDEX_DELETE_COMMAND_ID,
			title: localize2('paradis.sessionIndex.delete', "会話の全文索引を削除"),
			category: localize2('paradis.sessionIndex.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const dialogService = accessor.get(IDialogService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);
		const client = accessor.get(IInstantiationService).createInstance(ParadisAgentActivityClient);
		const { confirmed } = await dialogService.confirm({
			message: localize('paradis.sessionIndex.deleteConfirm', "会話の全文索引を削除しますか？"),
			detail: localize('paradis.sessionIndex.deleteDetail', "この PC に保存した会話の索引を削除し、全文検索をオフにします。会話のログそのものは消えません。"),
			primaryButton: localize('paradis.sessionIndex.deleteButton', "削除"),
		});
		if (!confirmed) {
			return;
		}
		await configurationService.updateValue(PARADIS_SESSION_INDEX_SETTING_ENABLED, false, ConfigurationTarget.USER);
		await client.indexDelete();
		notificationService.info(localize('paradis.sessionIndex.deleted', "会話の全文索引を削除しました。"));
	}
}

registerAction2(ParadisDeleteSessionIndexAction);
