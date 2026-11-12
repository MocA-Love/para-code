/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// プロファイルの管理モーダル（モック③）と新規作成モーダル（モック④）。
// paradisBookmarkDialogs.ts のモーダルシェルの流儀をそのまま踏襲する: workbench コンテナへ
// 自前の backdrop + モーダルを重ね、色は `--vscode-*` トークンのみを使う。backdrop に付けた共通の印
// `paradis-modal-backdrop` は overlayManager の OVERLAY_DEFINITIONS に登録済みで、
// 表示中はネイティブの WebContentsView が自動的に pause される（印を外すとページの裏に
// 隠れて何も見えない）。

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IParadisBrowserProfile, PARADIS_BROWSER_PROFILE_COLORS } from '../common/paradisBrowserProfileModel.js';
import { IParadisBrowserProfilesService } from './paradisBrowserProfilesService.js';
import { paradisModalClasses, ParadisModalSize } from '../../../browser/paradisModal.js';

const $ = dom.$;

/** 誤りの文の要素に振る id の連番（入力欄の aria-describedby から指す）。 */
let errorElementIdCounter = 0;

/** 誤りの文の要素に id を振り、入力欄の読み上げに結び付ける。 */
function linkErrorToInput(input: HTMLInputElement, error: HTMLElement): void {
	error.id = `paradis-browser-profile-error-${++errorElementIdCounter}`;
	input.setAttribute('aria-describedby', error.id);
}

/** 誤りの文を出す・消す。入力欄の aria-invalid も合わせる。 */
function setInputError(input: HTMLInputElement, error: HTMLElement, message: string | undefined): void {
	error.textContent = message ?? '';
	error.style.display = message === undefined ? 'none' : '';
	if (message === undefined) {
		input.removeAttribute('aria-invalid');
	} else {
		input.setAttribute('aria-invalid', 'true');
	}
}

/** 識別カラーの読み上げ名（色の値は保存データと照合するので、名前は別の対応表で持つ）。 */
function colorName(color: string): string {
	switch (color) {
		case '#e2a33d': return localize('paradis.browserProfiles.color.orange', "オレンジ");
		case '#3fb950': return localize('paradis.browserProfiles.color.green', "緑");
		case '#a371f7': return localize('paradis.browserProfiles.color.purple', "紫");
		case '#4daafc': return localize('paradis.browserProfiles.color.blue', "青");
		case '#f47067': return localize('paradis.browserProfiles.color.red', "赤");
		case '#8b8b8b': return localize('paradis.browserProfiles.color.gray', "灰");
		default: return color;
	}
}

/**
 * 共通のモーダルシェル（backdrop + タイトルバー + 本文 + フッター）。1回開くごとに1インスタンス、
 * 閉じるときに自分を破棄する。
 */
export abstract class ParadisProfileModal extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _modal: HTMLElement;
	/** 開く前にフォーカスがあった要素（呼び出し側が戻し先を渡したときはそれ）。閉じたらここへ戻す。 */
	protected readonly previouslyFocused: HTMLElement | undefined;
	/** Tab の巡回対象。DOM を検索せず、作った側が登録する（upstream の dialog.ts と同じ流儀）。 */
	private readonly _headerFocusables: HTMLElement[] = [];
	private readonly _footerFocusables: HTMLElement[] = [];
	/** 本文側の巡回対象。作り直す画面は再描画のたびに入れ替える。 */
	protected readonly contentFocusables: HTMLElement[] = [];
	protected readonly body: HTMLElement;
	protected readonly footer: HTMLElement;

	constructor(dialogTitle: string, icon: ThemeIcon, layoutService: ILayoutService, restoreFocusTo?: HTMLElement) {
		super();

		const active = dom.getActiveElement();
		this.previouslyFocused = restoreFocusTo ?? (dom.isHTMLElement(active) ? active : undefined);

		this._backdrop = $('.paradis-browser-profile-backdrop.paradis-modal-backdrop');
		const modal = $('.paradis-browser-profile-modal');
		modal.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		this._modal = modal;
		this._backdrop.appendChild(modal);

		const header = dom.append(modal, $('.pbpm-header'));
		const title = dom.append(header, $('.pbpm-title'));
		dom.append(title, $(ThemeIcon.asCSSSelector(icon)));
		dom.append(title, $('h2')).textContent = dialogTitle;
		const closeButton = dom.append(header, $('button.pbpm-close.paradis-focus-ring-inset')) as HTMLButtonElement;
		closeButton.type = 'button';
		closeButton.appendChild($(ThemeIcon.asCSSSelector(Codicon.close)));
		closeButton.setAttribute('aria-label', localize('paradis.browserProfiles.dialog.close', "閉じる"));
		this._headerFocusables.push(closeButton);
		this._register(dom.addDisposableListener(closeButton, dom.EventType.CLICK, () => this.close()));

		this.body = dom.append(modal, $('.pbpm-body'));
		this.footer = dom.append(modal, $('.pbpm-footer'));

		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');
		modal.setAttribute('aria-label', dialogTitle);
		modal.tabIndex = -1;
		this._register(dom.addDisposableListener(this._backdrop, dom.EventType.MOUSE_DOWN, event => {
			if (event.target === this._backdrop) {
				this.close();
			}
		}));
		this._register(dom.addDisposableListener(this._backdrop, dom.EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.keyCode === KeyCode.Escape) {
				keyboardEvent.preventDefault();
				this.close();
				return;
			}
			// フォーカストラップ。`aria-modal` は支援技術への宣言でしかなく、Tab は普通に外へ抜ける。
			// 抜けた先で Esc を押しても backdrop の keydown には届かず、閉じられなくなる。
			if (keyboardEvent.keyCode === KeyCode.Tab) {
				this._trapTab(keyboardEvent);
			}
		}));

		layoutService.activeContainer.appendChild(this._backdrop);
	}

	/**
	 * モーダル自身へフォーカスを戻す。
	 *
	 * フォーカスしていた要素を作り直し/削除で DOM から外すと `activeElement` が body になり、
	 * Esc もタブトラップも backdrop の keydown に届かなくなって**モーダルが操作不能になる**
	 * （閉じたときのフォーカス復帰も効かなくなる）。要素を消した側が必ずここへ戻す。
	 */
	protected focusModal(): void {
		if (!dom.isAncestorOfActiveElement(this._backdrop)) {
			this._modal.focus();
		}
	}

	/** モーダル内の focusable を DOM 順に巡回させ、両端で折り返す。 */
	private _trapTab(keyboardEvent: StandardKeyboardEvent): void {
		const focusable = [...this._headerFocusables, ...this.contentFocusables, ...this._footerFocusables]
			// 作り直しで外れた要素（前回の描画分・畳んだ確認ポップオーバー）は飛ばす。
			.filter(element => element.isConnected && !element.hasAttribute('disabled'));
		if (focusable.length === 0) {
			return;
		}
		const active = dom.getActiveElement();
		const currentIndex = focusable.findIndex(element => element === active);
		const nextIndex = keyboardEvent.shiftKey
			? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
			: (currentIndex === -1 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
		keyboardEvent.preventDefault();
		focusable[nextIndex].focus();
	}

	protected appendButton(label: string, kind: 'primary' | 'secondary' | 'danger', run: () => void): HTMLButtonElement {
		const button = dom.append(this.footer, $(`button.pbpm-btn.paradis-focus-ring.${kind}`)) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		this._footerFocusables.push(button);
		this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => run()));
		return button;
	}

	close(): void {
		this.dispose();
	}

	override dispose(): void {
		// 閉じたら開く前の場所へフォーカスを戻す。戻さないとフォーカスが body へ落ち、
		// キーボードだけで操作している人がワークベンチへ帰れなくなる。
		const shouldRestoreFocus = dom.isAncestorOfActiveElement(this._backdrop);
		this._backdrop.remove();
		if (shouldRestoreFocus && this.previouslyFocused?.isConnected) {
			this.previouslyFocused.focus();
		}
		super.dispose();
	}
}

/**
 * 管理モーダル（モック③）。一覧・インラインでのリネーム・削除（確認つき）・新規作成への導線。
 */
class ParadisManageProfilesDialog extends ParadisProfileModal {

	private readonly _listElement: HTMLElement;
	/**
	 * 一覧の作り直しごとに捨てるリスナー置き場。
	 *
	 * `_render()` は `onDidChangeProfiles`（作成・リネーム・削除・`touch`）のたびに走るので、
	 * 行のリスナーをモーダル本体のストアへ積むと開いている間ずっと溜まり続ける
	 * （CLAUDE.md「繰り返し呼ばれるメソッド内で作った disposable をクラスへ登録しない」）。
	 */
	private readonly _renderStore = this._register(new DisposableStore());
	/** 開いている削除確認ポップオーバー（同時に1つだけ）。 */
	private _confirmElement: HTMLElement | undefined;
	/** インラインでリネーム中の行。 */
	private _editingId: string | undefined;
	/** 削除・消去の確認を開いている間に届いた変更（確認を閉じたら描き直す）。 */
	private _renderPending = false;

	constructor(
		@IParadisBrowserProfilesService private readonly profilesService: IParadisBrowserProfilesService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILayoutService layoutService: ILayoutService,
	) {
		super(localize('paradis.browserProfiles.manage.title', "ブラウザプロファイルを管理"), Codicon.lock, layoutService);

		dom.append(this.body, $('p.pbpm-description')).textContent = localize(
			'paradis.browserProfiles.manage.description',
			"名前ごとに Cookie / LocalStorage が永続化されます。ログインし直す必要がなくなる一方、削除するとそのプロファイルの保存内容もすべて失われます。",
		);
		this._listElement = dom.append(this.body, $('.pbpm-list'));

		this.appendButton(localize('paradis.browserProfiles.manage.new', "新規プロファイル"), 'secondary', () => {
			// このモーダルは閉じるので、作成モーダルを閉じたらこのモーダルを開く前の場所へ戻す
			paradisShowCreateProfileDialog(this.instantiationService, undefined, this.previouslyFocused);
			this.close();
		});
		this.appendButton(localize('paradis.browserProfiles.manage.done', "閉じる"), 'primary', () => this.close());

		this._register(this.profilesService.onDidChangeProfiles(() => {
			// 入力中に作り直すと打ちかけの名前が消える。`touch()`（＝タブを開くたび）や他ウィンドウの
			// 変更でも発火するので、リネーム中は保留する（確定/取り消しの直後に必ず描き直される）。
			if (this._editingId !== undefined) {
				return;
			}
			// 削除・消去の確認を開いている間も保留する。作り直すと確認が畳まれ、他のウィンドウや
			// エージェントがタブを開いただけで、押そうとしていた確認が消える。閉じたときに描き直す。
			if (this._confirmElement !== undefined) {
				this._renderPending = true;
				return;
			}
			this._render();
		}));
		this._render();
	}

	private _render(): void {
		// 前回の行のリスナーを捨ててから作り直す。開いている削除確認も一緒に畳む
		// （行ごと作り直すので、確認の対象がどれだったか曖昧になるより閉じた方が安全）。
		this._renderStore.clear();
		this._renderPending = false;
		this.contentFocusables.length = 0;
		this._confirmElement?.remove();
		this._confirmElement = undefined;
		dom.clearNode(this._listElement);
		const profiles = this.profilesService.list();
		if (profiles.length === 0) {
			dom.append(this._listElement, $('.pbpm-empty')).textContent = localize(
				'paradis.browserProfiles.manage.empty',
				"まだプロファイルがありません。",
			);
			this.focusModal();
			return;
		}
		for (const profile of profiles) {
			this._renderRow(profile);
		}
		// 作り直しでフォーカスしていた行アクションが消えた場合の受け皿。
		this.focusModal();
	}

	private _renderRow(profile: IParadisBrowserProfile): void {
		const row = dom.append(this._listElement, $('.pbpm-row'));
		const dot = dom.append(row, $('.pbpm-dot'));
		dot.style.backgroundColor = profile.color;

		if (this._editingId === profile.id) {
			this._renderRenameRow(row, profile);
			return;
		}

		const info = dom.append(row, $('.pbpm-info'));
		dom.append(info, $('.pbpm-name')).textContent = profile.name;
		const meta = dom.append(info, $('.pbpm-meta'));
		meta.textContent = localize('paradis.browserProfiles.manage.lastUsed', "最終利用: {0}", fromNow(profile.lastUsedAt, true));
		// Cookie 件数は main へ聞く。Electron にはパーティション単位のストレージ使用量 API が
		// 無いので、LocalStorage の容量は出さない（取れないものを 0 と出すより黙る）。
		void this.profilesService.getProfileStats(profile.id).then(stats => {
			if (!meta.isConnected) {
				return;
			}
			const cookies = stats.cookieCount === undefined
				? localize('paradis.browserProfiles.manage.cookiesUnknown', "Cookie —")
				: localize('paradis.browserProfiles.manage.cookies', "Cookie {0}件", stats.cookieCount);
			meta.textContent = `${localize('paradis.browserProfiles.manage.lastUsed', "最終利用: {0}", fromNow(profile.lastUsedAt, true))} ・ ${cookies}`;
		});

		const actions = dom.append(row, $('.pbpm-row-actions'));
		this._appendRowAction(actions, Codicon.edit, localize('paradis.browserProfiles.manage.rename', "名前を変更"), () => {
			this._editingId = profile.id;
			this._render();
		});
		// プロファイル閲覧中は upstream の "Clear Storage (…)" が一つも出ない（コンテキストキーが
		// profile のため）ので、「消す」導線が削除しかなくなる。名前と色を残したままログアウト
		// だけしたい場合のためにここへ置く。
		this._appendRowAction(actions, Codicon.clearAll, localize('paradis.browserProfiles.manage.clear', "保存データを消去（プロファイルは残す）"), () => this._confirmClear(profile));
		this._appendRowAction(actions, Codicon.trash, localize('paradis.browserProfiles.manage.delete', "削除"), () => this._confirmDelete(profile));
	}

	private _renderRenameRow(row: HTMLElement, profile: IParadisBrowserProfile): void {
		const field = dom.append(row, $('.pbpm-rename'));
		const input = dom.append(field, $('input.pbpm-input')) as HTMLInputElement;
		input.type = 'text';
		input.value = profile.name;
		input.setAttribute('aria-label', localize('paradis.browserProfiles.manage.renameAria', "プロファイル名"));
		this.contentFocusables.push(input);
		const error = dom.append(field, $('.pbpm-error'));
		error.style.display = 'none';
		linkErrorToInput(input, error);

		const commit = () => {
			const result = this.profilesService.rename(profile.id, input.value);
			if (!result.ok) {
				setInputError(input, error, result.error);
				input.focus();
				return;
			}
			this._editingId = undefined;
			this._render();
		};
		const cancel = () => {
			this._editingId = undefined;
			this._render();
		};

		this._renderStore.add(dom.addDisposableListener(input, dom.EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.keyCode === KeyCode.Enter) {
				keyboardEvent.preventDefault();
				commit();
			} else if (keyboardEvent.keyCode === KeyCode.Escape) {
				// モーダルごと閉じずに、リネームだけを取り消す。
				keyboardEvent.preventDefault();
				keyboardEvent.stopPropagation();
				cancel();
			}
		}));

		const actions = dom.append(row, $('.pbpm-row-actions'));
		this._appendRowAction(actions, Codicon.check, localize('paradis.browserProfiles.manage.renameCommit', "名前を確定"), commit);
		this._appendRowAction(actions, Codicon.close, localize('paradis.browserProfiles.manage.renameCancel', "取り消し"), cancel);

		input.focus();
		input.select();
	}

	private _appendRowAction(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => void): void {
		const button = dom.append(parent, $('button.pbpm-row-action.paradis-focus-ring-inset')) as HTMLButtonElement;
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		button.appendChild($(ThemeIcon.asCSSSelector(icon)));
		this.contentFocusables.push(button);
		this._renderStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => run()));
	}

	/**
	 * 削除は取り消せない（保存済みのログイン状態が消える）ので、必ず確認を挟む。
	 * 確認はモーダルを重ねずに一覧の直下へ出す（モック③のポップオーバー）。
	 */
	private _confirmDelete(profile: IParadisBrowserProfile): void {
		this._confirmPopover(
			localize('paradis.browserProfiles.manage.confirmTitle', "「{0}」を削除しますか？", profile.name),
			localize(
				'paradis.browserProfiles.manage.confirmBody',
				"この操作は取り消せません。保存されているログイン状態・Cookie・LocalStorage もすべて削除されます。",
			),
			localize('paradis.browserProfiles.manage.confirmDelete', "削除する"),
			profile,
			() => this.profilesService.remove(profile.id),
		);
	}

	/** 名前と色は残したまま、保存されているログイン状態だけを消す。 */
	private _confirmClear(profile: IParadisBrowserProfile): void {
		this._confirmPopover(
			localize('paradis.browserProfiles.manage.confirmClearTitle', "「{0}」の保存データを消去しますか？", profile.name),
			localize(
				'paradis.browserProfiles.manage.confirmClearBody',
				"プロファイル自体は残りますが、保存されているログイン状態・Cookie・LocalStorage は削除され、次に開いたときは未ログインになります。",
			),
			localize('paradis.browserProfiles.manage.confirmClear', "消去する"),
			profile,
			async () => {
				try {
					await this.profilesService.clearProfileData(profile.id);
				} catch {
					// タブは閉じ終わっているので、消えたように見えてもログイン状態が残っている。
					this.notificationService.notify({
						severity: Severity.Warning,
						message: localize(
							'paradis.browserProfiles.manage.clearFailed',
							"「{0}」の保存データを消去できませんでした。ログイン状態が残っている可能性があります。もう一度お試しください。",
							profile.name,
						),
					});
				}
			},
		);
	}

	private _confirmPopover(
		titleText: string,
		bodyText: string,
		confirmLabel: string,
		profile: IParadisBrowserProfile,
		run: () => Promise<void>,
	): void {
		this._confirmElement?.remove();
		const popover = dom.append(this.body, $('.pbpm-confirm'));
		this._confirmElement = popover;
		const title = dom.append(popover, $('.pbpm-confirm-title'));
		dom.append(title, $(ThemeIcon.asCSSSelector(Codicon.warning)));
		dom.append(title, $('span')).textContent = titleText;

		const description = dom.append(popover, $('p'));
		description.textContent = bodyText;
		// 開いているタブは先に閉じる（閉じないと生きたページが消した直後に書き戻す）。その数は
		// **全ウィンドウ分**なので main に聞く。こちらのウィンドウの台帳は自分の分しか知らない。
		void this.profilesService.getProfileStats(profile.id).then(stats => {
			if (!description.isConnected || stats.openViewCount <= 0) {
				return;
			}
			description.textContent = `${bodyText} ${localize(
				'paradis.browserProfiles.manage.confirmOpenTabs',
				"このプロファイルで開いているタブ {0} 個も閉じられます。",
				stats.openViewCount,
			)}`;
		});

		const actions = dom.append(popover, $('.pbpm-confirm-actions'));
		const confirmFocusableStart = this.contentFocusables.length;
		const dismiss = () => {
			popover.remove();
			this._confirmElement = undefined;
			// 確認ボタンにフォーカスがあったまま消すと body へ落ちる。巡回対象からも外す
			// （残しても isConnected で無視されるが、開くたびに配列が伸び続けるため）。
			this.contentFocusables.splice(confirmFocusableStart, 2);
			if (this._renderPending) {
				this._render();
			} else {
				this.focusModal();
			}
		};
		const cancelButton = dom.append(actions, $('button.pbpm-btn.paradis-focus-ring.secondary')) as HTMLButtonElement;
		cancelButton.type = 'button';
		cancelButton.textContent = localize('paradis.browserProfiles.manage.confirmCancel', "キャンセル");
		this.contentFocusables.push(cancelButton);
		this._renderStore.add(dom.addDisposableListener(cancelButton, dom.EventType.CLICK, dismiss));
		const confirmButton = dom.append(actions, $('button.pbpm-btn.paradis-focus-ring.danger')) as HTMLButtonElement;
		confirmButton.type = 'button';
		confirmButton.textContent = confirmLabel;
		this.contentFocusables.push(confirmButton);
		this._renderStore.add(dom.addDisposableListener(confirmButton, dom.EventType.CLICK, () => {
			dismiss();
			void run();
		}));
		// 取り消せない操作なので、Enter で誤って実行しないようキャンセル側にフォーカスを置く
		cancelButton.focus();
	}
}

/** 新規作成モーダル（モック④）。名前と識別カラーだけ。 */
class ParadisCreateProfileDialog extends ParadisProfileModal {

	private readonly _nameInput: HTMLInputElement;
	private readonly _errorElement: HTMLElement;
	private readonly _swatches = new Map<string, HTMLElement>();
	private _selectedColor: string;

	constructor(
		private readonly onCreated: ((profile: IParadisBrowserProfile) => void) | undefined,
		restoreFocusTo: HTMLElement | undefined,
		@IParadisBrowserProfilesService private readonly profilesService: IParadisBrowserProfilesService,
		@ILayoutService layoutService: ILayoutService,
	) {
		super(localize('paradis.browserProfiles.create.title', "新しいプロファイルを作成"), Codicon.add, layoutService, restoreFocusTo);

		this._selectedColor = PARADIS_BROWSER_PROFILE_COLORS[0];

		dom.append(this.body, $('label.pbpm-label')).textContent = localize('paradis.browserProfiles.create.name', "プロファイル名");
		this._nameInput = dom.append(this.body, $('input.pbpm-input')) as HTMLInputElement;
		this._nameInput.type = 'text';
		this._nameInput.placeholder = localize('paradis.browserProfiles.create.namePlaceholder', "例: PRD, 検証用アカウントA");
		this._nameInput.setAttribute('aria-label', localize('paradis.browserProfiles.create.name', "プロファイル名"));
		this.contentFocusables.push(this._nameInput);

		const hint = dom.append(this.body, $('.pbpm-hint'));
		hint.textContent = localize(
			'paradis.browserProfiles.create.hint',
			"エージェントからは open_browser_profile(\"この名前\") のように、この名前で参照します。",
		);

		dom.append(this.body, $('label.pbpm-label.pbpm-label-spaced')).textContent = localize('paradis.browserProfiles.create.color', "識別カラー");
		const swatchRow = dom.append(this.body, $('.pbpm-swatches'));
		for (const color of PARADIS_BROWSER_PROFILE_COLORS) {
			const swatch = dom.append(swatchRow, $('button.pbpm-swatch.paradis-focus-ring')) as HTMLButtonElement;
			swatch.type = 'button';
			swatch.style.backgroundColor = color;
			swatch.setAttribute('aria-label', colorName(color));
			this.contentFocusables.push(swatch);
			this._register(dom.addDisposableListener(swatch, dom.EventType.CLICK, () => {
				this._selectedColor = color;
				this._refreshSwatches();
			}));
			this._swatches.set(color, swatch);
		}

		this._errorElement = dom.append(this.body, $('.pbpm-error'));
		this._errorElement.style.display = 'none';
		linkErrorToInput(this._nameInput, this._errorElement);

		this.appendButton(localize('paradis.browserProfiles.create.cancel', "キャンセル"), 'secondary', () => this.close());
		this.appendButton(localize('paradis.browserProfiles.create.submit', "作成して開く"), 'primary', () => this._submit());

		this._register(dom.addDisposableListener(this._nameInput, dom.EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.keyCode === KeyCode.Enter) {
				keyboardEvent.preventDefault();
				this._submit();
			}
		}));

		this._refreshSwatches();
		this._nameInput.focus();
	}

	private _refreshSwatches(): void {
		for (const [color, swatch] of this._swatches) {
			swatch.classList.toggle('selected', color === this._selectedColor);
			swatch.setAttribute('aria-pressed', String(color === this._selectedColor));
		}
	}

	private _submit(): void {
		const result = this.profilesService.create(this._nameInput.value, this._selectedColor);
		if (!result.ok) {
			setInputError(this._nameInput, this._errorElement, result.error);
			this._nameInput.focus();
			return;
		}
		this.close();
		this.onCreated?.(result.profile);
	}
}

/** 管理モーダルを開く。 */
export function paradisShowManageProfilesDialog(instantiationService: IInstantiationService): void {
	instantiationService.createInstance(ParadisManageProfilesDialog);
}

/**
 * 新規作成モーダルを開く。作成後に何をするか（新しいタブで開く／今のタブを差し替える）は
 * 呼び出し側が決める。
 */
export function paradisShowCreateProfileDialog(
	instantiationService: IInstantiationService,
	onCreated?: (profile: IParadisBrowserProfile) => void,
	restoreFocusTo?: HTMLElement,
): void {
	instantiationService.createInstance(ParadisCreateProfileDialog, onCreated, restoreFocusTo);
}
