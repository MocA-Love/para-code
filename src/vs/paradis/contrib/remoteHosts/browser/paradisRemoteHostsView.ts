/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import './media/paradisRemoteHosts.css';
import * as DOM from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IListVirtualDelegate, ListDragOverEffectPosition, ListDragOverEffectType } from '../../../../base/browser/ui/list/list.js';
import { ElementsDragAndDropData } from '../../../../base/browser/ui/list/listView.js';
import { IDragAndDropData } from '../../../../base/browser/dnd.js';
import { IAsyncDataSource, ITreeDragAndDrop, ITreeDragOverReaction, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { FuzzyScore } from '../../../../base/common/filters.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { WorkbenchAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProgressService } from '../../../../platform/progress/common/progress.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisWorkspaceSwitchService, paradisWorkspaceColorHex } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	isParadisRemoteFileEntry,
	isParadisRemoteHost,
	isParadisRemoteSpace,
	paradisAllowsHostDrop,
	paradisIsOfflineHostKey,
	paradisIsSafeSshHost,
	paradisOfflineAliasOf,
	paradisParseSpacesByHost,
	paradisRemoteHostBrowser,
	PARADIS_OFFLINE_HOST_PREFIX,
	PARADIS_OFFLINE_URI_SCHEME,
	ParadisRemoteFileEntry,
	ParadisRemoteHost,
	ParadisRemoteHostsElement,
	ParadisRemoteSpace,
} from '../common/paradisRemoteHosts.js';
import {
	IParadisRemoteTransferServices,
	IParadisRemoteTransferSource,
	paradisCopyToDirectory,
	paradisPickLocalFiles,
	paradisSaveToMachine,
	paradisSendToHost,
} from './paradisRemoteHostsTransfer.js';

// --- ツリーの入力と要素の絞り込み ----------------------------------------------------------------------

/** ツリーのルート入力。AsyncDataTree の都合上、null 以外のオブジェクトを1つ置く。 */
interface ParadisRemoteHostsRoot {
	readonly root: true;
}

const ROOT_INPUT: ParadisRemoteHostsRoot = { root: true };

/** ドロップを受けられる行 (= フォルダーとして中身を持てる場所)。 */
interface DropTarget {
	readonly hostKey: string;
	readonly uri: URI;
}

/** 転送の出発点になりうる行。 */
type TransferableElement = ParadisRemoteSpace | ParadisRemoteFileEntry;

function asDropTarget(element: ParadisRemoteHostsElement): DropTarget | undefined {
	// 未接続ホストは閲覧専用。ドロップ先にも掴む対象にもしない
	if (paradisIsOfflineHostKey(element.hostKey)) {
		return undefined;
	}
	if (isParadisRemoteSpace(element)) {
		return element;
	}
	if (isParadisRemoteFileEntry(element) && element.type === 'dir') {
		return { hostKey: element.hostKey, uri: element.uri };
	}
	return undefined;
}

function asTransferSource(element: TransferableElement): IParadisRemoteTransferSource {
	return {
		uri: element.uri,
		name: element.name,
		isDirectory: element.type !== 'file',
	};
}

// allow-any-unicode-next-line
function hostLabelFromAuthority(authority: string): string {
	return authority.replace(/^ssh-remote\+/, '');
}

/** 「今後確認しない」を選んだホストの保存キー。 */
const PARADIS_OFFLINE_APPROVED_STORAGE_KEY = 'paradis.remoteHosts.approvedOfflineHosts';

// --- データソース --------------------------------------------------------------------------------

class DataSource implements IAsyncDataSource<ParadisRemoteHostsRoot, ParadisRemoteHostsElement> {
	constructor(private readonly view: ParadisRemoteHostsView) { }

	hasChildren(element: ParadisRemoteHostsRoot | ParadisRemoteHostsElement): boolean {
		if ((element as ParadisRemoteHostsRoot).root) {
			return true;
		}
		return (element as ParadisRemoteHostsElement).type !== 'file';
	}

	async getChildren(element: ParadisRemoteHostsRoot | ParadisRemoteHostsElement): Promise<Iterable<ParadisRemoteHostsElement>> {
		if ((element as ParadisRemoteHostsRoot).root) {
			return this.view.computeHostElements();
		}
		const node = element as ParadisRemoteHostsElement;
		// 未接続ホストの配下は ssh で読む。スペース台帳はそのホストへ繋がって初めて読めるので、
		// ここではホーム直下をそのまま出す
		if (paradisIsOfflineHostKey(node.hostKey)) {
			return this.view.computeOfflineEntries(node as ParadisRemoteHost | ParadisRemoteFileEntry);
		}
		if (isParadisRemoteHost(node)) {
			return this.view.computeSpaceElements(node);
		}
		return this.view.computeFileEntries(node);
	}
}

// --- デリゲート / レンダラー -----------------------------------------------------------------------

class TreeDelegate implements IListVirtualDelegate<ParadisRemoteHostsElement> {
	getHeight(_element: ParadisRemoteHostsElement): number {
		return 22;
	}

	getTemplateId(element: ParadisRemoteHostsElement): string {
		if (isParadisRemoteHost(element)) {
			return HostRenderer.TEMPLATE_ID;
		}
		if (isParadisRemoteSpace(element)) {
			return SpaceRenderer.TEMPLATE_ID;
		}
		return FileRenderer.TEMPLATE_ID;
	}
}

interface IRowTemplateData {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly meta: HTMLElement;
	readonly actionsContainer: HTMLElement;
	readonly actionBar: ActionBar;
	readonly disposables: DisposableStore;
}

/** スペース行・ファイル行の共通テンプレート。ホスト行は専用テンプレート (HostRenderer) を使う。 */
abstract class RowRenderer<T extends TransferableElement> implements ITreeRenderer<T, FuzzyScore, IRowTemplateData> {
	abstract readonly templateId: string;

	constructor(
		/** ホバー時に出す転送ボタン。要素ごとの可否判断も含めてビュー側が返す。 */
		private readonly inlineActions: (element: T) => readonly IAction[],
	) { }

	renderTemplate(container: HTMLElement): IRowTemplateData {
		const row = DOM.append(container, DOM.$('.para-rh-row'));
		const icon = DOM.append(row, DOM.$('span.para-rh-icon'));
		const name = DOM.append(row, DOM.$('.para-rh-name'));
		const meta = DOM.append(row, DOM.$('.para-rh-meta'));
		const actionsContainer = DOM.append(row, DOM.$('.para-rh-actions'));
		const actionBar = new ActionBar(actionsContainer);
		return { row, icon, name, meta, actionsContainer, actionBar, disposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<T, FuzzyScore>, _index: number, templateData: IRowTemplateData): void {
		templateData.actionBar.clear();
		this.renderRow(node.element, templateData);
		for (const action of this.inlineActions(node.element)) {
			templateData.actionBar.push(action, { icon: true, label: false });
		}
	}

	protected abstract renderRow(element: T, templateData: IRowTemplateData): void;

	disposeTemplate(templateData: IRowTemplateData): void {
		templateData.actionBar.dispose();
		templateData.disposables.dispose();
	}
}

/** ホスト見出し行。ラベル + 接続中表示のみで、アクションは持たない。 */
interface IHostRowTemplateData extends IRowTemplateData {
	readonly connectedDot: HTMLElement;
}

class HostRenderer implements ITreeRenderer<ParadisRemoteHost, FuzzyScore, IHostRowTemplateData> {

	static readonly TEMPLATE_ID = 'para-rh-host';
	readonly templateId = HostRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IHostRowTemplateData {
		const row = DOM.append(container, DOM.$('.para-rh-row'));
		const icon = DOM.append(row, DOM.$('span.para-rh-icon'));
		const connectedDot = DOM.append(row, DOM.$('span.para-rh-icon.connected-dot.codicon.codicon-circle-filled.hidden'));
		connectedDot.title = localize('paraRemoteHosts.connectedDot', "このウィンドウはこのホストに接続しています");
		const name = DOM.append(row, DOM.$('.para-rh-name.para-rh-host-label'));
		const meta = DOM.append(row, DOM.$('.para-rh-meta'));
		const actionsContainer = DOM.append(row, DOM.$('.para-rh-actions'));
		const actionBar = new ActionBar(actionsContainer);
		return { row, icon, connectedDot, name, meta, actionsContainer, actionBar, disposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<ParadisRemoteHost, FuzzyScore>, _index: number, templateData: IHostRowTemplateData): void {
		templateData.actionBar.clear();
		const element = node.element;
		const isLocal = element.hostKey === '';
		templateData.icon.className = `para-rh-icon ${isLocal ? 'host-local' : 'host-ssh'} ${ThemeIcon.asClassName(isLocal ? Codicon.vm : Codicon.server)}`;
		templateData.icon.title = isLocal ? localize('paraRemoteHosts.localMachine', "このマシン") : element.label;
		// 緑ドットは「いつもと違う方」= SSH 先が繋がっているときだけ (手元は大半がこちらなので)
		templateData.connectedDot.classList.toggle('hidden', isLocal || !element.connected);
		templateData.name.textContent = element.label;
		// 未接続ホストは薄字にして、閲覧しかできないことを行だけで分かるようにする
		templateData.row.classList.toggle('offline', !!element.offline);
		templateData.meta.textContent = element.offline
			? localize('paraRemoteHosts.offlineBadge', "未接続")
			: '';
		templateData.row.title = element.offline
			? localize('paraRemoteHosts.offlineHostTooltip', "展開すると ssh でファイル一覧を取得します (閲覧のみ)")
			: '';
		// 色帯はスペース行専用。行は使い回されるので、他のテンプレートでは必ず透明へ戻す
		templateData.row.closest<HTMLElement>('.monaco-tl-row')?.style.setProperty('--para-rh-color', 'transparent');
	}

	disposeTemplate(templateData: IHostRowTemplateData): void {
		templateData.actionBar.dispose();
		templateData.disposables.dispose();
	}
}

class SpaceRenderer extends RowRenderer<ParadisRemoteSpace> {
	static readonly TEMPLATE_ID = 'para-rh-space';
	override readonly templateId = SpaceRenderer.TEMPLATE_ID;

	protected renderRow(element: ParadisRemoteSpace, templateData: IRowTemplateData): void {
		templateData.icon.className = `para-rh-icon space ${ThemeIcon.asClassName(Codicon.repo)}`;
		templateData.name.textContent = element.name;
		templateData.name.title = element.uri.path;
		templateData.meta.textContent = '';

		// Workspaces ビューと同じ固定パレットの色を行左端の帯へ反映する
		const colorHex = paradisWorkspaceColorHex(element.color);
		templateData.row.closest<HTMLElement>('.monaco-tl-row')?.style.setProperty('--para-rh-color', colorHex ?? 'transparent');

		templateData.actionsContainer.classList.remove('has-meta');
	}
}

class FileRenderer extends RowRenderer<ParadisRemoteFileEntry> {
	static readonly TEMPLATE_ID = 'para-rh-file';
	override readonly templateId = FileRenderer.TEMPLATE_ID;

	protected renderRow(element: ParadisRemoteFileEntry, templateData: IRowTemplateData): void {
		const isDir = element.type === 'dir';
		templateData.icon.className = `para-rh-icon ${isDir ? 'dir' : 'file'} ${ThemeIcon.asClassName(isDir ? Codicon.folder : Codicon.file)}`;
		templateData.icon.title = '';
		templateData.name.textContent = element.name;
		templateData.meta.textContent = '';
		templateData.row.closest<HTMLElement>('.monaco-tl-row')?.style.setProperty('--para-rh-color', 'transparent');
	}
}

// --- ドラッグ&ドロップ -----------------------------------------------------------------------------

class HostDragAndDrop implements ITreeDragAndDrop<ParadisRemoteHostsElement> {
	constructor(private readonly handleDrop: (sources: readonly TransferableElement[], target: DropTarget) => Promise<void>) { }

	getDragURI(element: ParadisRemoteHostsElement): string | null {
		// 未接続ホスト配下は転送できないので、掴めるようにもしない
		// (掴めるとコピーカーソルが出て、落とせるように見えてしまう)
		if (paradisIsOfflineHostKey(element.hostKey)) {
			return null;
		}
		if (isParadisRemoteSpace(element) || isParadisRemoteFileEntry(element)) {
			return element.uri.toString();
		}
		return null;
	}

	getDragLabel(elements: readonly ParadisRemoteHostsElement[]): string | undefined {
		if (!elements.length) {
			return undefined;
		}
		return elements.map(element => isParadisRemoteHost(element) ? element.label : element.name).join(', ');
	}

	onDragOver(data: IDragAndDropData, targetElement: ParadisRemoteHostsElement | undefined): boolean | ITreeDragOverReaction {
		const sources = this.draggedSources(data);
		const target = targetElement ? asDropTarget(targetElement) : undefined;
		if (!target || !this.canDrop(sources, target)) {
			return false;
		}
		return { accept: true, effect: { type: ListDragOverEffectType.Copy, position: ListDragOverEffectPosition.Over } };
	}

	drop(data: IDragAndDropData, targetElement: ParadisRemoteHostsElement | undefined): void {
		const sources = this.draggedSources(data);
		const target = targetElement ? asDropTarget(targetElement) : undefined;
		// onDragOver と同じ判定をここでも通す。drop が呼ばれるのは直前の dragover を受理した
		// ときだけだが、その受理は「最後にホバーした行」に対するもので、実際に落ちた行とは
		// 限らない (素早く動かすとずれる)。データを動かす手前で必ずもう一度確かめる。
		if (target && this.canDrop(sources, target)) {
			this.handleDrop(sources, target);
		}
	}

	/** 同じマシン内のドロップは受けない (paradisAllowsHostDrop 参照)。 */
	private canDrop(sources: readonly TransferableElement[], target: DropTarget): boolean {
		return paradisAllowsHostDrop(sources.map(source => source.hostKey), target.hostKey);
	}

	dispose(): void { }

	private draggedSources(data: IDragAndDropData): readonly TransferableElement[] {
		if (!(data instanceof ElementsDragAndDropData)) {
			return [];
		}
		return data.elements.filter((element): element is TransferableElement =>
			isParadisRemoteSpace(element) || isParadisRemoteFileEntry(element));
	}
}

// --- ビュー -------------------------------------------------------------------------------------

export class ParadisRemoteHostsView extends ViewPane {

	private tree: WorkbenchAsyncDataTree<ParadisRemoteHostsRoot, ParadisRemoteHostsElement, FuzzyScore> | undefined;
	/** 接続先ホストのユーザーホーム。「送る」ダイアログの初期位置に使う */
	private remoteUserHome: URI | undefined;
	/** このウィンドウで一覧取得に同意済みの未接続ホスト (ssh 別名)。 */
	private readonly approvedOfflineHosts = new Set<string>();
	private readonly transferServices: IParadisRemoteTransferServices;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ILabelService private readonly labelService: ILabelService,
		@IEditorService private readonly editorService: IEditorService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileDialogService fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IPathService private readonly pathService: IPathService,
		@IProgressService progressService: IProgressService,
		@IHostService private readonly hostService: IHostService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IStorageService private readonly storageService: IStorageService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.transferServices = { dialogService, fileDialogService, fileService, notificationService, progressService };

		// スペース台帳が変わったら一覧を追従させる (登録・削除・色変更など)
		this._register(workspaceSwitchService.onDidChangeRepositories(() => { this.refresh(); }));
	}

	/** このウィンドウの接続先 authority。手元ウィンドウでは undefined */
	get remoteAuthority(): string | undefined {
		return this.environmentService.remoteAuthority || undefined;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('para-rh-pane-body');

		const treeContainer = DOM.append(container, DOM.$('.para-rh-list'));

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<ParadisRemoteHostsRoot, ParadisRemoteHostsElement, FuzzyScore>,
			'ParadisRemoteHosts',
			treeContainer,
			new TreeDelegate(),
			[
				new HostRenderer(),
				new SpaceRenderer(element => this.inlineActionsFor(element)),
				new FileRenderer(element => this.inlineActionsFor(element)),
			],
			new DataSource(this),
			{
				identityProvider: {
					getId: (element: ParadisRemoteHostsElement) => {
						if (isParadisRemoteHost(element)) {
							return `host:${element.hostKey}`;
						}
						if (isParadisRemoteSpace(element)) {
							return `space:${element.repositoryId}`;
						}
						return element.uri.toString();
					},
				},
				horizontalScrolling: false,
				dnd: new HostDragAndDrop((sources, target) => this.dropInto(sources, target)),
				accessibilityProvider: {
					// allow-any-unicode-next-line
					getAriaLabel: (element: ParadisRemoteHostsElement) => isParadisRemoteHost(element) ? element.label : element.name,
					// allow-any-unicode-next-line
					getWidgetAriaLabel: () => localize('paraRemoteHosts.treeAria', "Para ホスト"),
				},
			},
		));

		// クリックでファイルを開く。フォルダー・スペース・ホストはツリー標準の開閉に任せる
		this._register(this.tree.onDidOpen(event => {
			const element = event.element;
			// 未接続ホストのファイルは開けない (paradis-offline スキームのプロバイダは無い)。
			// 押すたびにエラーを出すより、何もしない方がまし
			if (element && isParadisRemoteFileEntry(element) && element.type === 'file'
				&& !paradisIsOfflineHostKey(element.hostKey)) {
				void this.openFile(element);
			}
		}));

		this._register(this.tree.onContextMenu(event => {
			const element = event.element;
			if (!element) {
				return;
			}
			// 未接続ホストの見出し行だけはメニューを出す。展開に失敗するホストほど
			// 「接続して開く」への導線が要るのに、子要素からしか辿れないと辿り着けない
			if (isParadisRemoteHost(element)) {
				const alias = element.offline ? (element.sshAlias ?? element.label) : undefined;
				if (alias === undefined) {
					return;
				}
				this.contextMenuService.showContextMenu({
					getAnchor: () => event.anchor,
					getActions: () => this.buildOfflineHostActions(alias),
				});
				return;
			}
			this.contextMenuService.showContextMenu({
				getAnchor: () => event.anchor,
				getActions: () => this.buildContextMenuActions(element),
			});
		}));

		void this.tree.setInput(ROOT_INPUT);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}

	override focus(): void {
		super.focus();
		this.tree?.domFocus();
	}

	/** 展開済みノードを再読み込みする (タイトルバーの「更新」からも呼ばれる)。 */
	async refresh(): Promise<void> {
		await this.tree?.updateChildren();
	}

	// --- ツリーの中身 -------------------------------------------------------------------------------

	/**
	 * ルート直下。手元は常に出し、このウィンドウが接続しているホストも並べる。
	 *
	 * スペース台帳は接続先ごとの保管領域に分かれて書かれるため、1つのウィンドウから読めるのは
	 * 「繋がっている側」ぶんだけ。それでも手元ウィンドウでは手元の台帳、SSH ウィンドウでは
	 * SSH 側の台帳が出るので、各ウィンドウで両サイド (手元 + 接続先) のブラウズが成立する。
	 */
	async computeHostElements(): Promise<readonly ParadisRemoteHost[]> {
		const hosts: ParadisRemoteHost[] = [];
		hosts.push({
			type: 'host',
			hostKey: '',
			label: localize('paraRemoteHosts.thisMachine', "このマシン"),
			// 緑ドットは SSH 側専用のため手元は常に false。renderer でも隠れる
			connected: false,
			homeUri: this.getLocalUserHome(),
		});
		const authority = this.remoteAuthority;
		let connectedLabel: string | undefined;
		if (authority) {
			const environment = await this.remoteAgentService.getEnvironment().catch(() => null);
			this.remoteUserHome = environment?.userHome;
			connectedLabel = hostLabelFromAuthority(authority);
			hosts.push({
				type: 'host',
				hostKey: authority,
				label: connectedLabel,
				connected: true,
				homeUri: environment?.userHome,
			});
		} else {
			this.remoteUserHome = undefined;
		}

		// `~/.ssh/config` に書いてあるだけのホストも並べる。中身は展開したときに ssh で読む
		// (Web には実装が差し込まれないので、その環境では今までどおり接続中のぶんだけ出る)
		const browser = paradisRemoteHostBrowser();
		if (browser) {
			const configured = await browser.listConfiguredHosts().catch(() => []);
			// 同じ別名が config 本体と Include の両方に書いてあることは珍しくない。
			// 重ねるとツリーの identity が衝突するので、ここで一意にしておく
			const seen = new Set<string>(connectedLabel !== undefined ? [connectedLabel] : []);
			for (const alias of configured) {
				// 今まさに繋がっているホストは上で接続済みとして出しているので重ねない。
				// ssh へ渡せない別名は、展開したらエラーになるだけなので最初から出さない
				if (seen.has(alias) || !paradisIsSafeSshHost(alias)) {
					continue;
				}
				seen.add(alias);
				hosts.push({
					type: 'host',
					hostKey: `${PARADIS_OFFLINE_HOST_PREFIX}${alias}`,
					label: alias,
					connected: false,
					homeUri: undefined,
					offline: true,
					sshAlias: alias,
				});
			}
		}
		return hosts;
	}

	/**
	 * 未接続ホストを展開してよいか尋ねる。同意したホストは覚える。
	 *
	 * 黙って ssh を起こさないのは、繋がっているホストと違って**新しく認証が走り得る**ため。
	 * shared process には端末が無いので、鍵のパスフレーズや多要素を聞かれると
	 * (BatchMode で即失敗はするものの) ユーザーからは「展開しただけで固まった」ように見える。
	 */
	private async confirmOfflineBrowse(host: ParadisRemoteHost): Promise<boolean> {
		const alias = host.sshAlias ?? host.label;
		if (this.approvedOfflineHosts.has(alias) || this.rememberedOfflineHosts().includes(alias)) {
			return true;
		}
		const result = await this.dialogService.confirm({
			message: localize('paraRemoteHosts.offlineConfirm', "{0} のファイル一覧を取得しますか?", alias),
			detail: localize('paraRemoteHosts.offlineConfirmDetail', "未接続のため ssh で直接読み取ります。初めてのホストなら、その鍵を known_hosts へ登録します（鍵が後から変わった場合は拒否されます）。パスフレーズや多要素認証が必要なホストは、ここでは読み取れないため「このホストに接続して開く」から繋いでください。"),
			primaryButton: localize('paraRemoteHosts.offlineConfirmYes', "取得"),
			checkbox: { label: localize('paraRemoteHosts.offlineConfirmRemember', "このホストでは今後確認しない") },
		});
		if (!result.confirmed) {
			return false;
		}
		this.approvedOfflineHosts.add(alias);
		if (result.checkboxChecked) {
			const remembered = new Set(this.rememberedOfflineHosts());
			remembered.add(alias);
			this.storageService.store(PARADIS_OFFLINE_APPROVED_STORAGE_KEY, JSON.stringify([...remembered]), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		return true;
	}

	/** 「今後確認しない」を選んだホスト。壊れた保存値は空扱いにする。 */
	private rememberedOfflineHosts(): string[] {
		try {
			const raw = JSON.parse(this.storageService.get(PARADIS_OFFLINE_APPROVED_STORAGE_KEY, StorageScope.APPLICATION, '[]'));
			return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
		} catch {
			return [];
		}
	}

	/** 未接続ホストの中身を ssh で読む。閲覧専用なので転送系のアクションは付けない。 */
	async computeOfflineEntries(element: ParadisRemoteHost | ParadisRemoteFileEntry): Promise<readonly ParadisRemoteFileEntry[]> {
		const browser = paradisRemoteHostBrowser();
		if (!browser) {
			return [];
		}
		const alias = paradisOfflineAliasOf(element.hostKey);
		if (!alias) {
			return [];
		}
		if (isParadisRemoteHost(element) && !await this.confirmOfflineBrowse(element)) {
			return [];
		}
		// ホスト直下はホーム。以降は前の行が持っているパスを継ぐ
		const path = isParadisRemoteHost(element) ? '' : element.uri.path;
		try {
			const listing = await browser.listDirectory(alias, path);
			const base = path.length > 0 ? path : '~';
			if (listing.truncated) {
				// 打ち切ったことを黙っていると「これで全部」と読めてしまう
				this.notificationService.warn(localize('paraRemoteHosts.offlineTruncated', "{0} のファイルが多いため、一覧の先頭だけを表示しています。", alias));
			}
			return listing.entries.map(entry => ({
				type: entry.isDirectory ? 'dir' as const : 'file' as const,
				hostKey: element.hostKey,
				// 未接続ホストの URI は表示とパスの継承にしか使わない (fileService は解決できない)。
				// 転送に使われないよう、専用スキームを付けて実在の file:// と混ざらないようにする
				uri: URI.from({ scheme: PARADIS_OFFLINE_URI_SCHEME, authority: alias, path: base === '~' ? `/~/${entry.name}` : `${base}/${entry.name}` }),
				name: entry.name,
			}));
		} catch (error) {
			this.notificationService.error(localize('paraRemoteHosts.offlineListFailed', "{0} のファイル一覧を取得できませんでした: {1}", alias, error instanceof Error ? error.message : String(error)));
			return [];
		}
	}

	computeSpaceElements(host: ParadisRemoteHost): readonly ParadisRemoteSpace[] {
		const spaces = (paradisParseSpacesByHost(this.storageService).get(host.hostKey) ?? []).map(repository => ({
			type: 'space' as const,
			hostKey: host.hostKey,
			repositoryId: repository.id,
			name: repository.name,
			uri: repository.uri,
			color: repository.color,
		}));
		if (host.homeUri) {
			spaces.push({
				type: 'space',
				hostKey: host.hostKey,
				repositoryId: `paradis.home:${host.hostKey}`,
				name: localize('paraRemoteHosts.homeDirectory', "ホーム"),
				uri: host.homeUri,
				color: undefined,
			});
		}
		return spaces;
	}

	async computeFileEntries(element: ParadisRemoteSpace | ParadisRemoteFileEntry): Promise<readonly ParadisRemoteFileEntry[]> {
		try {
			// resolveMetadata は子ごとに stat が飛ぶため SSH 越しでは往復が跳ねる。
			// エクスプローラーと同じくメタデータなしの一覧解決に留める
			const stat = await this.fileService.resolve(element.uri);
			const children = [...stat.children ?? []].sort((a, b) =>
				Number(b.isDirectory) - Number(a.isDirectory) ||
				a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
			return children.map(child => ({
				type: child.isDirectory ? 'dir' as const : 'file' as const,
				hostKey: element.hostKey,
				uri: child.resource,
				name: child.name,
			}));
		} catch (error) {
			this.notificationService.error(error);
			return [];
		}
	}

	// --- 操作 --------------------------------------------------------------------------------------

	/**
	 * 未接続ホストへ実際に繋いだウィンドウを開く。
	 *
	 * ここから先は upstream の SSH 接続そのものなので、繋がった側のウィンドウでは
	 * 「Para ホスト」も接続済みホストとして中身を出し、転送も使えるようになる。
	 */
	private async connectToOfflineHost(alias: string): Promise<void> {
		try {
			await this.hostService.openWindow({ remoteAuthority: `ssh-remote+${alias}` });
		} catch (error) {
			this.notificationService.error(error);
		}
	}

	private async openFile(element: ParadisRemoteFileEntry): Promise<void> {
		await this.editorService.openEditor({ resource: element.uri }).catch(error => this.notificationService.error(error));
	}

	/**
	 * 手元 (ローカルマシン) のユーザーホーム。web ウィンドウでは接続先 URI が返ることがある
	 * (guessLocalUserHome がワークスペースフォルダにフォールバックするため) ので、
	 * file スキームのときだけ使う。
	 */
	private getLocalUserHome(): URI | undefined {
		const home = this.pathService.userHome({ preferLocal: true });
		return home?.scheme === Schemas.file ? home : undefined;
	}

	private async saveToMachine(element: TransferableElement): Promise<void> {
		try {
			const localUserHome = this.getLocalUserHome();
			if (!localUserHome) {
				this.notificationService.info(localize('paraRemoteHosts.saveUnavailable', "このウィンドウでは手元への保存を利用できません"));
				return;
			}
			await paradisSaveToMachine(this.transferServices, asTransferSource(element), localUserHome);
			// 転送先 (このマシン) もこのツリーに出ている。D&D・アップロードと同じく反映させる
			await this.refresh();
		} catch (error) {
			this.notificationService.error(error);
		}
	}

	private async sendToHost(element: TransferableElement): Promise<void> {
		if (!this.remoteAuthority) {
			return;
		}
		try {
			await paradisSendToHost(this.transferServices, asTransferSource(element), this.remoteUserHome);
			// 転送先 (接続先ホスト) もこのツリーに出ている。D&D・アップロードと同じく反映させる
			await this.refresh();
		} catch (error) {
			this.notificationService.error(error);
		}
	}

	private async uploadInto(target: DropTarget): Promise<void> {
		try {
			const localUserHome = this.getLocalUserHome();
			if (!localUserHome) {
				this.notificationService.info(localize('paraRemoteHosts.uploadUnavailable', "このウィンドウでは手元からのアップロードを利用できません"));
				return;
			}
			const files = await paradisPickLocalFiles(this.transferServices, localUserHome);
			if (!files.length) {
				return;
			}
			await paradisCopyToDirectory(
				this.transferServices,
				files.map(uri => ({ uri, name: basename(uri), isDirectory: false })),
				target.uri,
			);
			await this.refresh();
		} catch (error) {
			this.notificationService.error(error);
		}
	}

	private async dropInto(sources: readonly TransferableElement[], target: DropTarget): Promise<void> {
		if (!sources.length) {
			return;
		}
		try {
			await paradisCopyToDirectory(this.transferServices, sources.map(source => asTransferSource(source)), target.uri);
			await this.refresh();
		} catch (error) {
			this.notificationService.error(error);
		}
	}

	// --- アクション ----------------------------------------------------------------------------------

	/** ホバー時の転送ボタン。要素の所属とこのウィンドウの接続先から取れる操作だけを出す。 */
	private inlineActionsFor(element: TransferableElement): readonly IAction[] {
		const actions: IAction[] = [];
		let actionIndex = 0;
		const push = (label: string, icon: ThemeIcon, run: () => Promise<void>) =>
			actions.push(new Action(`para-rh-inline-${actionIndex++}`, label, ThemeIcon.asClassName(icon), true, run));

		// 未接続ホストは閲覧専用。転送は IFileService.copy に載っていて、この URI は解決できない。
		// 押してから失敗させるより項目を出さない方がよい (接続への導線は右クリック側に出す)
		if (paradisIsOfflineHostKey(element.hostKey)) {
			return actions;
		}

		if (element.hostKey !== '') {
			push(localize('paraRemoteHosts.saveToLocal', "このマシンへ保存…"), Codicon.cloudDownload, () => this.saveToMachine(element));
			const dirTarget = asDropTarget(element);
			if (dirTarget) {
				push(localize('paraRemoteHosts.uploadHere', "ローカルからアップロード…"), Codicon.cloudUpload, () => this.uploadInto(dirTarget));
			}
		} else if (this.remoteAuthority) {
			push(localize('paraRemoteHosts.sendToHost', "{0} へ送る…", hostLabelFromAuthority(this.remoteAuthority)), Codicon.cloudUpload, () => this.sendToHost(element));
		}
		return actions;
	}

	/**
	 * 未接続ホスト (とその配下) のメニュー。転送は出さず、まず接続への導線を出す。
	 * 「押したら失敗する項目」を並べるより、繋ぐ道を示す方が親切。
	 */
	private buildOfflineHostActions(alias: string, uri?: URI): readonly IAction[] {
		const actions: IAction[] = [];
		let index = 0;
		const push = (label: string, icon: ThemeIcon, run: () => Promise<void>) =>
			actions.push(new Action(`para-rh-offline-${index++}`, label, ThemeIcon.asClassName(icon), true, run));

		push(localize('paraRemoteHosts.connectAndOpen', "このホストに接続して開く"), Codicon.plug, () => this.connectToOfflineHost(alias));
		actions.push(new Separator());
		if (uri) {
			push(localize('paraRemoteHosts.copyPath', "パスをコピー"), Codicon.clippy, async () => {
				// 未接続ホストのパスは表示用に組み立てた URI なので、ホーム基準の印を人が読める形へ戻す
				await this.clipboardService.writeText(uri.path.replace(/^\/~\//, '~/'));
			});
		}
		push(localize('paraRemoteHosts.copyHostName', "ホスト名をコピー"), Codicon.clippy, async () => {
			await this.clipboardService.writeText(alias);
		});
		return actions;
	}

	private buildContextMenuActions(element: TransferableElement): readonly IAction[] {
		const actions: IAction[] = [];
		let index = 0;
		const push = (label: string, icon: ThemeIcon | undefined, run: () => Promise<void>, enabled = true) =>
			actions.push(new Action(`para-rh-context-${index++}`, label, icon ? ThemeIcon.asClassName(icon) : undefined, enabled, run));
		const pushSeparator = () => {
			if (actions.length && !(actions[actions.length - 1] instanceof Separator)) {
				actions.push(new Separator());
			}
		};

		// 未接続ホスト配下は開く/転送ができないので、まず「繋いでから開く」導線を出す
		const offlineAlias = paradisOfflineAliasOf(element.hostKey);
		if (offlineAlias !== undefined) {
			return this.buildOfflineHostActions(offlineAlias, element.uri);
		}

		if (isParadisRemoteFileEntry(element) && element.type === 'file') {
			push(localize('paraRemoteHosts.open', "開く"), Codicon.goToFile, () => this.openFile(element));
		}

		for (const action of this.inlineActionsFor(element)) {
			if (actions.length) {
				pushSeparator();
			}
			actions.push(action);
		}

		pushSeparator();
		push(localize('paraRemoteHosts.copyPath', "パスをコピー"), Codicon.clippy, async () => {
			await this.clipboardService.writeText(this.labelService.getUriLabel(element.uri, { relative: false, noPrefix: true }));
		});

		return actions;
	}
}
