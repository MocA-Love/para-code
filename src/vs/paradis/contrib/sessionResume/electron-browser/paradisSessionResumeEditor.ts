/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import './media/paradisSessionResume.css';
import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorMarkdownCodeBlockRenderer } from '../../../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IChatOutputRendererService } from '../../../../workbench/contrib/chat/browser/chatOutputItemRenderer.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisResumeAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { IParadisResumeMessage, IParadisResumeSearchResult, IParadisResumeSession, IParadisResumeSpace, ParadisResumeAgent } from '../common/paradisSessionResume.js';
import { ParadisSessionResumeClient } from './paradisSessionResumeClient.js';
import { PARADIS_SESSION_RESUME_EDITOR_ID } from './paradisSessionResumeInput.js';

const $ = dom.$;
type AgentFilter = 'all' | ParadisResumeAgent;
type PeriodFilter = 'all' | 'day' | 'week' | 'month';
const SPACE_FILTER_PREFIX = 'space:';

interface IResumeSpaceView extends IParadisResumeSpace {
	readonly uri: URI;
}

export class ParadisSessionResumeEditor extends EditorPane {
	static readonly ID = PARADIS_SESSION_RESUME_EDITOR_ID;

	private root: HTMLElement | undefined;
	private list: HTMLElement | undefined;
	private detail: HTMLElement | undefined;
	private searchInput: HTMLInputElement | undefined;
	private agentSelect: HTMLSelectElement | undefined;
	private spaceSelect: HTMLSelectElement | undefined;
	private periodSelect: HTMLSelectElement | undefined;
	private archivedInput: HTMLInputElement | undefined;
	private refreshButton: HTMLButtonElement | undefined;
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly searchScheduler = this._register(new RunOnceScheduler(() => this.searchTranscripts(), 250));
	private readonly client: ParadisSessionResumeClient;
	private spaces: readonly IResumeSpaceView[] = [];
	private sessions: readonly IParadisResumeSession[] = [];
	private selected: IParadisResumeSession | undefined;
	private previewMessages: readonly IParadisResumeMessage[] | undefined;
	private previewTruncated = false;
	private loading = false;
	private refreshPending = false;
	private previewLoading = false;
	private previewSequence = 0;
	private query = '';
	private searchMatches: ReadonlyMap<string, IParadisResumeSearchResult> | undefined;
	private searchSequence = 0;
	private renderSequence = 0;
	private currentSearchMatchIndex = 0;
	private renderedSearchMatches: HTMLElement[] = [];
	private agentFilter: AgentFilter = 'all';
	private spaceFilter = 'all';
	private periodFilter: PeriodFilter = 'all';
	private readonly resumingCatalogIds = new Set<string>();
	private readonly markdownCodeBlockRenderer: EditorMarkdownCodeBlockRenderer;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@INotificationService private readonly notificationService: INotificationService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IChatOutputRendererService private readonly chatOutputRendererService: IChatOutputRendererService,
	) {
		super(PARADIS_SESSION_RESUME_EDITOR_ID, group, telemetryService, themeService, storageService);
		this.client = instantiationService.createInstance(ParadisSessionResumeClient);
		this.markdownCodeBlockRenderer = instantiationService.createInstance(EditorMarkdownCodeBlockRenderer);
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this.refresh()));
		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => this.refresh()));
		this._register(this.worktreeService.onDidChangeWorktrees(() => this.refresh()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, $('.paradis-session-resume'));
		const toolbar = dom.append(this.root, $('.paradis-session-resume-toolbar'));
		const searchWrap = dom.append(toolbar, $('.paradis-session-resume-search'));
		dom.append(searchWrap, $(`span${ThemeIcon.asCSSSelector(Codicon.search)}`));
		this.searchInput = dom.append(searchWrap, $('input')) as HTMLInputElement;
		this.searchInput.type = 'search';
		this.searchInput.maxLength = 200;
		this.searchInput.placeholder = localize('paradis.sessionResume.searchPlaceholder', "タイトル、会話、パス、セッションIDを検索");
		this.searchInput.setAttribute('aria-label', this.searchInput.placeholder);
		this._register(dom.addDisposableListener(this.searchInput, dom.EventType.INPUT, () => {
			this.query = this.searchInput?.value.trim().toLocaleLowerCase() ?? '';
			this.searchMatches = undefined;
			this.currentSearchMatchIndex = 0;
			this.searchScheduler.schedule();
			this.render();
		}));

		this.agentSelect = this.createSelect(toolbar, localize('paradis.sessionResume.agentLabel', "エージェント"), [
			['all', localize('paradis.sessionResume.allAgents', "すべてのエージェント")],
			['claude', 'Claude Code'],
			['codex', 'Codex'],
		]);
		this._register(dom.addDisposableListener(this.agentSelect, dom.EventType.CHANGE, () => {
			this.agentFilter = this.agentSelect?.value as AgentFilter;
			this.ensureSelectedSessionIsVisible();
			this.render();
		}));

		this.spaceSelect = this.createSelect(toolbar, localize('paradis.sessionResume.spaceLabel', "スペース"), [
			['all', localize('paradis.sessionResume.allSpaces', "すべてのスペース")],
			['current', localize('paradis.sessionResume.currentSpaceFilter', "現在のスペース")],
		]);
		this._register(dom.addDisposableListener(this.spaceSelect, dom.EventType.CHANGE, () => {
			this.spaceFilter = this.spaceSelect?.value ?? 'all';
			this.currentSearchMatchIndex = 0;
			this.ensureSelectedSessionIsVisible();
			this.render();
		}));

		this.periodSelect = this.createSelect(toolbar, localize('paradis.sessionResume.periodLabel', "期間"), [
			['all', localize('paradis.sessionResume.periodAll', "すべての期間")],
			['day', localize('paradis.sessionResume.periodDay', "過去24時間")],
			['week', localize('paradis.sessionResume.periodWeek', "過去7日")],
			['month', localize('paradis.sessionResume.periodMonth', "過去30日")],
		]);
		this._register(dom.addDisposableListener(this.periodSelect, dom.EventType.CHANGE, () => {
			this.periodFilter = this.periodSelect?.value as PeriodFilter;
			this.ensureSelectedSessionIsVisible();
			this.render();
		}));

		const archivedLabel = dom.append(toolbar, $('label.paradis-session-resume-check'));
		this.archivedInput = dom.append(archivedLabel, $('input')) as HTMLInputElement;
		this.archivedInput.type = 'checkbox';
		dom.append(archivedLabel, $('span')).textContent = localize('paradis.sessionResume.archived', "アーカイブ済み");
		this._register(dom.addDisposableListener(this.archivedInput, dom.EventType.CHANGE, () => this.refresh()));

		this.refreshButton = dom.append(toolbar, $('button.paradis-session-resume-refresh')) as HTMLButtonElement;
		this.refreshButton.title = localize('paradis.sessionResume.refresh', "セッション履歴を更新");
		this.refreshButton.setAttribute('aria-label', this.refreshButton.title);
		dom.append(this.refreshButton, $(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		this._register(dom.addDisposableListener(this.refreshButton, dom.EventType.CLICK, () => this.refresh()));

		const content = dom.append(this.root, $('.paradis-session-resume-content'));
		this.list = dom.append(content, $('.paradis-session-resume-list'));
		this.detail = dom.append(content, $('.paradis-session-resume-detail'));
		this.render();
	}

	private createSelect(parent: HTMLElement, ariaLabel: string, options: readonly (readonly [string, string])[]): HTMLSelectElement {
		const select = dom.append(parent, $('select')) as HTMLSelectElement;
		select.setAttribute('aria-label', ariaLabel);
		for (const [value, label] of options) {
			const option = dom.append(select, $('option')) as HTMLOptionElement;
			option.value = value;
			option.textContent = label;
		}
		return select;
	}

	private updateSpaceSelectOptions(): void {
		if (!this.spaceSelect) {
			return;
		}
		const previous = this.spaceFilter;
		dom.clearNode(this.spaceSelect);
		for (const [value, label] of [
			['all', localize('paradis.sessionResume.allSpaces', "すべてのスペース")],
			['current', localize('paradis.sessionResume.currentSpaceFilter', "現在のスペース")],
		] as const) {
			const option = dom.append(this.spaceSelect, $('option')) as HTMLOptionElement;
			option.value = value;
			option.textContent = label;
		}
		for (const space of this.spaces) {
			const option = dom.append(this.spaceSelect, $('option')) as HTMLOptionElement;
			option.value = `${SPACE_FILTER_PREFIX}${space.stateKey}`;
			option.textContent = space.name;
		}
		const available = [...this.spaceSelect.options].some(option => option.value === previous);
		this.spaceFilter = available ? previous : 'all';
		this.spaceSelect.value = this.spaceFilter;
	}

	private ensureSelectedSessionIsVisible(): boolean {
		const filtered = this.filteredSessions();
		if (this.selected && filtered.some(session => session.catalogId === this.selected?.catalogId)) {
			return false;
		}
		this.selected = filtered[0];
		this.previewMessages = undefined;
		this.previewTruncated = false;
		if (this.selected) {
			void this.loadPreview(this.selected);
		}
		return true;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!this.loading && this.sessions.length === 0) {
			await this.refresh();
		}
	}

	override layout(_dimension: dom.Dimension): void { }
	override focus(): void { this.searchInput?.focus(); }

	private collectSpaces(): readonly IResumeSpaceView[] {
		const current = this.workspaceSwitchService.activeStateKey;
		const spaces: IResumeSpaceView[] = [];
		for (const repository of this.workspaceSwitchService.repositories) {
			if (repository.uri.scheme !== 'file') {
				continue;
			}
			spaces.push({ stateKey: repository.id, name: repository.name, cwd: repository.uri.fsPath, uri: repository.uri, current: repository.id === current });
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (worktree.missing || worktree.isMainCheckout || worktree.uri.scheme !== 'file') {
					continue;
				}
				const stateKey = paradisWorktreeStateKey(worktree.uri);
				spaces.push({
					stateKey, name: `${repository.name} ✦ ${worktree.name}`, cwd: worktree.uri.fsPath, uri: worktree.uri,
					current: stateKey === current,
				});
			}
		}
		return spaces;
	}

	private async refresh(): Promise<void> {
		if (this.loading) {
			this.refreshPending = true;
			return;
		}
		// 旧catalogに対する全文検索結果が、新しいcatalogへ遅着して一覧を空にしないよう失効させる。
		this.searchSequence++;
		this.searchMatches = undefined;
		this.loading = true;
		this.refreshButton?.classList.add('loading');
		this.render();
		try {
			await this.worktreeService.initializationBarrier;
			this.spaces = this.collectSpaces();
			this.updateSpaceSelectOptions();
			this.sessions = await this.client.list({
				spaces: this.spaces.map(({ stateKey, name, cwd, current }) => ({ stateKey, name, cwd, current })),
				includeArchived: this.archivedInput?.checked === true,
			});
			this.selected = this.sessions.find(session => session.id === this.selected?.id && session.agent === this.selected.agent) ?? this.sessions[0];
			this.previewMessages = undefined;
			const selectionChanged = this.ensureSelectedSessionIsVisible();
			if (!selectionChanged && this.selected) {
				void this.loadPreview(this.selected);
			}
		} catch (error) {
			this.notificationService.error(error);
		} finally {
			this.loading = false;
			this.refreshButton?.classList.remove('loading');
			this.render();
			if (this.query) {
				this.searchScheduler.schedule();
			}
			if (this.refreshPending) {
				this.refreshPending = false;
				void this.refresh();
			}
		}
	}

	private filteredSessions(): readonly IParadisResumeSession[] {
		const periodMs = this.periodFilter === 'day' ? 86_400_000 : this.periodFilter === 'week' ? 7 * 86_400_000 : this.periodFilter === 'month' ? 30 * 86_400_000 : undefined;
		const threshold = periodMs ? Date.now() - periodMs : undefined;
		return this.sessions.filter(session => {
			if (this.agentFilter !== 'all' && session.agent !== this.agentFilter) { return false; }
			if (this.spaceFilter === 'current' && !session.currentSpace) { return false; }
			if (this.spaceFilter.startsWith(SPACE_FILTER_PREFIX) && session.spaceStateKey !== this.spaceFilter.slice(SPACE_FILTER_PREFIX.length)) { return false; }
			if (threshold !== undefined && session.updatedAt < threshold) { return false; }
			if (!this.query) { return true; }
			if (this.searchMatches !== undefined) { return this.searchMatches.has(session.catalogId); }
			const haystack = `${session.title}\n${session.preview}\n${session.cwd}\n${session.id}\n${session.spaceName}`.toLocaleLowerCase();
			return this.query.split(/\s+/).every(term => haystack.includes(term));
		});
	}

	private async searchTranscripts(): Promise<void> {
		const query = this.query;
		const sequence = ++this.searchSequence;
		if (!query) {
			this.searchMatches = undefined;
			if (this.selected) {
				this.previewMessages = undefined;
				void this.loadPreview(this.selected);
			} else {
				this.render();
			}
			return;
		}
		try {
			const matches = await this.client.search(query, this.sessions.map(session => session.catalogId));
			if (sequence === this.searchSequence && query === this.query) {
				this.searchMatches = new Map(matches.map(match => [match.catalogId, match]));
				const selectionChanged = this.ensureSelectedSessionIsVisible();
				if (!selectionChanged && this.selected) {
					this.previewMessages = undefined;
					void this.loadPreview(this.selected);
				} else {
					this.render();
				}
			}
		} catch {
			// 検索失敗時もmetadata検索は利用できる。入力内容を外部へ送ったり記録したりしない。
		}
	}

	private render(): void {
		if (!this.list || !this.detail) { return; }
		this.renderSequence++;
		this.renderedSearchMatches = [];
		this.renderDisposables.clear();
		dom.clearNode(this.list);
		dom.clearNode(this.detail);
		if (this.loading && this.sessions.length === 0) {
			this.renderState(this.list, Codicon.loading, localize('paradis.sessionResume.loading', "ローカルのセッション履歴を読み込んでいます…"), true);
			this.renderState(this.detail, Codicon.history, localize('paradis.sessionResume.selectAfterLoad', "セッションを選択すると会話を確認できます。"));
			return;
		}
		const filtered = this.filteredSessions();
		if (filtered.length === 0) {
			this.renderState(this.list, Codicon.search, this.sessions.length === 0
				? localize('paradis.sessionResume.noSessions', "登録されたスペースにClaude CodeまたはCodexのセッションが見つかりません。")
				: localize('paradis.sessionResume.noMatches', "条件に一致するセッションがありません。"));
		} else {
			const current = filtered.filter(session => session.currentSpace);
			const other = filtered.filter(session => !session.currentSpace);
			if (current.length > 0) {
				this.renderGroup(this.list, localize('paradis.sessionResume.currentSpace', "現在のスペース"), current, true);
			}
			if (other.length > 0) {
				const bySpace = new Map<string, IParadisResumeSession[]>();
				for (const session of other) {
					const sessions = bySpace.get(session.spaceStateKey) ?? [];
					sessions.push(session);
					bySpace.set(session.spaceStateKey, sessions);
				}
				const otherHeading = dom.append(this.list, $('.paradis-session-resume-superheading'));
				otherHeading.textContent = localize('paradis.sessionResume.otherSpaces', "他のスペース");
				for (const sessions of bySpace.values()) {
					this.renderGroup(this.list, sessions[0].spaceName, sessions, this.query.length > 0);
				}
			}
		}
		this.renderDetail();
	}

	private renderState(parent: HTMLElement, icon: ThemeIcon, label: string, spinning = false): void {
		const state = dom.append(parent, $('.paradis-session-resume-state'));
		const iconElement = dom.append(state, $(`span${ThemeIcon.asCSSSelector(icon)}`));
		if (spinning) { iconElement.classList.add('codicon-modifier-spin'); }
		dom.append(state, $('span')).textContent = label;
	}

	private renderAgentIcon(parent: HTMLElement, agent: ParadisResumeAgent): HTMLElement {
		const icon = agent === 'claude' ? Codicon.claude : Codicon.openai;
		const badge = dom.append(parent, $(`span.agent-badge.${agent}${ThemeIcon.asCSSSelector(icon)}`));
		const label = agent === 'claude' ? 'Claude Code' : 'Codex';
		badge.title = label;
		badge.setAttribute('role', 'img');
		badge.setAttribute('aria-label', label);
		return badge;
	}

	private searchTerms(): readonly string[] {
		return [...new Set(this.query.split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
	}

	private highlightSearchMatches(parent: HTMLElement): void {
		const terms = this.searchTerms();
		if (terms.length === 0) {
			return;
		}
		const pattern = new RegExp(terms.map(escapeRegExpCharacters).join('|'), 'gi');
		const walker = parent.ownerDocument.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		let node: Node | null;
		while ((node = walker.nextNode())) {
			const textNode = node as Text;
			if (!textNode.parentElement?.closest('mark.search-match')) {
				nodes.push(textNode);
			}
		}
		for (const textNode of nodes) {
			const value = textNode.data;
			pattern.lastIndex = 0;
			let cursor = 0;
			let match: RegExpExecArray | null;
			const fragment = parent.ownerDocument.createDocumentFragment();
			let matched = false;
			while ((match = pattern.exec(value))) {
				matched = true;
				fragment.append(value.slice(cursor, match.index));
				const mark = parent.ownerDocument.createElement('mark');
				mark.className = 'search-match';
				mark.textContent = match[0];
				this.renderedSearchMatches.push(mark);
				fragment.append(mark);
				cursor = match.index + match[0].length;
			}
			if (matched) {
				fragment.append(value.slice(cursor));
				textNode.replaceWith(fragment);
			}
		}
	}

	private appendHighlightedText(parent: HTMLElement, value: string): void {
		parent.textContent = value;
		this.highlightSearchMatches(parent);
	}

	private renderGroup(parent: HTMLElement, title: string, sessions: readonly IParadisResumeSession[], expanded: boolean): void {
		const details = dom.append(parent, $('details.paradis-session-resume-group')) as HTMLDetailsElement;
		details.open = expanded;
		const summary = dom.append(details, $('summary'));
		dom.append(summary, $('span.group-title')).textContent = title;
		dom.append(summary, $('span.group-count')).textContent = String(sessions.length);
		const rows = dom.append(details, $('.group-rows'));
		for (const session of sessions) {
			const row = dom.append(rows, $('button.paradis-session-resume-row')) as HTMLButtonElement;
			row.classList.toggle('selected', session.catalogId === this.selected?.catalogId);
			row.setAttribute('aria-pressed', String(session.catalogId === this.selected?.catalogId));
			const top = dom.append(row, $('.row-top'));
			this.renderAgentIcon(top, session.agent);
			this.appendHighlightedText(dom.append(top, $('span.row-title')), session.title);
			dom.append(top, $('span.row-time')).textContent = fromNow(session.updatedAt, true);
			const searchMatch = this.searchMatches?.get(session.catalogId);
			this.appendHighlightedText(dom.append(row, $('.row-preview')), searchMatch?.snippet || session.preview);
			if (this.query && searchMatch) {
				const matchInfo = dom.append(row, $('.row-match-info'));
				dom.append(matchInfo, $('span.match-source')).textContent = searchMatch.source === 'conversation'
					? localize('paradis.sessionResume.conversationMatch', "会話に一致")
					: localize('paradis.sessionResume.metadataMatch', "セッション情報に一致");
				dom.append(matchInfo, $('span.match-count')).textContent = localize('paradis.sessionResume.matchCount', "{0}件一致", searchMatch.matchCount);
			}
			const meta = dom.append(row, $('.row-meta'));
			dom.append(meta, $('span')).textContent = session.spaceName;
			dom.append(meta, $('span')).textContent = basename(URI.file(session.cwd));
			if (session.archived) {
				dom.append(meta, $('span.archived')).textContent = localize('paradis.sessionResume.archivedBadge', "アーカイブ済み");
			}
			this.renderDisposables.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => {
				this.selected = session;
				this.previewMessages = undefined;
				this.currentSearchMatchIndex = 0;
				this.render();
				void this.loadPreview(session);
			}));
		}
	}

	private renderDetail(): void {
		if (!this.detail) { return; }
		const session = this.selected;
		if (!session) {
			this.renderState(this.detail, Codicon.history, localize('paradis.sessionResume.selectSession', "セッションを選択すると会話を確認できます。"));
			return;
		}
		const renderSequence = this.renderSequence;
		const renderCancellation = this.renderDisposables.add(new CancellationTokenSource());
		const header = dom.append(this.detail, $('.paradis-session-resume-detail-header'));
		const heading = dom.append(header, $('.detail-heading'));
		this.renderAgentIcon(heading, session.agent);
		dom.append(heading, $('h2')).textContent = session.title;
		const meta = dom.append(header, $('.detail-meta'));
		dom.append(meta, $('span')).textContent = session.agent === 'claude' ? 'Claude Code' : 'Codex';
		dom.append(meta, $('span')).textContent = session.spaceName;
		dom.append(meta, $('span')).textContent = session.cwd;
		dom.append(meta, $('span.monospace')).textContent = session.id;
		let searchMatchLabel: HTMLElement | undefined;
		let previousSearchMatch: HTMLButtonElement | undefined;
		let nextSearchMatch: HTMLButtonElement | undefined;
		if (this.query) {
			const navigator = dom.append(header, $('.detail-search-navigator'));
			searchMatchLabel = dom.append(navigator, $('span.match-position'));
			searchMatchLabel.setAttribute('role', 'status');
			searchMatchLabel.setAttribute('aria-live', 'polite');
			previousSearchMatch = dom.append(navigator, $(`button${ThemeIcon.asCSSSelector(Codicon.chevronUp)}`)) as HTMLButtonElement;
			previousSearchMatch.title = localize('paradis.sessionResume.previousMatch', "前の一致箇所");
			previousSearchMatch.setAttribute('aria-label', previousSearchMatch.title);
			nextSearchMatch = dom.append(navigator, $(`button${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`)) as HTMLButtonElement;
			nextSearchMatch.title = localize('paradis.sessionResume.nextMatch', "次の一致箇所");
			nextSearchMatch.setAttribute('aria-label', nextSearchMatch.title);
		}

		const transcript = dom.append(this.detail, $('.paradis-session-resume-transcript'));
		if (this.previewLoading && this.previewMessages === undefined) {
			this.renderState(transcript, Codicon.loading, localize('paradis.sessionResume.previewLoading', "会話を読み込んでいます…"), true);
		} else if (!this.previewMessages || this.previewMessages.length === 0) {
			this.renderState(transcript, Codicon.comment, localize('paradis.sessionResume.noPreview', "表示できるユーザーまたはアシスタントのメッセージがありません。"));
		} else {
			if (this.previewTruncated) {
				const note = dom.append(transcript, $('.preview-note'));
				note.textContent = this.query && this.searchMatches?.get(session.catalogId)?.source === 'conversation'
					? localize('paradis.sessionResume.searchPreviewTruncated', "検索に一致したメッセージと、その前後の会話だけを表示しています。")
					: localize('paradis.sessionResume.previewTruncated', "この会話の最新部分を表示しています。以前のメッセージは省略されています。");
			}
			for (const message of this.previewMessages) {
				const article = dom.append(transcript, $(`article.message.${message.role}`));
				const label = dom.append(article, $('.message-role'));
				label.textContent = message.role === 'user' ? localize('paradis.sessionResume.you', "あなた") : (session.agent === 'claude' ? 'Claude' : 'Codex');
				const messageText = dom.append(article, $('.message-text'));
				const sourceMatch = message.rawSearchMatch ? dom.append(article, $('.message-source-match')) : undefined;
				if (sourceMatch) {
					const mark = dom.append(sourceMatch, $('mark.search-match.raw-search-match'));
					mark.textContent = localize('paradis.sessionResume.markdownSourceMatch', "Markdownソースに一致");
					this.renderedSearchMatches.push(mark);
				}
				const rendered = this.markdownRendererService.render(new MarkdownString(message.text, {
					isTrusted: false,
					supportHtml: false,
					supportThemeIcons: true,
					supportAlertSyntax: true,
				}), {
					codeBlockRenderer: (language, value) => this.renderCodeBlock(session, language, value, renderSequence, renderCancellation.token),
					asyncRenderCallback: () => {
						if (renderSequence !== this.renderSequence) {
							return;
						}
						this.highlightSearchMatches(messageText);
						sourceMatch?.classList.toggle('hidden', this.hasRenderedSearchMatch(messageText));
						this.updateSearchMatchNavigator(transcript, searchMatchLabel, previousSearchMatch, nextSearchMatch);
					},
					sanitizerConfig: { remoteImageIsAllowed: () => false },
				});
				this.renderDisposables.add(rendered);
				messageText.appendChild(rendered.element);
				this.highlightSearchMatches(messageText);
				sourceMatch?.classList.toggle('hidden', this.hasRenderedSearchMatch(messageText));
			}
		}
		this.updateSearchMatchNavigator(transcript, searchMatchLabel, previousSearchMatch, nextSearchMatch);
		if (previousSearchMatch && nextSearchMatch) {
			this.renderDisposables.add(dom.addDisposableListener(previousSearchMatch, dom.EventType.CLICK, () => this.moveSearchMatch(transcript, searchMatchLabel, previousSearchMatch, nextSearchMatch, -1)));
			this.renderDisposables.add(dom.addDisposableListener(nextSearchMatch, dom.EventType.CLICK, () => this.moveSearchMatch(transcript, searchMatchLabel, previousSearchMatch, nextSearchMatch, 1)));
		}

		const actions = dom.append(this.detail, $('.paradis-session-resume-actions'));
		if (!session.currentSpace) {
			const background = dom.append(actions, $('button.secondary')) as HTMLButtonElement;
			background.disabled = this.resumingCatalogIds.has(session.catalogId);
			background.textContent = localize('paradis.sessionResume.backgroundResume', "バックグラウンドで再開");
			this.renderDisposables.add(dom.addDisposableListener(background, dom.EventType.CLICK, () => this.resume(session, false)));
		}
		const primaryLabel = session.currentSpace
			? localize('paradis.sessionResume.resumeTerminal', "ターミナルで再開")
			: localize('paradis.sessionResume.switchAndResume', "{0}へ移動して再開", session.spaceName);
		const dangerousFlag = session.agent === 'claude'
			? '--dangerously-skip-permissions'
			: '--dangerously-bypass-approvals-and-sandbox';
		const dangerous = dom.append(actions, $('button.danger')) as HTMLButtonElement;
		dangerous.disabled = this.resumingCatalogIds.has(session.catalogId);
		dangerous.textContent = session.currentSpace
			? localize('paradis.sessionResume.resumeDangerously', "権限確認なしで再開")
			: localize('paradis.sessionResume.switchAndResumeDangerously', "権限確認なしで移動・再開");
		dangerous.title = localize(
			'paradis.sessionResume.resumeDangerouslyTitle',
			"{0}を付け、承認とサンドボックスを省略して再開します",
			dangerousFlag,
		);
		this.renderDisposables.add(dom.addDisposableListener(dangerous, dom.EventType.CLICK, () => this.resume(session, !session.currentSpace, true)));

		const primary = dom.append(actions, $('button.primary')) as HTMLButtonElement;
		primary.disabled = this.resumingCatalogIds.has(session.catalogId);
		primary.textContent = primaryLabel;
		this.renderDisposables.add(dom.addDisposableListener(primary, dom.EventType.CLICK, () => this.resume(session, !session.currentSpace)));
	}

	private async renderCodeBlock(session: IParadisResumeSession, language: string | undefined, value: string, renderSequence: number, token: CancellationToken): Promise<HTMLElement> {
		if ((language ?? '').toLocaleLowerCase() !== 'mermaid') {
			return this.markdownCodeBlockRenderer.renderCodeBlock(language, value, {});
		}
		const container = $('.paradis-session-resume-mermaid');
		try {
			const rendered = await this.chatOutputRendererService.renderCodeBlock('mermaid', new TextEncoder().encode(value), container, {
				title: localize('paradis.sessionResume.mermaidDiagram', "Mermaid図"),
				chatSessionResource: URI.from({ scheme: 'paradis-session-resume', path: `/sessions/${session.catalogId}` }),
			}, token);
			if (renderSequence !== this.renderSequence) {
				rendered.dispose();
			} else {
				this.renderDisposables.add(rendered);
			}
			return container;
		} catch {
			if (token.isCancellationRequested) {
				return container;
			}
			return this.markdownCodeBlockRenderer.renderCodeBlock(language, value, {});
		}
	}

	private updateSearchMatchNavigator(transcript: HTMLElement, label: HTMLElement | undefined, previous: HTMLButtonElement | undefined, next: HTMLButtonElement | undefined): void {
		if (!label || !previous || !next) {
			return;
		}
		const matches = this.visibleSearchMatches(transcript);
		this.currentSearchMatchIndex = matches.length === 0 ? 0 : Math.min(this.currentSearchMatchIndex, matches.length - 1);
		matches.forEach((match, index) => match.classList.toggle('current', index === this.currentSearchMatchIndex));
		label.textContent = matches.length === 0
			? localize('paradis.sessionResume.noConversationMatches', "会話内の一致なし")
			: localize('paradis.sessionResume.matchPosition', "会話内の一致 {0} / {1}", this.currentSearchMatchIndex + 1, matches.length);
		previous.disabled = matches.length === 0;
		next.disabled = matches.length === 0;
	}

	private moveSearchMatch(transcript: HTMLElement, label: HTMLElement | undefined, previous: HTMLButtonElement | undefined, next: HTMLButtonElement | undefined, delta: -1 | 1): void {
		const matches = this.visibleSearchMatches(transcript);
		if (matches.length === 0) {
			return;
		}
		this.currentSearchMatchIndex = (this.currentSearchMatchIndex + delta + matches.length) % matches.length;
		this.updateSearchMatchNavigator(transcript, label, previous, next);
		matches[this.currentSearchMatchIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
	}

	private visibleSearchMatches(transcript: HTMLElement): readonly HTMLElement[] {
		return this.renderedSearchMatches
			.filter(match => match.isConnected && transcript.contains(match) && !match.parentElement?.classList.contains('hidden'))
			.sort((a, b) => a === b ? 0 : (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
	}

	private hasRenderedSearchMatch(parent: HTMLElement): boolean {
		return this.renderedSearchMatches.some(match => match.isConnected && parent.contains(match));
	}

	private async loadPreview(session: IParadisResumeSession): Promise<void> {
		const sequence = ++this.previewSequence;
		const query = this.query;
		this.previewLoading = true;
		this.render();
		try {
			const preview = await this.client.preview(session.catalogId, query || undefined);
			if (sequence !== this.previewSequence || this.selected?.catalogId !== session.catalogId || query !== this.query) { return; }
			this.previewMessages = preview.messages;
			this.previewTruncated = preview.truncated;
		} catch (error) {
			if (sequence === this.previewSequence && this.selected?.catalogId === session.catalogId && query === this.query) {
				this.notificationService.error(error);
				this.previewMessages = [];
			}
		} finally {
			if (sequence === this.previewSequence && this.selected?.catalogId === session.catalogId && query === this.query) {
				this.previewLoading = false;
				this.render();
			}
		}
	}

	private async resume(session: IParadisResumeSession, switchFirst: boolean, dangerouslyBypassPermissions = false): Promise<void> {
		if (this.resumingCatalogIds.has(session.catalogId)) {
			return;
		}
		const space = this.spaces.find(candidate => candidate.stateKey === session.spaceStateKey);
		if (!space) {
			this.notificationService.error(localize('paradis.sessionResume.spaceMissing', "このセッションのスペースは現在利用できません。"));
			return;
		}
		this.resumingCatalogIds.add(session.catalogId);
		this.render();
		try {
			if (switchFirst) {
				await this.workspaceSwitchService.switchToStateKey(space.stateKey);
			}
			await this.instantiationService.invokeFunction(paradisResumeAgentInWorkspace, {
				rootUri: space.uri, stateKey: space.stateKey, agent: session.agent, sessionId: session.id,
				dangerouslyBypassPermissions,
			});
		} catch (error) {
			this.notificationService.error(error);
		} finally {
			this.resumingCatalogIds.delete(session.catalogId);
			this.render();
		}
	}
}
