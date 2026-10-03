/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量パネルの Claude のアカウントカードに出す操作（paradisLimitsPanelContributions.ts の部品）。
//  - 登録していない、いまのログイン: 「Para Code に登録」（ブラウザでのログインなしで登録する）
//  - 登録した控えのアカウント: 「このアカウントを使う」（切替ボタンは使用量パネルの各カードに置く、
//    という決定）。この PC 全体の Claude のログインを書き換えるので、押したら確認し、動いている
//    Claude Code への影響を説明する
//  - 節の末尾: claude-swap に登録されていて Para Code にはまだ無いアカウントの一覧と、登録し直しの
//    案内（claude-swap のデータは読むだけ）。1文に縮め、注意書きと一覧は「詳しく」を開いたときだけ出す

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IParadisClaudeSwitchResult } from '../common/paradisClaudeAccounts.js';
import { IParadisLimitsAccount, IParadisLimitsProviderSnapshot, paradisLimitsNeedsRelogin } from '../common/paradisLimitsMonitor.js';
import { IParadisLimitsPanelContext, IParadisLimitsPanelContribution, ParadisLimitsPanelContributions } from './paradisLimitsPanelContributions.js';

const $ = dom.$;

class ParadisClaudeAccountActions extends Disposable implements IParadisLimitsPanelContribution {

	readonly provider = 'claude';

	/** 押した後、結果が返るまで同じボタンを押せなくする（描き直しをまたいで持つ）。 */
	private registering = false;
	private switching = false;
	/** claude-swap の案内の「詳しく」を開いているか（描き直しをまたいで持つ）。 */
	private legacyDetailsOpen = false;

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
			button.title = context.client.connectedToRemote
				? localize('paradis.claudeAccounts.registerHintRemote', "いま接続先でログインしている Claude アカウントを接続先に登録し、ほかのアカウントとの切り替えに使えるようにします")
				: localize('paradis.claudeAccounts.registerHint', "いまこの PC でログインしている Claude アカウントを登録し、ほかのアカウントとの切り替えに使えるようにします");
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

	renderProviderFooter(container: HTMLElement, providerSnapshot: IParadisLimitsProviderSnapshot): IDisposable | undefined {
		const legacy = providerSnapshot.legacyAccounts ?? [];
		if (legacy.length === 0) {
			return undefined;
		}
		const details = dom.append(container, $('details.plm-legacy-notice')) as HTMLDetailsElement;
		details.open = this.legacyDetailsOpen;
		const summary = dom.append(details, $('summary'));
		dom.append(summary, $('span')).textContent = localize(
			'paradis.claudeAccounts.legacySummary',
			"claude-swap (cswap) に登録されていた {0} 件は、Para Code ではまだ使えません。「＋ アカウントを追加」からログインし直して登録してください。",
			legacy.length,
		);
		dom.append(summary, $('span.plm-legacy-more')).textContent = localize('paradis.claudeAccounts.legacyMore', "詳しく");
		dom.append(details, $('div')).textContent = localize(
			'paradis.claudeAccounts.legacyDetail',
			"いまログインしているアカウントは、カードの「Para Code に登録」で登録できます。登録したら、claude-swap での切り替えはやめてください。両方で切り替えると、片方が保存したログインが使えなくなることがあります。claude-swap のデータは読むだけで、書き換えません。",
		);
		const list = dom.append(details, $('ul.plm-legacy-list'));
		for (const account of legacy) {
			dom.append(list, $('li')).textContent = account.organizationName
				? localize('paradis.claudeAccounts.legacyWithOrganization', "{0}（{1}）", account.email, account.organizationName)
				: account.email;
		}
		return dom.addDisposableListener(details, 'toggle', () => {
			this.legacyDetailsOpen = details.open;
		});
	}

	private async switchTo(account: IParadisLimitsAccount, context: IParadisLimitsPanelContext): Promise<void> {
		if (this.switching) {
			return;
		}
		const email = account.email ?? account.id;
		const { confirmed } = await this.dialogService.confirm({
			message: localize('paradis.claudeAccounts.switchConfirm', "Claude のアカウントを {0} に切り替えますか？", email),
			detail: context.client.connectedToRemote
				? localize(
					'paradis.claudeAccounts.switchDetailRemote',
					"接続先の Claude Code のログインを書き換えます。Para Code の外で使う Claude Code も含め、接続先で新しく起動する Claude Code はこのアカウントを使います（この PC のログインは変わりません）。\n\nいま動いている Claude Code は、しばらくして読み直すまで前のアカウントのまま動くことがあります。確実に切り替えるには、Claude Code を起動し直してください。",
				)
				: localize(
					'paradis.claudeAccounts.switchDetail',
					"この PC の Claude Code のログインを書き換えます。Para Code の外で使う Claude Code も含め、この PC で新しく起動する Claude Code はこのアカウントを使います。\n\nいま動いている Claude Code は、しばらくして読み直すまで前のアカウントのまま動くことがあります。確実に切り替えるには、Claude Code を起動し直してください。",
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
		this.reportSwitch(result, email, context.client.connectedToRemote);
		context.requestRefresh(false);
	}

	private reportSwitch(result: IParadisClaudeSwitchResult, email: string, remote: boolean): void {
		switch (result.outcome) {
			case 'switched':
				this.notificationService.info(localize('paradis.claudeAccounts.switched', "Claude のアカウントを {0} に切り替えました。いま動いている Claude Code は、起動し直すと確実に新しいアカウントを使います。", result.email ?? email));
				return;
			case 'already_active':
				this.notificationService.info(localize('paradis.claudeAccounts.alreadyActive', "すでに {0} を使っています。", result.email ?? email));
				return;
			case 'busy':
				this.notificationService.warn(localize('paradis.claudeAccounts.switchBusy', "ほかの切り替えが進行中です。終わってからもう一度お試しください。"));
				return;
			case 'unmanaged_live':
				this.notificationService.warn(remote
					? localize('paradis.claudeAccounts.unmanagedLiveRemote', "いま接続先でログインしている {0} は Para Code に登録されていないため、切り替えるとそのログインが失われます。先にそのアカウントのカードで「Para Code に登録」を押してください。", result.previousEmail ?? '')
					: localize('paradis.claudeAccounts.unmanagedLive', "いまこの PC でログインしている {0} は Para Code に登録されていないため、切り替えるとそのログインが失われます。先にそのアカウントのカードで「Para Code に登録」を押してください。", result.previousEmail ?? ''));
				return;
			case 'not_found':
				this.notificationService.error(localize('paradis.claudeAccounts.switchNotFound', "切り替え先のアカウントが見つかりません。一覧を更新してからもう一度お試しください。"));
				return;
			case 'no_credentials':
				this.notificationService.error(localize('paradis.claudeAccounts.switchNoCredentials', "{0} の保存済みの認証情報が使えません。カードの「再ログイン…」からログインし直してください。", result.email ?? email));
				return;
			case 'unverified':
				this.notificationService.warn(localize('paradis.claudeAccounts.switchUnverified', "いま使っている {0} の最新のログイン情報を確認できなかったため、切り替えませんでした。切り替えると、そのアカウントに再ログインが必要になるおそれがあります。通信できることを確かめ、しばらくしてからもう一度お試しください。", result.previousEmail ?? ''));
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
					this.notificationService.warn(context.client.connectedToRemote
						? localize('paradis.claudeAccounts.noLiveLoginRemote', "接続先の Claude にログインしていないため、登録できませんでした。接続先のターミナルで claude を起動してログインするか、「＋ アカウントを追加」を使ってください。")
						: localize('paradis.claudeAccounts.noLiveLogin', "この PC の Claude にログインしていないため、登録できませんでした。"));
					break;
				case 'not_oauth':
					this.notificationService.warn(localize('paradis.claudeAccounts.notOauth', "API キーでのログインは登録できません。Claude のサブスクリプションでログインしたアカウントだけ登録できます。"));
					break;
				case 'busy':
					this.notificationService.warn(localize('paradis.claudeAccounts.registerBusy', "アカウントの切り替え中です。終わってからもう一度お試しください。"));
					break;
				case 'unverified':
					this.notificationService.warn(localize('paradis.claudeAccounts.registerUnverified', "ログインしているアカウントを確認できなかったため、登録しませんでした。通信できることを確かめ、しばらくしてからもう一度お試しください。"));
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
