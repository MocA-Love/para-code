/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude/Codex(OpenAI)/GitHub のサービスステータスのタイトルバー左側トリガー(案A: サービスごと
// の個別チップ、右下ドットで重大度を示す)。titlebarPart.ts の PARA-PATCH 点(resourceMonitor/
// limitsMonitorウィジェットの隣)から createParadisServiceStatusWidget(instantiationService, container)
// として1回だけ生成される。
//
// ポーリングの唯一の主体はこのウィジェット(ポップオーバーは表示のみ)。各サービスのステータスは
// 数分単位でしか変化しないため、通常5分間隔、ポップオーバー表示中は1分間隔にする。
// `paradis.serviceStatus.enabled` が false の間はポーリングを停止する。
//
// スナップショットと取得中Promiseはモジュールスコープに置き、最短間隔ガード(MIN_REFRESH_INTERVAL_MS)
// と合わせて短時間の連打(チップを3つ続けてクリック等)による重複リクエストを防ぐ。補助ウィンドウ
// (mainWindow.open('about:blank')で開くAuxiliaryNativeTitlebarPart)はDOMレルムこそ分かれるが、
// CSPで自前スクリプトの実行(script-src 'none')を持たずメインウィンドウのJSを共有するため、
// このモジュール状態は実際には全ウィンドウ間でも共有される(ウィンドウ枚数分のポーリング増殖は
// 起きない)。

import './media/paradisServiceStatus.css';
import * as dom from '../../../../base/browser/dom.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import {
	IParadisServiceStatusEntry,
	IParadisServiceStatusSnapshot,
	PARADIS_SERVICE_STATUS_PROVIDERS,
	PARADIS_SERVICE_STATUS_SETTING_ENABLED,
	PARADIS_SERVICE_STATUS_SEVERITIES,
	PARADIS_SERVICE_STATUS_SOURCES,
	ParadisServiceStatusProvider,
	paradisServiceStatusSeverityLabel,
} from '../common/paradisServiceStatus.js';
import { ParadisServiceStatusClient } from './paradisServiceStatusClient.js';
import { ParadisServiceStatusPopover } from './paradisServiceStatusPopover.js';
import { appendParadisServiceStatusLogo } from './paradisServiceStatusLogos.js';

const $ = dom.$;

/** ポップオーバー表示中のポーリング間隔。 */
const POPOVER_OPEN_POLL_INTERVAL_MS = 60_000;
/** ポップオーバー非表示中(トリガーのみ)のポーリング間隔。 */
const IDLE_POLL_INTERVAL_MS = 300_000;
/** これより新しいスナップショットが既にあれば、取得し直さずそれを使う。
 *  POPOVER_OPEN_POLL_INTERVAL_MS よりわずかに短くし、ポップオーバー表示中のタイマー発火が
 *  常にこのガードへ引っかかって実効間隔が2倍になる、という事態を避ける。 */
const MIN_REFRESH_INTERVAL_MS = 50_000;

let sharedSnapshot: IParadisServiceStatusSnapshot | undefined;
let sharedFetchPromise: Promise<IParadisServiceStatusSnapshot> | undefined;

/** titlebarPart.ts の PARA-PATCH 点から呼ばれるファクトリ。 */
export function createParadisServiceStatusWidget(instantiationService: IInstantiationService, container: HTMLElement): IDisposable {
	return instantiationService.createInstance(ParadisServiceStatusWidget, container);
}

class ParadisServiceStatusWidget extends Disposable {

	private readonly client: ParadisServiceStatusClient;
	private readonly document: Document;
	private readonly buttons = new Map<ParadisServiceStatusProvider, HTMLElement>();
	private readonly dots = new Map<ParadisServiceStatusProvider, HTMLElement>();
	private readonly popover = this._register(new MutableDisposable<ParadisServiceStatusPopover>());
	private readonly pollTimer = this._register(new IntervalTimer());

	private activeProvider: ParadisServiceStatusProvider | undefined;
	private latestSnapshot: IParadisServiceStatusSnapshot | undefined;
	private disposed = false;

	constructor(
		container: HTMLElement,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this.document = dom.getDocument(container);
		this.client = this.instantiationService.createInstance(ParadisServiceStatusClient);

		for (const provider of PARADIS_SERVICE_STATUS_PROVIDERS) {
			const source = PARADIS_SERVICE_STATUS_SOURCES[provider];
			const button = dom.append(container, $('button.paradis-service-status-trigger'));
			button.setAttribute('type', 'button');
			button.setAttribute('aria-label', localize('paradis.serviceStatus.triggerAria', "{0} のステータス", source.label));
			appendParadisServiceStatusLogo(button, provider);
			const dot = dom.append(button, $('.paradis-service-status-dot.unknown'));
			this._register(dom.addDisposableListener(button, 'click', () => this.toggle(provider, button)));
			this.buttons.set(provider, button);
			this.dots.set(provider, dot);
		}

		// 可視復帰時に(有効かつポップオーバー非表示なら)即時1回だけ更新する(resourceMonitorと同じ方式)
		this._register(dom.addDisposableListener(this.document, 'visibilitychange', () => {
			if (!this.document.hidden && !this.popover.value && this.isEnabled()) {
				void this.poll();
			}
		}));

		if (sharedSnapshot) {
			this.applySnapshot(sharedSnapshot);
		}

		this.applyEnabled();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_SERVICE_STATUS_SETTING_ENABLED)) {
				this.applyEnabled();
			}
		}));
	}

	override dispose(): void {
		this.disposed = true;
		for (const button of this.buttons.values()) {
			button.remove();
		}
		super.dispose();
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(PARADIS_SERVICE_STATUS_SETTING_ENABLED);
	}

	private applyEnabled(): void {
		const enabled = this.isEnabled();
		for (const button of this.buttons.values()) {
			button.style.display = enabled ? '' : 'none';
		}
		if (enabled) {
			this.reschedulePolling();
			void this.poll();
		} else {
			this.pollTimer.cancel();
			this.closePopover();
		}
	}

	private reschedulePolling(): void {
		if (!this.isEnabled()) {
			this.pollTimer.cancel();
			return;
		}
		const interval = this.popover.value ? POPOVER_OPEN_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
		this.pollTimer.cancelAndSet(() => this.poll(), interval);
	}

	private toggle(provider: ParadisServiceStatusProvider, anchor: HTMLElement): void {
		if (this.activeProvider === provider) {
			this.closePopover();
			return;
		}
		this.closePopover();
		this.activeProvider = provider;
		anchor.classList.add('active');
		this.popover.value = this.instantiationService.createInstance(ParadisServiceStatusPopover, anchor, {
			provider,
			entry: this.latestSnapshot?.entries[provider],
			onClose: () => this.closePopover(),
		});
		this.reschedulePolling();
		void this.poll();
	}

	private closePopover(): void {
		if (this.activeProvider) {
			this.buttons.get(this.activeProvider)?.classList.remove('active');
		}
		this.activeProvider = undefined;
		this.popover.clear();
		this.reschedulePolling();
	}

	/**
	 * 直近 {@link MIN_REFRESH_INTERVAL_MS} 以内に取得済みのスナップショットがあればそれを使い、
	 * 既に取得中なら同じPromiseに相乗りするだけで新規リクエストは出さない(ファイル冒頭コメント参照)。
	 */
	private async poll(): Promise<void> {
		// アイドルポーリングはウィンドウ不可視中スキップ(resourceMonitor/limitsMonitorと同じ)
		if (!this.popover.value && this.document.hidden) {
			return;
		}
		if (sharedSnapshot && Date.now() - sharedSnapshot.generatedAt < MIN_REFRESH_INTERVAL_MS) {
			this.applySnapshot(sharedSnapshot);
			return;
		}
		if (!sharedFetchPromise) {
			sharedFetchPromise = this.client.getSnapshot().finally(() => { sharedFetchPromise = undefined; });
		}
		try {
			const snapshot = await sharedFetchPromise;
			sharedSnapshot = snapshot;
			this.applySnapshot(snapshot);
		} catch {
			// ネットワーク一時不通など。次のポーリングで回復する
		}
	}

	private applySnapshot(snapshot: IParadisServiceStatusSnapshot): void {
		if (this.disposed) {
			return;
		}
		this.latestSnapshot = snapshot;
		this.renderTriggers(snapshot);
		if (this.activeProvider) {
			this.popover.value?.updateEntry(snapshot.entries[this.activeProvider]);
		}
	}

	private renderTriggers(snapshot: IParadisServiceStatusSnapshot): void {
		for (const provider of PARADIS_SERVICE_STATUS_PROVIDERS) {
			const entry: IParadisServiceStatusEntry | undefined = snapshot.entries[provider];
			const button = this.buttons.get(provider);
			const dot = this.dots.get(provider);
			if (!button || !dot || !entry) {
				continue;
			}
			dot.classList.remove(...PARADIS_SERVICE_STATUS_SEVERITIES);
			dot.classList.add(entry.severity);
			const source = PARADIS_SERVICE_STATUS_SOURCES[provider];
			button.setAttribute('aria-label', localize('paradis.serviceStatus.triggerAriaWithState', "{0} のステータス: {1}", source.label, paradisServiceStatusSeverityLabel(entry.severity)));
		}
	}
}
