/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH などで接続したとき、接続先で同じユーザーの古い版の Para Code サーバーが動いていれば知らせ、
// 「止めて掃除する」で止める（使っていない版のフォルダも消す）。
//
// 探す・止める・消すのは接続先のサーバー（`node/paradisStaleServersService.ts`）。ここは要求と結果
// だけを扱う。止める対象（このユーザーの、今と違う版のサーバーとその子孫）は接続先がその場で
// 選び直すので、ここから pid を渡すことはない。
//
// 「前の版で残したターミナルは、このウィンドウからは開けません」のお知らせ（残したときに控えた
// `paradis.remote.keptTerminals.<authority>` の記録から出す）もここで出す。古い版のサーバーが
// まだ動いていれば、そちらのお知らせ（止められる）にまとめて重ねない。もう居なければ、今までどおり
// 「開けません」だけを伝える。

import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { paradisKeptTerminalsStorageKey, paradisParseKeptRemoteTerminals, paradisShouldReportStrandedTerminals } from '../../remoteTerminals/common/paradisRemoteTerminalShutdown.js';
import { PARADIS_TERMINAL_RECONNECTION_GRACE_TIME } from '../../remoteTerminals/common/paradisTerminalGraceTime.js';
import {
	IParadisStaleServersScan,
	IParadisStaleServersService,
	PARADIS_STALE_SERVERS_CHANNEL,
	paradisPlanStaleServerNotice,
	paradisStaleServerMessage,
	paradisStaleServerResultMessage,
} from '../common/paradisStaleServers.js';

/** 探すのを待つ上限。ps を1回読むだけなので、普通は1秒もかからない。 */
const SCAN_TIMEOUT_MS = 30_000;

class ParadisStaleRemoteServer extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.staleRemoteServer';

	constructor(
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IStorageService private readonly storageService: IStorageService,
		@IProductService private readonly productService: IProductService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILabelService private readonly labelService: ILabelService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const authority = this.environmentService.remoteAuthority;
		if (authority !== undefined) {
			void this.run(authority);
		}
	}

	private async run(authority: string): Promise<void> {
		// 残した記録は、読んだ時点で捨てる。この記録が意味を持つのは「残した次の接続」の1回だけで、
		// 残すと版が同じでも延々と残り続ける。拾い直しは接続してすぐ（この contribution が動く
		// AfterRestored の前）に済んでいる。
		const key = paradisKeptTerminalsStorageKey(authority);
		const record = paradisParseKeptRemoteTerminals(this.storageService.get(key, StorageScope.APPLICATION));
		this.storageService.remove(key, StorageScope.APPLICATION);
		const strandedShouldReport = paradisShouldReportStrandedTerminals({
			record,
			commit: this.productService.commit,
			now: Date.now(),
			// 接続先が実際に使っている猶予時間は分からない（`--reconnection-grace-time` で変えられるが、
			// その値はクライアントへ出てこない）。既定値を「いつまでの記録なら意味があるか」の上限にする。
			graceTime: PARADIS_TERMINAL_RECONNECTION_GRACE_TIME,
		});

		const scan = await this.scan();
		const plan = paradisPlanStaleServerNotice({ staleServerCount: scan?.servers.length ?? 0, strandedShouldReport });
		const hostLabel = this.labelService.getHostLabel(Schemas.vscodeRemote, authority) || authority;
		if (plan === 'stranded') {
			this.logService.info(`[paradisStaleRemoteServer] ${record?.count} terminal(s) were left on ${authority} by a different build (${record?.commit}); they cannot be reclaimed by this one (${this.productService.commit})`);
			// 「まだ動いている」と言い切らない。接続先の猶予はこちらから知る手立てが無い。
			this.notificationService.notify({
				severity: Severity.Info,
				// allow-any-unicode-next-line
				message: localize('paradis.remote.strandedTerminals', "前のバージョンで接続先に残したターミナルは、このウィンドウからは開けません。Para Code を更新すると、接続先でも新しいバージョンのサーバーにつながるためです。前のものがまだ動いていれば、接続先の猶予時間が過ぎたときに終了します。"),
			});
			return;
		}
		if (plan !== 'staleServers' || !scan) {
			return;
		}
		this.logService.info(`[paradisStaleRemoteServer] ${scan.servers.length} server(s) of older builds are running on ${authority}`);
		this.notificationService.prompt(Severity.Warning, paradisStaleServerMessage(hostLabel, scan), [
			// 「止めて掃除する」を既定（先頭）にしない。スリープ中の別の PC のものかもしれないため。
			{ label: localize('paradis.staleServers.notNow', "今はしない"), run: () => { } },
			{ label: localize('paradis.staleServers.stop', "止めて掃除する"), run: () => void this.stopAndClean(hostLabel, scan.servers.map(server => server.commit)) },
		]);
	}

	private service(): IParadisStaleServersService | undefined {
		const connection = this.remoteAgentService.getConnection();
		return connection ? ProxyChannel.toService<IParadisStaleServersService>(connection.getChannel(PARADIS_STALE_SERVERS_CHANNEL)) : undefined;
	}

	private async scan(): Promise<IParadisStaleServersScan | undefined> {
		try {
			const scan = await raceTimeout(this.service()?.scan() ?? Promise.resolve(undefined), SCAN_TIMEOUT_MS);
			return scan?.supported ? scan : undefined;
		} catch (error) {
			// 古い REH（このチャネルが無い）や、ps が使えない接続先。何も知らせない。
			this.logService.trace('[paradisStaleRemoteServer] could not look for servers of older builds', error);
			return undefined;
		}
	}

	/** 通知に出した版だけを渡す。接続先はその場で選び直し、その積だけを止める（pid・パスは渡さない）。 */
	private async stopAndClean(hostLabel: string, commits: readonly string[]): Promise<void> {
		const service = this.service();
		if (!service) {
			return;
		}
		try {
			const result = await service.stopAndClean(commits);
			this.notificationService.notify({ severity: Severity.Info, message: paradisStaleServerResultMessage(hostLabel, result) });
		} catch (error) {
			this.logService.warn('[paradisStaleRemoteServer] could not stop the servers of older builds', error);
			this.notificationService.notify({ severity: Severity.Warning, message: localize('paradis.staleServers.failed', "{0} の古い版のサーバーを止められませんでした。", hostLabel) });
		}
	}
}

registerWorkbenchContribution2(ParadisStaleRemoteServer.ID, ParadisStaleRemoteServer, WorkbenchPhase.AfterRestored);
