/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（REH）に、番号の変わらない受け口を置く。`paradis.server.contribution.ts` から副作用 import で
// 読み込まれる。取り決めは common/paradisAgentGateway.ts、番号の持ち方は paradisAgentGatewayHost.ts。
//
// 窓はこのチャネルで受け口の番号を聞き、接続先のエージェントの設定の URL に書く。このチャネルを
// 持たない古い REH では、窓の呼び出しが `Unknown channel` で失敗し、窓は今までどおり戻りトンネルの
// 番号を URL に書く。

import { homedir } from 'os';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { ParadisServerContributions } from '../../../common/paradisProcessContributions.js';
import { IParadisAgentGatewayService, PARADIS_AGENT_GATEWAY_CHANNEL } from '../common/paradisAgentGateway.js';
import { ParadisAgentGatewayHost } from './paradisAgentGatewayHost.js';

ParadisServerContributions.register(PARADIS_AGENT_GATEWAY_CHANNEL, ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const store = new DisposableStore();
	const host = new ParadisAgentGatewayHost({
		paraCodeDirectory: join(homedir(), '.para-code'),
		log: {
			info: message => logService.info(message),
			warn: (message, error) => logService.warn(message, error),
		},
	});
	store.add(toDisposable(() => host.dispose()));
	const service: IParadisAgentGatewayService = {
		getEndpoint: () => host.getEndpoint(),
	};
	server.registerChannel(PARADIS_AGENT_GATEWAY_CHANNEL, ProxyChannel.fromService<RemoteAgentConnectionContext>(service, store));
	return store;
});
