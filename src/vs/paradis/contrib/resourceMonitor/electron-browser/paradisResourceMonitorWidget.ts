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
import { IParadisResourceMonitorSnapshot } from '../common/paradisResourceMonitor.js';
import { paradisFormatCpu, paradisFormatMemory, paradisGetTrackedHostMemorySeverity } from '../common/paradisResourceMonitorFormat.js';
import { ParadisResourceMonitorClient } from './paradisResourceMonitorClient.js';
import { IParadisResourceMonitorPanelOptions, ParadisResourceMonitorPanel } from './paradisResourceMonitorPanel.js';

const $ = dom.$;

const CONFIG_KEY_ENABLED = 'paradis.resourceMonitor.enabled';

/** パネル表示中のポーリング間隔。 */
const PANEL_OPEN_POLL_INTERVAL_MS = 2000;
/** パネル非表示中(トリガーのみ)のポーリング間隔。 */
const IDLE_POLL_INTERVAL_MS = 5000;

/** titlebarPart.ts の PARA-PATCH 点から呼ばれるファクトリ。 */
export function createParadisResourceMonitorWidget(instantiationService: IInstantiationService, container: HTMLElement): IDisposable {
	return instantiationService.createInstance(ParadisResourceMonitorWidget, container);
}

class ParadisResourceMonitorWidget extends Disposable {

	private readonly button: HTMLElement;
	private readonly iconWrap: HTMLElement;
	private readonly dot: HTMLElement;
	private readonly textElement: HTMLElement;

	private readonly client: ParadisResourceMonitorClient;
	private readonly panel = this._register(new MutableDisposable<ParadisResourceMonitorPanel>());
	private readonly pollTimer = this._register(new IntervalTimer());

	private latestSnapshot: IParadisResourceMonitorSnapshot | undefined;
	private isFetching = false;

	constructor(
		container: HTMLElement,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

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

		this.applyEnabled();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_KEY_ENABLED)) {
				this.applyEnabled();
			}
		}));
	}

	override dispose(): void {
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
		const interval = this.panel.value ? PANEL_OPEN_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
		this.pollTimer.cancelAndSet(() => this.poll(false), interval);
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

	private async poll(force: boolean): Promise<void> {
		if (this.isFetching) {
			return;
		}
		this.isFetching = true;
		this.panel.value?.setFetching(true);
		try {
			const snapshot = await this.client.getSnapshot(force);
			this.latestSnapshot = snapshot;
			this.updateTriggerText(snapshot);
			this.panel.value?.updateSnapshot(snapshot);
		} catch {
			// メインプロセス一時不通など。次のポーリングで回復する。
		} finally {
			this.isFetching = false;
			this.panel.value?.setFetching(false);
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
