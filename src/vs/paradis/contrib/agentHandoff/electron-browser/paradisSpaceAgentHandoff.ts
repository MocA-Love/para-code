/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PC の画面から組み立てた依頼文を、今のスペースの Claude Code・Codex のターミナルへ渡す（G-02 のソース管理の
// 失敗、G-01 の差分のメモ）。送り先を選ぶクイックピックを出し、届ける処理はスマホからの依頼と同じ
// paradisDeliverAgentPrompt（貼り付けの前と Enter の前に、受け取れる状態かを確かめ直す）を使う。
//
// 送り先は今のスペースのエージェントだけ。別のスペースのエージェントへは送らない（スペースの取り違えを防ぐ）。

import { Codicon } from '../../../../base/common/codicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { isLinux } from '../../../../base/common/platform.js';
import { extUri, extUriIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentPromptServices, ParadisAgentPromptTarget, paradisAgentPromptServices, paradisDeliverAgentPrompt } from '../../mobileRelay/electron-browser/paradisMobileAgentPromptDelivery.js';
import { paradisResolveMobileTerminalStateKey } from '../../mobileRelay/common/paradisMobileRelay.js';
import { paradisCollectAllTerminalInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import { IParadisWorktreeService, paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

/** 依頼文の長さの上限（スマホからのコミットの直しと同じ）。 */
export const PARADIS_AGENT_HANDOFF_MAX_PROMPT_LENGTH = 40_000;

export interface IParadisSpaceAgentHandoffServices extends IParadisAgentPromptServices {
	readonly quickInputService: IQuickInputService;
	readonly notificationService: INotificationService;
	readonly worktreeService: IParadisWorktreeService;
	readonly clipboardService: IClipboardService;
}

/** `accessor` は await の前でしか使えないので、処理の先頭で呼ぶ。 */
export function paradisSpaceAgentHandoffServices(accessor: ServicesAccessor): IParadisSpaceAgentHandoffServices {
	return {
		...paradisAgentPromptServices(accessor),
		quickInputService: accessor.get(IQuickInputService),
		notificationService: accessor.get(INotificationService),
		worktreeService: accessor.get(IParadisWorktreeService),
		clipboardService: accessor.get(IClipboardService),
	};
}

export interface IParadisSpaceAgentHandoffRequest {
	readonly prompt: string;
	/** 送り先を選ぶ画面の見出し（何を送るか）。 */
	readonly placeholder: string;
	/**
	 * 依頼の元になったリポジトリ。今のスペースの中に無ければ送らない（切り替えの直後に古い画面から押された、など）。
	 */
	readonly expectedRoot?: URI;
}

const STATUS_LABELS: Record<ParadisAgentStatus, string> = {
	permission: localize('paradis.agentHandoff.status.permission', "許可待ち"),
	question: localize('paradis.agentHandoff.status.question', "質問中"),
	working: localize('paradis.agentHandoff.status.working', "作業中"),
	review: localize('paradis.agentHandoff.status.review', "完了"),
};

type TargetItem = IQuickPickItem & { readonly target: ParadisAgentPromptTarget };

/**
 * 送り先を選んでもらい、依頼文を届ける。届けたら true。取りやめ・失敗は false（失敗は通知で知らせる）。
 */
export async function paradisHandOffToSpaceAgent(services: IParadisSpaceAgentHandoffServices, request: IParadisSpaceAgentHandoffRequest): Promise<boolean> {
	const { switchService, notificationService } = services;
	const ws = switchService.activeStateKey;
	const space = ws === undefined ? undefined : paradisListSpaces(switchService.repositories, services.worktreeService).find(entry => entry.space === ws);
	if (ws === undefined || space === undefined) {
		notificationService.notify({ severity: Severity.Warning, message: localize('paradis.agentHandoff.noSpace', "スペースを開いていないため、エージェントへ送れません。") });
		return false;
	}
	// git 拡張は SSH 先でも作業ツリーのパスを file の URI で渡してくる。スペースの URI と仕組みが違うときはパスで比べる
	const expectedRoot = request.expectedRoot && request.expectedRoot.scheme !== space.uri.scheme
		? space.uri.with({ path: request.expectedRoot.path })
		: request.expectedRoot;
	// 手元の Windows・macOS はパスの大文字小文字を区別しない（SSH 先は Linux とみなして区別する）
	const comparer = space.uri.scheme === Schemas.file && !isLinux ? extUriIgnorePathCase : extUri;
	if (expectedRoot && !comparer.isEqualOrParent(expectedRoot, space.uri)) {
		notificationService.notify({ severity: Severity.Warning, message: localize('paradis.agentHandoff.otherSpace', "今のスペース（{0}）のリポジトリではないため、エージェントへ送りません。そのスペースへ切り替えてからやり直してください。", space.name) });
		return false;
	}
	if (request.prompt.length > PARADIS_AGENT_HANDOFF_MAX_PROMPT_LENGTH) {
		notificationService.notify({ severity: Severity.Warning, message: localize('paradis.agentHandoff.tooLong', "送る内容が長すぎます。何回かに分けて送ってください。") });
		return false;
	}

	const items: TargetItem[] = [];
	for (const instance of paradisCollectAllTerminalInstances(services.terminalService, services.terminalGroupService)) {
		const stateKey = paradisResolveMobileTerminalStateKey(services.scopeService.getStateKeyForInstance(instance.instanceId), services.scopeService.resolveScope(instance.instanceId), switchService.activeStateKey);
		const terminalKey = services.identityService.getTerminalKey(instance.instanceId);
		if (stateKey !== ws || terminalKey === undefined || !services.agentStatusStore.isAgentInstance(instance.instanceId)) {
			continue;
		}
		const status = services.agentStatusStore.getInstanceStatus(instance.instanceId);
		items.push({
			target: { kind: 'terminal', terminalKey },
			label: `$(${Codicon.terminal.id}) ${instance.title}`,
			description: status ? STATUS_LABELS[status] ?? status : localize('paradis.agentHandoff.status.idle', "入力待ち"),
		});
	}
	items.push({
		target: { kind: 'new' },
		label: `$(${Codicon.add.id}) ${localize('paradis.agentHandoff.new', "新しいエージェントで送る")}`,
		description: localize('paradis.agentHandoff.newDetail', "既定のエージェントを {0} で起動します", space.name),
	});

	const picked = await services.quickInputService.pick(items, { placeHolder: request.placeholder });
	if (!picked) {
		return false;
	}
	const outcome = await paradisDeliverAgentPrompt(services, ws, space.uri, request.prompt, picked.target, () => { });
	if (!outcome.ok) {
		// 届ける処理の文はスマホ向けの言い回し（「PC で確かめて」など）なので、PC では code から言い直す。
		// 送れなかった依頼文は、手で貼れるようにコピーの口を付ける
		notificationService.prompt(Severity.Warning, paradisPcDeliveryError(outcome.code, outcome.consumed) ?? outcome.error, [{
			label: localize('paradis.agentHandoff.copyPrompt', "送る内容をコピー"),
			run: () => services.clipboardService.writeText(request.prompt),
		}]);
		return false;
	}
	notificationService.notify({
		severity: Severity.Info,
		message: outcome.via === 'launch'
			? localize('paradis.agentHandoff.launched', "新しいエージェントを起動して送りました。")
			: localize('paradis.agentHandoff.sent', "「{0}」へ送りました。", outcome.title ?? ''),
	});
	return true;
}

/** 届ける処理の失敗（`code`）を PC の利用者向けの文にする。知らない code は undefined（元の文を出す）。 */
export function paradisPcDeliveryError(code: string, consumed: boolean | undefined): string | undefined {
	switch (code) {
		case 'not-agent':
			return localize('paradis.agentHandoff.error.notAgent', "選んだターミナルではエージェントが動いていません。");
		case 'busy':
			return localize('paradis.agentHandoff.error.busy', "エージェントが作業中か、許可や質問への答えを待っています。終わってから送るか、新しいエージェントで送ってください。");
		case 'parked':
		case 'not-running':
			return localize('paradis.agentHandoff.error.notReady', "選んだターミナルでエージェントが入力を待っていることを確かめられませんでした。ターミナルを開いて確かめるか、新しいエージェントで送ってください。");
		case 'changed':
			return consumed
				? localize('paradis.agentHandoff.error.changedPasted', "貼り付けた後にエージェントの状態が変わったため、送信（Enter）はしていません。ターミナルの入力欄を確かめてください。")
				: localize('paradis.agentHandoff.error.changed', "送る直前にエージェントの状態が変わったため、送っていません。");
		case 'timeout':
			return localize('paradis.agentHandoff.error.timeout', "エージェントの起動に時間がかかっています。起動したかをターミナルで確かめてください（まだ送っていません）。");
		case 'launched-not-ready':
			return localize('paradis.agentHandoff.error.launchedNotReady', "新しいエージェントは起動しましたが、入力を待つ状態になったことを確かめられなかったため、まだ送っていません。ターミナルを確かめてから、もう一度送ってください。");
		case 'no-agent':
			return localize('paradis.agentHandoff.error.noAgent', "起動できるエージェントが設定されていません。設定の「paradis.workspaceSwitch.agents」を確かめてください。");
		default:
			return undefined;
	}
}
