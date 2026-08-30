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
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	IParadisLimitsAccount,
	IParadisLimitsSnapshot,
	IParadisLimitsWindow,
	paradisLimitsFormatCountdown,
	paradisLimitsNeedsRelogin,
	paradisLimitsSeverity,
	paradisLimitsWorstPercent,
	ParadisLimitsProvider,
	ParadisLimitsSeverity
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

/** 「一覧から隠した」アカウントID(account.id)の配列をJSONで保持するストレージキー。 */
const PARADIS_LIMITS_HIDDEN_ACCOUNTS_STORAGE_KEY = 'paradis.limitsMonitor.hiddenAccountIds';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** リングのホバーに出す1行の状態説明（パネルの説明文より短く保つ）。 */
function paradisLimitsStatusSummary(account: IParadisLimitsAccount): string {
	switch (account.status) {
		case 'refreshing':
			return localize('paradis.limitsMonitor.tooltipRefreshing', "トークンを更新中（操作は要りません）");
		case 'unavailable':
			return account.unavailableReason === 'api_key'
				? localize('paradis.limitsMonitor.tooltipApiKey', "APIキー利用のため使用状況はありません")
				: localize('paradis.limitsMonitor.tooltipUnavailable', "使用状況を取得できていません");
		case 'relogin_required':
			return localize('paradis.limitsMonitor.tooltipRelogin', "再ログインが必要です");
		case 'no_credentials':
			return localize('paradis.limitsMonitor.tooltipNoCredentials', "認証情報がありません");
		default:
			return account.statusDetail ?? localize('paradis.limitsMonitor.tooltipFetchFailed', "使用状況を取得できませんでした");
	}
}

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
	private refreshRequested = false;
	private readonly removingHomes = new Set<string>();
	/**
	 * 一覧から個別に隠したアカウントの台帳。真の保持者はここ(永続化もここ)。
	 *
	 * account.id だけをキーにしない: Codexのidはホームの絶対パス、Claudeはcswapの
	 * スロット番号で、どちらも削除された分は次のアカウント追加やスロット再利用で
	 * 別のアカウントに再割り当てされ得る(node/paradisLimitsMonitorChannel.ts)。
	 * 非表示にした時点のemailも一緒に持ち、一致するときだけ非表示を適用することで、
	 * 「同じidだが中身は別アカウント」になった行を自動的に復帰させる。
	 */
	private readonly hiddenAccounts = new Map<string, string | undefined>();

	constructor(
		container: HTMLElement,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHoverService private readonly hoverService: IHoverService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.loadHiddenAccountIds();
		// 同じプロファイルを2ウィンドウで開いていると、この台帳は両方から見える。片方だけが
		// メモリ上のMapを持ち続けると、後から書き込んだ方が先勝ちで上書きし、相手が隠した分を
		// 消してしまう(paradisPresetServiceのlocallyHiddenWorkspacePresetsと同じ理由)。
		// external=falseは自分のsaveHiddenAccountIds()による発火(store()は同期発火するため、
		// 素通しするとトグル操作のたびに自分自身のクリックハンドラ内でパネルが二重に
		// 作り直される)。他ウィンドウ発の変更(external=true)だけを取り込む。
		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, PARADIS_LIMITS_HIDDEN_ACCOUNTS_STORAGE_KEY, this._store)(e => {
			if (!e.external) {
				return;
			}
			this.loadHiddenAccountIds();
			if (this.latestSnapshot) {
				this.renderTrigger(this.latestSnapshot);
				this.panel.value?.updateSnapshot(this.latestSnapshot);
			}
		}));
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

	private loadHiddenAccountIds(): void {
		// 外部変更(他ウィンドウの書き込み)を取り込む再読み込みでも呼ぶため、まず現在の内容を捨てる。
		this.hiddenAccounts.clear();
		const raw = this.storageService.get(PARADIS_LIMITS_HIDDEN_ACCOUNTS_STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return;
		}
		try {
			const entries: unknown = JSON.parse(raw);
			if (Array.isArray(entries)) {
				for (const entry of entries) {
					if (typeof entry === 'string') {
						// 旧形式(id文字列のみ)からの移行。emailは分からないのでundefinedのまま扱う。
						this.hiddenAccounts.set(entry, undefined);
					} else if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
						this.hiddenAccounts.set(entry.id, typeof entry.email === 'string' ? entry.email : undefined);
					}
				}
			}
		} catch {
			// 壊れた値は無視する(全アカウント表示側に倒す。非表示状態を失うだけで実害はない)
		}
	}

	private saveHiddenAccountIds(): void {
		// Codexの account.id はホームの絶対パス(例: /Users/<user>/.codex-2)で、マシン固有。
		// StorageTarget.USERはSettings Syncの対象になるため、他マシンでは無関係な非表示設定
		// やゴミが乗ってしまう。MACHINEにして同期対象から外す。
		const entries = [...this.hiddenAccounts.entries()].map(([id, email]) => ({ id, email }));
		this.storageService.store(
			PARADIS_LIMITS_HIDDEN_ACCOUNTS_STORAGE_KEY,
			JSON.stringify(entries),
			StorageScope.PROFILE,
			StorageTarget.MACHINE,
		);
	}

	/**
	 * account.id が非表示にした時点と同じアカウントを指しているか。
	 *
	 * id(ホームパス/スロット番号)は削除→再利用で別アカウントに割り当てられ得るため、
	 * 非表示にした時点のemailと食い違ったら「もう同じアカウントではない」とみなし、
	 * 台帳から明示的に消さなくても自動的に非表示を解く。
	 *
	 * ただし両方のemailが分かっているときだけ不一致を見る: node/paradisLimitsMonitorChannel.ts
	 * の fetchCodexAccount は auth.json が読めない('error')・アクセストークンが無い
	 * ('no_credentials')場合、同じidのままemailを載せずに返す。片方(または両方)が
	 * undefinedなだけで「別アカウントになった」と誤判定すると、トークン読み取りが
	 * 一時的にこけただけ・ログアウトしただけで、隠していたはずの行が勝手に復活する。
	 */
	private isAccountHidden(account: IParadisLimitsAccount): boolean {
		if (!this.hiddenAccounts.has(account.id)) {
			return false;
		}
		const hiddenEmail = this.hiddenAccounts.get(account.id);
		return hiddenEmail === undefined || account.email === undefined || hiddenEmail === account.email;
	}

	/** パネル(削除ボタンの隣の目アイコン)・非表示中リスト双方から呼ばれる、非表示状態の唯一の変更点。 */
	private toggleHiddenAccount(account: IParadisLimitsAccount): void {
		if (this.isAccountHidden(account)) {
			this.hiddenAccounts.delete(account.id);
		} else {
			this.hiddenAccounts.set(account.id, account.email);
		}
		this.saveHiddenAccountIds();
		if (this.latestSnapshot) {
			this.renderTrigger(this.latestSnapshot);
			this.panel.value?.updateSnapshot(this.latestSnapshot);
		}
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
			onRemoveAccount: account => void this.removeAccount(account),
			isAccountHidden: account => this.isAccountHidden(account),
			onToggleHiddenAccount: account => this.toggleHiddenAccount(account),
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

	private async removeAccount(account: IParadisLimitsAccount): Promise<void> {
		if (account.provider !== 'codex' || !account.removable || this.removingHomes.has(account.id)) {
			return;
		}
		this.removingHomes.add(account.id);
		try {
			const accountName = account.email ?? localize('paradis.limitsMonitor.unknownAccount', "不明なアカウント");
			const homeLabel = account.homeLabel ?? account.id;
			const remote = this.client.connectedToRemote;
			const { confirmed } = await this.dialogService.confirm({
				message: localize('paradis.limitsMonitor.removeConfirm', "このCodexアカウントを削除しますか？"),
				detail: remote
					? localize(
						'paradis.limitsMonitor.removeDetailPermanent',
						"{0} ({1}) の認証情報、設定、セッション履歴を含むホーム全体を接続先マシン上で完全に削除します。利用中のCodexプロセスに影響する可能性があります。リモートにはゴミ箱がないため復元できません。",
						accountName,
						homeLabel,
					)
					: localize(
						'paradis.limitsMonitor.removeDetail',
						"{0} ({1}) の認証情報、設定、セッション履歴を含むホーム全体をゴミ箱へ移動します。利用中のCodexプロセスに影響する可能性があります。ゴミ箱から復元できます。",
						accountName,
						homeLabel,
					),
				primaryButton: remote
					? localize('paradis.limitsMonitor.removePermanently', "完全に削除")
					: localize('paradis.limitsMonitor.moveToTrash', "ゴミ箱へ移動"),
			});
			if (!confirmed) {
				return;
			}
			await this.client.removeCodexHome(account.id, remote);
			// account.id(ホームパス)は次の追加で再利用され得る。email不一致で自動的に非表示は
			// 解けるが、email不明のまま隠していた場合の保険としてここでも明示的に落としておく。
			if (this.hiddenAccounts.delete(account.id)) {
				this.saveHiddenAccountIds();
			}
			await this.poll(true);
		} catch (error) {
			this.logService.error('[ParadisLimitsMonitor] Failed to remove Codex home', error);
			this.notificationService.error(this.client.connectedToRemote
				? localize('paradis.limitsMonitor.removeFailedPermanent', "Codexアカウントを削除できませんでした。もう一度お試しください。")
				: localize('paradis.limitsMonitor.removeFailed', "Codexアカウントをゴミ箱へ移動できませんでした。もう一度お試しください。"));
		} finally {
			this.removingHomes.delete(account.id);
		}
	}

	private async poll(force: boolean): Promise<void> {
		// アイドルポーリングはウィンドウ不可視中スキップ(resourceMonitorと同じ)。復帰は
		// visibilitychange購読と次tickのhidden判定で担保される
		if (!force && !this.panel.value && dom.getDocument(this.button).hidden) {
			return;
		}
		if (this.isFetching) {
			if (force) {
				this.refreshRequested = true;
			}
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
			if (this.refreshRequested) {
				this.refreshRequested = false;
				void this.poll(true);
			}
		}
	}

	private renderTrigger(snapshot: IParadisLimitsSnapshot): void {
		this.ringDisposables.clear();
		dom.clearNode(this.button);

		this.renderProvider('claude', snapshot.claude.accounts);
		this.renderProvider('codex', snapshot.codex.accounts);
		const allAccounts = [...snapshot.claude.accounts, ...snapshot.codex.accounts];
		const visibleAccounts = allAccounts.filter(account => !this.isAccountHidden(account));
		this.updateTriggerAria(visibleAccounts, allAccounts.length - visibleAccounts.length);

		if (this.button.childElementCount === 0) {
			// アカウントが1件も取得できていない場合と、取得できているが全部を非表示に
			// している場合の両方でここに来る(完全に空だとクリック面が消えてパネルから
			// 設定状況を確認できなくなるため、最低限のプレースホルダーは常に必要)。
			// 見分けはupdateTriggerAriaが付けるaria-labelの「非表示 N件」で付く。
			appendParadisLimitsLogo(this.button, 'claude');
			appendParadisLimitsLogo(this.button, 'codex');
		}
	}

	/**
	 * 状態を色と記号だけで伝えていたので、同じ内容をボタンの名前にも載せる。
	 *
	 * リング1つずつに aria-label を付けても、フォーカスできるのはボタンだけで、そのボタンが
	 * 自前の aria-label を持つ以上は読み上げられない（子孫のテキストは名前に使われない）。
	 * 使用率は再描画間隔ぶん古くなりうるので、数値より状態を先に読ませる。
	 */
	private updateTriggerAria(accounts: readonly IParadisLimitsAccount[], hiddenCount: number): void {
		const base = localize('paradis.limitsMonitor.triggerAria', "AI利用リミット");
		const summaries = accounts.map(account => {
			const name = account.email ?? account.homeLabel ?? account.id;
			if (account.status !== 'ok') {
				return `${name}: ${paradisLimitsStatusSummary(account)}`;
			}
			const worst = paradisLimitsWorstPercent(account);
			return worst === undefined
				? name
				: localize('paradis.limitsMonitor.triggerAriaAccount', "{0}: 最大{1}%使用", name, Math.round(worst));
		});
		if (hiddenCount > 0) {
			summaries.push(localize('paradis.limitsMonitor.triggerAriaHidden', "非表示 {0}件", hiddenCount));
		}
		this.button.setAttribute('aria-label', [base, ...summaries].join('、'));
	}

	private renderProvider(provider: ParadisLimitsProvider, accounts: readonly IParadisLimitsAccount[]): void {
		const visibleAccounts = accounts.filter(account => !this.isAccountHidden(account));
		if (visibleAccounts.length === 0) {
			return;
		}
		appendParadisLimitsLogo(this.button, provider);
		for (const account of visibleAccounts) {
			this.renderRing(account);
		}
	}

	private renderRing(account: IParadisLimitsAccount): void {
		const worst = paradisLimitsWorstPercent(account);
		// 'unavailable'（読めていないだけ。制限に達したアカウントはリセットまで再取得が止まる）と
		// 'refreshing'（Claude Codeが自動で更新する）は壊れていないので、赤い「!」ではなく
		// 灰色の「?」で示す。
		const hasError = paradisLimitsNeedsRelogin(account.status);
		const isUnknown = !hasError && account.status !== 'ok';
		let severity: ParadisLimitsSeverity | 'error' | 'unknown';
		if (hasError) {
			severity = 'error';
		} else if (isUnknown) {
			severity = 'unknown';
		} else {
			severity = paradisLimitsSeverity(worst ?? 0);
		}

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

		if (hasError || isUnknown) {
			const mark = document.createElementNS(SVG_NS, 'text');
			mark.setAttribute('x', '10');
			mark.setAttribute('y', '14');
			mark.setAttribute('text-anchor', 'middle');
			mark.classList.add(isUnknown ? 'paradis-limits-ring-unknown-mark' : 'paradis-limits-ring-error-mark');
			mark.textContent = isUnknown ? '?' : '!';
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

		// 個々のリングはフォーカスできず、ボタン側に aria-label がある以上、svgに名前を付けても
		// 読み上げられない。状態はボタンのラベルへ畳み込む（renderTrigger）。
		svg.setAttribute('aria-hidden', 'true');

		this.button.appendChild(svg);
		// 関数で渡してホバー時に評価する。文字列を確定させると、リングの再描画間隔
		// （パネル非表示中は120秒）まで固定され、分単位のカウントダウンが最大2分ズレる。
		this.ringDisposables.add(this.hoverService.setupManagedHover(this.hoverDelegate, svg as unknown as HTMLElement, () => this.ringTooltip(account)));
	}

	/**
	 * ホバーだけで各枠の使用率とリセットまでの時間が読めるようにする。
	 * 以前は使用率しか無く、「あと何分待てば5時間枠が空くか」を知るのに毎回パネルを開く
	 * 必要があった。なお表示はポーリング間隔ぶん（パネル非表示中は120秒）古くなりうる。
	 */
	private ringTooltip(account: IParadisLimitsAccount): string {
		const name = account.email ?? account.homeLabel ?? account.id;
		if (account.status !== 'ok') {
			return `${name} — ${paradisLimitsStatusSummary(account)}`;
		}
		const now = Date.now();
		const describe = (window: IParadisLimitsWindow): string => {
			const percent = Math.round(window.usedPercent);
			const countdown = paradisLimitsFormatCountdown(window.resetsAt, now);
			return countdown !== undefined
				? localize('paradis.limitsMonitor.tooltipWindowReset', "{0}%（{1}後）", percent, countdown)
				: localize('paradis.limitsMonitor.tooltipWindow', "{0}%", percent);
		};
		const parts: string[] = [];
		if (account.fiveHour) {
			parts.push(localize('paradis.limitsMonitor.tooltipWindow5h', "5時間 {0}", describe(account.fiveHour)));
		}
		if (account.sevenDay) {
			parts.push(localize('paradis.limitsMonitor.tooltipWindow7d', "7日 {0}", describe(account.sevenDay)));
		}
		for (const scoped of account.scoped ?? []) {
			parts.push(`${scoped.label ?? '?'} ${describe(scoped)}`);
		}
		return parts.length > 0 ? `${name} — ${parts.join(' · ')}` : name;
	}
}
