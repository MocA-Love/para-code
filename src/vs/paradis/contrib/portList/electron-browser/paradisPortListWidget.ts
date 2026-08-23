/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポート一覧ウィジェットのタイトルバートリガー(アイコンのみ)。
// titlebarPart.ts の PARA-PATCH 点(レイアウト/アクションツールバーの手前)から
// createParadisPortListWidget(instantiationService, container) として1回だけ生成される。
//
// ポーリングの唯一の主体はこのウィジェット(パネルは表示のみ、limitsMonitorWidget.tsと同じ構造)。

import './media/paradisPortList.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IParadisPortEntry, IParadisPortListSnapshot } from '../common/paradisPortList.js';
import { ParadisPortListClient } from './paradisPortListClient.js';
import { IParadisPortListPanelOptions, ParadisPortListPanel } from './paradisPortListPanel.js';
import { IParadisPortListPollTimer, ParadisPortListPolling } from './paradisPortListPolling.js';

const $ = dom.$;

export interface IParadisPortListWidgetHandle extends IDisposable {
	readonly element: HTMLElement;
}

export interface IParadisPortListWidgetDependencies {
	readonly document: EventTarget & { readonly hidden: boolean };
	readonly pollTimer: IParadisPortListPollTimer & IDisposable;
}

/** titlebarPart.ts の PARA-PATCH 点から呼ばれるファクトリ。 */
export function createParadisPortListWidget(instantiationService: IInstantiationService, container: HTMLElement): IParadisPortListWidgetHandle {
	return instantiationService.createInstance(ParadisPortListWidget, container, undefined);
}

export class ParadisPortListWidget extends Disposable implements IParadisPortListWidgetHandle {

	readonly element: HTMLElement;

	private readonly client: ParadisPortListClient;
	private readonly panel = this._register(new MutableDisposable<ParadisPortListPanel>());
	private readonly document: EventTarget & { readonly hidden: boolean };
	private readonly pollTimer: IParadisPortListPollTimer & IDisposable;
	private readonly polling: ParadisPortListPolling;

	private latestSnapshot: IParadisPortListSnapshot | undefined;
	private isFetching = false;
	private refreshRequested = false;

	constructor(
		container: HTMLElement,
		dependencies: IParadisPortListWidgetDependencies = { document: dom.getDocument(container), pollTimer: new IntervalTimer() },
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.document = dependencies.document;
		this.pollTimer = this._register(dependencies.pollTimer);
		this.polling = this._register(new ParadisPortListPolling(this.pollTimer, () => void this.poll(false)));

		this.client = this.instantiationService.createInstance(ParadisPortListClient);

		this.element = dom.append(container, $('button.paradis-port-list-trigger'));
		this.element.setAttribute('type', 'button');
		this.element.setAttribute('aria-label', localize('paradis.portList.triggerAria', "リッスン中のポート"));
		this.element.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.plug)}`));

		this._register(dom.addDisposableListener(this.element, 'click', () => this.togglePanel()));
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}

	private togglePanel(): void {
		if (this.panel.value) {
			this.closePanel();
			return;
		}
		// パネルを開いた時点の接続状態を確定させ、確認ダイアログ・タイトル表示・kill(fail-closed
		// 判定)まで同じ値を使い回す。ポーリングの合間に接続状態が変わっても、開いている間は
		// 「ローカルの一覧を見ているのに実行はリモート」のような混線が起きない。
		const viaRemote = this.client.connectedToRemote;
		const options: IParadisPortListPanelOptions = {
			initialSnapshot: this.latestSnapshot,
			viaRemote,
			onManualRefresh: () => this.poll(true),
			onClose: () => this.closePanel(),
			onKill: entry => void this.killEntry(entry, viaRemote),
			onKillAll: entries => void this.killAll(entries, viaRemote),
		};
		this.element.classList.add('active');
		this.panel.value = this.instantiationService.createInstance(ParadisPortListPanel, this.element, options);
		this.polling.setPanelOpen(true);
		void this.poll(true);
	}

	private closePanel(): void {
		this.element.classList.remove('active');
		this.polling.setPanelOpen(false);
		this.panel.clear();
	}

	private async poll(force: boolean): Promise<void> {
		if (!force && !this.panel.value && this.document.hidden) {
			return;
		}
		if (this.isFetching) {
			if (force) {
				this.refreshRequested = true;
			}
			return;
		}
		this.isFetching = true;
		this.panel.value?.setFetching(true);
		try {
			const snapshot = await this.client.getSnapshot(force);
			this.latestSnapshot = snapshot;
			this.panel.value?.updateSnapshot(snapshot);
		} catch (error) {
			this.logService.warn('[ParadisPortList] Failed to refresh the port list', error);
		} finally {
			this.isFetching = false;
			this.panel.value?.setFetching(false);
			if (this.refreshRequested) {
				this.refreshRequested = false;
				void this.poll(true);
			}
		}
	}

	private async killEntry(entry: IParadisPortEntry, viaRemote: boolean): Promise<void> {
		try {
			await this.client.kill({ port: entry.port, pid: entry.pid, processName: entry.processName }, viaRemote);
			await this.poll(true);
		} catch (error) {
			this.logService.error('[ParadisPortList] Failed to kill port', entry.port, error);
			this.notificationService.error(localize('paradis.portList.killFailed', "ポート :{0} ({1}) を終了できませんでした。", entry.port, entry.processName));
		}
	}

	private async killAll(entries: readonly IParadisPortEntry[], viaRemote: boolean): Promise<void> {
		// 何を殺すのか見えないまま「すべて終了」を押させない。先頭数件を列挙し、残りは件数だけ出す。
		const PREVIEW_LIMIT = 8;
		const preview = entries.slice(0, PREVIEW_LIMIT).map(entry => `:${entry.port} (${entry.processName})`).join(', ');
		const remaining = entries.length - PREVIEW_LIMIT;
		const targets = remaining > 0
			? localize('paradis.portList.killAllTargetsMore', "{0}、他{1}件", preview, remaining)
			: preview;
		const { confirmed } = await this.dialogService.confirm({
			message: localize('paradis.portList.killAllConfirm', "{0}件のポートをすべて終了しますか？", entries.length),
			detail: viaRemote
				? localize('paradis.portList.killAllDetailRemote', "接続先マシン上の以下のプロセスをすぐに終了します。保存していない作業がある場合は失われることがあります。\n{0}", targets)
				: localize('paradis.portList.killAllDetailLocal', "以下のプロセスをすぐに終了します。保存していない作業がある場合は失われることがあります。\n{0}", targets),
			primaryButton: localize('paradis.portList.killAllPrimary', "すべて終了"),
		});
		if (!confirmed) {
			return;
		}
		let failures: number;
		try {
			const result = await this.client.killAll(entries.map(entry => ({ port: entry.port, pid: entry.pid, processName: entry.processName })), viaRemote);
			failures = result.failed;
		} catch (error) {
			failures = entries.length;
			this.logService.error('[ParadisPortList] Failed to kill ports during Kill All', error);
		}
		await this.poll(true);
		if (failures > 0) {
			this.notificationService.error(localize('paradis.portList.killAllPartialFailure', "{0}件のポートを終了できませんでした。", failures));
		}
	}
}
