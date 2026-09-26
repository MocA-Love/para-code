/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量パネルの Claude のアカウントカードに出す操作（paradisLimitsPanelContributions.ts の部品）。
//  - 登録していない、いまのログイン: 「Para Code に登録」（ブラウザでのログインなしで登録する）

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IParadisLimitsAccount } from '../common/paradisLimitsMonitor.js';
import { IParadisLimitsPanelContext, IParadisLimitsPanelContribution, ParadisLimitsPanelContributions } from './paradisLimitsPanelContributions.js';

const $ = dom.$;

class ParadisClaudeAccountActions extends Disposable implements IParadisLimitsPanelContribution {

	readonly provider = 'claude';

	/** 押した後、結果が返るまで同じボタンを押せなくする（描き直しをまたいで持つ）。 */
	private registering = false;

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
	}

	renderAccountActions(container: HTMLElement, account: IParadisLimitsAccount, context: IParadisLimitsPanelContext): IDisposable | undefined {
		const store = new DisposableStore();
		if (account.registrable) {
			const button = dom.append(container, $('button.plm-card-action-btn')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = localize('paradis.claudeAccounts.register', "Para Code に登録");
			button.title = localize('paradis.claudeAccounts.registerHint', "いまこの PC でログインしている Claude アカウントを登録し、ほかのアカウントとの切り替えに使えるようにします");
			button.disabled = this.registering;
			store.add(dom.addDisposableListener(button, 'click', () => void this.registerLive(context)));
		}
		return store;
	}

	private async registerLive(context: IParadisLimitsPanelContext): Promise<void> {
		if (this.registering) {
			return;
		}
		this.registering = true;
		try {
			const result = await context.client.registerLiveClaudeAccount();
			switch (result.outcome) {
				case 'registered':
				case 'updated':
					this.notificationService.info(localize('paradis.claudeAccounts.registered', "{0} を Para Code に登録しました。", result.email ?? ''));
					break;
				case 'no_live_login':
					this.notificationService.warn(localize('paradis.claudeAccounts.noLiveLogin', "この PC の Claude にログインしていないため、登録できませんでした。"));
					break;
				case 'not_oauth':
					this.notificationService.warn(localize('paradis.claudeAccounts.notOauth', "API キーでのログインは登録できません。Claude のサブスクリプションでログインしたアカウントだけ登録できます。"));
					break;
				case 'busy':
					this.notificationService.warn(localize('paradis.claudeAccounts.registerBusy', "アカウントの切り替え中です。終わってからもう一度お試しください。"));
					break;
				case 'failed':
					this.notificationService.error(localize('paradis.claudeAccounts.registerFailed', "Claude アカウントを登録できませんでした。もう一度お試しください。"));
					break;
			}
		} catch {
			this.notificationService.error(localize('paradis.claudeAccounts.registerFailed', "Claude アカウントを登録できませんでした。もう一度お試しください。"));
		} finally {
			this.registering = false;
			context.requestRefresh(false);
		}
	}
}

ParadisLimitsPanelContributions.register(ParadisClaudeAccountActions);
