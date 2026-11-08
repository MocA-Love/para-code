/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの右クリックのエージェントの節に「別の Agent に引き継ぐ...」と「Agent セッションをフォーク...」を出す（Q592-5）。
//
// - フォーク: 同じ会話から分かれた新しい会話を、右のエディタグループの新しいタブで始める。CLI の分岐を使う
//   （Claude Code は `claude --resume <id> --fork-session`、Codex は `codex fork <id>`。どちらも確認ありの権限で起動し、
//   確認を省く分岐は出さない）。会話 ID と作業フォルダは hook が報告した会話（状態スナップショットの paneSessions）から取る。
//   会話を始めたフォルダで起動する（違うフォルダだと Claude Code は会話をそのフォルダのプロジェクトへ複製するため）。
// - 引き継ぎ: 元と違う種類の設定済みエージェントを選び、今のスペースで起動して依頼文を渡す（paradisDeliverAgentPrompt の
//   launch）。依頼文には会話の記録のパスを渡す。受け取るエージェントの側で読めないパス（手元と接続先がまたがるなど）なら、
//   画面の末尾を上限付きで入れる（paradisAgentSessionHandoff.ts）。

import { addDisposableListener, EventType, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { paradisResolveWslAgentHome } from '../../../common/paradisWslAgentHome.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentPaneSession } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { paradisPcDeliveryError, paradisSpaceAgentHandoffServices } from '../../agentHandoff/electron-browser/paradisSpaceAgentHandoff.js';
import { paradisDeliverAgentPrompt } from '../../mobileRelay/electron-browser/paradisMobileAgentPromptDelivery.js';
import { paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisConfiguredAgents, paradisResumeAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import {
	PARADIS_HANDOFF_CAPTURE_LINES,
	paradisAgentKindOfCommand,
	paradisBoundHandoffCapture,
	paradisBuildAgentHandoffPrompt,
	paradisHandoffAgentLabel,
	paradisReadableTranscriptPath,
} from '../common/paradisAgentSessionHandoff.js';
import { PARADIS_TERMINAL_AGENT_MENU_GROUP, PARADIS_TERMINAL_AGENT_RUNNING, paradisReadTerminalTail, paradisTargetInstance } from './paradisTerminalContextMenu.contribution.js';

export const PARADIS_TERMINAL_AGENT_CAN_FORK = new RawContextKey<boolean>('paradisTerminalAgentCanFork', false, localize('paradisTerminalAgentCanFork', "アクティブなターミナルのエージェントの会話を分岐できるかどうか"));

export const PARADIS_TERMINAL_HANDOFF_COMMAND_ID = 'paradis.terminal.handOffAgentSession';
export const PARADIS_TERMINAL_FORK_COMMAND_ID = 'paradis.terminal.forkAgentSession';

export const IParadisTerminalAgentSessionService = createDecorator<IParadisTerminalAgentSessionService>('paradisTerminalAgentSessionService');

/** ターミナルで動いている会話（hook が報告したもの）を引く。 */
export interface IParadisTerminalAgentSessionService {
	readonly _serviceBrand: undefined;
	/** そのターミナルで動いている会話。hook が来ていなければ undefined。 */
	getSession(instance: ITerminalInstance): IParadisAgentPaneSession | undefined;
}

class ParadisTerminalAgentSessionService extends Disposable implements IParadisTerminalAgentSessionService {

	declare readonly _serviceBrand: undefined;

	private sessions = new Map<string, IParadisAgentPaneSession>();
	private readonly canFork: IContextKey<boolean>;

	constructor(
		@IParadisAgentStatusSnapshotService snapshotService: IParadisAgentStatusSnapshotService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.canFork = PARADIS_TERMINAL_AGENT_CAN_FORK.bindTo(contextKeyService);
		this._register(snapshotService.subscribe(outcome => {
			if (outcome.snapshot !== undefined) {
				this.sessions = new Map((outcome.snapshot.paneSessions ?? []).map(session => [session.token, session]));
				this.update();
			}
		}));
		this._register(this.terminalService.onDidChangeActiveInstance(() => this.update()));
		// メニューを組み立てる前に決め直す（paradisTerminalContextMenu.contribution.ts と同じ）
		this._register(Event.runAndSubscribe(onDidRegisterWindow, ({ window, disposables }) => {
			disposables.add(addDisposableListener(window, EventType.CONTEXT_MENU, () => this.update(), true));
		}, { window: mainWindow, disposables: this._store }));
		this.update();
	}

	getSession(instance: ITerminalInstance): IParadisAgentPaneSession | undefined {
		const token = this.paneTokenService.getTokenForInstance(instance.instanceId);
		return token === undefined ? undefined : this.sessions.get(token);
	}

	private update(): void {
		const instance = this.terminalService.activeInstance;
		const session = instance === undefined ? undefined : this.getSession(instance);
		this.canFork.set(session !== undefined && session.resumable !== false);
	}
}

registerSingleton(IParadisTerminalAgentSessionService, ParadisTerminalAgentSessionService, InstantiationType.Delayed);

/** 会話の台帳を起動時から持つ（コマンドを押したときに初めて購読すると、最初の状態がまだ届いていない）。 */
class ParadisTerminalAgentSessionStartup implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisTerminalAgentSession';
	constructor(@IParadisTerminalAgentSessionService _service: IParadisTerminalAgentSessionService) { }
}

registerWorkbenchContribution2(ParadisTerminalAgentSessionStartup.ID, ParadisTerminalAgentSessionStartup, WorkbenchPhase.AfterRestored);

/** この窓のパスを URI にする（SSH の窓なら接続先のパス）。 */
function paradisCwdUri(environmentService: IWorkbenchEnvironmentService, path: string): URI {
	const remoteAuthority = environmentService.remoteAuthority;
	return remoteAuthority === undefined ? URI.file(path) : URI.from({ scheme: Schemas.vscodeRemote, authority: remoteAuthority, path });
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PARADIS_TERMINAL_FORK_COMMAND_ID,
			title: localize2('paradis.terminal.forkAgentSession', "Agent セッションをフォーク..."),
			icon: Codicon.repoForked,
			f1: false,
			// 会話 ID が分かるまで（起動直後で最初の依頼の前、hook の無い構成）は押せない
			precondition: PARADIS_TERMINAL_AGENT_CAN_FORK,
			menu: { id: MenuId.TerminalInstanceContext, group: PARADIS_TERMINAL_AGENT_MENU_GROUP, order: 3, when: PARADIS_TERMINAL_AGENT_RUNNING },
		});
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const terminalService = accessor.get(ITerminalService);
		const sessionService = accessor.get(IParadisTerminalAgentSessionService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		const notificationService = accessor.get(INotificationService);
		const instantiationService = accessor.get(IInstantiationService);
		const logService = accessor.get(ILogService);
		const { switchService } = paradisSpaceAgentHandoffServices(accessor);
		const instance = paradisTargetInstance(terminalService, arg);
		const session = instance === undefined ? undefined : sessionService.getSession(instance);
		const stateKey = switchService.activeStateKey;
		if (instance === undefined || session === undefined || session.resumable === false) {
			notificationService.info(localize('paradis.terminal.forkNoSession', "このターミナルの会話 ID がまだ分からないため、分岐できません。エージェントへ最初の依頼を送ってから、もう一度選んでください。"));
			return;
		}
		if (stateKey === undefined) {
			notificationService.warn(localize('paradis.terminal.forkNoSpace', "スペースを開いていないため、分岐できません。"));
			return;
		}
		if ((session.remote === true) !== (environmentService.remoteAuthority !== undefined)) {
			notificationService.warn(localize('paradis.terminal.forkOtherMachine', "この会話は別のマシンで動いているため、この窓からは分岐できません。"));
			return;
		}
		const cwd = session.cwd ?? await instance.getInitialCwd();
		if (!cwd) {
			notificationService.warn(localize('paradis.terminal.forkNoFolder', "会話を始めたフォルダが分からないため、分岐できません。"));
			return;
		}
		// Codex の会話は、そのターミナルで使っているホーム（アカウント）にだけある。同じホームで分岐する
		const codexHome = session.agent === 'codex' ? instance.shellLaunchConfig.env?.CODEX_HOME : undefined;
		try {
			await instantiationService.invokeFunction(paradisResumeAgentInWorkspace, {
				rootUri: paradisCwdUri(environmentService, cwd),
				stateKey,
				agent: session.agent,
				...(session.cli !== undefined ? { cli: session.cli } : {}),
				sessionId: session.sessionId,
				mode: 'fork',
				placement: 'side',
				...(typeof codexHome === 'string' && isAbsolute(codexHome) ? { codexHome } : {}),
			});
		} catch (error) {
			logService.error('[paradisTerminalAgentSession] could not fork the agent session', error);
			notificationService.error(localize('paradis.terminal.forkFailed', "分岐用のターミナルを開けませんでした。"));
		}
	}
});

type AgentItem = IQuickPickItem & { readonly agentId: string };

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PARADIS_TERMINAL_HANDOFF_COMMAND_ID,
			title: localize2('paradis.terminal.handOffAgentSession', "別の Agent に引き継ぐ..."),
			icon: Codicon.arrowSwap,
			f1: false,
			menu: { id: MenuId.TerminalInstanceContext, group: PARADIS_TERMINAL_AGENT_MENU_GROUP, order: 2, when: PARADIS_TERMINAL_AGENT_RUNNING },
		});
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const services = paradisSpaceAgentHandoffServices(accessor);
		const sessionService = accessor.get(IParadisTerminalAgentSessionService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		const quickInputService = accessor.get(IQuickInputService);
		const { notificationService, switchService } = services;
		const instance = paradisTargetInstance(services.terminalService, arg);
		const ws = switchService.activeStateKey;
		const space = ws === undefined ? undefined : paradisListSpaces(switchService.repositories, services.worktreeService).find(entry => entry.space === ws);
		if (instance === undefined || ws === undefined || space === undefined) {
			notificationService.warn(localize('paradis.terminal.handoffNoSpace', "スペースを開いていないため、引き継げません。"));
			return;
		}
		const session = sessionService.getSession(instance);
		const agents = paradisConfiguredAgents(services.modelCatalogService)
			.filter(agent => session === undefined || paradisAgentKindOfCommand(agent.command) !== session.agent);
		if (agents.length === 0) {
			notificationService.info(localize('paradis.terminal.handoffNoAgent', "引き継げる別のエージェントが設定されていません。設定の「paradis.workspaceSwitch.agents」を確かめてください。"));
			return;
		}
		const picked = await quickInputService.pick<AgentItem>(agents.map(agent => ({ agentId: agent.id, label: agent.label })), {
			placeHolder: localize('paradis.terminal.handoffPick', "この会話を引き継ぐエージェントを選んでください（{0} で新しく起動します）", space.name),
		});
		if (!picked || instance.isDisposed) {
			return;
		}
		const windowRemote = environmentService.remoteAuthority !== undefined;
		const transcriptPath = paradisReadableTranscriptPath({
			transcriptPath: session?.transcriptPath,
			sessionRemote: session?.remote === true,
			windowRemote,
			// 新しいエージェントは今のスペースで動く。手元の Windows で WSL のスペースなら WSL の中（POSIX のパス）
			targetPosix: windowRemote || !isWindows || paradisResolveWslAgentHome(space.uri.fsPath) !== undefined,
		});
		const prompt = paradisBuildAgentHandoffPrompt({
			agent: session?.agent,
			title: instance.title,
			...(session !== undefined ? { sessionId: session.sessionId } : {}),
			...(session?.cwd !== undefined ? { cwd: session.cwd } : {}),
			...(transcriptPath !== undefined
				? { transcriptPath }
				: { capturedText: paradisBoundHandoffCapture(paradisReadTerminalTail(instance, PARADIS_HANDOFF_CAPTURE_LINES)) }),
		});
		if (prompt === undefined) {
			notificationService.info(localize('paradis.terminal.handoffNoContext', "引き継ぐ会話の記録も画面の内容も見つかりませんでした。"));
			return;
		}
		const outcome = await paradisDeliverAgentPrompt(services, ws, space.uri, prompt, { kind: 'launch', agent: picked.agentId }, () => { });
		if (!outcome.ok) {
			notificationService.prompt(Severity.Warning, paradisPcDeliveryError(outcome.code, outcome.consumed) ?? outcome.error, [{
				label: localize('paradis.terminal.handoffCopy', "引き継ぎの依頼文をコピー"),
				run: () => services.clipboardService.writeText(prompt),
			}]);
			return;
		}
		notificationService.info(localize('paradis.terminal.handoffDone', "{0} の会話を {1} に引き継ぎました（新しいタブで起動しています）。", paradisHandoffAgentLabel(session?.agent) ?? instance.title, picked.label));
	}
});
