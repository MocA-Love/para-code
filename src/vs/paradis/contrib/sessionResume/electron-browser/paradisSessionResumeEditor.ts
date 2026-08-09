/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import './media/paradisSessionResume.css';
import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisResumeAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { IParadisResumeMessage, IParadisResumeSession, IParadisResumeSpace, ParadisResumeAgent } from '../common/paradisSessionResume.js';
import { ParadisSessionResumeClient } from './paradisSessionResumeClient.js';
import { PARADIS_SESSION_RESUME_EDITOR_ID } from './paradisSessionResumeInput.js';

const $ = dom.$;
type AgentFilter = 'all' | ParadisResumeAgent;
type PeriodFilter = 'all' | 'day' | 'week' | 'month';

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
	private query = '';
	private searchMatches: ReadonlySet<string> | undefined;
	private searchSequence = 0;
	private agentFilter: AgentFilter = 'all';
	private periodFilter: PeriodFilter = 'all';
	private readonly resumingCatalogIds = new Set<string>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(PARADIS_SESSION_RESUME_EDITOR_ID, group, telemetryService, themeService, storageService);
		this.client = instantiationService.createInstance(ParadisSessionResumeClient);
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
		this.searchInput.placeholder = localize('paradis.sessionResume.searchPlaceholder', "Search title, conversation, path, or session ID");
		this.searchInput.setAttribute('aria-label', this.searchInput.placeholder);
		this._register(dom.addDisposableListener(this.searchInput, dom.EventType.INPUT, () => {
			this.query = this.searchInput?.value.trim().toLocaleLowerCase() ?? '';
			this.searchMatches = undefined;
			this.searchScheduler.schedule();
			this.render();
		}));

		this.agentSelect = this.createSelect(toolbar, localize('paradis.sessionResume.agentLabel', "Agent"), [
			['all', localize('paradis.sessionResume.allAgents', "All agents")],
			['claude', 'Claude Code'],
			['codex', 'Codex'],
		]);
		this._register(dom.addDisposableListener(this.agentSelect, dom.EventType.CHANGE, () => {
			this.agentFilter = this.agentSelect?.value as AgentFilter;
			this.render();
		}));

		this.periodSelect = this.createSelect(toolbar, localize('paradis.sessionResume.periodLabel', "Period"), [
			['all', localize('paradis.sessionResume.periodAll', "Any time")],
			['day', localize('paradis.sessionResume.periodDay', "Last 24 hours")],
			['week', localize('paradis.sessionResume.periodWeek', "Last 7 days")],
			['month', localize('paradis.sessionResume.periodMonth', "Last 30 days")],
		]);
		this._register(dom.addDisposableListener(this.periodSelect, dom.EventType.CHANGE, () => {
			this.periodFilter = this.periodSelect?.value as PeriodFilter;
			this.render();
		}));

		const archivedLabel = dom.append(toolbar, $('label.paradis-session-resume-check'));
		this.archivedInput = dom.append(archivedLabel, $('input')) as HTMLInputElement;
		this.archivedInput.type = 'checkbox';
		dom.append(archivedLabel, $('span')).textContent = localize('paradis.sessionResume.archived', "Archived");
		this._register(dom.addDisposableListener(this.archivedInput, dom.EventType.CHANGE, () => this.refresh()));

		this.refreshButton = dom.append(toolbar, $('button.paradis-session-resume-refresh')) as HTMLButtonElement;
		this.refreshButton.title = localize('paradis.sessionResume.refresh', "Refresh session history");
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
			this.sessions = await this.client.list({
				spaces: this.spaces.map(({ stateKey, name, cwd, current }) => ({ stateKey, name, cwd, current })),
				includeArchived: this.archivedInput?.checked === true,
			});
			this.selected = this.sessions.find(session => session.id === this.selected?.id && session.agent === this.selected.agent) ?? this.sessions[0];
			this.previewMessages = undefined;
			if (this.selected) {
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
			this.render();
			return;
		}
		try {
			const matches = await this.client.search(query, this.sessions.map(session => session.catalogId));
			if (sequence === this.searchSequence && query === this.query) {
				this.searchMatches = new Set(matches);
				this.render();
			}
		} catch {
			// 検索失敗時もmetadata検索は利用できる。入力内容を外部へ送ったり記録したりしない。
		}
	}

	private render(): void {
		if (!this.list || !this.detail) { return; }
		this.renderDisposables.clear();
		dom.clearNode(this.list);
		dom.clearNode(this.detail);
		if (this.loading && this.sessions.length === 0) {
			this.renderState(this.list, Codicon.loading, localize('paradis.sessionResume.loading', "Reading local session history…"), true);
			this.renderState(this.detail, Codicon.history, localize('paradis.sessionResume.selectAfterLoad', "Select a session to preview it."));
			return;
		}
		const filtered = this.filteredSessions();
		if (filtered.length === 0) {
			this.renderState(this.list, Codicon.search, this.sessions.length === 0
				? localize('paradis.sessionResume.noSessions', "No Claude Code or Codex sessions were found in registered spaces.")
				: localize('paradis.sessionResume.noMatches', "No sessions match these filters."));
		} else {
			const current = filtered.filter(session => session.currentSpace);
			const other = filtered.filter(session => !session.currentSpace);
			if (current.length > 0) {
				this.renderGroup(this.list, localize('paradis.sessionResume.currentSpace', "Current space"), current, true);
			}
			if (other.length > 0) {
				const bySpace = new Map<string, IParadisResumeSession[]>();
				for (const session of other) {
					const sessions = bySpace.get(session.spaceStateKey) ?? [];
					sessions.push(session);
					bySpace.set(session.spaceStateKey, sessions);
				}
				const otherHeading = dom.append(this.list, $('.paradis-session-resume-superheading'));
				otherHeading.textContent = localize('paradis.sessionResume.otherSpaces', "Other spaces");
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
			const badge = dom.append(top, $(`span.agent-badge.${session.agent}`));
			badge.textContent = session.agent === 'claude' ? 'C' : 'X';
			dom.append(top, $('span.row-title')).textContent = session.title;
			dom.append(top, $('span.row-time')).textContent = fromNow(session.updatedAt, true);
			dom.append(row, $('.row-preview')).textContent = session.preview;
			const meta = dom.append(row, $('.row-meta'));
			dom.append(meta, $('span')).textContent = session.spaceName;
			dom.append(meta, $('span')).textContent = basename(URI.file(session.cwd));
			if (session.archived) {
				dom.append(meta, $('span.archived')).textContent = localize('paradis.sessionResume.archivedBadge', "Archived");
			}
			this.renderDisposables.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => {
				this.selected = session;
				this.previewMessages = undefined;
				this.render();
				void this.loadPreview(session);
			}));
		}
	}

	private renderDetail(): void {
		if (!this.detail) { return; }
		const session = this.selected;
		if (!session) {
			this.renderState(this.detail, Codicon.history, localize('paradis.sessionResume.selectSession', "Select a session to preview it."));
			return;
		}
		const header = dom.append(this.detail, $('.paradis-session-resume-detail-header'));
		const heading = dom.append(header, $('.detail-heading'));
		const badge = dom.append(heading, $(`span.agent-badge.${session.agent}`));
		badge.textContent = session.agent === 'claude' ? 'C' : 'X';
		dom.append(heading, $('h2')).textContent = session.title;
		const meta = dom.append(header, $('.detail-meta'));
		dom.append(meta, $('span')).textContent = session.agent === 'claude' ? 'Claude Code' : 'Codex';
		dom.append(meta, $('span')).textContent = session.spaceName;
		dom.append(meta, $('span')).textContent = session.cwd;
		dom.append(meta, $('span.monospace')).textContent = session.id;

		const transcript = dom.append(this.detail, $('.paradis-session-resume-transcript'));
		if (this.previewLoading && this.previewMessages === undefined) {
			this.renderState(transcript, Codicon.loading, localize('paradis.sessionResume.previewLoading', "Loading conversation…"), true);
		} else if (!this.previewMessages || this.previewMessages.length === 0) {
			this.renderState(transcript, Codicon.comment, localize('paradis.sessionResume.noPreview', "No user or assistant messages could be previewed."));
		} else {
			if (this.previewTruncated) {
				const note = dom.append(transcript, $('.preview-note'));
				note.textContent = localize('paradis.sessionResume.previewTruncated', "Showing the latest part of this conversation.");
			}
			for (const message of this.previewMessages) {
				const article = dom.append(transcript, $(`article.message.${message.role}`));
				const label = dom.append(article, $('.message-role'));
				label.textContent = message.role === 'user' ? localize('paradis.sessionResume.you', "You") : (session.agent === 'claude' ? 'Claude' : 'Codex');
				dom.append(article, $('.message-text')).textContent = message.text;
			}
		}

		const actions = dom.append(this.detail, $('.paradis-session-resume-actions'));
		const primary = dom.append(actions, $('button.primary')) as HTMLButtonElement;
		primary.disabled = this.resumingCatalogIds.has(session.catalogId);
		primary.textContent = session.currentSpace
			? localize('paradis.sessionResume.resumeTerminal', "Resume in terminal")
			: localize('paradis.sessionResume.switchAndResume', "Switch to {0} and resume", session.spaceName);
		this.renderDisposables.add(dom.addDisposableListener(primary, dom.EventType.CLICK, () => this.resume(session, !session.currentSpace)));
		if (!session.currentSpace) {
			const background = dom.append(actions, $('button.secondary')) as HTMLButtonElement;
			background.disabled = this.resumingCatalogIds.has(session.catalogId);
			background.textContent = localize('paradis.sessionResume.backgroundResume', "Resume in background");
			this.renderDisposables.add(dom.addDisposableListener(background, dom.EventType.CLICK, () => this.resume(session, false)));
		}
	}

	private async loadPreview(session: IParadisResumeSession): Promise<void> {
		this.previewLoading = true;
		this.render();
		try {
			const preview = await this.client.preview(session.catalogId);
			if (this.selected?.catalogId !== session.catalogId) { return; }
			this.previewMessages = preview.messages;
			this.previewTruncated = preview.truncated;
		} catch (error) {
			if (this.selected?.catalogId === session.catalogId) {
				this.notificationService.error(error);
				this.previewMessages = [];
			}
		} finally {
			if (this.selected?.catalogId === session.catalogId) {
				this.previewLoading = false;
				this.render();
			}
		}
	}

	private async resume(session: IParadisResumeSession, switchFirst: boolean): Promise<void> {
		if (this.resumingCatalogIds.has(session.catalogId)) {
			return;
		}
		const space = this.spaces.find(candidate => candidate.stateKey === session.spaceStateKey);
		if (!space) {
			this.notificationService.error(localize('paradis.sessionResume.spaceMissing', "This session's space is no longer available."));
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
			});
		} catch (error) {
			this.notificationService.error(error);
		} finally {
			this.resumingCatalogIds.delete(session.catalogId);
			this.render();
		}
	}
}
