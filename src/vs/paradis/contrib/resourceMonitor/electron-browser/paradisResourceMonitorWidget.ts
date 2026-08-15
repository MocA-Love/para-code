/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CPU/RAMモニタのタイトルバー左側トリガーウィジェット(Superset apps/desktop の TopBar
// ResourceConsumption トリガーボタン移植)。titlebarPart.ts の PARA-PATCH 点から
// createParadisResourceMonitorWidget(instantiationService, container) として1回だけ生成される。
//
// ポーリングの唯一の主体はこのウィジェット(パネルは表示のみ、paradisResourceMonitorPanel.ts参照)。
// パネル非表示中も5秒間隔で自動更新し続け、パネルを開いている間は2秒間隔に切り替える
// (electron-main側に2.5秒の鮮度キャッシュがあるため負荷は小さい)。
// `paradis.resourceMonitor.enabled` が false の間はポーリング自体を停止する。

import './media/paradisResourceMonitor.css';
import * as dom from '../../../../base/browser/dom.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IParadisResourceMonitorSnapshot, ParadisResourceMonitorFreshness } from '../common/paradisResourceMonitor.js';
import { paradisFormatCpu, paradisFormatMemory, paradisGetTrackedHostMemorySeverity } from '../common/paradisResourceMonitorFormat.js';
import { ParadisResourceMonitorClient } from './paradisResourceMonitorClient.js';
import { IParadisResourceMonitorPanelOptions, ParadisResourceMonitorPanel } from './paradisResourceMonitorPanel.js';

const $ = dom.$;

const CONFIG_KEY_ENABLED = 'paradis.resourceMonitor.enabled';

/** パネル表示中のポーリング間隔。 */
const PANEL_OPEN_POLL_INTERVAL_MS = 2000;
/** パネル非表示中(トリガーのみ)のポーリング間隔。 */
const IDLE_POLL_INTERVAL_MS = 5000;

export interface IParadisResourceMonitorPollTimer extends IDisposable {
	cancel(): void;
	cancelAndSet(runner: () => void, interval: number): void;
}

export interface IParadisResourceMonitorWidgetDependencies {
	readonly document: EventTarget & { readonly hidden: boolean };
	readonly pollTimer: IParadisResourceMonitorPollTimer;
}

interface IParadisResourceMonitorPollingPolicy {
	readonly interval: number | undefined;
	readonly freshness: ParadisResourceMonitorFreshness;
}

/** ウィジェットの可視状態とパネル状態から、timerとIPCの鮮度クラスを一貫して決める。 */
export function paradisResourceMonitorPollingPolicy(enabled: boolean, panelOpen: boolean, hidden: boolean): IParadisResourceMonitorPollingPolicy {
	if (!enabled) {
		return { interval: undefined, freshness: 'idle' };
	}
	if (panelOpen) {
		return { interval: PANEL_OPEN_POLL_INTERVAL_MS, freshness: 'active' };
	}
	return { interval: hidden ? undefined : IDLE_POLL_INTERVAL_MS, freshness: 'idle' };
}

/** titlebarPart.ts の PARA-PATCH 点から呼ばれるファクトリ。 */
export function createParadisResourceMonitorWidget(instantiationService: IInstantiationService, container: HTMLElement): IDisposable {
	return instantiationService.createInstance(ParadisResourceMonitorWidget, container, undefined);
}

export class ParadisResourceMonitorWidget extends Disposable {

	private readonly button: HTMLElement;
	private readonly iconWrap: HTMLElement;
	private readonly dot: HTMLElement;
	private readonly textElement: HTMLElement;

	private readonly client: ParadisResourceMonitorClient;
	private readonly panel = this._register(new MutableDisposable<ParadisResourceMonitorPanel>());
	private readonly document: EventTarget & { readonly hidden: boolean };
	private readonly pollTimer: IParadisResourceMonitorPollTimer;

	private latestSnapshot: IParadisResourceMonitorSnapshot | undefined;
	private isFetching = false;
	private idleRefreshPending = false;
	private isDisposed = false;

	constructor(
		container: HTMLElement,
		dependencies: IParadisResourceMonitorWidgetDependencies = { document: dom.getDocument(container), pollTimer: new IntervalTimer() },
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.document = dependencies.document;
		this.pollTimer = this._register(dependencies.pollTimer);

		this.client = this.instantiationService.createInstance(ParadisResourceMonitorClient);

		this.button = dom.append(container, $('button.paradis-resource-monitor-trigger'));
		this.button.setAttribute('type', 'button');
		this.button.setAttribute('aria-label', localize('paradis.resourceMonitor.triggerAria', "CPU and memory usage"));

		this.iconWrap = dom.append(this.button, $('.paradis-resource-monitor-trigger-icon'));
		this.iconWrap.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.chip)}`));
		this.dot = dom.append(this.iconWrap, $('.paradis-resource-monitor-trigger-dot'));
		this.dot.style.display = 'none';

		this.textElement = dom.append(this.button, $('.paradis-resource-monitor-trigger-text'));
		this.textElement.textContent = '--';

		this._register(dom.addDisposableListener(this.button, 'click', () => this.togglePanel()));

		// パネル非表示の不可視中はアイドルtimer自体を止める。可視化時は5秒timerを再アームし、
		// 古い表示を残さないよう即時取得する。パネル表示中は不可視でも2秒timerを維持する。
		this._register(dom.addDisposableListener(this.document, 'visibilitychange', () => {
			this.reschedulePolling();
			if (!this.document.hidden && !this.panel.value && this.configurationService.getValue<boolean>(CONFIG_KEY_ENABLED)) {
				void this.poll(false, true);
			}
		}));

		this.applyEnabled();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_KEY_ENABLED)) {
				this.applyEnabled();
			}
		}));
	}

	override dispose(): void {
		this.isDisposed = true;
		this.idleRefreshPending = false;
		this.button.remove();
		super.dispose();
	}

	private applyEnabled(): void {
		const enabled = this.configurationService.getValue<boolean>(CONFIG_KEY_ENABLED);
		this.button.style.display = enabled ? '' : 'none';
		if (enabled) {
			this.reschedulePolling();
			if (!this.latestSnapshot) {
				// setInterval では最初の実行が interval 後になるため、初回だけ即時取得する
				void this.poll(false);
			}
		} else {
			this.pollTimer.cancel();
			this.closePanel();
		}
	}

	private reschedulePolling(): void {
		// enabled=false の間は再アームしない。closePanel() 経由でここが呼ばれても、
		// 無効化直後の pollTimer.cancel() を打ち消してポーリングが恒久継続するのを防ぐ。
		if (!this.configurationService.getValue<boolean>(CONFIG_KEY_ENABLED)) {
			this.pollTimer.cancel();
			return;
		}
		const policy = paradisResourceMonitorPollingPolicy(true, !!this.panel.value, this.document.hidden);
		if (policy.interval === undefined) {
			this.pollTimer.cancel();
			return;
		}
		this.pollTimer.cancelAndSet(() => this.poll(false), policy.interval);
	}

	private togglePanel(): void {
		if (this.panel.value) {
			this.closePanel();
			return;
		}

		const options: IParadisResourceMonitorPanelOptions = {
			initialSnapshot: this.latestSnapshot,
			onManualRefresh: () => this.poll(true),
			onClose: () => this.closePanel(),
			switchToScope: stateKey => this.client.switchToScope(stateKey),
		};
		this.button.classList.add('active');
		this.panel.value = this.instantiationService.createInstance(ParadisResourceMonitorPanel, this.button, options);
		this.reschedulePolling();
		void this.poll(false);
	}

	private closePanel(): void {
		this.button.classList.remove('active');
		this.panel.clear();
		this.reschedulePolling();
	}

	private async poll(force: boolean, retryWhenBusy = false): Promise<void> {
		// アイドルポーリング(パネル非表示)のみ、ウィジェットが属するウィンドウが不可視
		// (最小化・完全背面などで document.hidden)の間は getSnapshot を呼ばず、electron-main
		// 側の ps サブプロセスを起こさない。手動更新(force)とパネル表示中(2秒ポーリング)は
		// 常に取得する。復帰時はvisibilitychangeでtimerを再アームして即時取得する。マルチ
		// ウィンドウ対応のため mainWindow 固定ではなくウィジェットが属するウィンドウのdocumentを
		// 見る。
		if (!force && !this.panel.value && this.document.hidden) {
			return;
		}
		if (this.isFetching) {
			if (retryWhenBusy) {
				this.idleRefreshPending = true;
			}
			return;
		}
		this.isFetching = true;
		this.panel.value?.setFetching(true);
		try {
			const freshness = paradisResourceMonitorPollingPolicy(true, !!this.panel.value, this.document.hidden).freshness;
			const snapshot = await this.client.getSnapshot(force, freshness);
			this.latestSnapshot = snapshot;
			this.updateTriggerText(snapshot);
			this.panel.value?.updateSnapshot(snapshot);
		} catch {
			// メインプロセス一時不通など。次のポーリングで回復する。
		} finally {
			this.isFetching = false;
			this.panel.value?.setFetching(false);
			if (this.idleRefreshPending) {
				this.idleRefreshPending = false;
				if (!this.isDisposed && !this.document.hidden && !this.panel.value && this.configurationService.getValue<boolean>(CONFIG_KEY_ENABLED)) {
					void this.poll(false);
				}
			}
		}
	}

	private updateTriggerText(snapshot: IParadisResourceMonitorSnapshot): void {
		this.textElement.textContent = `${paradisFormatCpu(snapshot.totalCpu)} / ${paradisFormatMemory(snapshot.totalMemory)}`;

		const sharePercent = snapshot.hostTotalMemory > 0 ? (snapshot.totalMemory / snapshot.hostTotalMemory) * 100 : 0;
		const severity = paradisGetTrackedHostMemorySeverity(sharePercent);
		if (severity === 'normal') {
			this.dot.style.display = 'none';
		} else {
			this.dot.style.display = '';
			this.dot.classList.toggle('elevated', severity === 'elevated');
			this.dot.classList.toggle('high', severity === 'high');
		}
	}
}
