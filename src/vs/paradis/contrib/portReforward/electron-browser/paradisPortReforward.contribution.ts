/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポートパネルの「張り直す」。SSH の窓で、転送が一覧に残ったまま繋がらなくなったときに、利用者が
// 自分で戻せる逃げ道。upstream のファイルには触れず、ポートパネルの右クリック（`MenuId.TunnelContext`）と
// ビューの「…」（`MenuId.ViewTitle`）、コマンドパレットへ足す。
//
// 1 本ごとに、(1) この窓の転送を閉じ、(2) shared process で全部の窓の分をまとめて閉じ、(3) 同じ手元の
// ポート・名前・公開範囲で転送し直す。(2) が無いと、同じ SSH 先の別の窓が参照を持っている間は
// shared process が古い転送（もう居ない窓の宛先へ繋ぐもの）を返し続けて直らない。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { RemoteNameContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IRemoteExplorerService, TUNNEL_VIEW_ID, TunnelType } from '../../../../workbench/services/remote/common/remoteExplorerService.js';
import { mapHasAddressLocalhostOrAllInterfaces, Tunnel, TunnelCloseReason, TunnelProperties } from '../../../../workbench/services/remote/common/tunnelModel.js';
import { IParadisPortReforwardCloseRequest, PARADIS_PORT_REFORWARD_CHANNEL, PARADIS_PORT_REFORWARD_FORCE_CLOSE } from '../common/paradisPortReforward.js';

// upstream の tunnelView.ts は行の種類と複数選択のコンテキストキーを export していないので、名前で書く
const TUNNEL_TYPE_KEY = 'tunnelType';
const TUNNEL_VIEW_MULTI_SELECTION_KEY = 'tunnelViewMultiSelection';

/** 右クリックで渡ってくる行（upstream の `ITunnelItem`）のうち、ここで使う部分。 */
interface IParadisTunnelRow {
	readonly tunnelType: TunnelType;
	readonly remoteHost: string;
	readonly remotePort: number;
}

function isTunnelRow(value: unknown): value is IParadisTunnelRow {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const row = value as Partial<IParadisTunnelRow>;
	return typeof row.tunnelType === 'string' && typeof row.remoteHost === 'string' && typeof row.remotePort === 'number';
}

/** 張り直しに使うサービス。`ServicesAccessor` は `await` の後では使えないので、先に取り出しておく。 */
interface IParadisReforwardServices {
	readonly remoteExplorerService: IRemoteExplorerService;
	readonly sharedProcessService: ISharedProcessService;
	readonly authority: string | undefined;
	readonly logService: ILogService;
	readonly notificationService: INotificationService;
}

function getReforwardServices(accessor: ServicesAccessor): IParadisReforwardServices {
	return {
		remoteExplorerService: accessor.get(IRemoteExplorerService),
		sharedProcessService: accessor.get(ISharedProcessService),
		authority: accessor.get(IWorkbenchEnvironmentService).remoteAuthority,
		logService: accessor.get(ILogService),
		notificationService: accessor.get(INotificationService),
	};
}

/** 1 本を張り直す。張れたら undefined、張れなければ理由を返す。 */
async function reforwardTunnel({ remoteExplorerService, sharedProcessService, authority, logService }: IParadisReforwardServices, tunnel: Tunnel): Promise<string | undefined> {
	const remote = { host: tunnel.remoteHost, port: tunnel.remotePort };
	const properties: TunnelProperties = {
		remote,
		local: tunnel.localPort,
		name: tunnel.name,
		source: tunnel.source,
		privacy: tunnel.privacy,
	};

	await remoteExplorerService.close(remote, TunnelCloseReason.Other);
	if (authority) {
		const request: IParadisPortReforwardCloseRequest = { authority, remoteHost: remote.host, remotePort: remote.port };
		try {
			await sharedProcessService.getChannel(PARADIS_PORT_REFORWARD_CHANNEL).call<boolean>(PARADIS_PORT_REFORWARD_FORCE_CLOSE, request);
		} catch (err) {
			// 閉じられなくても、この窓の分は転送し直す（別の窓が参照を持っていなければそれで戻る）
			logService.warn(`[ParadisPortReforward] Could not close the shared tunnel to ${remote.host}:${remote.port} for every window:`, err);
		}
	}

	const result = await remoteExplorerService.forward(properties);
	if (!result) {
		return localize('paradisPortReforward.noTunnel', "転送を作れませんでした");
	}
	if (typeof result === 'string') {
		return result;
	}
	return undefined;
}

/** 張り直せなかったものをまとめて知らせる。 */
function notifyFailures(notificationService: INotificationService, failures: readonly string[]): void {
	if (failures.length === 0) {
		return;
	}
	notificationService.notify({
		severity: Severity.Warning,
		message: localize('paradisPortReforward.failed', "張り直せなかったポートがあります: {0}", failures.join(' / ')),
	});
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.ports.reforward',
			title: localize2('paradisPortReforward.one', "この転送を張り直す"),
			menu: [{
				id: MenuId.TunnelContext,
				group: '3_forward',
				order: 2,
				when: ContextKeyExpr.and(
					RemoteNameContext.notEqualsTo(''),
					ContextKeyExpr.equals(TUNNEL_TYPE_KEY, TunnelType.Forwarded),
					ContextKeyExpr.equals(TUNNEL_VIEW_MULTI_SELECTION_KEY, undefined),
				),
			}],
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		if (!isTunnelRow(arg)) {
			return;
		}
		const services = getReforwardServices(accessor);
		const tunnel = mapHasAddressLocalhostOrAllInterfaces(services.remoteExplorerService.tunnelModel.forwarded, arg.remoteHost, arg.remotePort);
		if (!tunnel) {
			return;
		}
		const failure = await reforwardTunnel(services, tunnel);
		notifyFailures(services.notificationService, failure ? [`${tunnel.remotePort}: ${failure}`] : []);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.ports.reforwardAll',
			title: localize2('paradisPortReforward.all', "転送をすべて張り直す"),
			f1: true,
			precondition: RemoteNameContext.notEqualsTo(''),
			menu: [{
				id: MenuId.ViewTitle,
				group: '1_paradisReforward',
				order: 0,
				when: ContextKeyExpr.equals('view', TUNNEL_VIEW_ID),
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const services = getReforwardServices(accessor);
		// 張り直しの途中で台帳が書き換わるので、先に写しておく
		const tunnels = Array.from(services.remoteExplorerService.tunnelModel.forwarded.values()).filter(tunnel => tunnel.closeable !== false);
		const failures: string[] = [];
		// 1 本ずつ順に。並べると、同じ SSH 先の shared process の転送をまとめて閉じる処理どうしが交差する
		for (const tunnel of tunnels) {
			try {
				const failure = await reforwardTunnel(services, tunnel);
				if (failure) {
					failures.push(`${tunnel.remotePort}: ${failure}`);
				}
			} catch (err) {
				failures.push(`${tunnel.remotePort}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		notifyFailures(services.notificationService, failures);
	}
});
