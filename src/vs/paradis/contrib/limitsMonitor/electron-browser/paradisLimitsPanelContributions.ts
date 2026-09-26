/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量パネル（paradisLimitsMonitorPanel.ts）へ、プロバイダごとの部品を差し込む口。
//
// パネル本体はアカウントカードの枠・メーター・状態の説明だけを描き、プロバイダ固有の操作
// （Claude の「このアカウントを使う」、Codex のリセットクレジットや切り替えなど）はここに登録した
// 部品が描く。部品はパネルを開くたびに `IInstantiationService.createInstance` で作られ、
// パネルを閉じると破棄されるので、コンストラクタでサービスを受け取れる。
//
// 使い方:
//   class MyCodexCardActions extends Disposable implements IParadisLimitsPanelContribution {
//       readonly provider = 'codex';
//       constructor(@IDialogService private readonly dialogService: IDialogService) { super(); }
//       renderAccountActions(container, account, context) { ...ボタンを足して IDisposable を返す... }
//   }
//   ParadisLimitsPanelContributions.register(MyCodexCardActions);
// 登録するモジュールは、タイトルバーのウィジェット（paradisLimitsMonitorWidget.ts）から副作用
// import で読み込む。

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { IParadisLimitsAccount, IParadisLimitsProviderSnapshot, ParadisLimitsProvider } from '../common/paradisLimitsMonitor.js';
import { ParadisLimitsMonitorClient } from './paradisLimitsMonitorClient.js';

/** 部品へ渡す、パネルとのやりとりの口。 */
export interface IParadisLimitsPanelContext {
	/** バックエンドへのクライアント（ウィジェットと同じもの）。 */
	readonly client: ParadisLimitsMonitorClient;
	/** 取り直して描き直す。`force` は手動更新と同じ（Claude は 180 秒より古い分だけ取り直す）。 */
	requestRefresh(force: boolean): void;
	/** パネルを閉じる（ダイアログを開く前など）。 */
	closePanel(): void;
}

/** プロバイダごとの部品。どのメソッドも省略できる。 */
export interface IParadisLimitsPanelContribution extends IDisposable {
	readonly provider: ParadisLimitsProvider;

	/**
	 * アカウントカードの下端の右寄せの列（`.plm-card-actions`）へ、ボタンなどを足す。
	 * 何も足さなければ列は消える。返した IDisposable はカードを描き直すたびに破棄される
	 * （パネルは表示中 30 秒ごとと、Claude の取得のたびに描き直す）。
	 */
	renderAccountActions?(container: HTMLElement, account: IParadisLimitsAccount, context: IParadisLimitsPanelContext): IDisposable | undefined;

	/**
	 * プロバイダの節の末尾（アカウントカードの後ろ）へ、独立したカード列や案内を足す。
	 * 返した IDisposable は描き直すたびに破棄される。
	 */
	renderProviderFooter?(container: HTMLElement, providerSnapshot: IParadisLimitsProviderSnapshot, context: IParadisLimitsPanelContext): IDisposable | undefined;
}

/** 部品のクラス。コンストラクタはサービスだけを受け取る（`@IXxxService` で注入）。 */
export type ParadisLimitsPanelContributionCtor = new (...services: BrandedService[]) => IParadisLimitsPanelContribution;

class ParadisLimitsPanelContributionRegistry {

	private readonly contributions: ParadisLimitsPanelContributionCtor[] = [];

	/** 部品を登録する。モジュールの最上位で1回呼ぶ想定。 */
	register<Services extends BrandedService[]>(contribution: new (...services: Services) => IParadisLimitsPanelContribution): IDisposable {
		const ctor = contribution as unknown as ParadisLimitsPanelContributionCtor;
		this.contributions.push(ctor);
		return toDisposable(() => {
			const index = this.contributions.indexOf(ctor);
			if (index >= 0) {
				this.contributions.splice(index, 1);
			}
		});
	}

	getAll(): readonly ParadisLimitsPanelContributionCtor[] {
		return this.contributions;
	}
}

export const ParadisLimitsPanelContributions = new ParadisLimitsPanelContributionRegistry();
