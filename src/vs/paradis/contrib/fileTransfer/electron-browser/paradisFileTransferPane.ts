/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送の片側（案C）。
//
// 表・選択・キーボード操作・ドラッグは VS Code の WorkbenchTable に任せ、独自に描くのは見出し
// （ホスト名・接続の点・絞り込み・「操作」）、戻る・進む・上・パンくず、足元の件数、ドロップ先の説明だけ。
// 表は paradisFileTransferPaneTable.ts、操作は paradisFileTransferPaneOperations.ts、
// ドラッグ＆ドロップは paradisFileTransferPaneDnd.ts に分けてある。

import * as dom from '../../../../base/browser/dom.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, dirname, extUri } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ParadisTransferSide } from '../common/paradisFileTransfer.js';
import { paradisIsSftpResource } from '../common/paradisSftp.js';
import { IParadisPaneEntry, paradisFilterEntries, paradisFormatSize, paradisIsHiddenName, paradisSortEntries } from '../common/paradisFileTransferListing.js';
import { paradisClassifyTransferError, ParadisTransferErrorKind } from '../common/paradisFileTransferQueue.js';
import { createParadisPaneDragAndDrop } from './paradisFileTransferPaneDnd.js';
import { paradisHandleFilterKey, ParadisFileTransferPaneOperations } from './paradisFileTransferPaneOperations.js';
import { ParadisFileTransferPaneTable } from './paradisFileTransferPaneTable.js';
import { IParadisFileTransferService, paradisTransferSourceFor } from './paradisFileTransferService.js';

const $ = dom.$;

/** 画面を置いている側（エディタ）への問い合わせ。 */
export interface IParadisFileTransferPaneHost {
	/** 反対側の画面。 */
	otherPane(side: ParadisTransferSide): ParadisFileTransferPane | undefined;
	/** このタブを閉じる。 */
	closeEditor(): void;
}

interface IHeaderParts {
	readonly head: HTMLElement;
	readonly hostName: HTMLElement;
	readonly hostDot: HTMLElement;
	readonly hostSub: HTMLElement;
	readonly filterBox: InputBox;
	readonly actionsButton: HTMLButtonElement;
}

interface INavParts {
	readonly nav: HTMLElement;
	readonly back: HTMLButtonElement;
	readonly forward: HTMLButtonElement;
	readonly up: HTMLButtonElement;
	readonly crumbs: HTMLElement;
}

export class ParadisFileTransferPane extends Disposable {

	readonly element: HTMLElement;

	private readonly _onDidNavigate = this._register(new Emitter<URI>());
	/** 場所を移った（タブの控えに覚えさせる）。 */
	readonly onDidNavigate: Event<URI> = this._onDidNavigate.event;

	private readonly header: IHeaderParts;
	private readonly navParts: INavParts;
	private readonly banner: HTMLElement;
	private readonly tableHost: HTMLElement;
	private readonly message: HTMLElement;
	private readonly footer: HTMLElement;
	private readonly dropCaption: HTMLElement;
	private readonly paneTable: ParadisFileTransferPaneTable;
	private readonly operations: ParadisFileTransferPaneOperations;

	private location: URI | undefined;
	private readonly backStack: URI[] = [];
	private readonly forwardStack: URI[] = [];
	private allEntries: readonly IParadisPaneEntry[] = [];
	private visibleEntries: IParadisPaneEntry[] = [];
	private truncated = false;
	private modes = false;
	private showHidden = false;
	private loadSequence = 0;
	/** 「接続していません」の描き直しの世代。古い描画の後から届いたホストの一覧を捨てる。 */
	private messageGeneration = 0;
	private listError: ParadisTransferErrorKind | undefined;
	private listErrorDetail = '';
	private dimension: { width: number; height: number } = { width: 0, height: 0 };
	private readonly crumbStore = this._register(new DisposableStore());
	private readonly messageStore = this._register(new DisposableStore());

	constructor(
		readonly side: ParadisTransferSide,
		private readonly host: IParadisFileTransferPaneHost,
		@IParadisFileTransferService private readonly transferService: IParadisFileTransferService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@INotificationService private readonly notificationService: INotificationService,
		@IThemeService private readonly themeService: IThemeService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super();
		this.element = $('.para-ft-pane');
		this.element.dataset.side = side;
		this.element.tabIndex = -1;

		this.header = this.createHeader();
		this.navParts = this.createNav();
		this.banner = dom.append(this.element, $('.para-ft-banner'));
		this.banner.setAttribute('role', 'status');
		dom.hide(this.banner);
		this.tableHost = dom.append(this.element, $('.para-ft-table'));
		this.message = dom.append(this.element, $('.para-ft-message'));
		dom.hide(this.message);
		this.footer = dom.append(this.element, $('.para-ft-foot'));
		this.dropCaption = dom.append(this.element, $('.para-ft-dropcap'));
		dom.hide(this.dropCaption);

		this.paneTable = this._register(instantiationService.createInstance(ParadisFileTransferPaneTable, {
			user: `ParadisFileTransfer.${side}`,
			container: this.tableHost,
			ariaLabel: localize('paradis.fileTransfer.tableAria', "{0} のファイル", transferService.sideLabel(side)),
			twoLines: () => this.modes,
			filterText: () => this.header.filterBox.value,
			dnd: this.createDropTarget(),
		}));
		this.operations = instantiationService.createInstance(ParadisFileTransferPaneOperations, this.createOperationsContext());
		this.registerListeners();
		this.updateFileIconClass();
		this.updateHostState();
	}

	private get table() {
		return this.paneTable.table;
	}

	private createHeader(): IHeaderParts {
		const head = dom.append(this.element, $('.para-ft-head'));
		const hostIcon = dom.append(head, $('span.para-ft-hicon'));
		hostIcon.classList.add(...ThemeIcon.asClassNameArray(this.side === 'local' ? Codicon.deviceDesktop : Codicon.server));
		const hostName = dom.append(head, $('span.para-ft-hname'));
		hostName.textContent = this.transferService.sideLabel(this.side);
		const hostDot = dom.append(head, $('span.para-ft-hdot'));
		const hostSub = dom.append(head, $('span.para-ft-hsub'));
		dom.append(head, $('span.para-ft-sp'));
		const filterBox = this._register(new InputBox(dom.append(head, $('.para-ft-filter')), this.contextViewService, {
			placeholder: localize('paradis.fileTransfer.filter', "絞り込み"),
			ariaLabel: localize('paradis.fileTransfer.filterAria', "{0} の一覧を名前で絞り込む", this.transferService.sideLabel(this.side)),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		const actionsButton = dom.append(head, $<HTMLButtonElement>('button.para-ft-actions'));
		actionsButton.type = 'button';
		actionsButton.setAttribute('aria-haspopup', 'true');
		dom.append(actionsButton, $('span')).textContent = localize('paradis.fileTransfer.actions', "操作");
		dom.append(actionsButton, $(`span${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));
		return { head, hostName, hostDot, hostSub, filterBox, actionsButton };
	}

	private createNav(): INavParts {
		const nav = dom.append(this.element, $('.para-ft-nav'));
		const back = this.navButton(nav, Codicon.arrowLeft, localize('paradis.fileTransfer.back', "戻る"), () => this.goBack());
		const forward = this.navButton(nav, Codicon.arrowRight, localize('paradis.fileTransfer.forward', "進む"), () => this.goForward());
		const up = this.navButton(nav, Codicon.arrowUp, localize('paradis.fileTransfer.up', "上のフォルダー"), () => this.goUp());
		const crumbs = dom.append(nav, $('.para-ft-crumbs'));
		this.navButton(nav, Codicon.refresh, localize('paradis.fileTransfer.refresh', "再読み込み"), () => this.refresh());
		return { nav, back, forward, up, crumbs };
	}

	private createDropTarget() {
		const pane = this;
		return createParadisPaneDragAndDrop({
			get location() { return pane.location; },
			owns: resource => this.transferService.owns(this.side, resource),
			canReceive: () => this.canReceive(),
			showDropCaption: (targetDirectory, count) => this.showDropCaption(targetDirectory, count),
			hideDropCaption: () => this.hideDropCaption(),
			receive: (entries, targetDirectory) => void this.transferTo(entries, targetDirectory, this.side),
		});
	}

	private createOperationsContext() {
		const pane = this;
		return {
			get side() { return pane.side; },
			get location() { return pane.location; },
			get allEntries() { return pane.allEntries; },
			get visibleEntries() { return pane.visibleEntries; },
			get modes() { return pane.modes; },
			get showHidden() { return pane.showHidden; },
			get listed() { return !pane.listError; },
			selection: () => this.table.getSelectedElements(),
			navigate: (resource: URI) => this.navigate(resource),
			refresh: () => this.refresh(),
			goUp: () => this.goUp(),
			goBack: () => this.goBack(),
			goForward: () => this.goForward(),
			toggleHidden: () => this.toggleHidden(),
			selectAll: () => this.table.setSelection(this.visibleEntries.map((_, index) => index)),
			focusTable: () => this.table.domFocus(),
			focusFilter: () => this.header.filterBox.focus(),
			canCopyToOtherSide: () => !!this.host.otherPane(this.side)?.canReceive(),
			copyToOtherSide: (entries: readonly IParadisPaneEntry[]) => this.copyToOtherSide(entries),
			closeEditor: () => this.host.closeEditor(),
			label: () => this.label,
			otherLabel: () => this.host.otherPane(this.side)?.label ?? this.transferService.sideLabel(this.side === 'local' ? 'remote' : 'local'),
			canSwitchHost: () => this.side === 'remote',
			switchHost: () => this.pickOtherHost(),
			canShowHostList: () => this.side === 'remote' && !this.transferService.remoteAuthority && !!this.location,
			showHostList: () => this.showHostList(),
		};
	}

	private registerListeners(): void {
		this._register(this.header.filterBox.onDidChange(() => this.render()));
		this._register(dom.addDisposableListener(this.header.actionsButton, 'click', () => this.operations.showMenu(this.header.actionsButton)));
		this._register(this.paneTable.onDidChangeSort(() => this.render()));
		this._register(this.table.onDidOpen(event => {
			if (event.element) {
				void this.operations.openEntries([event.element]);
			}
		}));
		this._register(this.table.onContextMenu(event => {
			if (event.element && !this.table.getSelectedElements().includes(event.element)) {
				const index = this.visibleEntries.indexOf(event.element);
				if (index >= 0) {
					this.table.setSelection([index]);
					this.table.setFocus([index]);
				}
			}
			this.operations.showMenu(event.anchor);
		}));
		this._register(this.table.onDidChangeSelection(() => this.renderFooter()));
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_DOWN, e => {
			if (!paradisHandleFilterKey(e, this.header.filterBox, first => this.focusTable(first))) {
				this.operations.handleKey(e);
			}
		}));
		this._register(this.themeService.onDidFileIconThemeChange(() => {
			this.updateFileIconClass();
			this.table.rerender();
		}));
		if (this.side === 'remote') {
			this._register(this.transferService.onDidChangeConnection(connected => {
				this.updateHostState();
				if (connected) {
					void this.refresh();
				}
			}));
		}
	}

	get currentLocation(): URI | undefined {
		return this.location;
	}

	/** 見出しの名前（右側で接続していないホストを開いていれば、その別名）。 */
	get label(): string {
		return this.transferService.sideLabel(this.side, this.location);
	}

	/** 右側で、接続していないホストを SSH で直接開いているか。 */
	private get isDirect(): boolean {
		return this.side === 'remote' && !!this.location && paradisIsSftpResource(this.location);
	}

	/** この側に転送を受けられるか（接続していない右側は受けない）。 */
	canReceive(): boolean {
		return !!this.location && (this.side === 'local' || this.isDirect || (!!this.transferService.remoteAuthority && this.transferService.remoteConnected));
	}

	// --- ホストを選ぶ -------------------------------------------------------------------------------

	/** ユーザーが選んだホストを右側に開く。このウィンドウの接続先なら今の接続、それ以外は SSH を直接張る。 */
	private async openHost(alias: string): Promise<void> {
		const home = await this.transferService.openHost(alias);
		await this.navigate(home);
	}

	/** 「ほかのホストを開く…」。`~/.ssh/config` のホストから選ぶ。 */
	private async pickOtherHost(): Promise<void> {
		const hosts = await this.transferService.listConfiguredHosts();
		if (!hosts.length) {
			this.notificationService.info(localize('paradis.fileTransfer.noHostsShort', "~/.ssh/config にホストがありません。"));
			return;
		}
		const current = this.location && paradisIsSftpResource(this.location) ? this.location.authority : this.transferService.remoteLabel;
		const items: IQuickPickItem[] = hosts.map(alias => ({
			label: alias,
			description: alias === current ? localize('paradis.fileTransfer.currentHost', "開いているホスト") : undefined,
		}));
		const picked = await this.quickInputService.pick(items, { placeHolder: localize('paradis.fileTransfer.pickHost', "右側に開くホストを選んでください（このウィンドウの接続先以外は SSH で直接読み書きします）") });
		if (!picked) {
			return;
		}
		try {
			await this.openHost(picked.label);
		} catch (error) {
			this.notificationService.error(error);
		}
	}

	/** 手元のウィンドウで、右側をホストの一覧に戻す。 */
	private showHostList(): void {
		if (this.location) {
			this.backStack.push(this.location);
			this.forwardStack.length = 0;
		}
		this.location = undefined;
		this.loadSequence++;
		this.allEntries = [];
		this.listError = undefined;
		this.element.classList.remove('loading');
		this.updateHostState();
		this.updateNavButtons();
		this.render();
	}

	// --- 移動 --------------------------------------------------------------------------------------

	async navigate(resource: URI, pushHistory = true): Promise<void> {
		if (pushHistory && this.location && !extUri.isEqual(this.location, resource)) {
			this.backStack.push(this.location);
			this.forwardStack.length = 0;
		}
		const hostChanged = this.location?.scheme !== resource.scheme || this.location?.authority !== resource.authority;
		this.location = resource;
		this.header.filterBox.value = '';
		this._onDidNavigate.fire(resource);
		if (hostChanged) {
			this.updateHostState();
		}
		await this.load(false);
	}

	async refresh(): Promise<void> {
		if (this.location) {
			await this.load(true);
		}
	}

	private async goBack(): Promise<void> {
		const previous = this.backStack.pop();
		if (previous) {
			if (this.location) {
				this.forwardStack.push(this.location);
			}
			await this.navigate(previous, false);
		}
	}

	private async goForward(): Promise<void> {
		const next = this.forwardStack.pop();
		if (next) {
			if (this.location) {
				this.backStack.push(this.location);
			}
			await this.navigate(next, false);
		}
	}

	private async goUp(): Promise<void> {
		if (this.location) {
			const parent = dirname(this.location);
			if (!extUri.isEqual(parent, this.location)) {
				await this.navigate(parent);
			}
		}
	}

	private toggleHidden(): void {
		this.showHidden = !this.showHidden;
		this.render();
	}

	private async load(keepSelection: boolean): Promise<void> {
		const location = this.location;
		if (!location) {
			return;
		}
		const sequence = ++this.loadSequence;
		const selected = keepSelection ? new Set(this.table.getSelectedElements().map(entry => entry.resource.toString())) : new Set<string>();
		this.renderCrumbs();
		this.updateNavButtons();
		this.element.classList.add('loading');
		try {
			const listing = await this.transferService.list(this.side, location);
			if (sequence !== this.loadSequence) {
				return;
			}
			this.allEntries = listing.entries;
			this.truncated = listing.truncated;
			this.modes = listing.modes;
			this.listError = undefined;
		} catch (error) {
			if (sequence !== this.loadSequence) {
				return;
			}
			this.allEntries = [];
			this.truncated = false;
			const kind = paradisClassifyTransferError(error);
			// SSH で直接開いたホストは、このウィンドウの接続とは別。繋がらない理由（鍵・known_hosts など）をそのまま出す
			this.listError = this.isDirect
				? (kind === 'disconnected' ? 'other' : kind)
				: this.side === 'remote' && !this.transferService.remoteConnected ? 'disconnected' : kind;
			this.listErrorDetail = error instanceof Error ? error.message : String(error);
		} finally {
			if (sequence === this.loadSequence) {
				this.element.classList.remove('loading');
			}
		}
		this.render();
		if (selected.size) {
			this.table.setSelection(this.visibleEntries.flatMap((entry, index) => selected.has(entry.resource.toString()) ? [index] : []));
		}
	}

	// --- 描画 --------------------------------------------------------------------------------------

	private render(): void {
		const filtered = paradisFilterEntries(this.allEntries, { filter: this.header.filterBox.value, showHidden: this.showHidden });
		this.visibleEntries = paradisSortEntries(filtered, this.paneTable.sort);
		this.element.classList.toggle('para-ft-two-lines', this.modes);
		this.table.splice(0, this.table.length, this.visibleEntries);
		this.renderMessage();
		this.renderFooter();
	}

	private renderCrumbs(): void {
		this.crumbStore.clear();
		const crumbs = this.navParts.crumbs;
		dom.clearNode(crumbs);
		const location = this.location;
		if (!location) {
			return;
		}
		const segments: URI[] = [];
		let current = location;
		for (let guard = 0; guard < 256; guard++) {
			segments.unshift(current);
			const parent = dirname(current);
			if (extUri.isEqual(parent, current)) {
				break;
			}
			current = parent;
		}
		segments.forEach((segment, index) => {
			if (index > 0) {
				dom.append(crumbs, $(`span.para-ft-crumb-sep${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
			}
			const button = dom.append(crumbs, $<HTMLButtonElement>('button.para-ft-crumb'));
			button.type = 'button';
			button.textContent = index === 0 ? '/' : basename(segment);
			button.title = segment.path;
			if (index === segments.length - 1) {
				button.classList.add('last');
				button.setAttribute('aria-current', 'location');
			}
			this.crumbStore.add(dom.addDisposableListener(button, 'click', () => void this.navigate(segment)));
		});
		// 深い場所でも今いるフォルダーが見えるよう、右端へ寄せる
		crumbs.scrollLeft = crumbs.scrollWidth;
	}

	private renderMessage(): void {
		this.messageGeneration++;
		this.messageStore.clear();
		this.message.classList.remove('para-ft-not-connected');
		dom.clearNode(this.message);
		dom.clearNode(this.banner);
		dom.hide(this.banner);
		this.element.classList.toggle('para-ft-dimmed', false);

		if (this.side === 'remote' && !this.transferService.remoteAuthority && !this.isDirect) {
			this.renderNotConnected();
			return;
		}
		if (this.side === 'remote' && !this.isDirect && !this.transferService.remoteConnected) {
			this.renderDisconnectedBanner();
		}
		if (this.listError && this.listError !== 'disconnected') {
			this.renderListError();
			return;
		}
		dom.hide(this.message);
		dom.show(this.tableHost);
		this.relayoutTable();
	}

	private renderDisconnectedBanner(): void {
		dom.show(this.banner);
		dom.append(this.banner, $(`span${ThemeIcon.asCSSSelector(Codicon.plug)}`));
		dom.append(this.banner, $('span.para-ft-banner-text')).textContent = localize('paradis.fileTransfer.disconnected', "接続が切れました。再接続しています。転送は止まり、繋がり直したら流し直します。");
		this.element.classList.toggle('para-ft-dimmed', true);
	}

	private renderListError(): void {
		dom.show(this.message);
		dom.hide(this.tableHost);
		const icon = this.listError === 'permission' ? Codicon.lock : Codicon.warning;
		dom.append(this.message, $(`span.para-ft-message-icon${ThemeIcon.asCSSSelector(icon)}`));
		dom.append(this.message, $('.para-ft-message-text')).textContent = this.listError === 'permission'
			? localize('paradis.fileTransfer.listPermission', "このフォルダーを読む権限がありません")
			: this.listError === 'notFound'
				? localize('paradis.fileTransfer.listNotFound', "フォルダーが見つかりません")
				: localize('paradis.fileTransfer.listFailed', "一覧を読めませんでした: {0}", this.listErrorDetail);
		const up = dom.append(this.message, $<HTMLButtonElement>('button.para-ft-button.secondary'));
		up.type = 'button';
		up.textContent = localize('paradis.fileTransfer.goUp', "上のフォルダーへ");
		this.messageStore.add(dom.addDisposableListener(up, 'click', () => void this.goUp()));
	}

	/** 手元のウィンドウの右側。「接続していません」と、`~/.ssh/config` のホストから繋ぐ導線を出す。 */
	private renderNotConnected(): void {
		dom.hide(this.tableHost);
		dom.show(this.message);
		this.message.classList.add('para-ft-not-connected');
		dom.append(this.message, $(`span.para-ft-message-icon.large${ThemeIcon.asCSSSelector(Codicon.plug)}`));
		dom.append(this.message, $('.para-ft-message-title')).textContent = localize('paradis.fileTransfer.notConnected', "接続していません");
		dom.append(this.message, $('.para-ft-message-text')).textContent = localize('paradis.fileTransfer.notConnectedDetailDirect', "「接続せずに開く」は、このウィンドウのまま SSH で直接読み書きします。「接続して開く」は、そのホストに繋いだ新しいウィンドウでこの画面を開きます。候補は ~/.ssh/config のホストです。");
		const list = dom.append(this.message, $('.para-ft-hostlist'));
		list.textContent = localize('paradis.fileTransfer.loadingHosts', "ホストを読み込んでいます…");
		const generation = this.messageGeneration;
		void this.transferService.listConfiguredHosts().then(hosts => {
			// 待っている間に描き直していたら、外れた要素に listener を足さない
			if (generation !== this.messageGeneration || this._store.isDisposed) {
				return;
			}
			this.renderHostList(list, hosts);
		});
		dom.append(this.message, $('.para-ft-later')).textContent = localize('paradis.fileTransfer.stage2Direct', "接続せずに開けるのは、鍵ファイルか ssh-agent の鍵で入れるホストです。パスワード・2 段階認証・ProxyJump が要るホストは今後の版で対応します。それまでは「接続して開く」を使ってください。");
		this.footer.textContent = '';
	}

	private renderHostList(list: HTMLElement, hosts: readonly string[]): void {
		dom.clearNode(list);
		if (!hosts.length) {
			list.textContent = localize('paradis.fileTransfer.noHosts', "~/.ssh/config にホストがありません。リモート エクスプローラーの SSH Targets からも接続できます。");
			return;
		}
		for (const alias of hosts) {
			const row = dom.append(list, $('.para-ft-hostrow'));
			dom.append(row, $(`span${ThemeIcon.asCSSSelector(Codicon.server)}`));
			dom.append(row, $('span.para-ft-hostname')).textContent = alias;
			const direct = dom.append(row, $<HTMLButtonElement>('button.para-ft-button.primary'));
			direct.type = 'button';
			direct.textContent = localize('paradis.fileTransfer.openDirect', "接続せずに開く");
			direct.title = localize('paradis.fileTransfer.openDirectTitle', "このウィンドウのまま、SSH で {0} のファイルを直接読み書きします", alias);
			const connect = dom.append(row, $<HTMLButtonElement>('button.para-ft-button.secondary'));
			connect.type = 'button';
			connect.textContent = localize('paradis.fileTransfer.connect', "接続して開く");
			const status = dom.append(row, $('.para-ft-hoststatus'));
			status.setAttribute('role', 'status');
			dom.hide(status);
			this.messageStore.add(dom.addDisposableListener(direct, 'click', async () => {
				direct.disabled = true;
				row.classList.remove('error');
				status.textContent = localize('paradis.fileTransfer.connecting', "接続しています…");
				dom.show(status);
				try {
					await this.openHost(alias);
				} catch (error) {
					// 描き直した後なら、外れた行には書かない
					if (row.isConnected) {
						row.classList.add('error');
						status.textContent = error instanceof Error ? error.message : String(error);
					}
				} finally {
					direct.disabled = false;
				}
			}));
			this.messageStore.add(dom.addDisposableListener(connect, 'click', () => {
				this.transferService.connectAndOpen(alias).catch(error => this.notificationService.error(error));
			}));
		}
	}

	private renderFooter(): void {
		if (this.side === 'remote' && !this.transferService.remoteAuthority && !this.isDirect) {
			return;
		}
		const total = this.allEntries.filter(entry => this.showHidden || !paradisIsHiddenName(entry.name)).length;
		const hidden = this.allEntries.filter(entry => paradisIsHiddenName(entry.name)).length;
		const selected = this.table.getSelectedElements();
		let text: string;
		if (this.header.filterBox.value.trim()) {
			text = localize('paradis.fileTransfer.footFiltered', "{0} / {1} 項目（絞り込み中）", this.visibleEntries.length, total);
		} else if (selected.length) {
			const bytes = selected.reduce((sum, entry) => sum + (entry.isDirectory ? 0 : entry.size ?? 0), 0);
			text = localize('paradis.fileTransfer.footSelected', "{0} 項目 · {1} 項目を選択（{2}）", total, selected.length, paradisFormatSize(bytes));
		} else if (hidden && !this.showHidden) {
			text = localize('paradis.fileTransfer.footHidden', "{0} 項目 · 隠しファイル {1} 件", total, hidden);
		} else {
			text = localize('paradis.fileTransfer.footTotal', "{0} 項目", total);
		}
		if (this.truncated) {
			text += ' · ' + localize('paradis.fileTransfer.footTruncated', "多すぎるため途中までを出しています");
		}
		this.footer.textContent = text;
	}

	private updateHostState(): void {
		const remote = this.side === 'remote';
		const direct = this.isDirect;
		const authority = this.transferService.remoteAuthority;
		const shown = !remote || direct || !!authority;
		const connected = !remote || direct || (!!authority && this.transferService.remoteConnected);
		this.header.hostName.textContent = this.label;
		this.header.hostDot.classList.toggle('connected', remote && connected);
		this.header.hostDot.classList.toggle('disconnected', remote && !connected && !!authority);
		dom.setVisibility(remote && shown, this.header.hostDot);
		this.header.hostSub.textContent = !remote
			? localize('paradis.fileTransfer.local', "ローカル")
			: direct
				? localize('paradis.fileTransfer.directSsh', "SSH（直接）")
				: authority ? authority.split('+')[0].replace(/^ssh-remote$/, 'SSH') : '';
		dom.setVisibility(shown, this.header.filterBox.element, this.header.actionsButton, this.navParts.nav);
		if (!shown || this.location) {
			this.renderMessage();
		}
	}

	private updateNavButtons(): void {
		this.navParts.back.disabled = this.backStack.length === 0;
		this.navParts.forward.disabled = this.forwardStack.length === 0;
		this.navParts.up.disabled = !this.location || extUri.isEqual(dirname(this.location), this.location);
	}

	private updateFileIconClass(): void {
		const theme = this.themeService.getFileIconTheme();
		this.element.classList.toggle('show-file-icons', theme.hasFileIcons);
		this.element.classList.toggle('align-icons-and-twisties', theme.hasFileIcons && !theme.hasFolderIcons);
	}

	private navButton(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => void): HTMLButtonElement {
		const button = dom.append(parent, $<HTMLButtonElement>('button.para-ft-nav-button'));
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.title = label;
		dom.append(button, $(`span${ThemeIcon.asCSSSelector(icon)}`));
		this._register(dom.addDisposableListener(button, 'click', () => run()));
		return button;
	}

	// --- 転送 --------------------------------------------------------------------------------------

	/** 選んだ項目を反対側の今のフォルダーへ送る。 */
	async copyToOtherSide(entries: readonly IParadisPaneEntry[]): Promise<void> {
		const other = this.host.otherPane(this.side);
		const targetDirectory = other?.currentLocation;
		if (!entries.length || !other || !targetDirectory || !other.canReceive()) {
			return;
		}
		await this.transferTo(entries, targetDirectory, other.side);
	}

	private async transferTo(entries: readonly IParadisPaneEntry[], targetDirectory: URI, targetSide: ParadisTransferSide): Promise<void> {
		try {
			await this.transferService.transfer(entries.map(paradisTransferSourceFor), targetDirectory, targetSide);
		} catch (error) {
			this.notificationService.error(error);
		}
	}

	private showDropCaption(targetDirectory: URI, count: number): void {
		const where = this.side === 'remote' ? `${this.label}:${targetDirectory.path}` : targetDirectory.fsPath;
		this.dropCaption.textContent = localize('paradis.fileTransfer.dropCaption', "{0} へ {1} 項目をコピー", where, count);
		dom.show(this.dropCaption);
		this.element.classList.add('para-ft-dropping');
	}

	private hideDropCaption(): void {
		dom.hide(this.dropCaption);
		this.element.classList.remove('para-ft-dropping');
	}

	// --- 寸法 --------------------------------------------------------------------------------------

	layout(width: number, height: number): void {
		this.dimension = { width, height };
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
		this.element.classList.toggle('narrow', width < 520);
		this.relayoutTable();
	}

	private relayoutTable(): void {
		if (!this.dimension.height || this.tableHost.style.display === 'none') {
			return;
		}
		const fixed = [this.header.head, this.navParts.nav, this.banner, this.footer].reduce((sum, element) => sum + element.offsetHeight, 0);
		const height = Math.max(60, this.dimension.height - fixed);
		this.tableHost.style.height = `${height}px`;
		this.table.layout(height, this.dimension.width);
	}

	private focusTable(first: boolean): void {
		this.table.domFocus();
		if ((first || this.table.getFocus().length === 0) && this.visibleEntries.length) {
			this.table.setFocus([0]);
		}
	}

	focus(): void {
		if (this.tableHost.style.display !== 'none') {
			this.focusTable(false);
		} else {
			this.element.focus();
		}
	}
}
