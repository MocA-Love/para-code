/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 注釈トレイの中身を、選んだエージェントのペイン（エディタエリアのターミナル）の入力欄へ入れる
// （送り先は送るときに一覧から選ぶ。注釈を溜めて1回で渡せ、作業中のエージェントを細切れに
// 止めずに済むため）。
//
// 入れ方はフェーズ5の「エージェント向けプリセット」と同じ規則にしてある:
//  - Enter は送らない（送るかどうかはユーザーが入力欄で決める）
//  - 貼り付け（bracketed paste）として送る
//  - 質問・許可の確認が出ている間は入れない（入れた文字が選択肢の操作に食われる）
// 加えて、本文にはページ由来の値が入るので、改行は常に1行へ均す（プリセットは条件付きで残す）。
// 画像は userData 配下へ PNG を保存し、そのパスを本文の後ろへ1つずつ貼る（エージェントの TUI が
// 画像の貼り付けと同じ扱いで読めるように。MCP で渡す方式は後から足せる）。
// ターミナルへファイルをドロップしたときと同じ書き方にするので、Claude Code / Codex が画像として
// 取り込むかどうかは CLI 側の扱い次第（実機で要確認）。

import { timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { preparePathForShell } from '../../../../workbench/contrib/terminal/common/terminalEnvironment.js';
import { IParadisAgentBrowserBindingModel, IParadisPaneDescriptor } from '../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { PARADIS_AGENT_HOOKS_ENABLED_SETTING } from '../../agentBrowser/common/paradisAgentHooks.js';
import { IParadisAgentStatusStore, IParadisBrowserScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisConfiguredAgents, paradisLaunchAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { IParadisAgentModelCatalogService } from '../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import {
	IParadisDesignAnnotation,
	IParadisDesignImageReference,
	ParadisDesignTargetAvailability,
	paradisBuildAgentInsertText,
	paradisDesignTargetAvailability,
	paradisFormatDesignAnnotations,
} from '../common/paradisDesignModeFormat.js';
import { IParadisDesignModeService } from './paradisDesignModeService.js';

/** 貼り付けを1つずつ区切る間隔。続けて送ると TUI が1回の貼り付けにまとめることがある。 */
const PASTE_GAP_MS = 150;
/** 新しく起動したエージェントの入力欄が使えるようになるまで待つ上限。 */
const LAUNCH_READY_TIMEOUT_MS = 30_000;
const LAUNCH_READY_POLL_MS = 250;

/** 送り先の候補（同じスペースで動いているエージェントのペイン）。 */
export interface IParadisDesignTargetEntry {
	readonly instanceId: number;
	readonly title: string;
	readonly agentKind: 'claude' | 'codex' | 'agent';
	readonly status: ParadisAgentStatus | undefined;
	/** このページを共有（バインド）しているペインか。 */
	readonly sharedWithPage: boolean;
	readonly available: boolean;
}

/**
 * ペインの一覧から送り先の候補を作る。
 *
 * - このページと同じスペースのペインだけ（共有の可否と同じ判定 bindEligibility を使う）
 * - エージェントが動いた実績があるか、タイトルからエージェントと分かるペインだけ。
 *   ただのシェルへ入れると、改行を落としても誤って実行する余地が残るので出さない
 * - このページを共有しているペインを先頭に、次に今すぐ入れられるペインを並べる
 */
export function paradisDesignTargetEntries(
	panes: readonly IParadisPaneDescriptor[],
	pageId: string,
	isAgentInstance: (instanceId: number) => boolean,
	getStatus: (instanceId: number) => ParadisAgentStatus | undefined,
): IParadisDesignTargetEntry[] {
	const entries: IParadisDesignTargetEntry[] = [];
	for (const pane of panes) {
		if (pane.bindEligibility && !pane.bindEligibility.eligible) {
			continue;
		}
		const isAgent = isAgentInstance(pane.instanceId);
		if (!isAgent && pane.agentKind === 'shell') {
			continue;
		}
		const status = getStatus(pane.instanceId);
		entries.push({
			instanceId: pane.instanceId,
			title: pane.title,
			agentKind: pane.agentKind === 'shell' ? 'agent' : pane.agentKind,
			status,
			sharedWithPage: pane.binding?.pageId === pageId,
			available: paradisDesignTargetAvailability(status) === ParadisDesignTargetAvailability.Ready,
		});
	}
	const rank = (entry: IParadisDesignTargetEntry) => (entry.sharedWithPage ? 0 : 2) + (entry.available ? 0 : 1);
	return entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
		.map(({ entry }) => entry);
}

function agentLabel(kind: IParadisDesignTargetEntry['agentKind']): string {
	switch (kind) {
		case 'claude': return 'Claude Code';
		case 'codex': return 'Codex';
		default: return localize('paradis.designMode.send.agent', "エージェント");
	}
}

function statusLabel(status: ParadisAgentStatus | undefined): string {
	switch (status) {
		case 'working': return localize('paradis.designMode.send.status.working', "作業中");
		case 'permission': return localize('paradis.designMode.send.status.permission', "承認待ちのため選べません");
		case 'question': return localize('paradis.designMode.send.status.question', "質問中のため選べません");
		case 'review': return localize('paradis.designMode.send.status.review', "完了");
		default: return localize('paradis.designMode.send.status.idle', "待機");
	}
}

type ParadisDesignTargetPick =
	| { readonly kind: 'pane'; readonly instanceId: number }
	| { readonly kind: 'launch'; readonly agentId: string; readonly rootUri: URI; readonly stateKey: string }
	| { readonly kind: 'copy' };

interface IParadisDesignTargetItem extends IQuickPickItem {
	readonly target: ParadisDesignTargetPick;
}

/** 送った結果。`message` は呼び出し側がトレイに出す（通知のトーストは内蔵ブラウザの裏に隠れるため）。 */
export interface IParadisDesignSendResult {
	/** エージェントの入力欄へ入れた（トレイから消してよい）。 */
	readonly inserted: boolean;
	readonly message?: string;
	readonly severity?: Severity;
}

/** 区切りに付ける使い捨ての値（ページが推測できない長さ）。 */
function newNonce(): string {
	return generateUuid().replace(/-/g, '').slice(0, 16);
}

/**
 * 注釈を送る処理。ブラウザのエディタ1枚につき1つ作る（サービスはコンストラクタで受ける）。
 */
export class ParadisDesignModeSender {

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IParadisAgentBrowserBindingModel private readonly bindingModel: IParadisAgentBrowserBindingModel,
		@IParadisAgentStatusStore private readonly agentStatusStore: IParadisAgentStatusStore,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IParadisAgentModelCatalogService private readonly modelCatalogService: IParadisAgentModelCatalogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisBrowserScopeService private readonly browserScopeService: IParadisBrowserScopeService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IParadisDesignModeService private readonly designModeService: IParadisDesignModeService,
		@ILogService private readonly logService: ILogService,
	) { }

	/**
	 * 送り先を選ばせて送る。入力欄へ入れたら `inserted: true`（呼び出し側はトレイを空にする）。
	 * `token` はエディタのページが替わる・閉じられたときに取り消す。
	 */
	async send(model: IBrowserViewModel, annotations: readonly IParadisDesignAnnotation[], token: CancellationToken): Promise<IParadisDesignSendResult> {
		if (annotations.length === 0) {
			return { inserted: false };
		}
		const target = await this._pickTarget(model, annotations);
		if (!target || token.isCancellationRequested) {
			return { inserted: false };
		}
		try {
			switch (target.kind) {
				case 'copy':
					await this._copy(annotations);
					return { inserted: false, message: localize('paradis.designMode.send.copied', "注釈をクリップボードへコピーしました。"), severity: Severity.Info };
				case 'pane': {
					const instance = this.terminalService.getInstanceFromId(target.instanceId);
					if (!instance || instance.isDisposed) {
						throw new Error(localize('paradis.designMode.send.gone', "選んだターミナルは閉じられています。"));
					}
					if (!await this._insert(instance, annotations)) {
						return { inserted: false };
					}
					return { inserted: true, message: localize('paradis.designMode.send.inserted', "「{0}」の入力欄へ入れました。内容を確かめてから Enter で送ってください。", instance.title), severity: Severity.Info };
				}
				case 'launch':
					return await this._launchAndInsert(target, annotations, token);
			}
		} catch (error) {
			this.logService.warn('[ParadisDesignMode] send failed', error);
			const message = localize('paradis.designMode.send.failed', "注釈を送れませんでした: {0}", toErrorMessage(error));
			// トレイに出したうえで、後から見返せるようベルにも残す
			this.notificationService.notify({ severity: Severity.Error, message, sticky: true });
			return { inserted: false, message, severity: Severity.Error };
		}
	}

	/**
	 * 新しいエージェントを起動できる先（このページのスペース）。前面のスペースと違う、または
	 * スペースが決まっていないページでは起動しない（別のスペースに起動して入れてしまうため）。
	 * hook を切っていると起動の完了が分からないので、そのときも出さない。
	 */
	private _launchTarget(model: IBrowserViewModel): { readonly rootUri: URI; readonly stateKey: string } | undefined {
		if (this.configurationService.getValue<boolean>(PARADIS_AGENT_HOOKS_ENABLED_SETTING) === false) {
			return undefined;
		}
		const scope = this.browserScopeService.resolveScope(model.id);
		const activeStateKey = this.workspaceSwitchService.activeStateKey;
		const rootUri = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (scope.kind !== 'managed' || !activeStateKey || scope.stateKey !== activeStateKey || !rootUri) {
			return undefined;
		}
		return { rootUri, stateKey: activeStateKey };
	}

	private async _pickTarget(model: IBrowserViewModel, annotations: readonly IParadisDesignAnnotation[]): Promise<ParadisDesignTargetPick | undefined> {
		const entries = paradisDesignTargetEntries(
			this.bindingModel.getPanesForPage(model),
			model.id,
			instanceId => this.agentStatusStore.isAgentInstance(instanceId),
			instanceId => this.agentStatusStore.getInstanceStatus(instanceId),
		);
		const imageCount = this.designModeService.attachImages ? annotations.filter(annotation => annotation.image).length : 0;
		const items: (IParadisDesignTargetItem | IQuickPickSeparator)[] = [];
		for (const entry of entries) {
			const instance = this.terminalService.getInstanceFromId(entry.instanceId);
			const remote = !!instance?.remoteAuthority;
			const where = entry.sharedWithPage
				? localize('paradis.designMode.send.shared', "このページを共有中")
				: localize('paradis.designMode.send.sameSpace', "同じスペース");
			items.push({
				label: entry.title,
				iconClass: ThemeIcon.asClassName(Codicon.terminal),
				description: `${agentLabel(entry.agentKind)} · ${statusLabel(entry.status)}`,
				detail: remote && imageCount > 0
					? localize('paradis.designMode.send.remoteNoImages', "{0}（SSH 先のため画像は添えません）", where)
					: where,
				disabled: !entry.available,
				target: { kind: 'pane', instanceId: entry.instanceId },
			});
		}
		if (entries.length > 0) {
			items.push({ type: 'separator' });
		}
		const launchTarget = this._launchTarget(model);
		if (launchTarget) {
			for (const agent of paradisConfiguredAgents(this.modelCatalogService)) {
				items.push({
					label: localize('paradis.designMode.send.launch', "新しい {0} を起動して入れる", agent.label),
					iconClass: ThemeIcon.asClassName(Codicon.add),
					target: { kind: 'launch', agentId: agent.id, rootUri: launchTarget.rootUri, stateKey: launchTarget.stateKey },
				});
			}
		}
		items.push({
			label: localize('paradis.designMode.send.copy', "クリップボードへコピー"),
			description: localize('paradis.designMode.send.copyDescription', "Markdown と画像のパス"),
			iconClass: ThemeIcon.asClassName(Codicon.copy),
			target: { kind: 'copy' },
		});
		const picked = await this.quickInputService.pick(items, {
			title: localize('paradis.designMode.send.title', "注釈 {0} 件の送り先を選択", annotations.length),
			placeHolder: entries.length === 0
				? localize('paradis.designMode.send.noAgents', "このスペースで動いているエージェントが見つかりません")
				: localize('paradis.designMode.send.placeholder', "入力欄へ入れるだけで、Enter は送りません"),
			matchOnDescription: true,
		});
		return picked?.target;
	}

	/** 画像を保存し、本文での呼び名とパスを決める。 */
	private async _prepareImages(annotations: readonly IParadisDesignAnnotation[], inline: boolean): Promise<{ readonly references: Map<string, IParadisDesignImageReference>; readonly paths: string[] }> {
		const references = new Map<string, IParadisDesignImageReference>();
		const paths: string[] = [];
		if (!this.designModeService.attachImages) {
			return { references, paths };
		}
		for (const annotation of annotations) {
			if (!annotation.image) {
				continue;
			}
			const path = await this.designModeService.saveImage(annotation.image);
			paths.push(path);
			const label = localize('paradis.designMode.send.imageLabel', "画像 {0}", paths.length);
			references.set(annotation.id, inline ? { label, inlinePath: path } : { label });
		}
		return { references, paths };
	}

	private _formatOptions() {
		return { nonce: newNonce(), includeHtml: this.designModeService.includeHtml };
	}

	private async _copy(annotations: readonly IParadisDesignAnnotation[]): Promise<void> {
		const { references } = await this._prepareImages(annotations, true);
		// クリップボードはターミナルを通らないので、改行は残す（制御文字だけ落とす）
		await this.clipboardService.writeText(paradisBuildAgentInsertText(paradisFormatDesignAnnotations(annotations, references, this._formatOptions()), true) ?? '');
	}

	private _throwIfAwaitingAnswer(instance: ITerminalInstance): void {
		if (paradisDesignTargetAvailability(this.agentStatusStore.getInstanceStatus(instance.instanceId)) === ParadisDesignTargetAvailability.AwaitingAnswer) {
			throw new Error(localize('paradis.designMode.send.awaiting', "エージェントが質問か許可の確認を出しているため、入れられません。先に回答してください。"));
		}
	}

	/**
	 * hook が届いていないペイン（hook を切っている、WSL の中で動いている等）は、質問や許可の確認が
	 * 出ていても分からない。そのときは入れる前にユーザーに確かめる。
	 */
	private async _confirmIfStatusUnknown(instance: ITerminalInstance): Promise<boolean> {
		if (this.agentStatusStore.isAgentInstance(instance.instanceId)) {
			return true;
		}
		const result = await this.dialogService.confirm({
			type: 'warning',
			message: localize('paradis.designMode.send.unknownStatus', "「{0}」のエージェントの状態が分かりません", instance.title),
			detail: localize('paradis.designMode.send.unknownStatusDetail', "質問や許可の確認が出ていると、入れた文字が選択の操作として扱われることがあります。ターミナルが入力待ちになっていることを確かめてから入れてください。"),
			primaryButton: localize('paradis.designMode.send.unknownStatusInsert', "入れる(&&I)"),
		});
		return result.confirmed;
	}

	/** 入れたら true。ユーザーが確認で取りやめたら false。 */
	private async _insert(instance: ITerminalInstance, annotations: readonly IParadisDesignAnnotation[]): Promise<boolean> {
		if (!await this._confirmIfStatusUnknown(instance)) {
			return false;
		}
		// SSH 先で動くエージェントは手元の userData を読めないので、画像は添えない
		const remote = !!instance.remoteAuthority;
		const { references, paths } = remote ? { references: new Map<string, IParadisDesignImageReference>(), paths: [] } : await this._prepareImages(annotations, false);
		const text = paradisFormatDesignAnnotations(annotations, references, this._formatOptions());
		// 画像の保存を待っている間に状態が変わりうるので、送る直前に確かめる
		this._throwIfAwaitingAnswer(instance);
		// 改行は常に1行へ均す。ページ由来の値が入るので、送る瞬間にエージェントが終わっていて
		// 貼り付けを解さないシェルへ届いても、行としては実行されない
		const body = paradisBuildAgentInsertText(text, false);
		if (body !== undefined) {
			await instance.sendText(body, false, true);
		}
		for (const path of paths) {
			await timeout(PASTE_GAP_MS);
			this._throwIfAwaitingAnswer(instance);
			const quoted = await preparePathForShell(path, instance.shellLaunchConfig.executable ?? 'sh', instance.title, instance.shellType, undefined, instance.os);
			const pasted = paradisBuildAgentInsertText(quoted, false);
			if (pasted !== undefined) {
				await instance.sendText(' ', false, false);
				await instance.sendText(pasted, false, true);
			}
		}
		this.terminalService.setActiveInstance(instance);
		await this.terminalService.revealTerminal(instance);
		instance.focus(true);
		return true;
	}

	/**
	 * このページのスペースに新しいエージェントを起動し、入力欄が使えるようになってから入れる。
	 * 待ちきれなかったときはクリップボードへ回す（起動直後のシェルへ流し込まない）。
	 */
	private async _launchAndInsert(target: { readonly agentId: string; readonly rootUri: URI; readonly stateKey: string }, annotations: readonly IParadisDesignAnnotation[], token: CancellationToken): Promise<IParadisDesignSendResult> {
		const launched = await this.instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, { rootUri: target.rootUri, stateKey: target.stateKey, agentId: target.agentId });
		const instance = this.terminalService.getInstanceFromId(launched.instanceId);
		if (!instance || !await this._waitForAgentReady(instance, token)) {
			if (token.isCancellationRequested) {
				return { inserted: false };
			}
			await this._copy(annotations);
			const message = localize('paradis.designMode.send.launchTimeout', "エージェントの起動を待ちきれなかったため、注釈はクリップボードへコピーしました。起動したら入力欄へ貼り付けてください。");
			this.notificationService.notify({ severity: Severity.Warning, message, sticky: true });
			return { inserted: false, message, severity: Severity.Warning };
		}
		if (!await this._insert(instance, annotations)) {
			return { inserted: false };
		}
		return { inserted: true, message: localize('paradis.designMode.send.inserted', "「{0}」の入力欄へ入れました。内容を確かめてから Enter で送ってください。", instance.title), severity: Severity.Info };
	}

	/**
	 * エージェントの入力欄が使えるようになるまで待つ。hook が届いた（エージェントのセッションが
	 * 始まった）うえで、TUI が貼り付けモードを有効にしていることを合図にする。シェルのプロンプトも
	 * 貼り付けモードを使うので、貼り付けモードだけでは判断しない。
	 */
	private async _waitForAgentReady(instance: ITerminalInstance, token: CancellationToken): Promise<boolean> {
		const deadline = Date.now() + LAUNCH_READY_TIMEOUT_MS;
		while (Date.now() < deadline && !token.isCancellationRequested) {
			if (instance.isDisposed) {
				return false;
			}
			if (this.agentStatusStore.isAgentInstance(instance.instanceId) && instance.xterm?.raw.modes.bracketedPasteMode === true) {
				// hook は TUI の描画より少し先に届くことがあるので、ひと呼吸おく
				await timeout(500);
				return !instance.isDisposed && !token.isCancellationRequested;
			}
			await timeout(LAUNCH_READY_POLL_MS);
		}
		return false;
	}
}
