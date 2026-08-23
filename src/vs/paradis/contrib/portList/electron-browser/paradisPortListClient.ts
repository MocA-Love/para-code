/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process / REH のポート一覧チャネルを呼ぶ薄いクライアント。
// SSH で繋いでいる間、開発サーバー等のポートは接続先で動いているので、接続先へ聞く
// (同じチャネルを REH 側にも生やしてある。paradisLimitsMonitorClient.ts と同じ方式)。

import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import {
	IParadisPortKillRequest,
	IParadisPortListSnapshot,
	PARADIS_PORT_LIST_CHANNEL
} from '../common/paradisPortList.js';

export class ParadisPortListClient {

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
	) { }

	private get channel(): IChannel {
		const remoteConnection = this.remoteAgentService.getConnection();
		return remoteConnection
			? remoteConnection.getChannel(PARADIS_PORT_LIST_CHANNEL)
			: this.sharedProcessService.getChannel(PARADIS_PORT_LIST_CHANNEL);
	}

	/** 接続先(REH)経由で問い合わせているか。パネルのトリガー/確認文言の出し分けに使う。 */
	get connectedToRemote(): boolean {
		return this.remoteAgentService.getConnection() !== undefined;
	}

	getSnapshot(force = false): Promise<IParadisPortListSnapshot> {
		return this.channel.call<IParadisPortListSnapshot>('getSnapshot', [{ force }]);
	}

	/**
	 * @param expectedViaRemote 呼び出し元がユーザーに提示した経路(一覧表示時点での接続状態)。
	 * 実行時の接続状態と不一致なら続行しない(fail-closed、paradisLimitsMonitorClient.ts の
	 * removeCodexHome と同じ理由)。一覧はリモート・killはローカル、という混線を防ぐ。
	 */
	async kill(request: IParadisPortKillRequest, expectedViaRemote: boolean): Promise<void> {
		const remoteConnection = this.remoteAgentService.getConnection();
		if ((remoteConnection !== undefined) !== expectedViaRemote) {
			throw new Error('Port kill aborted: the remote connection state changed');
		}
		const channel = remoteConnection
			? remoteConnection.getChannel(PARADIS_PORT_LIST_CHANNEL)
			: this.sharedProcessService.getChannel(PARADIS_PORT_LIST_CHANNEL);
		await channel.call<void>('kill', [request]);
	}
}
