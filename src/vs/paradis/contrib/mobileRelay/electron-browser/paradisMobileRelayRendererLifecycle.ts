/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** rendererのPC focus lifecycleに必要な最小契約。 */
export interface IParadisMobileRelayFocusLifecycle {
	setEnabled(enabled: boolean): void;
	setEnabledAndSynchronize(enabled: boolean): void;
}

/** rendererのstate push metrics lifecycleに必要な最小契約。 */
export interface IParadisMobileRelayStatePushMetricsLifecycle {
	setStatePushMetricsEnabled(enabled: boolean): void;
}

/**
 * provider構築後の初期設定と設定変更を、focusとrenderer metricsへ同じ経路で反映する。
 */
export class ParadisMobileRelayRendererLifecycle<TProvider extends IParadisMobileRelayStatePushMetricsLifecycle> {
	readonly provider: TProvider;

	constructor(
		private readonly focusHeartbeat: IParadisMobileRelayFocusLifecycle,
		createProvider: () => TProvider,
		initialEnabled: boolean,
	) {
		this.provider = createProvider();
		this.focusHeartbeat.setEnabled(initialEnabled);
		this.provider.setStatePushMetricsEnabled(initialEnabled);
	}

	setEnabled(enabled: boolean): void {
		this.focusHeartbeat.setEnabledAndSynchronize(enabled);
		this.provider.setStatePushMetricsEnabled(enabled);
	}
}
