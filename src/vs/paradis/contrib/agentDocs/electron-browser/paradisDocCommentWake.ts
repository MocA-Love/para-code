/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// コメントのカードの「起こして届ける」「別のエージェントに渡す」（Q663-4、Q667-7）。押したウィンドウで動く。
//
// 起こしてよいかは shared process の届け方の係が台帳から決め（終了を見た会話だけ。動いている・分からない・起こしている
// 途中の会話は断る）、券を渡す。ウィンドウはこのウィンドウのターミナルでその会話が再開されていないかをもう一度確かめ、
// 会話を始めたフォルダを含むスペースに新しいターミナルを裏のタブで作って `claude --resume <id>`・`codex resume <id>` を
// 打つ（`paradisResumeAgentInWorkspace`、権限の確認を省かない）。貼るのはここではしない。起こしたペインから同じ ID の
// hook が来れば、届け方の係がそのペインを持ち主のペインとして、CLI の起動を待ってから今の道で届ける。
//
// 「別のエージェントに渡す」は、このウィンドウでエージェントが動いているペインを選ばせ、shared process で持ち主を移す
// （押して選んだことが確認になる）。移した後は今の届け方に任せる。

import { Event } from '../../../../base/common/event.js';
import { Lazy } from '../../../../base/common/lazy.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { ITerminalGroupService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisAgentDescriptor } from '../../agentChat/common/paradisAgentDescriptor.js';
import { paradisResumedSessionOfCommand } from '../../mobileRelay/common/paradisMobileAgentResume.js';
import { paradisCollectAllTerminalInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisResumeAgentInWorkspaceRequest, paradisResumeAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { paradisNormalizeDocPath } from '../common/paradisAgentDocs.js';
import { IParadisDocPaneSessionInfo, PARADIS_AGENT_DOCS_VIEW_CHANNEL, ParadisAgentDocsViewCall, paradisDocFileName } from '../common/paradisAgentDocsView.js';
import {
	PARADIS_DOC_DELIVERY_CHANNEL,
	PARADIS_DOC_DELIVERY_HAND_OFF_METHOD,
	PARADIS_DOC_DELIVERY_WAKE_FAILED_METHOD,
	PARADIS_DOC_DELIVERY_WAKE_METHOD,
	PARADIS_DOC_DELIVERY_WOKE_METHOD,
	ParadisDocWakeAnswer,
	ParadisDocWakeRefusal,
	paradisDocWakeSpaceFor,
} from '../common/paradisDocCommentDelivery.js';

/** 起こす手順が使う口（単体テストで差し替える）。 */
export interface IParadisDocWakeDependencies {
	readonly windowIsRemote: boolean;
	/** 起こす券を取る（shared process）。 */
	wake(hostId: string, path: string, windowIsRemote: boolean): Promise<ParadisDocWakeAnswer>;
	woke(session: string, paneToken: string | undefined): Promise<void>;
	wakeFailed(session: string): Promise<void>;
	/** このウィンドウのターミナルで、再開のコマンドとして動いている会話の ID。 */
	resumedSessions(): ReadonlySet<string>;
	/** スペースの一覧（フォルダは正規化した絶対パス）と今のスペース。 */
	spaces(): readonly { readonly stateKey: string; readonly path: string }[];
	readonly activeStateKey: string | undefined;
	resume(request: IParadisResumeAgentInWorkspaceRequest): Promise<{ readonly instanceId: number; readonly paneToken: string | undefined }>;
	/** 起こしたターミナルで CLI が終わった・ターミナルが閉じたら一度だけ呼ぶ（hook が来ないまま終わったときに、起こす途中の印を外す）。 */
	watchLaunched(instanceId: number, onEnd: () => void): void;
	notify(severity: Severity, message: string): void;
}

function refusalMessage(reason: ParadisDocWakeRefusal): string {
	switch (reason) {
		case 'noOwner':
			return localize('paradis.docComments.wake.noOwner', "この資料の作成元のセッションが分からないため、起こせません。");
		case 'live':
			return localize('paradis.docComments.wake.live', "作成元のセッションは動いています。そのターミナルへ届けます。");
		case 'unknown':
			return localize('paradis.docComments.wake.unknown', "作成元のセッションが動いているか分からないため、起こしません。");
		case 'waking':
			return localize('paradis.docComments.wake.waking', "作成元のセッションを起こしている途中です。");
		case 'maybeLive':
			return localize('paradis.docComments.wake.maybeLive', "作成元のセッションがどこかで動いている可能性があるため、起こしません。");
		case 'agent':
			return localize('paradis.docComments.wake.agent', "このエージェントのセッションは起こせません。別のエージェントに渡してください。");
		case 'remote':
			return localize('paradis.docComments.wake.remote', "SSH 先のセッションは、まだここから起こせません。");
		case 'noCwd':
			return localize('paradis.docComments.wake.noCwd', "作成元のセッションを始めたフォルダが分からないため、起こせません。");
	}
}

/**
 * 終了した持ち主の会話を起こす。券が出なければ理由を知らせて何もしない。券が出た後に起こせなかったら、
 * shared process の「起こしている途中」を外す（カードは「起こして届ける」に戻る）。
 */
export async function paradisWakeDocOwner(dependencies: IParadisDocWakeDependencies, hostId: string, path: string): Promise<void> {
	const answer = await dependencies.wake(hostId, path, dependencies.windowIsRemote);
	if (answer.kind !== 'wake') {
		dependencies.notify(answer.reason === 'live' || answer.reason === 'waking' ? Severity.Info : Severity.Warning, refusalMessage(answer.reason));
		return;
	}
	// hook が届く前の、このウィンドウで再開したばかりのターミナルも見る（同じ会話を二度再開しない）
	if (dependencies.resumedSessions().has(answer.session)) {
		await dependencies.wakeFailed(answer.session);
		dependencies.notify(Severity.Info, localize('paradis.docComments.wake.running', "このウィンドウのターミナルで作成元のセッションが動いているため、起こしません。そのターミナルへ届けます。"));
		return;
	}
	const stateKey = paradisDocWakeSpaceFor(dependencies.spaces(), answer.cwd)?.stateKey ?? dependencies.activeStateKey;
	if (stateKey === undefined) {
		await dependencies.wakeFailed(answer.session);
		dependencies.notify(Severity.Warning, localize('paradis.docComments.wake.noSpace', "スペースを開いていないため、起こせません。"));
		return;
	}
	let launched: { readonly instanceId: number; readonly paneToken: string | undefined };
	try {
		launched = await dependencies.resume({
			rootUri: URI.file(answer.cwd),
			stateKey,
			agent: answer.agent,
			sessionId: answer.session,
			dangerouslyBypassPermissions: false,
			preserveFocus: true,
		});
	} catch (error) {
		await dependencies.wakeFailed(answer.session);
		dependencies.notify(Severity.Error, localize('paradis.docComments.wake.failed', "作成元のセッションを起こすターミナルを開けませんでした。"));
		throw error;
	}
	await dependencies.woke(answer.session, launched.paneToken);
	// 起きた後に CLI が終わったときも呼ばれるが、そのときは起こす途中の印がもう無いので何も変わらない
	dependencies.watchLaunched(launched.instanceId, () => void dependencies.wakeFailed(answer.session));
}

/** 渡す先の候補（このウィンドウでエージェントが動いているペイン）。 */
export interface IParadisDocHandOffPane {
	readonly token: string;
	readonly label: string;
	readonly description: string;
}

export interface IParadisDocHandOffDependencies {
	panes(hostId: string): Promise<readonly IParadisDocHandOffPane[]>;
	pick(panes: readonly IParadisDocHandOffPane[], fileName: string): Promise<IParadisDocHandOffPane | undefined>;
	handOff(hostId: string, path: string, token: string): Promise<string>;
	notify(severity: Severity, message: string): void;
}

/** 資料を、選んだペインの会話へ渡す。 */
export async function paradisHandOffDoc(dependencies: IParadisDocHandOffDependencies, hostId: string, path: string): Promise<void> {
	const panes = await dependencies.panes(hostId);
	if (panes.length === 0) {
		dependencies.notify(Severity.Info, localize('paradis.docComments.handOff.none', "資料を渡せるエージェントのターミナルがありません。エージェントに 1 度話しかけてから選んでください。"));
		return;
	}
	const picked = await dependencies.pick(panes, paradisDocFileName(path));
	if (picked === undefined) {
		return;
	}
	const result = await dependencies.handOff(hostId, path, picked.token);
	if (result === 'ownerActive') {
		dependencies.notify(Severity.Info, localize('paradis.docComments.handOff.ownerActive', "作成元のセッションが動いている・動いているか分からないため、渡しませんでした。"));
	} else if (result !== 'handedOff') {
		dependencies.notify(Severity.Warning, localize('paradis.docComments.handOff.failed', "資料を渡せませんでした。ターミナルのエージェントに 1 度話しかけてから、もう一度選んでください。"));
	}
}

/** 起こしたターミナルを見張る上限（過ぎたら見張りをやめる。shared process の印も同じ頃に切れる）。 */
const WATCH_LAUNCHED_MS = 30 * 60_000;

/** このウィンドウのサービスで、起こす・渡すを行う。 */
export class ParadisDocCommentWaker extends Disposable {

	private readonly _deliveryChannel = new Lazy(() => this._sharedProcessService.getChannel(PARADIS_DOC_DELIVERY_CHANNEL));

	constructor(
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ITerminalGroupService private readonly _terminalGroupService: ITerminalGroupService,
		@IParadisPaneTokenService private readonly _paneTokenService: IParadisPaneTokenService,
		@IParadisWorkspaceSwitchService private readonly _switchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly _worktreeService: IParadisWorktreeService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	async wake(hostId: string, path: string): Promise<void> {
		const channel = this._deliveryChannel.value;
		try {
			await paradisWakeDocOwner({
				windowIsRemote: this._environmentService.remoteAuthority !== undefined,
				wake: (h, p, remote) => channel.call<ParadisDocWakeAnswer>(PARADIS_DOC_DELIVERY_WAKE_METHOD, [h, p, remote]),
				woke: (session, paneToken) => channel.call<void>(PARADIS_DOC_DELIVERY_WOKE_METHOD, [session, paneToken]),
				wakeFailed: session => channel.call<void>(PARADIS_DOC_DELIVERY_WAKE_FAILED_METHOD, [session]),
				resumedSessions: () => this._resumedSessions(),
				spaces: () => paradisListSpaces(this._switchService.repositories, this._worktreeService).flatMap(entry => {
					const folder = entry.uri.scheme === Schemas.file ? paradisNormalizeDocPath(entry.uri.fsPath) : undefined;
					return folder !== undefined ? [{ stateKey: entry.space, path: folder }] : [];
				}),
				activeStateKey: this._switchService.activeStateKey,
				resume: request => this._instantiationService.invokeFunction(paradisResumeAgentInWorkspace, request),
				watchLaunched: (instanceId, onEnd) => this._watchLaunched(instanceId, onEnd),
				notify: (severity, message) => this._notificationService.notify({ severity, message }),
			}, hostId, path);
		} catch (error) {
			this._logService.warn('[ParadisDocComments] could not wake the owner of a document', error);
		}
	}

	async handOff(hostId: string, path: string): Promise<void> {
		const channel = this._deliveryChannel.value;
		try {
			await paradisHandOffDoc({
				panes: target => this._handOffPanes(target),
				pick: async (panes, fileName) => {
					const items: (IQuickPickItem & { pane: IParadisDocHandOffPane })[] = panes.map(pane => ({ label: pane.label, description: pane.description, pane }));
					const picked = await this._quickInputService.pick(items, {
						placeHolder: localize('paradis.docComments.handOff.placeholder', "「{0}」のコメントをどのエージェントに渡すか選んでください", fileName),
					});
					return picked?.pane;
				},
				handOff: (h, p, token) => channel.call<string>(PARADIS_DOC_DELIVERY_HAND_OFF_METHOD, [h, p, token]),
				notify: (severity, message) => this._notificationService.notify({ severity, message }),
			}, hostId, path);
		} catch (error) {
			this._logService.warn('[ParadisDocComments] could not hand a document to another agent', error);
		}
	}

	/** このウィンドウでエージェントが動いている（hook が届いた）ペイン。 */
	private async _handOffPanes(hostId: string): Promise<IParadisDocHandOffPane[]> {
		const entries = this._terminalService.instances.flatMap(instance => {
			const token = this._paneTokenService.getTokenForInstance(instance.instanceId);
			return token !== undefined ? [{ instance, token }] : [];
		});
		if (entries.length === 0) {
			return [];
		}
		const sessions = await this._sharedProcessService.getChannel(PARADIS_AGENT_DOCS_VIEW_CHANNEL).call<IParadisDocPaneSessionInfo[]>(ParadisAgentDocsViewCall.PaneSessions, [entries.map(entry => entry.token)]);
		const byToken = new Map(sessions.map(session => [session.token, session]));
		return entries.flatMap(({ instance, token }) => {
			const session = byToken.get(token);
			return session !== undefined && session.hostId === hostId
				? [{ token, label: instance.title || localize('paradis.docComments.handOff.terminal', "ターミナル {0}", instance.instanceId), description: paradisAgentDescriptor(session.agent)?.displayName ?? session.agent }]
				: [];
		});
	}

	/** 起こしたターミナルで、再開のコマンドが終わる・ターミナルが閉じるのを一度だけ知らせる。 */
	private _watchLaunched(instanceId: number, onEnd: () => void): void {
		const instance = this._terminalService.getInstanceFromId(instanceId);
		if (instance === undefined || instance.isDisposed) {
			onEnd();
			return;
		}
		const store = this._register(new DisposableStore());
		const end = () => {
			if (!store.isDisposed) {
				this._store.delete(store);
				onEnd();
			}
		};
		store.add(instance.onExit(end));
		store.add(instance.onDisposed(end));
		// シェル統合は再開のコマンドを打った後に入ることがあるので、後から加わったときも見る
		const commandDetection = instance.capabilities.get(TerminalCapability.CommandDetection);
		if (commandDetection !== undefined) {
			store.add(commandDetection.onCommandFinished(end));
		} else {
			store.add(Event.once(instance.capabilities.onDidAddCommandDetectionCapability)(added => store.add(added.onCommandFinished(end))));
		}
		const timer = setTimeout(() => this._store.delete(store), WATCH_LAUNCHED_MS);
		store.add(toDisposable(() => clearTimeout(timer)));
	}

	/** このウィンドウのターミナル（退避中を含む）で、再開のコマンドとして動いている会話。 */
	private _resumedSessions(): Set<string> {
		const sessions = new Set<string>();
		for (const instance of paradisCollectAllTerminalInstances(this._terminalService, this._terminalGroupService)) {
			if (instance.isDisposed) {
				continue;
			}
			const executing = instance.capabilities.get(TerminalCapability.CommandDetection)?.executingCommand;
			const resumed = executing !== undefined ? paradisResumedSessionOfCommand(executing) : undefined;
			if (resumed !== undefined) {
				sessions.add(resumed.sessionId);
			}
		}
		return sessions;
	}
}
