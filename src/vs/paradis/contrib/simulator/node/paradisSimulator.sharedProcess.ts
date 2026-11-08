/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process にシミュレータのチャネルを登録する（`paradis.sharedProcess.contribution.ts` の登録口から読む）。
// ③ で台帳と MCP のツールを持たせるときは、agentBrowser の `registerToolProvider` を値で受け取る必要があるので、
// `registerParadisMobileCanvas(...)` の直呼びをここの登録へまとめ直す（設計書 1 節）。

import { isMacintosh } from '../../../../base/common/platform.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_SIMULATOR_CHANNEL, PARADIS_SIMULATOR_ENABLED_SETTING } from '../common/paradisSimulator.js';
import { ParadisServeSimBackend } from './paradisServeSimBackend.js';
import { ParadisSimulatorChannel, ParadisSimulatorService } from './paradisSimulatorChannel.js';
import { ParadisSimulatorHostProcess } from './paradisSimulatorHostProcess.js';

ParadisSharedProcessContributions.register(PARADIS_SIMULATOR_CHANNEL, ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const configurationService = accessor.get(IConfigurationService);
	const userDataPath = accessor.get(INativeEnvironmentService).userDataPath;
	// ホストはここでは起こさない（最初の要求で起こす）。macOS 以外でも作るだけなら何も起きない
	const host = new ParadisSimulatorHostProcess({ userDataPath, logService });
	const backend = new ParadisServeSimBackend(host, logService);
	const service = new ParadisSimulatorService(host, backend, () => configurationService.getValue<boolean>(PARADIS_SIMULATOR_ENABLED_SETTING) === true, isMacintosh, logService);
	const store = [host, backend, service];
	// 設定をオフにしたら、動いているホストを止める
	const listener = configurationService.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(PARADIS_SIMULATOR_ENABLED_SETTING) && configurationService.getValue<boolean>(PARADIS_SIMULATOR_ENABLED_SETTING) !== true) {
			void service.stopHost();
		}
	});
	server.registerChannel(PARADIS_SIMULATOR_CHANNEL, new ParadisSimulatorChannel<string>(service));
	return { dispose: () => { listener.dispose(); for (const disposable of store.reverse()) { disposable.dispose(); } } };
});
