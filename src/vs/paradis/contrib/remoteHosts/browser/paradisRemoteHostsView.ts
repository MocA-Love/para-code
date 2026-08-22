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
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
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
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisWorkspaceSwitchService, paradisWorkspaceColorHex } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	isParadisRemoteFileEntry,
	isParadisRemoteHost,
	isParadisRemoteSpace,
	paradisParseSpacesByHost,
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

/** サイズを人間に読める形へ。KB / MB / GB は1桁。 */
function formatSize(size: number | undefined): string {
	if (!size || size < 0) {
		return '';
	}
	const kb = size / 1024;
	if (kb < 1) {
		return localize('paraRemoteHosts.size.bytes', "{0} B", size);
	}
	const mb = kb / 1024;
	if (mb < 1) {
		return localize('paraRemoteHosts.size.kb', "{0} KB", kb.toFixed(1));
	}
	const gb = mb / 1024;
	if (gb < 1) {
		return localize('paraRemoteHosts.size.mb', "{0} MB", mb.toFixed(1));
	}
	return localize('paraRemoteHosts.size.gb', "{0} GB", gb.toFixed(1));
}

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
		templateData.meta.textContent = '';
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
		templateData.meta.textContent = formatSize(element.type === 'file' ? element.size : undefined);
		templateData.row.closest<HTMLElement>('.monaco-tl-row')?.style.setProperty('--para-rh-color', 'transparent');
		templateData.actionsContainer.classList.toggle('has-meta', templateData.meta.textContent !== '');
	}
}

// --- ドラッグ&ドロップ -----------------------------------------------------------------------------

class HostDragAndDrop implements ITreeDragAndDrop<ParadisRemoteHostsElement> {
	constructor(private readonly handleDrop: (sources: readonly TransferableElement[], target: DropTarget) => Promise<void>) { }

	getDragURI(element: ParadisRemoteHostsElement): string | null {
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
		if (!sources.length || !target) {
			return false;
		}
		// 同じマシン内では受けない (誤って移動させて元の場所から消える事故を避けたい。
		// このビューはあくまで「マシン間のコピー」の入口)
		if (sources.every(source => source.hostKey === target.hostKey)) {
			return false;
		}
		return { accept: true, effect: { type: ListDragOverEffectType.Copy, position: ListDragOverEffectPosition.Over } };
	}

	drop(data: IDragAndDropData, targetElement: ParadisRemoteHostsElement | undefined): void {
		const sources = this.draggedSources(data);
		const target = targetElement ? asDropTarget(targetElement) : undefined;
		if (sources.length && target) {
			this.handleDrop(sources, target);
		}
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
		@IFileDialogService fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IPathService private readonly pathService: IPathService,
		@IProgressService progressService: IProgressService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IStorageService private readonly storageService: IStorageService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.transferServices = { fileDialogService, fileService, notificationService, progressService };

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
			if (element && isParadisRemoteFileEntry(element) && element.type === 'file') {
				void this.openFile(element);
			}
		}));

		this._register(this.tree.onContextMenu(event => {
			const element = event.element;
			if (!element || isParadisRemoteHost(element)) {
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
		const localHome = this.pathService.userHome({ preferLocal: true });
		hosts.push({
			type: 'host',
			hostKey: '',
			label: localize('paraRemoteHosts.thisMachine', "このマシン"),
			connected: !this.remoteAuthority,
			homeUri: localHome ?? undefined,
		});
		const authority = this.remoteAuthority;
		if (authority) {
			const environment = await this.remoteAgentService.getEnvironment().catch(() => null);
			this.remoteUserHome = environment?.userHome;
			hosts.push({
				type: 'host',
				hostKey: authority,
				label: hostLabelFromAuthority(authority),
				connected: true,
				homeUri: environment?.userHome,
			});
		} else {
			this.remoteUserHome = undefined;
		}
		return hosts;
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
			// resolveMetadata を付けてサイズを取る。エクスプローラーほど巨大なディレクトリを
			// 開かない前提なので、サイズ表示を優先する
			const stat = await this.fileService.resolve(element.uri, { resolveMetadata: true });
			const children = [...stat.children ?? []].sort((a, b) =>
				Number(b.isDirectory) - Number(a.isDirectory) ||
				a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
			return children.map(child => ({
				type: child.isDirectory ? 'dir' as const : 'file' as const,
				hostKey: element.hostKey,
				uri: child.resource,
				name: child.name,
				size: child.size,
			}));
		} catch (error) {
			this.notificationService.error(error);
			return [];
		}
	}

	// --- 操作 --------------------------------------------------------------------------------------

	private async openFile(element: ParadisRemoteFileEntry): Promise<void> {
		await this.editorService.openEditor({ resource: element.uri }).catch(error => this.notificationService.error(error));
	}

	private async saveToMachine(element: TransferableElement): Promise<void> {
		const localUserHome = this.pathService.userHome({ preferLocal: true });
		await paradisSaveToMachine(this.transferServices, asTransferSource(element), localUserHome ?? undefined);
	}

	private async sendToHost(element: TransferableElement): Promise<void> {
		if (!this.remoteAuthority) {
			return;
		}
		await paradisSendToHost(this.transferServices, asTransferSource(element), this.remoteUserHome);
	}

	private async uploadInto(target: DropTarget): Promise<void> {
		const localUserHome = this.pathService.userHome({ preferLocal: true });
		const files = await paradisPickLocalFiles(this.transferServices, localUserHome ?? undefined);
		if (!files.length) {
			return;
		}
		await paradisCopyToDirectory(
			this.transferServices,
			files.map(uri => ({ uri, name: basename(uri), isDirectory: false })),
			target.uri,
		);
		this.refresh();
	}

	private async dropInto(sources: readonly TransferableElement[], target: DropTarget): Promise<void> {
		if (!sources.length) {
			return;
		}
		await paradisCopyToDirectory(this.transferServices, sources.map(source => asTransferSource(source)), target.uri);
		this.refresh();
	}

	// --- アクション ----------------------------------------------------------------------------------

	/** ホバー時の転送ボタン。要素の所属とこのウィンドウの接続先から取れる操作だけを出す。 */
	private inlineActionsFor(element: TransferableElement): readonly IAction[] {
		const actions: IAction[] = [];
		let actionIndex = 0;
		const push = (label: string, icon: ThemeIcon, run: () => Promise<void>) =>
			actions.push(new Action(`para-rh-inline-${actionIndex++}`, label, ThemeIcon.asClassName(icon), true, run));

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
