/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続していないホストへ SSH（SFTP）で直接送る・取ってくるチャネルを shared process に足す。
// `paradis.sharedProcess.contribution.ts` から副作用 import で読み込まれる。接続はホストごとに 1 本で、
// 全ウィンドウが共有する。

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { PARADIS_SFTP_CHANNEL } from '../common/paradisSftp.js';
import { ParadisSftpChannel, ParadisSftpService } from './paradisSftpService.js';

ParadisSharedProcessContributions.register('sftp', ({ server, accessor }) => {
	const service = new ParadisSftpService({ logService: accessor.get(ILogService) });
	server.registerChannel(PARADIS_SFTP_CHANNEL, new ParadisSftpChannel(service));
	// 閉じたウィンドウが開いたままにしたファイルを閉じる（開いたままの数が減らず、接続が閉じなくなる）。
	// 接続ごとに通し番号を付け、同じ名前で繋ぎ直したウィンドウのファイルは閉じない
	const connections = new Map<object, number>();
	for (const connection of server.connections) {
		connections.set(connection, service.connectionAdded(connection.ctx));
	}
	const store = new DisposableStore();
	store.add(server.onDidAddConnection(connection => connections.set(connection, service.connectionAdded(connection.ctx))));
	store.add(server.onDidRemoveConnection(connection => {
		const number = connections.get(connection);
		connections.delete(connection);
		if (number !== undefined) {
			void service.closeHandlesOf(connection.ctx, number);
		}
	}));
	return store;
});
