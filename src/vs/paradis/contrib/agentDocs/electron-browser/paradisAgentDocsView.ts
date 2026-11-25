/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 左サイドバーの「資料」ビュー。エージェントが作った資料（HTML・Markdown）を、セッションごと（切り替えで日付・フォルダごと）に並べ、
// 範囲（このセッション・このスペース・すべて）・種類・検索で絞り込む。行を押すと preview_file と同じ規則で開く。
// 台帳は shared process にあり（paradisAgentDocsViewChannel.ts）、ここは読むのと、外す・持ち主にする・有無の記録を頼むだけ。
// 見た目は note-and-design-send-mock.html の画面 9（UI キットの 2 行の行・切り替えの組・チップ・入力欄）。

import './media/paradisAgentDocsView.css';
import * as DOM from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { toAction } from '../../../../base/common/actions.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { FileOperationError, FileOperationResult, FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { GroupsOrder, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { createParadisStatusDot, ParadisCountBadge, ParadisStatusTone } from '../../../browser/paradisBadges.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { showParadisMenu } from '../../../browser/paradisMenu.js';
import { ParadisSegmented } from '../../../browser/paradisSegmented.js';
import { paradisAgentHookRemoteHostId } from '../../agentBrowser/common/paradisAgentHooks.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisAgentDescriptor } from '../../agentChat/common/paradisAgentDescriptor.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IParadisDocFolder, paradisDocKey, paradisIsInsideFolder } from '../common/paradisAgentDocs.js';
import {
	IParadisDocPaneSessionInfo,
	IParadisDocViewRecord,
	PARADIS_AGENT_DOCS_VIEW_CHANNEL,
	PARADIS_AGENT_DOCS_VIEW_ON_DID_CHANGE,
	ParadisAgentDocsViewCall,
	ParadisDocAssignResult,
	ParadisDocDateBucket,
	ParadisDocOwnerStatus,
	ParadisDocsGroup,
	ParadisDocsGrouping,
	ParadisDocsScope,
	paradisDocFileName,
	paradisDocParentPath,
	paradisFilterDocs,
	paradisGroupDocs,
} from '../common/paradisAgentDocsView.js';
import { paradisDocFolderOf } from './paradisAgentDocsChannel.js';

export const PARADIS_AGENT_DOCS_VIEW_ID = 'workbench.view.paradisAgentDocs.list';

/** まとめ方の保存先（ビューのタイトルのメニューからも書く）。 */
export const PARADIS_AGENT_DOCS_GROUPING_STORAGE_KEY = 'paradis.agentDocs.grouping';
const SCOPE_STORAGE_KEY = 'paradis.agentDocs.scope';
const KINDS_STORAGE_KEY = 'paradis.agentDocs.kinds';
/** 有無を確かめる行の上限（見えている範囲の先頭から）。 */
const MAX_STAT_ROWS = 200;
/**
 * ファイルが消えた・現れた知らせから、有無を確かめ直すまでの間。移された資料は追従（paradisAgentDocsRelocate）が先に
 * 記録の場所を書き換えるので、その間「見つからない」に出さない。
 */
const FILE_CHANGE_RECHECK_MS = 1_500;

/** 保存してあるまとめ方。 */
export function paradisReadDocsGrouping(storageService: IStorageService): ParadisDocsGrouping {
	const value = storageService.get(PARADIS_AGENT_DOCS_GROUPING_STORAGE_KEY, StorageScope.PROFILE);
	return value === 'date' || value === 'folder' ? value : 'session';
}

/** ウィンドウの接続先の印（手元は空文字）。接続先の名前から印を作れない窓は undefined（その窓では資料を扱わない）。 */
export function paradisWindowDocHostId(remoteAuthority: string | undefined): string | undefined {
	return remoteAuthority !== undefined ? paradisAgentHookRemoteHostId(remoteAuthority) : '';
}

/**
 * エディタの URI を台帳の形（接続先の印と絶対パス）にする。このウィンドウの接続先のファイルだけ。
 * Windows のドライブ文字は paradisNormalizeDocPath が大文字にそろえる（URI.fsPath は小文字にし、hook のパスは大文字で来る）。
 */
export function paradisDocTargetOf(resource: URI, windowHostId: string | undefined): { hostId: string; path: string } | undefined {
	const folder = paradisDocFolderOf(resource);
	return folder !== undefined && windowHostId !== undefined && folder.hostId === windowHostId ? folder : undefined;
}

/** 台帳のパスを、このウィンドウのファイルの URI にする（SSH の窓では接続先のファイル）。 */
export function paradisDocResource(path: string, remoteAuthority: string | undefined): URI {
	return remoteAuthority !== undefined ? URI.from({ scheme: Schemas.vscodeRemote, authority: remoteAuthority, path: path.replace(/\\/g, '/') }) : URI.file(path);
}

/** 「無い」と分かったときだけ true（読めない・つながらないは「確かめられない」）。 */
export function paradisIsFileNotFound(error: unknown): boolean {
	if (error instanceof FileOperationError) {
		return error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND;
	}
	return error instanceof Error && toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound;
}

const STATUS_TONES: Readonly<Record<ParadisDocOwnerStatus, ParadisStatusTone>> = { live: 'running', ended: 'neutral', unknown: 'warning', none: 'neutral' };

function statusLabel(status: ParadisDocOwnerStatus): string {
	switch (status) {
		case 'live': return localize('paradis.agentDocs.status.live', "動作中");
		case 'ended': return localize('paradis.agentDocs.status.ended', "終了済み");
		case 'unknown': return localize('paradis.agentDocs.status.unknown', "状態不明");
		default: return localize('paradis.agentDocs.status.none', "作成元が分からない");
	}
}

function dateLabel(bucket: ParadisDocDateBucket): string {
	switch (bucket) {
		case 'today': return localize('paradis.agentDocs.date.today', "今日");
		case 'yesterday': return localize('paradis.agentDocs.date.yesterday', "昨日");
		case 'week': return localize('paradis.agentDocs.date.week', "今週");
		default: return localize('paradis.agentDocs.date.older', "それより前");
	}
}

interface IRowEntry {
	readonly record: IParadisDocViewRecord;
	readonly element: HTMLElement;
}

export class ParadisAgentDocsView extends ViewPane {

	private readonly _channel;
	private readonly _remoteAuthority: string | undefined;
	private readonly _windowHostId: string | undefined;
	private _records: readonly IParadisDocViewRecord[] = [];
	/** このウィンドウのペインで動いている会話（トークン → 会話）。 */
	private _paneSessions = new Map<string, IParadisDocPaneSessionInfo>();
	private _scope: ParadisDocsScope;
	private _html: boolean;
	private _md: boolean;
	private _query = '';
	private readonly _collapsed = new Set<string>();
	/** 「見つからない資料」を開いている組（既定は畳む）。 */
	private readonly _missingExpanded = new Set<string>();
	/** ファイルの変化の知らせで、有無を確かめ直す資料（キー → 資料）。 */
	private readonly _recheck = new Map<string, IParadisDocViewRecord>();
	private readonly _recheckScheduler = this._register(new RunOnceScheduler(() => this._recheckChanged(), FILE_CHANGE_RECHECK_MS));
	/** 有無を確かめ中・確かめた結果（キー → 有るか）。同じ結果を何度も送らない。 */
	private readonly _checked = new Map<string, boolean>();

	private _countElement: HTMLElement | undefined;
	private _listElement: HTMLElement | undefined;
	private _scrollable: DomScrollableElement | undefined;
	private _rows: IRowEntry[] = [];
	/** 有無を確かめている資料（畳んで描いていない「見つからない資料」も入る）。 */
	private _statRows: { readonly record: IParadisDocViewRecord }[] = [];
	/** 描いた行と組の見出し（data-key で見分ける。描き直しの後にフォーカスを戻すため）。 */
	private _keyed: HTMLElement[] = [];
	private readonly _renderStore = this._register(new DisposableStore());
	private readonly _refreshScheduler = this._register(new RunOnceScheduler(() => this._refresh(), 50));
	private readonly _renderScheduler = this._register(new RunOnceScheduler(() => this._render(), 0));

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IStorageService private readonly _storageService: IStorageService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IFileService private readonly _fileService: IFileService,
		@ILabelService private readonly _labelService: ILabelService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IParadisPaneTokenService private readonly _paneTokenService: IParadisPaneTokenService,
		@IParadisWorkspaceSwitchService private readonly _workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly _worktreeService: IParadisWorktreeService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super(options, keybindingService, _contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._channel = sharedProcessService.getChannel(PARADIS_AGENT_DOCS_VIEW_CHANNEL);
		this._remoteAuthority = environmentService.remoteAuthority;
		this._windowHostId = paradisWindowDocHostId(environmentService.remoteAuthority);
		const scope = _storageService.get(SCOPE_STORAGE_KEY, StorageScope.PROFILE);
		this._scope = scope === 'session' || scope === 'all' ? scope : 'space';
		const kinds = _storageService.get(KINDS_STORAGE_KEY, StorageScope.PROFILE) ?? 'html,md';
		this._html = kinds.split(',').includes('html');
		this._md = kinds.split(',').includes('md');

		this._register(this._channel.listen<void>(PARADIS_AGENT_DOCS_VIEW_ON_DID_CHANGE)(() => this._scheduleRefresh()));
		this._register(_editorService.onDidActiveEditorChange(() => this._renderScheduler.schedule()));
		this._register(_terminalService.onDidChangeActiveInstance(() => this._renderScheduler.schedule()));
		this._register(_terminalService.onDidChangeInstances(() => this._scheduleRefresh()));
		this._register(_terminalService.onAnyInstanceTitleChange(() => this._renderScheduler.schedule()));
		this._register(_workspaceSwitchService.onDidSwitchScope(() => this._renderScheduler.schedule()));
		this._register(_storageService.onDidChangeValue(StorageScope.PROFILE, PARADIS_AGENT_DOCS_GROUPING_STORAGE_KEY, this._store)(() => this._renderScheduler.schedule()));
		this._register(_fileService.onDidFilesChange(event => {
			// 消した・移した（また置いた）ファイルを見直す（結果が変わったものだけ台帳へ送る）
			const affected = this._statRows.filter(row => event.contains(this._resourceOf(row.record.path)));
			if (affected.length > 0) {
				affected.forEach(row => this._recheck.set(paradisDocKey(row.record.hostId, row.record.path), row.record));
				this._recheckScheduler.schedule();
			}
		}));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this._checked.clear();
				this._recheck.clear();
				this._scheduleRefresh();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = DOM.append(container, DOM.$('.paradis-agent-docs'));
		const filter = DOM.append(root, DOM.$('.paradis-agent-docs-filter'));

		const scope = this._register(new ParadisSegmented<ParadisDocsScope>(filter, {
			items: [
				{ value: 'session', label: localize('paradis.agentDocs.scope.session', "このセッション") },
				{ value: 'space', label: localize('paradis.agentDocs.scope.space', "このスペース") },
				{ value: 'all', label: localize('paradis.agentDocs.scope.all', "すべて") },
			],
			value: this._scope,
			ariaLabel: localize('paradis.agentDocs.scope', "範囲"),
		}));
		this._register(scope.onDidChange(value => {
			this._scope = value;
			this._storageService.store(SCOPE_STORAGE_KEY, value, StorageScope.PROFILE, StorageTarget.USER);
			this._render();
		}));

		const chips = DOM.append(filter, DOM.$('.paradis-agent-docs-chips'));
		const chip = (label: string, pressed: boolean, onToggle: (pressed: boolean) => void) => {
			const button = DOM.append(chips, DOM.$<HTMLButtonElement>('button.paradis-chip.paradis-chip-neutral.paradis-focus-ring'));
			button.type = 'button';
			DOM.append(button, DOM.$('span.paradis-chip-label')).textContent = label;
			button.setAttribute('aria-pressed', String(pressed));
			this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => {
				const next = button.getAttribute('aria-pressed') !== 'true';
				button.setAttribute('aria-pressed', String(next));
				onToggle(next);
				this._storageService.store(KINDS_STORAGE_KEY, [this._html ? 'html' : '', this._md ? 'md' : ''].filter(kind => kind.length > 0).join(','), StorageScope.PROFILE, StorageTarget.USER);
				this._render();
			}));
		};
		chip('html', this._html, pressed => this._html = pressed);
		chip('md', this._md, pressed => this._md = pressed);
		this._countElement = DOM.append(chips, DOM.$('span.paradis-agent-docs-count'));

		const search = this._register(new ParadisInputField(filter, {
			ariaLabel: localize('paradis.agentDocs.search', "ファイル名・フォルダで絞り込む"),
			placeholder: localize('paradis.agentDocs.search', "ファイル名・フォルダで絞り込む"),
			icon: Codicon.search,
			small: true,
		}));
		search.element.classList.add('paradis-agent-docs-search');
		this._register(search.onDidChange(value => {
			this._query = value;
			this._render();
		}));

		this._listElement = DOM.$('.paradis-agent-docs-list');
		this._scrollable = this._register(new DomScrollableElement(this._listElement, { vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden }));
		this._scrollable.getDomNode().classList.add('paradis-agent-docs-scroll');
		root.appendChild(this._scrollable.getDomNode());
		// 行へフォーカスを移したときなど、要素そのものが動いたらつまみを合わせる
		this._register(DOM.addDisposableListener(this._listElement, DOM.EventType.SCROLL, () => this._scrollable?.scanDomNode()));
		this._listElement.setAttribute('role', 'list');
		this._listElement.setAttribute('aria-label', localize('paradis.agentDocs.list', "資料"));
		this._register(DOM.addDisposableListener(this._listElement, DOM.EventType.KEY_DOWN, event => this._onListKeyDown(new StandardKeyboardEvent(event))));
		this._scheduleRefresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._scrollable?.scanDomNode();
	}

	override focus(): void {
		super.focus();
		(this._rows[0]?.element ?? this._listElement)?.focus();
	}

	private _scheduleRefresh(): void {
		if (this.isBodyVisible()) {
			this._refreshScheduler.schedule();
		}
	}

	private async _refresh(): Promise<void> {
		const tokens = this._paneTokenService.listPaneTokens().map(entry => entry.token);
		try {
			const [records, sessions] = await Promise.all([
				this._channel.call<IParadisDocViewRecord[]>(ParadisAgentDocsViewCall.List),
				tokens.length > 0 ? this._channel.call<IParadisDocPaneSessionInfo[]>(ParadisAgentDocsViewCall.PaneSessions, [tokens]) : Promise.resolve([]),
			]);
			// 接続先の印が分からない窓では何も出さない（ほかの機械の資料をこの窓のファイルとして確かめない）
			this._records = Array.isArray(records) && this._windowHostId !== undefined ? records : [];
			this._paneSessions = new Map((Array.isArray(sessions) ? sessions : []).map(session => [session.token, session]));
		} catch {
			this._records = [];
		}
		this._render();
	}

	// --- 範囲 ------------------------------------------------------------------------------

	/** 表示中のエディタの資料。 */
	private _activeDocKey(): string | undefined {
		const resource = this._editorService.activeEditor?.resource;
		const target = resource !== undefined ? paradisDocTargetOf(resource, this._windowHostId) : undefined;
		return target !== undefined ? paradisDocKey(target.hostId, target.path) : undefined;
	}

	/** 「このセッション」: 表示中の資料の持ち主。資料を出していなければ、選んでいるターミナルで動いている会話。 */
	private _currentSession(activeKey: string | undefined): string | undefined {
		const active = activeKey !== undefined ? this._records.find(record => paradisDocKey(record.hostId, record.path) === activeKey) : undefined;
		if (active?.owner !== undefined) {
			return active.owner.session;
		}
		const instance = this._terminalService.activeInstance;
		const token = instance !== undefined ? this._paneTokenService.getTokenForInstance(instance.instanceId) : undefined;
		return token !== undefined ? this._paneSessions.get(token)?.session : undefined;
	}

	/** 今のスペースのフォルダ。スペースを持たないウィンドウは開いているフォルダ。 */
	private _currentFolder(): IParadisDocFolder | undefined {
		const stateKey = this._workspaceSwitchService.activeStateKey;
		const uri = stateKey !== undefined
			? paradisListSpaces(this._workspaceSwitchService.repositories, this._worktreeService).find(entry => entry.space === stateKey)?.uri
			: this._workspaceContextService.getWorkspace().folders[0]?.uri;
		return uri !== undefined ? paradisDocFolderOf(uri) : undefined;
	}

	// --- 描画 ------------------------------------------------------------------------------

	private _render(): void {
		const list = this._listElement;
		if (list === undefined) {
			return;
		}
		// 描き直しで行と組の見出しは作り直すので、フォーカスのあったものを覚えて戻す
		const focusedKey = this._keyed.find(element => DOM.isAncestorOfActiveElement(element))?.dataset.key;
		const scrollTop = list.scrollTop;
		this._renderStore.clear();
		DOM.clearNode(list);
		this._rows = [];
		this._keyed = [];

		const activeKey = this._activeDocKey();
		const filtered = paradisFilterDocs(this._records, {
			scope: this._scope,
			hostId: this._windowHostId ?? '',
			session: this._scope === 'session' ? this._currentSession(activeKey) : undefined,
			folder: this._scope === 'space' ? this._currentFolder() : undefined,
			html: this._html,
			md: this._md,
			query: this._query,
		});
		if (this._countElement) {
			// 数えるのはファイルのある資料（見つからない資料は、畳んだ行に数を出す）
			this._countElement.textContent = localize('paradis.agentDocs.count', "{0} 件", filtered.filter(record => record.missingSince === undefined).length);
		}
		this._statRows = filtered.slice(0, MAX_STAT_ROWS).map(record => ({ record }));
		if (filtered.length === 0) {
			DOM.append(list, DOM.$('.paradis-agent-docs-empty')).textContent = this._emptyMessage();
			this._scrollable?.scanDomNode();
			return;
		}
		const grouping = paradisReadDocsGrouping(this._storageService);
		const sessionTitles = this._sessionTitles();
		const groups = paradisGroupDocs(filtered, grouping, Date.now());
		for (const group of groups) {
			const collapsed = group.kind !== 'missing' && this._collapsed.has(group.key);
			if (group.kind !== 'missing') {
				this._renderGroupHeader(list, group, collapsed, sessionTitles);
			}
			if (!collapsed) {
				for (const record of group.records) {
					this._renderRow(list, record, activeKey, grouping !== 'session');
				}
				if (group.missing.length > 0) {
					this._renderMissing(list, group, activeKey, grouping !== 'session' || group.kind === 'missing', groups.length === 1);
				}
			}
		}
		list.scrollTop = scrollTop;
		this._scrollable?.scanDomNode();
		if (focusedKey !== undefined) {
			this._keyed.find(element => element.dataset.key === focusedKey)?.focus();
		}
		this._checkExistence(filtered.slice(0, MAX_STAT_ROWS));
	}

	private _emptyMessage(): string {
		if (this._records.every(record => record.hostId !== this._windowHostId)) {
			return localize('paradis.agentDocs.empty.none', "エージェントが作った HTML・Markdown の資料がここに並びます。");
		}
		if (this._scope === 'session' && this._currentSession(this._activeDocKey()) === undefined) {
			return localize('paradis.agentDocs.empty.noSession', "資料を開くか、エージェントのターミナルを選ぶと、そのセッションの資料を出します。");
		}
		return localize('paradis.agentDocs.empty.filtered', "条件に合う資料がありません。");
	}

	/** 会話 → このウィンドウのペインの題（動いている会話だけ）。 */
	private _sessionTitles(): Map<string, string> {
		const titles = new Map<string, string>();
		for (const instance of this._terminalService.instances) {
			const token = this._paneTokenService.getTokenForInstance(instance.instanceId);
			const session = token !== undefined ? this._paneSessions.get(token)?.session : undefined;
			if (session !== undefined && instance.title.length > 0) {
				titles.set(session, instance.title);
			}
		}
		return titles;
	}

	/** 会話が始まったフォルダのスペースの名前。スペースの外なら フォルダ名。 */
	private _placeOf(cwd: string | undefined): string | undefined {
		if (cwd === undefined) {
			return undefined;
		}
		let best: { name: string; length: number } | undefined;
		for (const entry of paradisListSpaces(this._workspaceSwitchService.repositories, this._worktreeService)) {
			const folder = paradisDocFolderOf(entry.uri);
			if (folder !== undefined && folder.hostId === this._windowHostId && paradisIsInsideFolder(cwd, folder.path) && (best === undefined || folder.path.length > best.length)) {
				best = { name: entry.name, length: folder.path.length };
			}
		}
		return best?.name ?? paradisDocFileName(cwd);
	}

	/**
	 * 組の末尾の「見つからない資料 N 件」。畳んだ 1 行で、開くと中の資料と「まとめて外す」が出る。
	 * 見つからない資料を 1 件ずつ並べると、ファイルのある資料が埋もれる。
	 */
	private _renderMissing(list: HTMLElement, group: ParadisDocsGroup, activeKey: string | undefined, showOwner: boolean, alone: boolean): void {
		const expanded = this._missingExpanded.has(group.key);
		const fold = DOM.append(list, DOM.$('.paradis-agent-docs-missing'));
		fold.classList.toggle('standalone', group.kind === 'missing');
		const toggle = DOM.append(fold, DOM.$<HTMLButtonElement>('button.paradis-agent-docs-missing-toggle.paradis-focus-ring-inset'));
		toggle.type = 'button';
		toggle.dataset.key = `missing:${group.key}`;
		this._keyed.push(toggle);
		toggle.setAttribute('aria-expanded', String(expanded));
		DOM.append(toggle, DOM.$(ThemeIcon.asCSSSelector(expanded ? Codicon.chevronDown : Codicon.chevronRight))).setAttribute('aria-hidden', 'true');
		// 一覧の最後の組（資料の残っていない会話・日付・フォルダの分）は、すぐ上の組の行と見分けられる名前にする
		const label = group.kind === 'missing' && !alone
			? localize('paradis.agentDocs.missingGroup.other', "そのほかの見つからない資料 {0} 件", group.missing.length)
			: localize('paradis.agentDocs.missingGroup', "見つからない資料 {0} 件", group.missing.length);
		DOM.append(toggle, DOM.$('span.paradis-agent-docs-missing-label')).textContent = label;
		toggle.title = localize('paradis.agentDocs.missingGroup.title', "{0}（消したか、スペースの外へ移したファイル。7 日たつと一覧から外れます）", label);
		this._renderStore.add(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, () => {
			if (!this._missingExpanded.delete(group.key)) {
				this._missingExpanded.add(group.key);
			}
			this._render();
		}));
		if (!expanded) {
			return;
		}
		const missing = group.missing;
		this._appendLink(fold, localize('paradis.agentDocs.removeAllMissing', "まとめて外す"), () => this._removeMany(missing));
		for (const record of missing) {
			this._renderRow(list, record, activeKey, showOwner);
		}
	}

	private _renderGroupHeader(list: HTMLElement, group: Exclude<ParadisDocsGroup, { kind: 'missing' }>, collapsed: boolean, sessionTitles: Map<string, string>): void {
		const header = DOM.append(list, DOM.$<HTMLButtonElement>('button.paradis-agent-docs-group.paradis-focus-ring-inset'));
		header.type = 'button';
		header.dataset.key = `group:${group.key}`;
		this._keyed.push(header);
		header.setAttribute('aria-expanded', String(!collapsed));
		DOM.append(header, DOM.$(ThemeIcon.asCSSSelector(collapsed ? Codicon.chevronRight : Codicon.chevronDown))).setAttribute('aria-hidden', 'true');
		let title: string;
		switch (group.kind) {
			case 'session': {
				const agentName = paradisAgentDescriptor(group.agent)?.displayName ?? group.agent;
				const name = sessionTitles.get(group.session);
				title = name !== undefined ? localize('paradis.agentDocs.group.sessionNamed', "{0}（{1}）", agentName, name) : agentName;
				createParadisStatusDot(header, title, STATUS_TONES[group.status]).classList.add('paradis-agent-docs-group-label');
				DOM.append(header, DOM.$('span.paradis-agent-docs-group-state')).textContent = statusLabel(group.status);
				// 終わった会話には名前が残らないので、始めたフォルダと最後に動いた時刻で見分ける
				const place = this._placeOf(group.cwd);
				const latest = fromNow(group.records[0].lastActivity, true);
				DOM.append(header, DOM.$('span.paradis-agent-docs-group-sub')).textContent = place !== undefined ? `${place} · ${latest}` : latest;
				title = `${title} · ${statusLabel(group.status)} · ${group.session}`;
				break;
			}
			case 'unowned':
				title = statusLabel('none');
				DOM.append(header, DOM.$('span.paradis-agent-docs-group-label.strong')).textContent = title;
				DOM.append(header, DOM.$('span.paradis-agent-docs-group-sub'));
				break;
			case 'date':
				title = dateLabel(group.bucket);
				DOM.append(header, DOM.$('span.paradis-agent-docs-group-label.strong')).textContent = title;
				DOM.append(header, DOM.$('span.paradis-agent-docs-group-sub'));
				break;
			default:
				title = this._labelService.getUriLabel(this._resourceOf(group.folder), { relative: true });
				DOM.append(header, DOM.$(ThemeIcon.asCSSSelector(Codicon.folder))).setAttribute('aria-hidden', 'true');
				DOM.append(header, DOM.$('span.paradis-agent-docs-group-label.strong')).textContent = title;
				DOM.append(header, DOM.$('span.paradis-agent-docs-group-sub'));
				break;
		}
		DOM.append(header, DOM.$('span.paradis-agent-docs-group-count')).textContent = String(group.records.length);
		header.title = title;
		this._renderStore.add(DOM.addDisposableListener(header, DOM.EventType.CLICK, () => {
			if (this._collapsed.has(group.key)) {
				this._collapsed.delete(group.key);
			} else {
				this._collapsed.add(group.key);
			}
			this._render();
		}));
	}

	private _renderRow(list: HTMLElement, record: IParadisDocViewRecord, activeKey: string | undefined, showOwner: boolean): void {
		const key = paradisDocKey(record.hostId, record.path);
		const missing = record.missingSince !== undefined;
		const row = DOM.append(list, DOM.$('.paradis-agent-docs-row.paradis-focus-subtle'));
		row.dataset.key = key;
		this._keyed.push(row);
		row.tabIndex = 0;
		row.setAttribute('role', 'listitem');
		row.classList.toggle('current', key === activeKey);
		row.classList.toggle('missing', missing);
		row.title = this._labelService.getUriLabel(this._resourceOf(record.path));
		DOM.append(row, DOM.$(ThemeIcon.asCSSSelector(record.kind === 'md' ? Codicon.markdown : Codicon.code))).setAttribute('aria-hidden', 'true');
		const body = DOM.append(row, DOM.$('.paradis-agent-docs-row-body'));
		const line1 = DOM.append(body, DOM.$('.paradis-agent-docs-row-line1'));
		DOM.append(line1, DOM.$('span.paradis-agent-docs-row-name')).textContent = paradisDocFileName(record.path);
		if (key === activeKey) {
			DOM.append(line1, DOM.$('span.paradis-chip.paradis-chip-neutral.paradis-agent-docs-row-shown')).textContent = localize('paradis.agentDocs.shown', "表示中");
		}
		if (record.openComments !== undefined && record.openComments > 0) {
			// 未回答のコメントの数（対応が要るので色を付ける）
			const label = localize('paradis.agentDocs.openComments', "未回答のコメント {0} 件", record.openComments);
			const badge = new ParadisCountBadge(line1, 'inline');
			badge.update(record.openComments, 'attention');
			badge.element.removeAttribute('aria-hidden');
			badge.element.setAttribute('aria-label', label);
			badge.element.title = label;
		}
		const line2 = DOM.append(body, DOM.$('.paradis-agent-docs-row-line2'));
		if (missing) {
			// 外すのは、上の「まとめて外す」か行のメニューから（行ごとにリンクを並べると、それだけで一覧が埋まる）
			DOM.append(line2, DOM.$('span.paradis-agent-docs-row-warning')).textContent = localize('paradis.agentDocs.missing', "ファイルが見つかりません");
			const folder = this._labelService.getUriLabel(this._resourceOf(paradisDocParentPath(record.path)), { relative: true });
			DOM.append(line2, DOM.$('span.paradis-agent-docs-row-folder')).textContent = `· ${folder}`;
		} else {
			const folder = this._labelService.getUriLabel(this._resourceOf(paradisDocParentPath(record.path)), { relative: true });
			const owner = showOwner ? this._ownerShortLabel(record) : undefined;
			DOM.append(line2, DOM.$('span.paradis-agent-docs-row-folder')).textContent = owner !== undefined ? `${folder} · ${owner}` : folder;
			DOM.append(line2, DOM.$('span.paradis-agent-docs-row-when')).textContent = `· ${fromNow(record.lastActivity, true)}`;
			if (record.owner === undefined) {
				// 行に重ねたときと、その資料を表示しているときだけ出す（いつも出すとフォルダの名前が切れる）。キーでは行のメニューから選ぶ
				this._appendLink(line2, localize('paradis.agentDocs.assign', "このセッションの資料にする"), () => this._assign(record)).classList.add('on-hover');
			}
		}
		this._rows.push({ record, element: row });
		this._renderStore.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, event => {
			if ((event.target as HTMLElement).closest('button')) {
				return;
			}
			void this._open(record);
		}));
		this._renderStore.add(DOM.addDisposableListener(row, DOM.EventType.CONTEXT_MENU, event => {
			DOM.EventHelper.stop(event, true);
			this._showMenu(record, { x: event.clientX, y: event.clientY });
		}));
	}

	private _ownerShortLabel(record: IParadisDocViewRecord): string {
		if (record.owner === undefined) {
			return statusLabel('none');
		}
		return paradisAgentDescriptor(record.owner.agent)?.shortName ?? record.owner.agent;
	}

	private _appendLink(parent: HTMLElement, label: string, run: () => void): HTMLElement {
		const link = DOM.append(parent, DOM.$<HTMLButtonElement>('button.paradis-agent-docs-link.paradis-focus-ring'));
		link.type = 'button';
		link.textContent = label;
		this._renderStore.add(DOM.addDisposableListener(link, DOM.EventType.CLICK, event => {
			DOM.EventHelper.stop(event, true);
			run();
		}));
		return link;
	}

	private _onListKeyDown(event: StandardKeyboardEvent): void {
		const index = this._rows.findIndex(row => row.element === DOM.getActiveElement());
		if (index < 0) {
			return;
		}
		const row = this._rows[index];
		if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
			DOM.EventHelper.stop(event.browserEvent, true);
			void this._open(row.record);
		} else if (event.equals(KeyCode.DownArrow) || event.equals(KeyCode.UpArrow)) {
			DOM.EventHelper.stop(event.browserEvent, true);
			this._rows[Math.max(0, Math.min(this._rows.length - 1, index + (event.equals(KeyCode.DownArrow) ? 1 : -1)))].element.focus();
		} else if (event.equals(KeyCode.ContextMenu) || event.equals(KeyMod.Shift | KeyCode.F10)) {
			DOM.EventHelper.stop(event.browserEvent, true);
			const rect = row.element.getBoundingClientRect();
			this._showMenu(row.record, { x: rect.left + 16, y: rect.bottom });
		}
	}

	private _showMenu(record: IParadisDocViewRecord, anchor: { x: number; y: number }): void {
		const actions = [];
		if (record.missingSince === undefined) {
			actions.push(toAction({ id: 'paradis.agentDocs.open', label: localize('paradis.agentDocs.menu.open', "開く"), run: () => this._open(record) }));
		}
		if (record.owner === undefined && record.missingSince === undefined) {
			actions.push(toAction({ id: 'paradis.agentDocs.assign', label: localize('paradis.agentDocs.menu.assign', "このセッションの資料にする…"), run: () => this._assign(record) }));
		}
		actions.push(toAction({ id: 'paradis.agentDocs.remove', label: localize('paradis.agentDocs.menu.remove', "一覧から外す"), run: () => this._remove(record) }));
		showParadisMenu(this._contextMenuService, { anchor, actions });
	}

	// --- 操作 ------------------------------------------------------------------------------

	private _resourceOf(path: string): URI {
		return paradisDocResource(path, this._remoteAuthority);
	}

	/** preview_file と同じ規則で開く: そのファイルを開いているグループ、無ければ直近のグループ。固定のタブで開く。 */
	private async _open(record: IParadisDocViewRecord): Promise<void> {
		if (record.missingSince !== undefined) {
			return;
		}
		const resource = this._resourceOf(record.path);
		const mainPart = this._editorGroupsService.mainPart;
		const openedGroupIds = this._editorService.findEditors(resource).map(identifier => identifier.groupId);
		const group = this._editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)
			.filter(candidate => this._editorGroupsService.getPart(candidate) === mainPart)
			.find(candidate => openedGroupIds.includes(candidate.id)) ?? mainPart.activeGroup;
		await this._editorService.openEditor({ resource, options: { pinned: true } }, group);
	}

	private async _remove(record: IParadisDocViewRecord): Promise<void> {
		await this._channel.call(ParadisAgentDocsViewCall.Remove, [record.hostId, record.path]);
	}

	private async _removeMany(records: readonly IParadisDocViewRecord[]): Promise<void> {
		const byHost = new Map<string, string[]>();
		for (const record of records) {
			byHost.set(record.hostId, [...(byHost.get(record.hostId) ?? []), record.path]);
		}
		await Promise.all([...byHost].map(([hostId, paths]) => this._channel.call(ParadisAgentDocsViewCall.RemoveMany, [hostId, paths])));
	}

	/** ファイルの変化の知らせのあった資料の有無を確かめ直す（台帳の今の記録で。移された資料はもう別の場所の記録になっている）。 */
	private _recheckChanged(): void {
		const keys = new Set(this._recheck.keys());
		this._recheck.clear();
		const records = this._records.filter(record => keys.has(paradisDocKey(record.hostId, record.path)));
		records.forEach(record => this._checked.delete(paradisDocKey(record.hostId, record.path)));
		this._checkExistence(records);
	}

	/** 持ち主のいない資料を、選んだペインの会話の資料にする。 */
	private async _assign(record: IParadisDocViewRecord): Promise<void> {
		await this._refresh();
		const items: (IQuickPickItem & { token: string })[] = [];
		for (const instance of this._terminalService.instances) {
			const token = this._paneTokenService.getTokenForInstance(instance.instanceId);
			const session = token !== undefined ? this._paneSessions.get(token) : undefined;
			if (token !== undefined && session !== undefined && session.hostId === record.hostId) {
				items.push({ token, label: instance.title || localize('paradis.agentDocs.assign.terminal', "ターミナル {0}", instance.instanceId), description: paradisAgentDescriptor(session.agent)?.displayName ?? session.agent });
			}
		}
		if (items.length === 0) {
			this._notificationService.info(localize('paradis.agentDocs.assign.none', "資料を渡せるエージェントのターミナルがありません。エージェントに 1 度話しかけてから選んでください。"));
			return;
		}
		const picked = await this._quickInputService.pick(items, {
			placeHolder: localize('paradis.agentDocs.assign.placeholder', "「{0}」をどのセッションの資料にするか選んでください", paradisDocFileName(record.path)),
		});
		if (picked === undefined) {
			return;
		}
		const result = await this._channel.call<ParadisDocAssignResult>(ParadisAgentDocsViewCall.Assign, [record.hostId, record.path, picked.token]);
		if (result === 'owned') {
			this._notificationService.info(localize('paradis.agentDocs.assign.owned', "この資料は別のセッションの資料になっていたので、変えませんでした。"));
		} else if (result !== 'assigned') {
			this._notificationService.warn(localize('paradis.agentDocs.assign.failed', "セッションの資料にできませんでした。ターミナルのエージェントに 1 度話しかけてから、もう一度選んでください。"));
		}
	}

	/** 見えている行のファイルの有無を確かめ、変わったものだけ台帳へ送る。確かめられなかったものは送らない。 */
	private _checkExistence(records: readonly IParadisDocViewRecord[]): void {
		if (!this.isBodyVisible()) {
			return;
		}
		for (const record of records) {
			const key = paradisDocKey(record.hostId, record.path);
			if (this._checked.has(key)) {
				continue;
			}
			this._checked.set(key, record.missingSince === undefined);
			void this._fileService.stat(this._resourceOf(record.path)).then(
				() => true,
				error => paradisIsFileNotFound(error) ? false : undefined,
			).then(exists => {
				if (exists !== undefined && exists !== (record.missingSince === undefined)) {
					this._checked.set(key, exists);
					void this._channel.call(ParadisAgentDocsViewCall.SetMissing, [record.hostId, record.path, !exists]);
				}
			});
		}
	}
}
