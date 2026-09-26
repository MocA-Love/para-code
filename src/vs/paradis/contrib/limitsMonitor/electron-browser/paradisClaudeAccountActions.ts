/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量パネルの Claude のアカウントカードに出す操作（paradisLimitsPanelContributions.ts の部品）。
//  - 登録していない、いまのログイン: 「Para Code に登録」（ブラウザでのログインなしで登録する）
//  - 登録した控えのアカウント: 「このアカウントを使う」（設問 Q5）。この PC の Claude のログインを
//    書き換える（設問 Q2）ので、押したら確認し、動いている Claude Code への影響を説明する

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IParadisClaudeSwitchResult } from '../common/paradisClaudeAccounts.js';
import { IParadisLimitsAccount, paradisLimitsNeedsRelogin } from '../common/paradisLimitsMonitor.js';
import { IParadisLimitsPanelContext, IParadisLimitsPanelContribution, ParadisLimitsPanelContributions } from './paradisLimitsPanelContributions.js';

const $ = dom.$;

class ParadisClaudeAccountActions extends Disposable implements IParadisLimitsPanelContribution {

	readonly provider = 'claude';

	/** 押した後、結果が返るまで同じボタンを押せなくする（描き直しをまたいで持つ）。 */
	private registering = false;
	private switching = false;

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
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
		// 使用中のカードには「使用中」バッジが出るので、ボタンは控えにだけ出す。再ログインが要る
		// アカウントは切り替えても使えないので出さない（カードの「再ログイン…」から直す）。
		if (account.managed && !account.active && !paradisLimitsNeedsRelogin(account.status)) {
			const button = dom.append(container, $('button.plm-card-action-btn')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = this.switching
				? localize('paradis.claudeAccounts.switching', "切り替え中…")
				: localize('paradis.claudeAccounts.use', "このアカウントを使う");
			button.disabled = this.switching;
			store.add(dom.addDisposableListener(button, 'click', () => void this.switchTo(account, context)));
		}
		return store;
	}

	private async switchTo(account: IParadisLimitsAccount, context: IParadisLimitsPanelContext): Promise<void> {
		if (this.switching) {
			return;
		}
		const email = account.email ?? account.id;
		const { confirmed } = await this.dialogService.confirm({
			message: localize('paradis.claudeAccounts.switchConfirm', "Claude のアカウントを {0} に切り替えますか？", email),
			detail: localize(
				'paradis.claudeAccounts.switchDetail',
				"この PC の Claude Code のログインを書き換えます。Para Code の外で使っている Claude Code も含め、すべてのウィンドウでこのアカウントを使うようになります。\n\n動いている Claude Code は、次の発言から新しいアカウントを使います（反映まで 30 秒ほどかかることがあります）。すぐに切り替わらないときは、Claude Code を起動し直してください。",
			),
			primaryButton: localize('paradis.claudeAccounts.switchButton', "切り替える"),
		});
		if (!confirmed) {
			return;
		}
		this.switching = true;
		context.requestRefresh(false);
		let result: IParadisClaudeSwitchResult;
		try {
			result = await context.client.switchClaudeAccount(account.id);
		} catch {
			result = { outcome: 'failed', rolledBack: true };
		} finally {
			this.switching = false;
		}
		this.reportSwitch(result, email);
		context.requestRefresh(false);
	}

	private reportSwitch(result: IParadisClaudeSwitchResult, email: string): void {
		switch (result.outcome) {
			case 'switched':
				this.notificationService.info(localize('paradis.claudeAccounts.switched', "Claude のアカウントを {0} に切り替えました。動いている Claude Code は次の発言から新しいアカウントを使います。", result.email ?? email));
				return;
			case 'already_active':
				this.notificationService.info(localize('paradis.claudeAccounts.alreadyActive', "すでに {0} を使っています。", result.email ?? email));
				return;
			case 'busy':
				this.notificationService.warn(localize('paradis.claudeAccounts.switchBusy', "ほかの切り替えが進行中です。終わってからもう一度お試しください。"));
				return;
			case 'unmanaged_live':
				this.notificationService.warn(localize('paradis.claudeAccounts.unmanagedLive', "いまこの PC でログインしている {0} は Para Code に登録されていないため、切り替えるとそのログインが失われます。先にそのアカウントのカードで「Para Code に登録」を押してください。", result.previousEmail ?? ''));
				return;
			case 'not_found':
				this.notificationService.error(localize('paradis.claudeAccounts.switchNotFound', "切り替え先のアカウントが見つかりません。一覧を更新してからもう一度お試しください。"));
				return;
			case 'no_credentials':
				this.notificationService.error(localize('paradis.claudeAccounts.switchNoCredentials', "{0} の保存済みの認証情報が使えません。カードの「再ログイン…」からログインし直してください。", result.email ?? email));
				return;
			case 'locked':
				this.notificationService.warn(localize('paradis.claudeAccounts.switchLocked', "Claude Code がログインを更新している最中でした。数秒待ってからもう一度お試しください。"));
				return;
			case 'failed':
				if (result.rolledBack === false) {
					this.notificationService.error(localize('paradis.claudeAccounts.switchFailedNoRollback', "Claude のアカウントを切り替えられず、元に戻すこともできませんでした。ターミナルで claude を起動し、/login でログインし直してください。"));
				} else if (result.detail === 'config_unreadable') {
					this.notificationService.error(localize('paradis.claudeAccounts.switchConfigUnreadable', "~/.claude.json を読み取れないため、切り替えませんでした。ファイルが壊れていないか確認してください。"));
				} else if (result.detail === 'keychain') {
					this.notificationService.error(localize('paradis.claudeAccounts.switchKeychain', "キーチェーンを読み書きできないため、切り替えませんでした。Mac のロックを解除してからもう一度お試しください。"));
				} else {
					this.notificationService.error(localize('paradis.claudeAccounts.switchFailed', "Claude のアカウントを切り替えられませんでした。変更は元に戻しました。"));
				}
				return;
		}
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
