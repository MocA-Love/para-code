/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（REH）の「古い版のサーバー」チャネル。`paradis.server.contribution.ts` から副作用 import で
// 読み込まれる。このチャネルを持たない古い REH では、ウィンドウ側が `Unknown channel` で気づいて
// 何もしない。

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { ParadisServerContributions } from '../../../common/paradisProcessContributions.js';
import { IParadisServerLayout, PARADIS_STALE_SERVERS_CHANNEL, paradisServerBinRoot } from '../common/paradisStaleServers.js';
import { ParadisStaleServersService, paradisStaleServersSurface } from './paradisStaleServersService.js';

ParadisServerContributions.register('staleServers', ({ server, accessor }) => {
	const environmentService = accessor.get(INativeEnvironmentService);
	const productService = accessor.get(IProductService);
	const logService = accessor.get(ILogService);
	const binRoot = process.platform === 'win32' ? undefined : paradisServerBinRoot(environmentService.appRoot, productService.commit);
	const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
	const layout: IParadisServerLayout | undefined = binRoot !== undefined && productService.commit !== undefined && uid !== undefined
		? { binRoot, currentCommit: productService.commit, uid, selfPid: process.pid }
		: undefined;
	const store = new DisposableStore();
	server.registerChannel(PARADIS_STALE_SERVERS_CHANNEL, ProxyChannel.fromService<RemoteAgentConnectionContext>(paradisStaleServersSurface(new ParadisStaleServersService(layout, logService)), store));
	return store;
});
