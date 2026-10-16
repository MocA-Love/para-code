/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（REH）の「常駐の端末の引き継ぎ」チャネル。`paradis.server.contribution.ts` から副作用
// import で読み込まれる。
//
// 窓はこれで2つのことをする。記録を取りに来て Sentry へ送る（REH にも pty ホストにも Sentry の
// SDK は無い。`paradisPtyHandover.ts`）。古い版のサーバーを止めた直後に、そのサーバーが握って
// いた端末の引き取りを頼む。どちらも pty ホストへそのまま渡すだけで、pty ホストが起きていなければ
// 起こさない（`ptyHostService.ts` の `_optionalProxy`）。
//
// このチャネルを持たない古い REH では、窓が `Unknown channel` で気づいて何もしない。

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { IPtyService } from '../../../../platform/terminal/common/terminal.js';
import { ParadisServerContributions } from '../../../common/paradisProcessContributions.js';
import { IParadisPtyHandoverService, PARADIS_PTY_HANDOVER_CHANNEL, ParadisPtyAdoptTrigger } from '../common/paradisPtyHandover.js';

/** 窓から頼めるきっかけ。見回りや起動時は pty ホストが自分で決めるので、外からは受けない。 */
function paradisIsRequestableTrigger(value: unknown): value is ParadisPtyAdoptTrigger {
	return value === 'stale-stop';
}

ParadisServerContributions.register('ptyHandover', ({ server, accessor }) => {
	const ptyService = accessor.get(IPtyService);
	const service: IParadisPtyHandoverService = {
		takeReport: async () => ptyService.paradisTakeHandoverReport?.(),
		readopt: async trigger => paradisIsRequestableTrigger(trigger) ? ptyService.paradisReadoptFromDaemon?.(trigger) : undefined,
	};
	const store = new DisposableStore();
	server.registerChannel(PARADIS_PTY_HANDOVER_CHANNEL, ProxyChannel.fromService<RemoteAgentConnectionContext>(service, store));
	return store;
});
