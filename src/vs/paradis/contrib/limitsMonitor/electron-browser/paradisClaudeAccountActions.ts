/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量パネルの Claude のアカウントカードに出す操作（paradisLimitsPanelContributions.ts の部品）。
//  - 登録していない、いまのログイン: 「Para Code に登録」（ブラウザでのログインなしで登録する）
//  - 登録した控えのアカウント: 「切り替える」（切替ボタンは使用量パネルの各カードに置く、
//    という決定）。この PC 全体の Claude のログインを書き換えるので、押したら確認し、動いている
//    Claude Code への影響を説明する
//  - 切り替えを断られたときは理由（通信・取得回数の上限・持ち主の不一致・ロック待ち）を分けて知らせ、
//    Sentry へも固定の語だけで送る。取得回数の上限なら待ち時間を知らせ、過ぎたら自動で1回やり直す
//    （利用者が別の操作をしたら取り消す）。切り替えた後は、前のアカウントのまま動いている Claude Code の
//    数をエージェントの検出（hook）から数えて知らせる
//  - 節の末尾: claude-swap に登録されていて Para Code にはまだ無いアカウントの一覧と、登録し直しの
//    案内（claude-swap のデータは読むだけ）。1文に縮め、注意書きと一覧は「詳しく」を開いたときだけ出す。
//    claude-swap の一覧がある間は「claude-swap はもう使わない」も出す（押すと案内ごと消える）

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisClaudeSwitchResult, paradisKnownUnverifiedReason } from '../common/paradisClaudeAccounts.js';
import { IParadisLimitsAccount, IParadisLimitsLegacyAccount, IParadisLimitsProviderSnapshot, paradisLimitsNeedsRelogin } from '../common/paradisLimitsMonitor.js';
import { IParadisLimitsPanelContext, IParadisLimitsPanelContribution, ParadisLimitsPanelContributions } from './paradisLimitsPanelContributions.js';

const $ = dom.$;

/** 取得回数の上限で断られたとき、待ち時間が分からなければこれだけ待ってやり直す。 */
const SWITCH_RETRY_DEFAULT_S = 60;
/** 待ち時間ちょうどだと再び断られやすいので、少し足す。 */
const SWITCH_RETRY_MARGIN_S = 5;
/** これより長く待つよう言われたら、自動のやり直しは予約しない（setTimeout の上限より十分短くする）。 */
const SWITCH_RETRY_MAX_S = 60 * 60;
/** 切り替えた後、動いている Claude Code の数を待つ上限。 */
const RUNNING_COUNT_TIMEOUT_MS = 5_000;

class ParadisClaudeAccountActions extends Disposable implements IParadisLimitsPanelContribution {

	readonly provider = 'claude';

	/** 押した後、結果が返るまで同じボタンを押せなくする（描き直しをまたいで持つ）。 */
	private registering = false;
	private switching = false;
	private retiringClaudeSwap = false;
	/** claude-swap の案内の「詳しく」を開いているか（描き直しをまたいで持つ）。 */
	private legacyDetailsOpen = false;

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IParadisAgentStatusSnapshotService private readonly agentStatusService: IParadisAgentStatusSnapshotService,
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
				: localize('paradis.claudeAccounts.switchAccount', "切り替える");
			button.disabled = this.switching;
			store.add(dom.addDisposableListener(button, 'click', () => void this.switchTo(account, context)));
		}
		return store;
	}

	renderProviderFooter(container: HTMLElement, providerSnapshot: IParadisLimitsProviderSnapshot, context: IParadisLimitsPanelContext): IDisposable | undefined {
		const legacy = providerSnapshot.legacyAccounts ?? [];
		if (legacy.length === 0 && !providerSnapshot.claudeSwapPresent) {
			return undefined;
		}
		const store = new DisposableStore();
		if (legacy.length > 0) {
			store.add(this.renderLegacyNotice(container, legacy, context));
		}
		if (providerSnapshot.claudeSwapPresent) {
			const button = dom.append(container, $('button.plm-card-action-link.plm-legacy-retire')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = localize('paradis.claudeAccounts.retireClaudeSwap', "claude-swap はもう使わない");
			button.disabled = this.retiringClaudeSwap;
			store.add(dom.addDisposableListener(button, 'click', () => void this.retireClaudeSwap(context)));
		}
		return store;
	}

	private renderLegacyNotice(container: HTMLElement, legacy: readonly IParadisLimitsLegacyAccount[], context: IParadisLimitsPanelContext): IDisposable {
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
			// メールを番号に置き換えているときは、メールを含みうる組織名も出さない。
			const name = context.displayNameForEmail('claude', account.email);
			dom.append(list, $('li')).textContent = account.organizationName && name === account.email
				? localize('paradis.claudeAccounts.legacyWithOrganization', "{0}（{1}）", account.email, account.organizationName)
				: name;
		}
		return dom.addDisposableListener(details, 'toggle', () => {
			this.legacyDetailsOpen = details.open;
		});
	}

	/**
	 * 動いている Claude Code の数（エージェントの検出が hook から控えている、Claude の会話があるペイン）。
	 * 切り替える前に起動したものは、開き直すまで前のアカウントのまま動く。ペインから ssh した先の会話は
	 * 手元のログインを使わないので数えない。数えられなければ undefined。
	 */
	private countRunningClaudeCode(): Promise<number | undefined> {
		return new Promise(resolve => {
			let done = false;
			const store = new DisposableStore();
			const finish = (count: number | undefined) => {
				if (!done) {
					done = true;
					store.dispose();
					resolve(count);
				}
			};
			const timer = setTimeout(() => finish(undefined), RUNNING_COUNT_TIMEOUT_MS);
			store.add(toDisposable(() => clearTimeout(timer)));
			// 最後に取れた値があれば subscribe の中ですぐ届く（その場合は返ってきた購読をすぐ捨てる）。
			const subscription = this.agentStatusService.subscribe(outcome => {
				const sessions = outcome.snapshot?.paneSessions;
				if (sessions !== undefined) {
					finish(new Set(sessions.filter(session => session.agent === 'claude' && !session.remote).map(session => session.token)).size);
				}
			});
			if (done) {
				subscription.dispose();
			} else {
				store.add(subscription);
			}
		});
	}

	private async retireClaudeSwap(context: IParadisLimitsPanelContext): Promise<void> {
		if (this.retiringClaudeSwap) {
			return;
		}
		const { confirmed } = await this.dialogService.confirm({
			message: localize('paradis.claudeAccounts.retireClaudeSwapConfirm', "claude-swap をもう使わないことにしますか？"),
			detail: localize(
				'paradis.claudeAccounts.retireClaudeSwapDetail',
				"claude-swap にも登録されているアカウントのログインも Para Code が更新し、使用量を表示し続けます。この後 claude-swap でそのアカウントに切り替えると、claude-swap でログインし直しが要ることがあります。claude-swap のデータは書き換えません。",
			),
			primaryButton: localize('paradis.claudeAccounts.retireClaudeSwapButton', "使わない"),
		});
		if (!confirmed) {
			return;
		}
		// 別の操作をしたので、予約していた切り替えのやり直しはやめる。
		context.cancelRetry();
		this.retiringClaudeSwap = true;
		context.redraw();
		try {
			await context.client.retireClaudeSwap();
		} catch {
			this.notificationService.error(localize('paradis.claudeAccounts.retireClaudeSwapFailed', "設定を保存できませんでした。もう一度お試しください。"));
		} finally {
			this.retiringClaudeSwap = false;
		}
		context.requestRefresh(false);
	}

	private async switchTo(account: IParadisLimitsAccount, context: IParadisLimitsPanelContext): Promise<void> {
		if (this.switching) {
			return;
		}
		const email = context.displayName(account);
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
		// 前に断られて予約していた自動のやり直しは、この操作で置き換える。
		context.cancelRetry();
		await this.runSwitch(account, context, false);
	}

	/** @param retried 取得回数の上限で断られた後の、自動のやり直しか。 */
	private async runSwitch(account: IParadisLimitsAccount, context: IParadisLimitsPanelContext, retried: boolean): Promise<void> {
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
		await this.reportSwitch(account, result, context, retried);
		context.requestRefresh(false);
	}

	/** 断った理由を Sentry へ送る（固定の語だけ。メールやトークンは送らない）。 */
	private reportRefusal(result: IParadisClaudeSwitchResult, remote: boolean, retried: boolean): void {
		// 接続先から返った値なので、知っている語のほかは 'unknown' に畳む。
		const reason = result.outcome === 'locked' ? 'lock_wait' : paradisKnownUnverifiedReason(result.unverifiedReason) ?? 'unknown';
		reportParadisDiagnosticError('owned', 'claude-accounts', 'switch-refused', new Error(`Claude account switch refused: ${reason}`), {
			safe_outcome: result.outcome,
			safe_reason: reason,
			safe_remote: remote,
			safe_retried: retried,
		}, 'warning');
	}

	private async reportSwitch(account: IParadisLimitsAccount, result: IParadisClaudeSwitchResult, context: IParadisLimitsPanelContext, retried: boolean): Promise<void> {
		const remote = context.client.connectedToRemote;
		const previous = result.previousEmail !== undefined ? context.displayNameForEmail('claude', result.previousEmail) : '';
		// 切り替え先は、返ってきたメール（無ければ押したカードの名前）。押したカードと同じメールなら、カードの名前を使う
		// （同じメールで組織が違うアカウントがあると、メールからは番号を決められないため）。予約したやり直しの間に
		// メールを番号に置き換える設定へ変わることがあるので、名前はこの時点で引き直す。
		const target = result.email === undefined || result.email.toLowerCase() === account.email?.toLowerCase() ? context.displayName(account) : context.displayNameForEmail('claude', result.email);
		switch (result.outcome) {
			case 'switched': {
				// 接続先の Claude Code は手元から数えられないので、手元を切り替えたときだけ数える。
				const running = remote ? undefined : await this.countRunningClaudeCode();
				const name = target;
				this.notificationService.info(running !== undefined && running > 0
					? retried
						? localize('paradis.claudeAccounts.switchedAfterRetryWithRunning', "自動でもう一度試し、Claude のアカウントを {0} に切り替えました。開いている Claude Code {1} 個は前のアカウントのまま動いています。開き直すと切り替わります。", name, running)
						: localize('paradis.claudeAccounts.switchedWithRunning', "Claude のアカウントを {0} に切り替えました。開いている Claude Code {1} 個は前のアカウントのまま動いています。開き直すと切り替わります。", name, running)
					: running === 0
						? retried
							? localize('paradis.claudeAccounts.switchedAfterRetryNoneRunning', "自動でもう一度試し、Claude のアカウントを {0} に切り替えました。", name)
							: localize('paradis.claudeAccounts.switchedNoneRunning', "Claude のアカウントを {0} に切り替えました。", name)
						: retried
							? localize('paradis.claudeAccounts.switchedAfterRetry', "自動でもう一度試し、Claude のアカウントを {0} に切り替えました。いま動いている Claude Code は、起動し直すと確実に新しいアカウントを使います。", name)
							: localize('paradis.claudeAccounts.switched', "Claude のアカウントを {0} に切り替えました。いま動いている Claude Code は、起動し直すと確実に新しいアカウントを使います。", name));
				return;
			}
			case 'already_active':
				this.notificationService.info(localize('paradis.claudeAccounts.alreadyActive', "すでに {0} を使っています。", target));
				return;
			case 'busy':
				this.notificationService.warn(localize('paradis.claudeAccounts.switchBusy', "ほかの切り替えが進行中です。終わってからもう一度お試しください。"));
				return;
			case 'unmanaged_live':
				this.notificationService.warn(remote
					? localize('paradis.claudeAccounts.unmanagedLiveRemote', "いま接続先でログインしている {0} は Para Code に登録されていないため、切り替えるとそのログインが失われます。先にそのアカウントのカードで「Para Code に登録」を押してください。", previous)
					: localize('paradis.claudeAccounts.unmanagedLive', "いまこの PC でログインしている {0} は Para Code に登録されていないため、切り替えるとそのログインが失われます。先にそのアカウントのカードで「Para Code に登録」を押してください。", previous));
				return;
			case 'not_found':
				this.notificationService.error(localize('paradis.claudeAccounts.switchNotFound', "切り替え先のアカウントが見つかりません。一覧を更新してからもう一度お試しください。"));
				return;
			case 'no_credentials':
				this.notificationService.error(localize('paradis.claudeAccounts.switchNoCredentials', "{0} の保存済みの認証情報が使えません。カードの「再ログイン…」からログインし直してください。", target));
				return;
			case 'unverified': {
				this.reportRefusal(result, remote, retried);
				switch (paradisKnownUnverifiedReason(result.unverifiedReason)) {
					case 'rate_limited': {
						if (retried) {
							this.notificationService.warn(localize('paradis.claudeAccounts.switchRateLimitedAgain', "自動でもう一度試しましたが、いま使っている {0} のログイン情報の確認の回数がまだ上限のため、切り替えませんでした。しばらくしてから切り替えてください。", previous));
							return;
						}
						const waitS = (result.retryAfterS ?? SWITCH_RETRY_DEFAULT_S) + SWITCH_RETRY_MARGIN_S;
						if (!(waitS <= SWITCH_RETRY_MAX_S)) {
							this.notificationService.warn(localize('paradis.claudeAccounts.switchRateLimitedLong', "いま使っている {0} のログイン情報の確認の回数が上限に達したため、切り替えませんでした。しばらくしてからもう一度お試しください。", previous));
							return;
						}
						this.notificationService.warn(localize('paradis.claudeAccounts.switchRateLimited', "いま使っている {0} のログイン情報の確認の回数が上限に達したため、切り替えませんでした。{1}分後に切り替えられます。その時刻を過ぎたら、自動でもう一度切り替えます（ほかの操作をしたら取り消します）。", previous, Math.ceil(waitS / 60)));
						context.scheduleRetry(waitS * 1000, () => void this.runSwitch(account, context, true));
						return;
					}
					case 'network':
						this.notificationService.warn(localize('paradis.claudeAccounts.switchUnverifiedNetwork', "通信できず、いま使っている {0} の最新のログイン情報を確認できなかったため、切り替えませんでした。切り替えると、そのアカウントに再ログインが必要になるおそれがあります。通信できることを確かめてから、もう一度お試しください。", previous));
						return;
					case 'owner_mismatch':
						this.notificationService.warn(localize('paradis.claudeAccounts.switchUnverifiedOwner', "いま使っている {0} のログインが確かめている間に変わったか、持ち主を確かめられなかったため、切り替えませんでした。切り替えると、そのアカウントに再ログインが必要になるおそれがあります。しばらくしてからもう一度お試しください。", previous));
						return;
					default:
						this.notificationService.warn(localize('paradis.claudeAccounts.switchUnverified', "いま使っている {0} の最新のログイン情報を確認できなかったため、切り替えませんでした。切り替えると、そのアカウントに再ログインが必要になるおそれがあります。通信できることを確かめ、しばらくしてからもう一度お試しください。", previous));
						return;
				}
			}
			case 'locked':
				this.reportRefusal(result, remote, retried);
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
		context.cancelRetry();
		this.registering = true;
		try {
			const result = await context.client.registerLiveClaudeAccount();
			switch (result.outcome) {
				case 'registered':
				case 'updated':
					this.notificationService.info(localize('paradis.claudeAccounts.registered', "{0} を Para Code に登録しました。", result.email !== undefined ? context.displayNameForEmail('claude', result.email) : ''));
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
