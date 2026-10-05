/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通信の計測（設計書 5 章の F0）のコマンドと、このウィンドウの renderer が数えた分を shared process へ送る役。
//
// - 「Start Mobile Link Measurement」で計測を始め（前の値は捨てる）、「Stop ...」でやめる
// - 「Export Mobile Link Measurement」で、集めた値（時間・大きさ・件数だけ）を JSON に書き出す
// - 計測中、各ウィンドウは 5 秒ごとに自分の renderer の分（PTY の入出力）を shared process へ送って 1 つにまとめる

import { localize, localize2 } from '../../../../nls.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisMobileRelayService, PARADIS_MOBILE_RELAY_CHANNEL } from '../common/paradisMobileRelay.js';
import { paradisMobileLinkMetrics } from '../common/paradisMobileLinkMetricsRecorder.js';

/** renderer の分を shared process へ送る間隔。 */
const RENDERER_FLUSH_INTERVAL_MS = 5_000;

function relayServiceOf(sharedProcessService: ISharedProcessService): IParadisMobileRelayService {
	return ProxyChannel.toService<IParadisMobileRelayService>(sharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL));
}

/** このウィンドウの renderer が数えた分を shared process へ送る（空なら送らない）。 */
async function flushRendererLinkMetrics(service: IParadisMobileRelayService): Promise<void> {
	if (!paradisMobileLinkMetrics.enabled) {
		return;
	}
	const raw = paradisMobileLinkMetrics.raw(true);
	if (Object.keys(raw.histograms).length === 0 && Object.keys(raw.counters).length === 0) {
		return;
	}
	await service.mergeLinkMetrics(raw);
}

class ParadisMobileLinkMetricsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisMobileLinkMetrics';

	private readonly flushTimer = this._register(new IntervalTimer());

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const service = relayServiceOf(sharedProcessService);
		this._register(service.onDidChangeLinkMetricsEnabled(enabled => this.apply(service, enabled)));
		service.getLinkMetricsEnabled().then(enabled => this.apply(service, enabled), error => this.logService.trace('[paradisMobileRelay] link metrics state unavailable', String(error)));
	}

	private apply(service: IParadisMobileRelayService, enabled: boolean): void {
		paradisMobileLinkMetrics.setEnabled(enabled);
		if (!enabled) {
			this.flushTimer.cancel();
			return;
		}
		this.flushTimer.cancelAndSet(() => {
			flushRendererLinkMetrics(service).catch(error => this.logService.trace('[paradisMobileRelay] link metrics flush failed', String(error)));
		}, RENDERER_FLUSH_INTERVAL_MS);
	}
}

registerWorkbenchContribution2(ParadisMobileLinkMetricsContribution.ID, ParadisMobileLinkMetricsContribution, WorkbenchPhase.AfterRestored);

class ParadisStartMobileLinkMetricsAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.mobile.startLinkMetrics',
			title: localize2('paradis.mobile.startLinkMetrics', "Start Mobile Link Measurement"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const service = relayServiceOf(accessor.get(ISharedProcessService));
		const notificationService = accessor.get(INotificationService);
		await service.setLinkMetricsEnabled(true);
		notificationService.info(localize('paradis.mobile.linkMetricsStarted', "Started measuring the mobile link. Use the app as usual, then run \"Export Mobile Link Measurement\". Only timings, sizes, and counts are recorded."));
	}
}
registerAction2(ParadisStartMobileLinkMetricsAction);

class ParadisStopMobileLinkMetricsAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.mobile.stopLinkMetrics',
			title: localize2('paradis.mobile.stopLinkMetrics', "Stop Mobile Link Measurement"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const service = relayServiceOf(accessor.get(ISharedProcessService));
		await flushRendererLinkMetrics(service);
		await service.setLinkMetricsEnabled(false);
	}
}
registerAction2(ParadisStopMobileLinkMetricsAction);

class ParadisExportMobileLinkMetricsAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.mobile.exportLinkMetrics',
			title: localize2('paradis.mobile.exportLinkMetrics', "Export Mobile Link Measurement"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const service = relayServiceOf(accessor.get(ISharedProcessService));
		const fileDialogService = accessor.get(IFileDialogService);
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);
		const productService = accessor.get(IProductService);
		await flushRendererLinkMetrics(service);
		const snapshot = await service.getLinkMetricsSnapshot();
		if (snapshot.startedAt === undefined) {
			notificationService.info(localize('paradis.mobile.linkMetricsNotStarted', "No mobile link measurement has been taken yet. Run \"Start Mobile Link Measurement\" first."));
			return;
		}
		const generatedAt = Date.now();
		const fileName = `paracode-mobile-link-metrics-${new Date(generatedAt).toISOString().replace(/[:.]/g, '-')}.json`;
		const target = await fileDialogService.showSaveDialog({
			defaultUri: joinPath(await fileDialogService.defaultFilePath(), fileName),
			filters: [{ name: 'JSON', extensions: ['json'] }],
		});
		if (target === undefined) {
			return;
		}
		const report = { source: 'pc', productVersion: productService.version, generatedAt, ...snapshot };
		await fileService.writeFile(target, VSBuffer.fromString(JSON.stringify(report, undefined, '\t')));
		notificationService.info(localize('paradis.mobile.linkMetricsExported', "Exported the mobile link measurement."));
	}
}
registerAction2(ParadisExportMobileLinkMetricsAction);
