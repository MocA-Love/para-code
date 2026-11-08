/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポートパネルの「…」に並べる、転送の整理と CSV（q.html の Q590-2〜4。設計 4〜8 章）。upstream のファイルには触れず、
// ビューの「…」（`MenuId.ViewTitle`）とコマンドパレットへ足す。並びは「転送をすべて張り直す」（portReforward）に続けて平らに置く。
//  - 番号を揃えて張り直す...: 手元とリモートの番号が違う転送を、手元の番号を空きと確かめてから揃えて張り直す
//  - 動いていない転送を外す...: listen していない利用者の転送を一覧で選んで外す（既定のチェックはエフェメラル帯だけ。
//    para-browser MCP の clean_up_port_forwards と同じ決め方。paradisPortSelection.ts）
//  - CSV に書き出す... / CSV から取り込む...: 手元のファイル（SSH の窓でも手元）を読み書きする。取り込みは行ごとの判定を
//    見せてから実行し、手元の番号が使用中の行は張らずに報告する。失敗した行は CSV で保存できる

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { toAction } from '../../../../base/common/actions.js';
import { RemoteNameContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IRemoteExplorerService, TUNNEL_VIEW_ID } from '../../../../workbench/services/remote/common/remoteExplorerService.js';
import { Attributes, Tunnel, TunnelCloseReason, UserTunnelSource } from '../../../../workbench/services/remote/common/tunnelModel.js';
import { isLocalhost, TunnelProtocol } from '../../../../platform/tunnel/common/tunnel.js';
import { paradisWindowRemoteOfWorkspace } from '../../portReforward/common/paradisPortReforward.js';
import { IParadisReforwardServices, paradisReforwardTunnel } from '../../portReforward/electron-browser/paradisPortReforwardTunnel.js';
import {
	IParadisPortCsvPlanRow,
	PARADIS_PORT_CSV_COLUMNS,
	PARADIS_PORT_CSV_MAX_ROWS,
	PARADIS_PORT_CSV_REASON_COLUMN,
	ParadisPortCsvRowError,
	ParadisPortCsvVerdict,
	paradisPortCsvExportRows,
	paradisPortCsvLocalPortsToCheck,
	paradisPortCsvPlan,
	paradisPortCsvRead,
	paradisPortCsvSerialize,
} from '../common/paradisPortCsv.js';
import { paradisIsEphemeralPort, paradisIsLoopbackLocalAddress, paradisMismatchedForwards, paradisNotListeningUserForwards, paradisPortLocalHostAllowed } from '../common/paradisPortSelection.js';
import { PARADIS_PORT_TOOLS_EPHEMERAL_MIN_PORT } from '../common/paradisPortTools.js';
import { IParadisPortDialogRow, ParadisPortDialogTone, paradisShowPortTableDialog } from './paradisPortTableDialog.js';

/** 「転送をすべて張り直す」（portReforward）と同じ群に続けて並べる。 */
const MENU_GROUP = '1_paradisReforward';
/** 取り込む CSV の大きさの上限。 */
const CSV_MAX_BYTES = 1024 * 1024;
const CSV_FILTERS = [{ name: 'CSV', extensions: ['csv'] }];

/** `ServicesAccessor` は `await` の後では使えないので、先に取り出しておく。 */
interface IParadisPortPanelServices extends IParadisReforwardServices {
	readonly notificationService: INotificationService;
	readonly nativeHostService: INativeHostService;
	readonly layoutService: ILayoutService;
	readonly fileDialogService: IFileDialogService;
	readonly fileService: IFileService;
	readonly pathService: IPathService;
	readonly configurationService: IConfigurationService;
}

function getServices(accessor: ServicesAccessor): IParadisPortPanelServices {
	return {
		remoteExplorerService: accessor.get(IRemoteExplorerService),
		sharedProcessService: accessor.get(ISharedProcessService),
		authority: accessor.get(IWorkbenchEnvironmentService).remoteAuthority,
		logService: accessor.get(ILogService),
		notificationService: accessor.get(INotificationService),
		nativeHostService: accessor.get(INativeHostService),
		layoutService: accessor.get(ILayoutService),
		fileDialogService: accessor.get(IFileDialogService),
		fileService: accessor.get(IFileService),
		pathService: accessor.get(IPathService),
		configurationService: accessor.get(IConfigurationService),
	};
}

function forwardedOf(services: IParadisPortPanelServices): Tunnel[] {
	return Array.from(services.remoteExplorerService.tunnelModel.forwarded.values());
}

function findForward(services: IParadisPortPanelServices, remotePort: number): Tunnel | undefined {
	return forwardedOf(services).find(tunnel => tunnel.remotePort === remotePort && isLocalhost(tunnel.remoteHost));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 同じ SSH 先を開いているほかの窓の数（その窓が保存すると、外した転送が戻るため知らせる）。 */
async function otherWindowsOfSameRemote(services: IParadisPortPanelServices): Promise<number> {
	if (!services.authority) {
		return 0;
	}
	try {
		const windows = await services.nativeHostService.getWindows({ includeAuxiliaryWindows: false });
		return windows.filter(window => {
			if (window.id === services.nativeHostService.windowId) {
				return false;
			}
			const remote = paradisWindowRemoteOfWorkspace(window.workspace);
			return remote.kind === 'remote' && remote.authority === services.authority;
		}).length;
	} catch {
		return 0;
	}
}

/** 手元の受け口が 127.0.0.1 になる窓か（para-browser MCP の道具と同じ確かめ）。 */
function localHostAllowed(services: IParadisPortPanelServices): boolean {
	return paradisPortLocalHostAllowed(services.configurationService.getValue('remote.localPortHost'));
}

function localHostRefusal(): string {
	return localize('paradis.portPanel.localHostRefused', "この窓は手元のすべてのネットワークで受ける設定（remote.localPortHost が allInterfaces）のため、転送を張りません。Para Code がここで張るのは 127.0.0.1 で受ける転送だけです。");
}

/** 張った後、手元が 127.0.0.1 で受けていなければすぐ閉じて理由を返す（LAN から SSH 先のサーバーが見えないように）。 */
async function closeIfNotLoopback(services: IParadisPortPanelServices, remotePort: number): Promise<string | undefined> {
	const after = findForward(services, remotePort);
	if (after && !paradisIsLoopbackLocalAddress(after.localAddress)) {
		await services.remoteExplorerService.close({ host: after.remoteHost, port: after.remotePort }, TunnelCloseReason.User);
		return localHostRefusal();
	}
	return undefined;
}

/** 1 本を、手元の番号を `localPort` にして張り直す。張れた番号が違えば理由を返す（元の番号には戻さない）。 */
async function alignForward(services: IParadisPortPanelServices, tunnel: Tunnel, localPort: number): Promise<string | undefined> {
	if (!localHostAllowed(services)) {
		return localHostRefusal();
	}
	if (!await services.nativeHostService.isPortFree(localPort)) {
		return localize('paradis.portPanel.localInUse', "手元の {0} が使用中", localPort);
	}
	const failure = await paradisReforwardTunnel(services, tunnel, localPort);
	if (failure) {
		return failure;
	}
	const notLoopback = await closeIfNotLoopback(services, tunnel.remotePort);
	if (notLoopback) {
		return notLoopback;
	}
	const after = findForward(services, tunnel.remotePort);
	if (after?.localPort !== localPort) {
		return localize('paradis.portPanel.tookOther', "手元の {0} を取れず {1} で張りました", localPort, after?.localPort ?? '?');
	}
	return undefined;
}

function notifyResult(services: IParadisPortPanelServices, done: string, failures: readonly string[]): void {
	services.notificationService.notify({
		severity: failures.length > 0 ? Severity.Warning : Severity.Info,
		message: failures.length > 0 ? localize('paradis.portPanel.resultWithFailures', "{0} できなかったもの: {1}", done, failures.join(' / ')) : done,
	});
}

// --- 番号を揃えて張り直す ---

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.ports.alignLocalPorts',
			title: localize2('paradis.portPanel.align', "番号を揃えて張り直す..."),
			f1: true,
			precondition: RemoteNameContext.notEqualsTo(''),
			menu: [{ id: MenuId.ViewTitle, group: MENU_GROUP, order: 1, when: ContextKeyExpr.equals('view', TUNNEL_VIEW_ID) }],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const services = getServices(accessor);
		if (!localHostAllowed(services)) {
			services.notificationService.warn(localHostRefusal());
			return;
		}
		const targets = paradisMismatchedForwards(forwardedOf(services)).sort((a, b) => a.remotePort - b.remotePort);
		if (targets.length === 0) {
			services.notificationService.info(localize('paradis.portPanel.align.none', "手元とリモートの番号が違う転送はありません。"));
			return;
		}
		const free = await Promise.all(targets.map(tunnel => services.nativeHostService.isPortFree(tunnel.remotePort)));
		const rows: IParadisPortDialogRow[] = targets.map((tunnel, index) => ({
			cells: [String(tunnel.remotePort), tunnel.localAddress, free[index] ? localize('paradis.portPanel.align.ok', "{0} に揃える", tunnel.remotePort) : localize('paradis.portPanel.localInUse', "手元の {0} が使用中", tunnel.remotePort)],
			tone: free[index] ? undefined : 'error',
			checked: free[index],
			disabled: !free[index],
		}));
		const answer = await paradisShowPortTableDialog(services.layoutService, {
			title: localize('paradis.portPanel.align.title', "番号を揃えて張り直す"),
			description: localize('paradis.portPanel.align.description', "手元とリモートの番号が違う転送 {0} 件。張り直すと、元の手元の番号を開いているブラウザのタブは繋がらなくなります。同じ SSH 先のほかの窓の同じポートの転送も一度まとめて閉じてから張り直します。", targets.length),
			columns: [localize('paradis.portPanel.column.remote', "リモート"), localize('paradis.portPanel.column.local', "手元"), localize('paradis.portPanel.column.state', "状態")],
			rows,
			checkable: true,
			primaryLabel: count => localize('paradis.portPanel.align.run', "{0} 件を張り直す", count),
		});
		if (!answer) {
			return;
		}
		let aligned = 0;
		const failures: string[] = [];
		// 1 本ずつ順に（同じ SSH 先の shared process の転送をまとめて閉じる処理どうしを交差させない）
		for (const index of answer.selected) {
			const current = findForward(services, targets[index].remotePort);
			if (!current || current.localPort === current.remotePort) {
				continue;
			}
			try {
				const failure = await alignForward(services, current, current.remotePort);
				if (failure) {
					failures.push(`${current.remotePort}: ${failure}`);
				} else {
					aligned++;
				}
			} catch (error) {
				failures.push(`${current.remotePort}: ${errorText(error)}`);
			}
		}
		notifyResult(services, localize('paradis.portPanel.align.done', "{0} 件の転送の番号を揃えました。", aligned), failures);
	}
});

// --- 動いていない転送を外す ---

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.ports.cleanUpNotListening',
			title: localize2('paradis.portPanel.cleanUp', "動いていない転送を外す..."),
			f1: true,
			precondition: RemoteNameContext.notEqualsTo(''),
			menu: [{ id: MenuId.ViewTitle, group: MENU_GROUP, order: 2, when: ContextKeyExpr.equals('view', TUNNEL_VIEW_ID) }],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const services = getServices(accessor);
		if (services.remoteExplorerService.tunnelModel.candidatesOrUndefined === undefined) {
			// 検出の結果が無い窓では、全部が動いていないように見える
			services.notificationService.info(localize('paradis.portPanel.cleanUp.noDetection', "この窓はまだ SSH 先で listen しているポートを検出していないため、動いていない転送を判定できません（設定 remote.autoForwardPortsSource が output のときなど）。"));
			return;
		}
		const targets = paradisNotListeningUserForwards(forwardedOf(services)).sort((a, b) => a.remotePort - b.remotePort);
		if (targets.length === 0) {
			services.notificationService.info(localize('paradis.portPanel.cleanUp.none', "SSH 先で listen していない転送はありません。"));
			return;
		}
		const others = await otherWindowsOfSameRemote(services);
		const answer = await paradisShowPortTableDialog(services.layoutService, {
			title: localize('paradis.portPanel.cleanUp.title', "動いていない転送を外す"),
			description: localize('paradis.portPanel.cleanUp.description', "SSH 先で listen していない転送 {0} 件。{1} より下の決まった番号はチェックを外しています。", targets.length, PARADIS_PORT_TOOLS_EPHEMERAL_MIN_PORT),
			columns: [localize('paradis.portPanel.column.remote', "リモート"), localize('paradis.portPanel.column.local', "手元"), localize('paradis.portPanel.column.source', "配信元")],
			rows: targets.map(tunnel => ({ cells: [String(tunnel.remotePort), tunnel.localAddress, tunnel.source.description], checked: paradisIsEphemeralPort(tunnel.remotePort) })),
			checkable: true,
			...(others > 0 ? { note: localize('paradis.portPanel.cleanUp.otherWindows', "この SSH 先の別の窓が {0} 個開いています。そちらでも外さないと、そちらの窓の保存で戻ります。", others) } : {}),
			primaryLabel: count => localize('paradis.portPanel.cleanUp.run', "{0} 件を外す", count),
		});
		if (!answer) {
			return;
		}
		let stopped = 0;
		for (const index of answer.selected) {
			// 答えを待つ間に listen し始めたもの・外れたものは触らない
			const current = findForward(services, targets[index].remotePort);
			if (!current || current.hasRunningProcess === true) {
				continue;
			}
			await services.remoteExplorerService.close({ host: current.remoteHost, port: current.remotePort }, TunnelCloseReason.User);
			stopped++;
		}
		services.notificationService.info(localize('paradis.portPanel.cleanUp.done', "{0} 件の転送を外しました。", stopped));
	}
});

// --- CSV に書き出す ---

/** 手元のホームフォルダ（SSH の窓でも手元のファイルを開くため、`file` の場所にする）。 */
async function localHome(services: IParadisPortPanelServices): Promise<URI> {
	return services.pathService.userHome({ preferLocal: true });
}

async function saveCsv(services: IParadisPortPanelServices, fileName: string, text: string): Promise<URI | undefined> {
	const target = await services.fileDialogService.showSaveDialog({
		title: localize('paradis.portPanel.csv.saveTitle', "CSV の保存先"),
		defaultUri: joinPath(await localHome(services), fileName),
		filters: CSV_FILTERS,
		availableFileSystems: [Schemas.file],
	});
	if (!target) {
		return undefined;
	}
	await services.fileService.writeFile(target, VSBuffer.fromString(text));
	return target;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.ports.exportCsv',
			title: localize2('paradis.portPanel.export', "CSV に書き出す..."),
			f1: true,
			precondition: RemoteNameContext.notEqualsTo(''),
			menu: [{ id: MenuId.ViewTitle, group: MENU_GROUP, order: 3, when: ContextKeyExpr.equals('view', TUNNEL_VIEW_ID) }],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const services = getServices(accessor);
		const model = services.remoteExplorerService.tunnelModel;
		const text = paradisPortCsvSerialize(PARADIS_PORT_CSV_COLUMNS, paradisPortCsvExportRows(forwardedOf(services), model.candidatesOrUndefined !== undefined));
		try {
			const target = await saveCsv(services, 'ports.csv', text);
			if (target) {
				services.notificationService.info(localize('paradis.portPanel.export.done', "転送 {0} 件を {1} に書き出しました。", model.forwarded.size, basename(target)));
			}
		} catch (error) {
			services.notificationService.error(localize('paradis.portPanel.export.failed', "CSV を書き出せませんでした: {0}", errorText(error)));
		}
	}
});

// --- CSV から取り込む ---

function rowErrorText(error: ParadisPortCsvRowError): string {
	switch (error) {
		case 'remotePortInvalid': return localize('paradis.portPanel.csv.remotePortInvalid', "remote_port が 1〜65535 の数でない");
		case 'localPortInvalid': return localize('paradis.portPanel.csv.localPortInvalid', "local_port が 1〜65535 の数でない");
		case 'remoteHostNotLocal': return localize('paradis.portPanel.csv.remoteHostNotLocal', "remote_host が localhost でない");
		case 'protocolInvalid': return localize('paradis.portPanel.csv.protocolInvalid', "protocol が http・https でない");
		case 'labelTooLong': return localize('paradis.portPanel.csv.labelTooLong', "label が長すぎる");
	}
}

function verdictText(verdict: ParadisPortCsvVerdict, localPort: string): string {
	switch (verdict.kind) {
		case 'done': return localize('paradis.portPanel.csv.done', "済み");
		case 'mismatch': return verdict.localInUse
			? localize('paradis.portPanel.csv.mismatchInUse', "番号が違う（今 {0}）・手元の {1} が使用中", verdict.currentLocalPort ?? '?', localPort)
			: localize('paradis.portPanel.csv.mismatch', "番号が違う（今 {0}）", verdict.currentLocalPort ?? '?');
		case 'add': return localize('paradis.portPanel.csv.add', "追加");
		case 'localInUse': return localize('paradis.portPanel.csv.localInUse', "手元で使用中");
		case 'error': return rowErrorText(verdict.error);
		case 'duplicate': return localize('paradis.portPanel.csv.duplicate', "重複（{0} 行目を使う）", verdict.firstLine);
	}
}

function verdictTone(verdict: ParadisPortCsvVerdict): ParadisPortDialogTone | undefined {
	switch (verdict.kind) {
		case 'mismatch': return verdict.localInUse ? 'error' : 'warn';
		case 'add': return 'new';
		case 'localInUse':
		case 'error': return 'error';
		case 'duplicate': return 'dim';
		default: return undefined;
	}
}

function localText(item: IParadisPortCsvPlanRow): string {
	return item.row.kind === 'entry' ? String(item.row.localPort) : item.row.localText;
}

/** 追加の 1 行を張る。手元の番号が取れなければ閉じて理由を返す（黙って別の番号にしない）。 */
async function forwardRow(services: IParadisPortPanelServices, remotePort: number, localPort: number, label: string | undefined, protocol: 'http' | 'https' | undefined): Promise<string | undefined> {
	if (!localHostAllowed(services)) {
		return localHostRefusal();
	}
	if (findForward(services, remotePort)) {
		return localize('paradis.portPanel.csv.alreadyForwarded', "取り込みの間に転送された");
	}
	const remote = { host: 'localhost', port: remotePort };
	const attributes: Attributes | undefined = protocol !== undefined
		? { label, onAutoForward: undefined, elevateIfNeeded: undefined, requireLocalPort: undefined, protocol: protocol === 'https' ? TunnelProtocol.Https : TunnelProtocol.Http }
		: undefined;
	const result = await services.remoteExplorerService.forward({ remote, local: localPort, name: label, source: UserTunnelSource }, attributes);
	if (!result || typeof result === 'string') {
		return result || localize('paradis.portPanel.csv.noTunnel', "転送を作れなかった");
	}
	if (!paradisIsLoopbackLocalAddress(result.localAddress)) {
		await services.remoteExplorerService.close(remote, TunnelCloseReason.User);
		return localHostRefusal();
	}
	if (result.tunnelLocalPort !== localPort) {
		await services.remoteExplorerService.close(remote, TunnelCloseReason.User);
		return localize('paradis.portPanel.localInUse', "手元の {0} が使用中", localPort);
	}
	return undefined;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.ports.importCsv',
			title: localize2('paradis.portPanel.import', "CSV から取り込む..."),
			f1: true,
			precondition: RemoteNameContext.notEqualsTo(''),
			menu: [{ id: MenuId.ViewTitle, group: MENU_GROUP, order: 4, when: ContextKeyExpr.equals('view', TUNNEL_VIEW_ID) }],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const services = getServices(accessor);
		if (!localHostAllowed(services)) {
			// 外から受け取った CSV で、多数の転送を 0.0.0.0 で開けてしまわないように
			services.notificationService.warn(localHostRefusal());
			return;
		}
		const picked = await services.fileDialogService.showOpenDialog({
			title: localize('paradis.portPanel.import.openTitle', "取り込む CSV"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: CSV_FILTERS,
			defaultUri: await localHome(services),
			availableFileSystems: [Schemas.file],
		});
		const file = picked?.[0];
		if (!file) {
			return;
		}
		let text: string;
		try {
			const stat = await services.fileService.stat(file);
			if (stat.size > CSV_MAX_BYTES) {
				services.notificationService.warn(localize('paradis.portPanel.import.tooLarge', "{0} は大きすぎるため取り込みません（1 MB まで）。", basename(file)));
				return;
			}
			text = (await services.fileService.readFile(file)).value.toString();
		} catch (error) {
			services.notificationService.error(localize('paradis.portPanel.import.readFailed', "CSV を読めませんでした: {0}", errorText(error)));
			return;
		}
		const read = paradisPortCsvRead(text);
		if (!read.ok) {
			services.notificationService.warn(read.error === 'empty'
				? localize('paradis.portPanel.import.empty', "{0} に行がありません。", basename(file))
				: localize('paradis.portPanel.import.noColumn', "{0} の 1 行目に remote_port の列がありません。書き出した CSV と同じ見出しにしてください。", basename(file)));
			return;
		}
		const forwarded = forwardedOf(services);
		const toCheck = paradisPortCsvLocalPortsToCheck(read.rows, forwarded);
		const free = await Promise.all(toCheck.map(port => services.nativeHostService.isPortFree(port)));
		const inUse = new Set(toCheck.filter((_port, index) => !free[index]));
		const plan = paradisPortCsvPlan(read.rows, forwarded, inUse);
		const adds = plan.filter(item => item.verdict.kind === 'add');
		const realigns = plan.filter(item => item.verdict.kind === 'mismatch' && !item.verdict.localInUse);
		const answer = await paradisShowPortTableDialog(services.layoutService, {
			title: localize('paradis.portPanel.import.title', "CSV から取り込む: {0}（{1} 行）", basename(file), read.rows.length),
			...(read.truncated ? { description: localize('paradis.portPanel.import.truncated', "先頭の {0} 行だけを取り込みます。", PARADIS_PORT_CSV_MAX_ROWS) } : {}),
			columns: [localize('paradis.portPanel.column.line', "行"), localize('paradis.portPanel.column.remote', "リモート"), localize('paradis.portPanel.column.local', "手元"), localize('paradis.portPanel.column.verdict', "判定")],
			rows: plan.map(item => ({
				cells: [String(item.row.line), item.row.kind === 'entry' ? String(item.row.remotePort) : item.row.remoteText, localText(item), verdictText(item.verdict, localText(item))],
				tone: verdictTone(item.verdict),
			})),
			checkable: false,
			...(realigns.length > 0 ? { option: { label: localize('paradis.portPanel.import.realign', "番号が違うものを揃えて張り直す（{0} 件）", realigns.length), checked: true } } : {}),
			primaryLabel: (_count, option) => localize('paradis.portPanel.import.run', "追加 {0} 件・張り直し {1} 件を実行", adds.length, option ? realigns.length : 0),
			primaryEnabled: (_count, option) => adds.length > 0 || (option && realigns.length > 0),
		});
		if (!answer) {
			return;
		}
		const failed: { readonly cells: readonly string[]; readonly reason: string }[] = [];
		for (const item of plan) {
			if (item.verdict.kind === 'error' || item.verdict.kind === 'localInUse' || (item.verdict.kind === 'mismatch' && item.verdict.localInUse && answer.option)) {
				failed.push({ cells: item.row.cells, reason: verdictText(item.verdict, localText(item)) });
			}
		}
		let added = 0;
		let realigned = 0;
		for (const item of [...adds, ...(answer.option ? realigns : [])]) {
			const row = item.row;
			if (row.kind !== 'entry') {
				continue;
			}
			try {
				let failure: string | undefined;
				if (item.verdict.kind === 'add') {
					failure = await forwardRow(services, row.remotePort, row.localPort, row.label, row.protocol);
				} else {
					const current = findForward(services, row.remotePort);
					failure = current ? await alignForward(services, current, row.localPort) : localize('paradis.portPanel.csv.gone', "取り込みの間に転送が外れた");
				}
				if (failure) {
					failed.push({ cells: row.cells, reason: failure });
				} else if (item.verdict.kind === 'add') {
					added++;
				} else {
					realigned++;
				}
			} catch (error) {
				failed.push({ cells: row.cells, reason: errorText(error) });
			}
		}
		const done = plan.filter(item => item.verdict.kind === 'done').length;
		services.notificationService.notify({
			severity: failed.length > 0 ? Severity.Warning : Severity.Info,
			message: localize('paradis.portPanel.import.result', "CSV から取り込みました: 追加 {0} 件、張り直し {1} 件、済み {2} 件、失敗 {3} 件", added, realigned, done, failed.length),
			...(failed.length > 0 ? {
				actions: {
					primary: [toAction({
						id: 'paradis.ports.importCsv.saveFailed',
						label: localize('paradis.portPanel.import.saveFailed', "失敗した行を CSV で保存"),
						run: async () => {
							const header = [...read.header, PARADIS_PORT_CSV_REASON_COLUMN];
							const rows = failed.map(item => [...read.header.map((_name, index) => item.cells[index] ?? ''), item.reason]);
							try {
								await saveCsv(services, 'ports-failed.csv', paradisPortCsvSerialize(header, rows));
							} catch (error) {
								services.notificationService.error(localize('paradis.portPanel.export.failed', "CSV を書き出せませんでした: {0}", errorText(error)));
							}
						},
					})],
				},
			} : {}),
		});
	}
});
