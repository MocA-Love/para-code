/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// AIリミットモニターのタイトルバートリガー(案C: プロバイダーロゴ＋アカウントごとのリングゲージ)。
// titlebarPart.ts の PARA-PATCH 点(resourceMonitorウィジェットの隣)から
// createParadisLimitsMonitorWidget(instantiationService, container) として1回だけ生成される。
//
// ポーリングの唯一の主体はこのウィジェット(パネルは表示のみ)。リミットの変化は緩やかなので
// 通常2分間隔、パネル表示中は30秒間隔。この定期ポーリング自体が各アカウントのトークンを
// 使い続ける(=生かし続ける)keep-aliveも兼ねる。`paradis.limitsMonitor.enabled` が false の間は
// ポーリングを停止する。

import './media/paradisLimitsMonitor.css';
import * as dom from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IParadisLimitsAccount,
	IParadisLimitsSnapshot,
	paradisLimitsSeverity,
	paradisLimitsWorstPercent,
	ParadisLimitsProvider
} from '../common/paradisLimitsMonitor.js';
import { appendParadisLimitsLogo } from './paradisLimitsLogos.js';
import { ParadisLimitsMonitorClient, PARADIS_LIMITS_SETTING_ENABLED } from './paradisLimitsMonitorClient.js';
import { IParadisLimitsMonitorPanelOptions, ParadisLimitsMonitorPanel } from './paradisLimitsMonitorPanel.js';
import { ParadisLimitsSetupDialog } from './paradisLimitsSetupDialog.js';

const $ = dom.$;

/** パネル表示中のポーリング間隔。 */
const PANEL_OPEN_POLL_INTERVAL_MS = 30_000;
/** パネル非表示中(トリガーのみ)のポーリング間隔。 */
const IDLE_POLL_INTERVAL_MS = 120_000;

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** titlebarPart.ts の PARA-PATCH 点から呼ばれるファクトリ。 */
export function createParadisLimitsMonitorWidget(instantiationService: IInstantiationService, container: HTMLElement): IDisposable {
	return instantiationService.createInstance(ParadisLimitsMonitorWidget, container);
}

class ParadisLimitsMonitorWidget extends Disposable {

	private readonly button: HTMLElement;
	private readonly client: ParadisLimitsMonitorClient;
	private readonly panel = this._register(new MutableDisposable<ParadisLimitsMonitorPanel>());
	private readonly setupDialog = this._register(new MutableDisposable<ParadisLimitsSetupDialog>());
	private readonly pollTimer = this._register(new IntervalTimer());
	/** リングは毎ポーリングで作り直すため、その都度のhover登録はここへ集めて再描画時にclearする。 */
	private readonly ringDisposables = this._register(new DisposableStore());
	private readonly hoverDelegate = getDefaultHoverDelegate('mouse');

	private latestSnapshot: IParadisLimitsSnapshot | undefined;
	private isFetching = false;

	constructor(
		container: HTMLElement,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();

		this.client = this.instantiationService.createInstance(ParadisLimitsMonitorClient);

		this.button = dom.append(container, $('button.paradis-limits-trigger'));
		this.button.setAttribute('type', 'button');
		this.button.setAttribute('aria-label', localize('paradis.limitsMonitor.triggerAria', "AI利用リミット"));

		this._register(dom.addDisposableListener(this.button, 'click', () => this.togglePanel()));

		// 可視復帰時に(有効かつパネル非表示なら)即時1回だけ更新する(resourceMonitorと同じ方式)
		this._register(dom.addDisposableListener(dom.getDocument(this.button), 'visibilitychange', () => {
			if (!dom.getDocument(this.button).hidden && !this.panel.value && this.isEnabled()) {
				void this.poll(false);
			}
		}));

		this.applyEnabled();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_LIMITS_SETTING_ENABLED)) {
				this.applyEnabled();
			}
		}));
	}

	override dispose(): void {
		this.button.remove();
		super.dispose();
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(PARADIS_LIMITS_SETTING_ENABLED);
	}

	private applyEnabled(): void {
		const enabled = this.isEnabled();
		this.button.style.display = enabled ? '' : 'none';
		if (enabled) {
			this.reschedulePolling();
			if (!this.latestSnapshot) {
				void this.poll(false);
			}
		} else {
			this.pollTimer.cancel();
			this.closePanel();
		}
	}

	private reschedulePolling(): void {
		if (!this.isEnabled()) {
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
		const options: IParadisLimitsMonitorPanelOptions = {
			initialSnapshot: this.latestSnapshot,
			onManualRefresh: () => this.poll(true),
			onClose: () => this.closePanel(),
			onAddAccount: provider => this.openSetupDialog(provider, undefined),
			onRelogin: account => this.openSetupDialog(account.provider, account),
		};
		this.button.classList.add('active');
		this.panel.value = this.instantiationService.createInstance(ParadisLimitsMonitorPanel, this.button, options);
		this.reschedulePolling();
		void this.poll(false);
	}

	private closePanel(): void {
		this.button.classList.remove('active');
		this.panel.clear();
		this.reschedulePolling();
	}

	private openSetupDialog(provider: ParadisLimitsProvider, reloginAccount: IParadisLimitsAccount | undefined): void {
		this.closePanel();
		this.setupDialog.value = this.instantiationService.createInstance(ParadisLimitsSetupDialog, this.client, {
			provider,
			reloginAccount,
			onClose: (completed: boolean) => {
				this.setupDialog.clear();
				if (completed) {
					void this.poll(true);
				}
			},
		});
	}

	private async poll(force: boolean): Promise<void> {
		// アイドルポーリングはウィンドウ不可視中スキップ(resourceMonitorと同じ)。復帰は
		// visibilitychange購読と次tickのhidden判定で担保される
		if (!force && !this.panel.value && dom.getDocument(this.button).hidden) {
			return;
		}
		if (this.isFetching) {
			return;
		}
		this.isFetching = true;
		this.panel.value?.setFetching(true);
		try {
			const snapshot = await this.client.getSnapshot(force);
			this.latestSnapshot = snapshot;
			this.renderTrigger(snapshot);
			this.panel.value?.updateSnapshot(snapshot);
		} catch {
			// shared process一時不通など。次のポーリングで回復する
		} finally {
			this.isFetching = false;
			this.panel.value?.setFetching(false);
		}
	}

	private renderTrigger(snapshot: IParadisLimitsSnapshot): void {
		this.ringDisposables.clear();
		dom.clearNode(this.button);

		this.renderProvider('claude', snapshot.claude.accounts);
		this.renderProvider('codex', snapshot.codex.accounts);

		if (this.button.childElementCount === 0) {
			// どちらのプロバイダーも見つからない場合は最低限のプレースホルダーを出す
			// (完全に空だとクリック面が消えてパネルから設定状況を確認できなくなるため)
			appendParadisLimitsLogo(this.button, 'claude');
			appendParadisLimitsLogo(this.button, 'codex');
		}
	}

	private renderProvider(provider: ParadisLimitsProvider, accounts: readonly IParadisLimitsAccount[]): void {
		if (accounts.length === 0) {
			return;
		}
		appendParadisLimitsLogo(this.button, provider);
		for (const account of accounts) {
			this.renderRing(account);
		}
	}

	private renderRing(account: IParadisLimitsAccount): void {
		const worst = paradisLimitsWorstPercent(account);
		const hasError = account.status !== 'ok';
		const severity = hasError ? 'error' : paradisLimitsSeverity(worst ?? 0);

		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 20 20');
		svg.classList.add('paradis-limits-ring');
		if (severity !== 'normal') {
			svg.classList.add(severity);
		}

		const track = document.createElementNS(SVG_NS, 'circle');
		track.setAttribute('cx', '10');
		track.setAttribute('cy', '10');
		track.setAttribute('r', String(RING_RADIUS));
		track.setAttribute('fill', 'none');
		track.setAttribute('stroke-width', '3');
		track.classList.add('paradis-limits-ring-track');
		svg.appendChild(track);

		if (hasError) {
			const mark = document.createElementNS(SVG_NS, 'text');
			mark.setAttribute('x', '10');
			mark.setAttribute('y', '14');
			mark.setAttribute('text-anchor', 'middle');
			mark.classList.add('paradis-limits-ring-error-mark');
			mark.textContent = '!';
			svg.appendChild(mark);
		} else {
			const arcLength = Math.max(0.5, Math.min(100, worst ?? 0) / 100 * RING_CIRCUMFERENCE);
			const arc = document.createElementNS(SVG_NS, 'circle');
			arc.setAttribute('cx', '10');
			arc.setAttribute('cy', '10');
			arc.setAttribute('r', String(RING_RADIUS));
			arc.setAttribute('fill', 'none');
			arc.setAttribute('stroke-width', '3');
			arc.setAttribute('stroke-linecap', 'round');
			arc.setAttribute('stroke-dasharray', `${arcLength} ${RING_CIRCUMFERENCE}`);
			arc.setAttribute('transform', 'rotate(-90 10 10)');
			arc.classList.add('paradis-limits-ring-arc');
			svg.appendChild(arc);
		}

		this.button.appendChild(svg);
		this.ringDisposables.add(this.hoverService.setupManagedHover(this.hoverDelegate, svg as unknown as HTMLElement, this.ringTooltip(account)));
	}

	private ringTooltip(account: IParadisLimitsAccount): string {
		const name = account.email ?? account.homeLabel ?? account.id;
		if (account.status !== 'ok') {
			return `${name} — ${account.statusDetail ?? account.status}`;
		}
		const parts: string[] = [];
		if (account.fiveHour) {
			parts.push(localize('paradis.limitsMonitor.tooltip5h', "5時間 {0}%", Math.round(account.fiveHour.usedPercent)));
		}
		if (account.sevenDay) {
			parts.push(localize('paradis.limitsMonitor.tooltip7d', "7日 {0}%", Math.round(account.sevenDay.usedPercent)));
		}
		for (const scoped of account.scoped ?? []) {
			parts.push(`${scoped.label ?? '?'} ${Math.round(scoped.usedPercent)}%`);
		}
		return parts.length > 0 ? `${name} — ${parts.join(' · ')}` : name;
	}
}
