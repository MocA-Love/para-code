/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisMainLoadService, PARADIS_MAIN_LOAD_CHANNEL, paradisRegisterMainLoadProbe } from '../common/paradisMainLoad.js';

/**
 * main の混雑の計測チャネルを、スペースの切り替えから使えるように登録する。
 * 切り替えの側はこの登録が無ければ (Web のビルド) 計測を飛ばす。
 */
class ParadisMainLoadProbeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisMainLoadProbe';

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super();
		this._register(paradisRegisterMainLoadProbe(ProxyChannel.toService<IParadisMainLoadService>(mainProcessService.getChannel(PARADIS_MAIN_LOAD_CHANNEL))));
	}
}

// 復元より前に登録する。起動直後の切り替え (前回のスペースへの補正) も測れるように。
registerWorkbenchContribution2(ParadisMainLoadProbeContribution.ID, ParadisMainLoadProbeContribution, WorkbenchPhase.BlockRestore);
