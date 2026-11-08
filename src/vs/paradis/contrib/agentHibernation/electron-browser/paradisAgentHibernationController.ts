/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 休止（G-03）の見張り。1 分ごとに、完了して放ってあるエディタのターミナルのエージェントを探し、
// shared process に止めてもらう。休止中のタブが画面に出て窓にフォーカスがある・スマホが開いたら、
// 再開の帯（terminalResumeBanner）の再開で同じ会話を続ける。台帳と帯はホスト（帯の contribution）が持つ。
//
// 各段（止めた・断った理由・起こした・送れなかった）は `[ParadisAgentHibernation]` で 1 行ずつログに出す。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentStatusSnapshot, PARADIS_AGENT_BROWSER_CHANNEL } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { PARADIS_TASK_BOARD_BRIDGE_CHANNEL, paradisTaskBoardTerminalId } from '../../taskBoard/common/paradisTaskBoardBridge.js';
import { paradisIsWorkbenchWindowFocused } from '../../workspaceSwitch/browser/paradisWindowFocus.js';
import { paradisForgetRemoteTerminalViewing, paradisIsRemoteTerminalViewing, paradisLastRemoteTerminalViewAt, paradisSetHibernationWakeHandler } from '../browser/paradisAgentHibernationRemoteViews.js';
import { IParadisHibernationPaneFacts, PARADIS_AGENT_HIBERNATION_ENABLED_SETTING, PARADIS_AGENT_HIBERNATION_IDLE_MINUTES_SETTING, PARADIS_AGENT_HIBERNATION_RETRY_MS, PARADIS_AGENT_HIBERNATION_TICK_MS, ParadisHibernationSkipReason, paradisAgentHibernationIdleMs, paradisHibernationVerdict, paradisIsUserTypedInput, paradisNextPendingDraft, paradisParseHibernationResult } from '../common/paradisAgentHibernation.js';

const LOG = '[ParadisAgentHibernation]';

/** 再開を試みた結果。`sent` 以外は送れなかった理由。 */
export type ParadisHibernationResumeOutcome = 'sent' | 'no-offer' | 'no-shell-integration' | 'not-at-prompt' | 'folder-missing' | 'unknown-shell' | 'typed' | 'folder-change-failed' | 'busy' | 'failed';

/** 台帳と再開の帯を持つ側（terminalResumeBanner の contribution）。 */
export interface IParadisAgentHibernationHost {
	/** そのタブで台帳に控えてある今の会話の ID。 */
	ledgerSessionId(instanceId: number): string | undefined;
	isHibernated(instanceId: number): boolean;
	/** 止める前に休止の印を付け、帯を「休止中」にする。付けられなければ false。 */
	markHibernated(instanceId: number, sessionId: string, completedAt: number): boolean;
	/** 止めた後に分かった、権限の確認を省いて動いていたか。 */
	setHibernatedBypass(instanceId: number, bypass: boolean): void;
	/** 止められなかったので印を外す（帯も消す）。 */
	unmarkHibernated(instanceId: number): void;
	/** 休止中のタブで同じ会話を再開する。`focus` ならタブへフォーカスを移す。 */
	resumeHibernated(instanceId: number, focus: boolean): Promise<ParadisHibernationResumeOutcome>;
}

interface IInstanceActivity {
	lastInputAt?: number;
	pendingDraft: boolean;
	lastVisibleAt?: number;
}

export class ParadisAgentHibernationController extends Disposable {

	private readonly tick = this._register(new RunOnceScheduler(() => void this.runTick(), PARADIS_AGENT_HIBERNATION_TICK_MS));
	private readonly activity = new Map<number, IInstanceActivity>();
	private readonly instanceListeners = this._register(new DisposableMap<number>());
	/** トークン → このウィンドウで見た、最後にターンが終わった時刻。 */
	private readonly completedAt = new Map<string, number>();
	/** トークン → 止めるのを断られて、次に試してよい時刻。 */
	private readonly retryAfter = new Map<string, number>();
	/** 止めている最中・再開している最中のタブ。 */
	private readonly busy = new Set<number>();
	/** タブ → 最後にログへ出した、休止しない理由（同じ理由を毎分出さない）。 */
	private readonly lastSkip = new Map<number, ParadisHibernationSkipReason>();
	private snapshot: IParadisAgentStatusSnapshot | undefined;
	private readonly wakeHandler = this._register(new MutableDisposable());

	constructor(
		private readonly host: IParadisAgentHibernationHost,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IParadisAgentStatusSnapshotService snapshotService: IParadisAgentStatusSnapshotService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IEditorService private readonly editorService: IEditorService,
		@IHostService hostService: IHostService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(snapshotService.subscribe(outcome => {
			if (outcome.snapshot !== undefined) {
				this.onSnapshot(outcome.snapshot);
			}
		}));
		this._register(this.terminalService.onDidCreateInstance(instance => this.watchInstance(instance)));
		for (const instance of this.terminalService.instances) {
			this.watchInstance(instance);
		}
		this._register(this.editorService.onDidVisibleEditorsChange(() => this.onVisibilityChanged()));
		this._register(hostService.onDidChangeFocus(() => this.onVisibilityChanged()));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PARADIS_AGENT_HIBERNATION_ENABLED_SETTING)) {
				this.logService.info(`${LOG} ${this.enabled() ? 'enabled' : 'disabled'}`);
			}
		}));
		this.wakeHandler.value = paradisSetHibernationWakeHandler(instanceId => this.wake(instanceId, 'mobile'));
		this.tick.schedule();
	}

	private enabled(): boolean {
		return this.configurationService.getValue<boolean>(PARADIS_AGENT_HIBERNATION_ENABLED_SETTING) === true;
	}

	// --- 見ているもの -------------------------------------------------------------------

	private watchInstance(instance: ITerminalInstance): void {
		if (this.instanceListeners.has(instance.instanceId)) {
			return;
		}
		const activity: IInstanceActivity = { pendingDraft: false };
		this.activity.set(instance.instanceId, activity);
		const store = this.instanceListeners;
		const listeners = instance.onDidInputData(data => {
			if (paradisIsUserTypedInput(data)) {
				activity.lastInputAt = Date.now();
			}
			activity.pendingDraft = paradisNextPendingDraft(activity.pendingDraft, data);
		});
		const disposed = instance.onDisposed(() => {
			this.activity.delete(instance.instanceId);
			this.lastSkip.delete(instance.instanceId);
			this.busy.delete(instance.instanceId);
			paradisForgetRemoteTerminalViewing(instance.instanceId);
			store.deleteAndDispose(instance.instanceId);
		});
		store.set(instance.instanceId, { dispose: () => { listeners.dispose(); disposed.dispose(); } });
	}

	private onSnapshot(snapshot: IParadisAgentStatusSnapshot): void {
		this.snapshot = snapshot;
		for (const pane of snapshot.paneStatuses) {
			if (pane.status === 'review') {
				this.completedAt.set(pane.token, pane.changedAt);
			} else {
				// 次のターンが動いた（中断で終わったターンは完了ではない）。次の確認待ちまで休止の候補にしない
				this.completedAt.delete(pane.token);
			}
		}
	}

	private visibleInstanceIds(): Set<number> {
		const ids = new Set<number>();
		for (const editor of this.editorService.visibleEditors) {
			if (editor instanceof TerminalEditorInput && editor.terminalInstance !== undefined) {
				ids.add(editor.terminalInstance.instanceId);
			}
		}
		return ids;
	}

	private onVisibilityChanged(): void {
		const now = Date.now();
		const visible = this.visibleInstanceIds();
		for (const instanceId of visible) {
			const activity = this.activity.get(instanceId);
			if (activity !== undefined) {
				activity.lastVisibleAt = now;
			}
		}
		if (!paradisIsWorkbenchWindowFocused()) {
			return;
		}
		for (const instanceId of visible) {
			if (this.host.isHibernated(instanceId)) {
				this.wake(instanceId, 'visible');
			}
		}
	}

	// --- 起こす ---------------------------------------------------------------------------

	private wake(instanceId: number, reason: 'visible' | 'mobile'): void {
		if (!this.host.isHibernated(instanceId) || this.busy.has(instanceId)) {
			return;
		}
		this.busy.add(instanceId);
		this.logService.info(`${LOG} waking terminal ${instanceId} (${reason === 'mobile' ? 'opened on the phone' : 'the tab came to the front'})`);
		void this.host.resumeHibernated(instanceId, reason === 'visible').then(outcome => {
			if (outcome === 'sent') {
				this.logService.info(`${LOG} sent the resume command to terminal ${instanceId}`);
			} else {
				this.logService.info(`${LOG} could not send the resume command to terminal ${instanceId}: ${outcome} (the banner stays)`);
			}
		}, error => this.logService.warn(`${LOG} resuming terminal ${instanceId} failed`, error)).finally(() => this.busy.delete(instanceId));
	}

	// --- 止める ---------------------------------------------------------------------------

	private async runTick(): Promise<void> {
		try {
			// 起動の直後から画面に出ている休止中のタブ（再起動をまたいだもの）は、見えている変化の知らせが来ないので、ここでも起こす。
			// 設定をオフにした後も、休止したままのタブは起こす
			this.onVisibilityChanged();
			if (this.enabled() && this.environmentService.remoteAuthority === undefined && this.snapshot !== undefined) {
				await this.planAndHibernate(this.snapshot);
			}
		} catch (error) {
			this.logService.warn(`${LOG} the hibernation check failed`, error);
		} finally {
			if (!this._store.isDisposed) {
				this.tick.schedule();
			}
		}
	}

	private async planAndHibernate(snapshot: IParadisAgentStatusSnapshot): Promise<void> {
		const now = Date.now();
		const idleMs = paradisAgentHibernationIdleMs(this.configurationService.getValue(PARADIS_AGENT_HIBERNATION_IDLE_MINUTES_SETTING));
		const visible = this.visibleInstanceIds();
		const statuses = new Map(snapshot.paneStatuses.map(pane => [pane.token, pane]));
		const sessions = new Map((snapshot.paneSessions ?? []).map(session => [session.token, session]));
		const awaiting = new Set(snapshot.awaitingUserTokens ?? []);
		const replayed = new Set((snapshot.replayedPrompts ?? []).map(prompt => prompt.token));
		let boardTerminals: ReadonlySet<string> | undefined;
		for (const instance of this.terminalService.instances) {
			const token = this.paneTokenService.getTokenForInstance(instance.instanceId);
			if (token === undefined || instance.isDisposed) {
				continue;
			}
			const activity = this.activity.get(instance.instanceId) ?? { pendingDraft: false };
			if (visible.has(instance.instanceId)) {
				activity.lastVisibleAt = now;
			}
			const status = statuses.get(token);
			const paneSession = sessions.get(token);
			const ledgerSessionId = this.host.ledgerSessionId(instance.instanceId);
			const session = paneSession !== undefined && (paneSession.agent === 'claude' || paneSession.agent === 'codex')
				&& paneSession.remote !== true && ledgerSessionId === paneSession.sessionId
				? { agent: paneSession.agent, sessionId: paneSession.sessionId } : undefined;
			const facts: IParadisHibernationPaneFacts = {
				editorArea: instance.target === TerminalLocation.Editor,
				remote: instance.remoteAuthority !== undefined || paneSession?.remote === true,
				taskBoard: false,
				hibernated: this.host.isHibernated(instance.instanceId),
				busy: this.busy.has(instance.instanceId),
				status: status?.status,
				quiet: status?.quiet === true,
				awaitingUser: awaiting.has(token),
				replayedPrompt: replayed.has(token),
				session,
				completedAt: this.completedAt.get(token),
				visible: visible.has(instance.instanceId),
				lastVisibleAt: activity.lastVisibleAt,
				lastInputAt: activity.lastInputAt,
				pendingDraft: activity.pendingDraft,
				remoteViewing: paradisIsRemoteTerminalViewing(instance.instanceId),
				lastRemoteViewAt: paradisLastRemoteTerminalViewAt(instance.instanceId),
				retryAfter: this.retryAfter.get(token),
			};
			let verdict = paradisHibernationVerdict(facts, now, idleMs);
			if (verdict.kind === 'hibernate') {
				// タスクボードのターミナルかは、止める候補になったときだけ尋ねる（尋ねられなければ止めない）
				boardTerminals ??= await this.boardTerminals();
				if (boardTerminals === undefined || boardTerminals.has(paradisTaskBoardTerminalId(token))) {
					verdict = paradisHibernationVerdict({ ...facts, taskBoard: true }, now, idleMs);
				}
			}
			if (verdict.kind === 'skip') {
				this.noteSkip(instance.instanceId, verdict.reason);
				continue;
			}
			this.lastSkip.delete(instance.instanceId);
			if (verdict.kind === 'hibernate' && session !== undefined && facts.completedAt !== undefined) {
				await this.hibernate(instance, token, session.sessionId, facts.completedAt);
			}
		}
	}

	/** 休止しない理由は、休止の候補になりうる理由が変わったときだけ trace に出す。 */
	private noteSkip(instanceId: number, reason: ParadisHibernationSkipReason): void {
		if (this.lastSkip.get(instanceId) === reason) {
			return;
		}
		this.lastSkip.set(instanceId, reason);
		if (reason === 'task-board' || reason === 'draft' || reason === 'remote-viewing' || reason === 'quiet' || reason === 'awaiting-user' || reason === 'completion-unknown') {
			this.logService.info(`${LOG} not hibernating terminal ${instanceId}: ${reason}`);
		} else {
			this.logService.trace(`${LOG} not hibernating terminal ${instanceId}: ${reason}`);
		}
	}

	private async boardTerminals(): Promise<ReadonlySet<string> | undefined> {
		try {
			const terminals = await this.sharedProcessService.getChannel(PARADIS_TASK_BOARD_BRIDGE_CHANNEL).call<unknown>('listWindowTerminals');
			return new Set(Array.isArray(terminals) ? terminals.filter((value): value is string => typeof value === 'string') : []);
		} catch (error) {
			this.logService.info(`${LOG} could not read the task board terminals; not hibernating this round`, String(error));
			return undefined;
		}
	}

	private async hibernate(instance: ITerminalInstance, token: string, sessionId: string, completedAt: number): Promise<void> {
		const instanceId = instance.instanceId;
		// 止める前に印を付ける。止めた後に印を付けると、エージェントのコマンドの終わりで台帳から会話が消える
		if (!this.host.markHibernated(instanceId, sessionId, completedAt)) {
			this.logService.info(`${LOG} not hibernating terminal ${instanceId}: the conversation is not in the resume ledger`);
			return;
		}
		this.busy.add(instanceId);
		try {
			const result = paradisParseHibernationResult(await this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call('hibernatePane', [token, sessionId]).catch(() => undefined));
			if (result.ok) {
				this.host.setHibernatedBypass(instanceId, result.bypass);
				this.retryAfter.delete(token);
				this.logService.info(`${LOG} hibernated terminal ${instanceId} (${result.killed ? 'needed SIGKILL' : 'stopped with SIGTERM'}${result.bypass ? ', resumes without permission prompts' : ''})`);
			} else {
				this.host.unmarkHibernated(instanceId);
				this.retryAfter.set(token, Date.now() + PARADIS_AGENT_HIBERNATION_RETRY_MS);
				this.logService.info(`${LOG} the shared process refused to hibernate terminal ${instanceId}: ${result.reason}`);
			}
		} finally {
			this.busy.delete(instanceId);
		}
		// 止めている間にタブが前へ来た・スマホが開いたなら、すぐ起こす
		if (this.host.isHibernated(instanceId) && ((paradisIsWorkbenchWindowFocused() && this.visibleInstanceIds().has(instanceId)) || paradisIsRemoteTerminalViewing(instanceId))) {
			this.wake(instanceId, paradisIsRemoteTerminalViewing(instanceId) ? 'mobile' : 'visible');
		}
	}
}
