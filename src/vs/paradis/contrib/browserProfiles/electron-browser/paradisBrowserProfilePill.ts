/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ナビバーの「今どのプロファイルか」ピル（承認済みモック 2-3.html の①）。
//
// upstream のファイルには触らず、公開されている拡張点だけで足している:
//  - `BrowserEditor.registerContribution()`（public static）で contribution を登録
//  - `BrowserWidgetLocation.PostUrl`（URL ボックス内の右端）へウィジェットを1つ出す
//
// モックとの意図的な差分: モックではピルが URL ボックスの**外**にあるが、upstream の navbar は
// PreUrl / PostUrl のどちらも URL ボックスの**内側**に固定で置く。外へ出すには upstream の
// navbar の DOM へ直接差し込むしかなく、upstream 側の DOM 変更で無言で壊れる。見た目より
// 壊れないことを優先して内側に置いている。
//
// 「今どのプロファイルか」の権威は main（実際に紐付いた Electron セッション）。ここでは
// 同期に分かる範囲をまず描き、main の答えが返ったら描き直す。

import * as dom from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IParadisAgentBrowserBindingModel } from '../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { ParadisBrowserProfileDropdown } from './paradisBrowserProfileDropdown.js';
import { paradisShowCreateProfileDialog, paradisShowManageProfilesDialog } from './paradisBrowserProfileDialogs.js';
import { IParadisBrowserProfilesService, ParadisProfileTarget } from './paradisBrowserProfilesService.js';

const $ = dom.$;

/**
 * URL ボックス内での並び順。共有トグル (50)・ブックマークの星 (60)・倍率 (90)・タブ pill (100)
 * が同じ入れ物にいる。プロファイルは「どのログイン状態で見ているか」という、押す前に必ず
 * 知りたい情報なので、狭いときに最後まで残るよう一番手前に置く。
 */
const WIDGET_ORDER = 40;

/** ピルに出す名前の最大長。溢れる分は省略記号にして、ホバーでフル名を出す。 */
const MAX_NAME_LENGTH = 10;

export class ParadisBrowserProfilePill extends BrowserEditorContribution {

	private readonly _element: HTMLElement;
	private readonly _dotElement: HTMLElement;
	private readonly _iconElement: HTMLElement;
	private readonly _nameElement: HTMLElement;
	private readonly _badgeElement: HTMLElement;
	private readonly _hover: IManagedHover;
	private readonly _dropdown = this._register(new MutableDisposable<ParadisBrowserProfileDropdown>());

	constructor(
		editor: BrowserEditor,
		@IParadisBrowserProfilesService private readonly profilesService: IParadisBrowserProfilesService,
		@IParadisAgentBrowserBindingModel private readonly bindingModel: IParadisAgentBrowserBindingModel,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IHoverService hoverService: IHoverService,
	) {
		super(editor);

		this._element = $('button.paradis-browser-profile-pill');
		this._element.setAttribute('aria-haspopup', 'listbox');
		this._element.setAttribute('aria-expanded', 'false');
		this._dotElement = dom.append(this._element, $('.pbp-pill-dot'));
		this._iconElement = dom.append(this._element, $(`.pbp-pill-icon${ThemeIcon.asCSSSelector(Codicon.globe)}`));
		this._nameElement = dom.append(this._element, $('.pbp-pill-name'));
		this._badgeElement = dom.append(this._element, $('.pbp-pill-badge'));
		dom.append(this._element, $(`.pbp-pill-chevron${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));

		this._hover = this._register(hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this._element, ''));
		this._register(dom.addDisposableListener(this._element, dom.EventType.CLICK, () => this._toggleDropdown()));

		this._register(this.profilesService.onDidChangeProfiles(() => this._render()));
		// エージェントが操作を始めた / やめたときにバッジを出し入れする。
		this._register(this.bindingModel.onDidChange(() => this._render()));

		this._render();
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [{ location: BrowserWidgetLocation.PostUrl, element: this._element, order: WIDGET_ORDER }];
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		// 別のタブへ切り替わった（＝モデルが差し替わった）。前のタブの内容を映したままの
		// ドロップダウンを残すと、そこで選んだ瞬間に「今のタブ」が差し替わってしまう。
		this._dropdown.clear();
		this._render();
		// main の答えが権威。同期に分かる分を先に描いてから、確定した内容で描き直す。
		void this.profilesService.resolveViewSession(model.id).then(() => {
			if (!store.isDisposed) {
				this._render();
			}
		});
	}

	override onModelDetached(): void {
		this._dropdown.clear();
		this._render();
	}

	// #region 描画

	private _render(): void {
		const model = this.editor.model;
		const session = model ? this.profilesService.getViewSession(model.id) : undefined;
		const profile = session?.profileId !== undefined
			? this.profilesService.list().find(candidate => candidate.id === session.profileId)
			: undefined;

		// ページがまだ無い間も枠は残す。display を切ると URL バーの高さが一瞬変わってガタつく。
		this._element.classList.toggle('is-detached', model === undefined);

		const named = profile !== undefined;
		this._dotElement.style.display = named ? '' : 'none';
		this._iconElement.style.display = named ? 'none' : '';
		this._element.classList.toggle('is-named', named);
		if (profile) {
			this._dotElement.style.backgroundColor = profile.color;
		}

		const fullName = profile ? profile.name : this._scopeLabel(session?.scope);
		this._nameElement.textContent = paradisEllipsize(fullName, MAX_NAME_LENGTH);

		const agentControlled = model !== undefined && this.bindingModel.getBindingsForPage(model.id).length > 0;
		this._element.classList.toggle('agent-controlled', agentControlled);
		this._badgeElement.style.display = agentControlled ? '' : 'none';
		this._badgeElement.textContent = agentControlled ? localize('paradis.browserProfiles.pill.agent', "Agent操作中") : '';

		const description = profile
			? localize('paradis.browserProfiles.pill.namedHover', "ブラウザプロファイル「{0}」。Cookie と LocalStorage はこのプロファイルに保存され、次に開いたときも残ります。", fullName)
			: localize('paradis.browserProfiles.pill.scopeHover', "ブラウザの保存スコープ: {0}", fullName);
		this._hover.update(agentControlled
			? localize('paradis.browserProfiles.pill.hoverWithAgent', "{0}\nこのページはエージェントが操作中です。", description)
			: description);
		this._element.setAttribute('aria-label', localize('paradis.browserProfiles.pill.aria', "{0} 変更するには選択してください。", description));
	}

	private _scopeLabel(scope: string | undefined): string {
		switch (scope) {
			case BrowserViewStorageScope.Workspace:
				return localize('paradis.browserProfiles.scope.workspace', "ワークスペース");
			case BrowserViewStorageScope.Ephemeral:
				return localize('paradis.browserProfiles.scope.ephemeral', "エフェメラル");
			case BrowserViewStorageScope.Global:
				return localize('paradis.browserProfiles.scope.global', "グローバル");
			default:
				// main へまだ問い合わせられていない（起動直後）。空にすると幅が動くので既定を出す。
				return localize('paradis.browserProfiles.scope.global', "グローバル");
		}
	}

	// #endregion

	// #region 操作

	private _toggleDropdown(): void {
		if (this._dropdown.value) {
			this._dropdown.clear();
			return;
		}
		const model = this.editor.model;
		this._dropdown.value = this.instantiationService.createInstance(ParadisBrowserProfileDropdown, {
			anchor: this._element,
			current: model ? this.profilesService.getViewSession(model.id) : undefined,
			profiles: this.profilesService.list(),
			agentProfileIds: this._activeAgentProfiles(),
			profilesEnabled: this.profilesService.canUseProfiles(),
			onSelect: target => {
				this._dropdown.clear();
				void this._switchTo(target);
			},
			onCreate: () => {
				this._dropdown.clear();
				paradisShowCreateProfileDialog(this.instantiationService, profile => void this._switchTo({ kind: 'profile', profileId: profile.id }));
			},
			onManage: () => {
				this._dropdown.clear();
				paradisShowManageProfilesDialog(this.instantiationService);
			},
		});
	}

	/** 今エージェントが操作しているページのプロファイル（ドロップダウンの補足表示用）。 */
	private _activeAgentProfiles(): ReadonlySet<string> {
		const profileIds = new Set<string>();
		for (const binding of this.bindingModel.bindings) {
			const profileId = this.profilesService.getProfileForView(binding.pageId);
			if (profileId !== undefined) {
				profileIds.add(profileId);
			}
		}
		return profileIds;
	}

	/**
	 * 選ばれたプロファイル／スコープへ切り替える。
	 *
	 * Electron のセッションはビューの構築時に固定されるため、実体は「同じ位置に新しいタブを
	 * 差し替える」ことになる。URL は引き継ぐが、ログイン状態が違えば同じ画面が出るとは限らない。
	 * ここを黙ってやると「勝手にログアウトされた」ように見えるので、必ず知らせる。
	 */
	private async _switchTo(target: ParadisProfileTarget): Promise<void> {
		const input = this.editor.input;
		if (!(input instanceof BrowserEditorInput)) {
			return;
		}
		const current = this.editor.model ? this.profilesService.getViewSession(this.editor.model.id) : undefined;
		if (target.kind === 'profile' && current?.profileId === target.profileId) {
			return;
		}
		if (target.kind === 'scope' && current?.profileId === undefined && current?.scope === target.scope) {
			return;
		}
		const replacement = await this.profilesService.switchView(input, target);
		if (!replacement) {
			this.notificationService.notify({
				severity: Severity.Warning,
				message: localize('paradis.browserProfiles.switchFailed', "ブラウザのプロファイルを切り替えられませんでした。"),
			});
			return;
		}
		const name = target.kind === 'profile'
			? this.profilesService.list().find(profile => profile.id === target.profileId)?.name ?? ''
			: this._scopeLabel(target.scope);
		const base = localize(
			'paradis.browserProfiles.switched',
			"「{0}」で開き直しました。ログイン状態が切り替え前とは違うため、同じページが表示されるとは限りません。",
			name,
		);
		// リモート接続中は名前付きプロファイルがウィンドウ毎の転送プロキシを使わない
		// （グローバルと同じ扱い。他のウィンドウへ転送を漏らさないため）。その結果 localhost:3000 の
		// ような転送ポートへ届かなくなるので、黙って繋がらなくなる前に伝える。
		const losesForwardedPorts = target.kind === 'profile' && this.environmentService.remoteAuthority !== undefined;
		this.notificationService.notify({
			severity: Severity.Info,
			message: losesForwardedPorts
				? localize(
					'paradis.browserProfiles.switchedRemote',
					"{0} また、名前付きプロファイルは転送されたポート（localhost など）へ接続できません。転送先を開く場合は組み込みスコープに戻してください。",
					base,
				)
				: base,
		});
	}

	// #endregion
}

/** ピルに収まる長さへ切る。サロゲートペアの途中で割らないよう文字単位で数える。 */
function paradisEllipsize(text: string, maxLength: number): string {
	const characters = Array.from(text);
	return characters.length > maxLength ? `${characters.slice(0, maxLength).join('')}…` : text;
}

BrowserEditor.registerContribution(ParadisBrowserProfilePill);
