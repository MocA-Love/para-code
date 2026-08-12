/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import './media/paradisWorkspaceSwitch.css';
import * as DOM from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IListVirtualDelegate, ListDragOverEffectPosition, ListDragOverEffectType } from '../../../../base/browser/ui/list/list.js';
import { ElementsDragAndDropData, ListViewTargetSector } from '../../../../base/browser/ui/list/listView.js';
import { IDragAndDropData } from '../../../../base/browser/dnd.js';
import { IObjectTreeElement, ITreeDragAndDrop, ITreeDragOverReaction, ITreeNode, ITreeRenderer, ObjectTreeElementCollapseState } from '../../../../base/browser/ui/tree/tree.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { FuzzyScore } from '../../../../base/common/filters.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusStore, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, PARADIS_WORKSPACE_COLORS, paradisAggregateAgentStatus, paradisSortAgentStatuses, paradisWorkspaceColorHex, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import { IParadisSpaceNotesService, IParadisSpaceNoteSummary } from '../common/paradisSpaceNotes.js';
import { ParadisCollapsedRepositoryStateController } from './paradisCollapsedRepositoryStateController.js';
import { ParadisSpaceNotesPanel } from './paradisSpaceNotesPanel.js';
import { paradisReorderByDrop, paradisSwapAdjacent } from '../common/paradisWorkspaceTreeState.js';
import { IParadisDiffStat, IParadisPrStatus, IParadisWorktreeCreateJobSnapshot, IParadisWorktreeCreateProgressStore, ParadisPrState } from '../common/paradisWorktreeCreate.js';

/** browser 層は electron-browser 層のコマンドIDを直接 import できないため、既存の
 * createWorktree/removeWorktree コマンドと同様に ID 文字列を直書きする (web ビルドでは
 * 未登録 = executeCommand が undefined を返すだけで安全に無効化される)。 */
const GET_DIFF_STATS_COMMAND_ID = 'paradis.workspaceSwitch.getDiffStats';
/** diff 統計のポーリング間隔。編集の即時反映より、常時ポーリングによる負荷を避けることを優先する。 */
const DIFF_STATS_POLL_INTERVAL_MS = 10_000;
const GET_PR_STATUSES_COMMAND_ID = 'paradis.workspaceSwitch.getPrStatuses';
/**
 * PR 状態のポーリング間隔。1回のポーリングで worktree ごとに gh の GitHub API 呼び出しが
 * 発生する (認証済み上限 5,000 req/h) ため、diff 統計より大幅に長くして API 消費を抑える。
 * PR の open/draft/merged/closed は分単位で変わるものではないので実用上十分。
 */
const PR_STATUS_POLL_INTERVAL_MS = 300_000;

export const PARADIS_WORKSPACES_VIEW_ID = 'workbench.view.paradisWorkspaces.repositories';

/** listService がツリーの indent を決めるのと同じ設定キー (と、未設定時の既定値)。 */
const TREE_INDENT_CONFIGURATION_KEY = 'workbench.tree.indent';
const DEFAULT_TREE_INDENT = 8;

/** バックグラウンド作成中のジョブを表す「作成中」プレースホルダ行。クリック・メニュー対象外。 */
interface ICreatingSpaceElement {
	readonly creatingJob: IParadisWorktreeCreateJobSnapshot;
}

/**
 * 折りたたまれたリポジトリの下に残す、ピン留め済み worktree の控え行。
 * ツリーの折りたたみは「子を全部隠す」動作なので、ピン留め行はリポジトリ行の直後に
 * ルート要素として差し込む（子の実体は隠れたまま残るため、identity が衝突しないよう
 * このフラグで別IDを振る）。インデントは CSS で子行に合わせる。
 */
type IPinnedKeepElement = IParadisWorktree & { readonly paradisPinnedKeep: true };

type WorkspaceTreeElement = IParadisWorkspaceRepository | IParadisWorktree | ICreatingSpaceElement;

function isPinnedKeep(element: WorkspaceTreeElement): element is IPinnedKeepElement {
	return (element as IPinnedKeepElement).paradisPinnedKeep === true;
}

function isCreating(element: WorkspaceTreeElement): element is ICreatingSpaceElement {
	return (element as ICreatingSpaceElement).creatingJob !== undefined;
}

function isWorktree(element: WorkspaceTreeElement): element is IParadisWorktree {
	return !isCreating(element) && (element as IParadisWorktree).repositoryId !== undefined;
}

// allow-any-unicode-next-line
const STR_CREATING_UNNAMED = localize('paradis.workspaceSwitch.creatingUnnamed', "(名前を生成中…)");

function creatingElementLabel(element: ICreatingSpaceElement): string {
	return element.creatingJob.name ?? STR_CREATING_UNNAMED;
}

/** パレットIDの表示名 (Superset の12色) */
function colorLabel(colorId: string): string {
	switch (colorId) {
		case 'red': return localize('paradis.color.red', "Red");
		case 'orange': return localize('paradis.color.orange', "Orange");
		case 'yellow': return localize('paradis.color.yellow', "Yellow");
		case 'lime': return localize('paradis.color.lime', "Lime");
		case 'green': return localize('paradis.color.green', "Green");
		case 'teal': return localize('paradis.color.teal', "Teal");
		case 'cyan': return localize('paradis.color.cyan', "Cyan");
		case 'blue': return localize('paradis.color.blue', "Blue");
		case 'indigo': return localize('paradis.color.indigo', "Indigo");
		case 'purple': return localize('paradis.color.purple', "Purple");
		case 'pink': return localize('paradis.color.pink', "Pink");
		case 'slate': return localize('paradis.color.slate', "Slate");
		default: return colorId;
	}
}

/** リポジトリ本体 (main checkout) を表す合成 worktree 行の表示名。 */
const STR_MAIN_CHECKOUT_NAME = localize('paradis.workspaceSwitch.mainCheckoutName', "local");

/** worktree の状態キー。main checkout の合成行は repositoryId をそのまま状態キーとして使う。 */
function worktreeStateKeyFor(worktree: IParadisWorktree): string {
	return worktree.isMainCheckout ? worktree.repositoryId : paradisWorktreeStateKey(worktree.uri);
}

/** OSごとの「Finder/Explorerで表示」ラベル (upstream の revealFileInOS と同じ出し分け) */
function revealLabel(): string {
	return isWindows
		? localize('paradis.workspaceSwitch.revealWindows', "Reveal in File Explorer")
		: isMacintosh
			? localize('paradis.workspaceSwitch.revealMac', "Reveal in Finder")
			: localize('paradis.workspaceSwitch.revealLinux', "Open Containing Folder");
}

/** ドット列に並べる上限。これを超えた分は「+n」に畳む (狭いサイドバーで溢れさせない) */
const MAX_STATUS_DOTS = 5;

/**
 * エージェント実行状態に応じたアイコンを適用する (Superset の WorkspaceIcon 相当)。
 * working = 橙のゆっくり明滅 / permission = 赤の脈動ドット / review = 緑ドット / なし = 通常アイコン
 *
 * working を回転 (codicon-modifier-spin) ではなくゆっくりした明滅にしているのは、
 * 複数スペースが同時に動く使い方では回転が常時視界に入り続けて疲れるため。
 * 速い脈動は「人間の対応待ち」だけに残し、動作中とは速度で区別する。
 */
function applyStatusIcon(iconElement: HTMLElement, status: ParadisAgentStatus | undefined, fallback: ThemeIcon): void {
	const icon = status === undefined ? fallback : Codicon.circleFilled;
	iconElement.className = `codicon ${ThemeIcon.asClassName(icon).replace('codicon ', '')}`;
	if (status !== undefined) {
		iconElement.classList.add(statusColorClass(status));
	}
}

/**
 * 状態 → ドット/アイコンに付ける色クラス。
 * 質問(AskUserQuestion)も許可要求と同じ「人間の対応が必要」= 赤の脈動表示にする。
 * default を置かず網羅させることで、状態の種類が増えたときにコンパイラが漏れを教える。
 */
function statusColorClass(status: ParadisAgentStatus): string {
	switch (status) {
		case 'working': return 'paradis-status-working';
		case 'review': return 'paradis-status-review';
		case 'permission':
		case 'question': return 'paradis-status-permission';
	}
}

/** ドット1個を、既にある要素を使い回して更新する (無ければ作る)。 */
function updateStatusDot(container: HTMLElement, index: number, status: ParadisAgentStatus): void {
	const existing = container.children.item(index);
	const dot = DOM.isHTMLElement(existing) ? existing : DOM.append(container, DOM.$('.paradis-agent-dot'));
	dot.className = `paradis-agent-dot ${statusColorClass(status)}`;
}

/**
 * スコープ内の各エージェントの状態を、1体につき1つのドットとして描く。
 * 集約アイコン (行の左) だけでは「1体終わっても他が動いている限り完了が見えない」ため、
 * 内訳をここで出す。並びは優先度の降順で、上限を超えた分は「+n」に畳む。
 *
 * 要素は作り直さず使い回す: clearNode してから作り直すと、再描画のたびに
 * 明滅アニメーションが先頭へ巻き戻り、無関係なスペースの状態が変わるだけで
 * 一覧全体のドットが明るさを飛ばしてしまう (落ち着いた明滅という狙いと逆になる)。
 */
function renderStatusDots(container: HTMLElement, statuses: readonly ParadisAgentStatus[]): void {
	container.classList.toggle('hidden', statuses.length === 0);
	const shown = Math.min(statuses.length, MAX_STATUS_DOTS);
	for (let index = 0; index < shown; index++) {
		updateStatusDot(container, index, statuses[index]);
	}
	// 余った分 (ドット / 「+n」ラベル) だけを取り除く
	while (container.childElementCount > shown) {
		container.lastElementChild?.remove();
	}
	if (statuses.length > shown) {
		DOM.append(container, DOM.$('span.paradis-agent-dot-more')).textContent = `+${statuses.length - shown}`;
	}
}

/** 状態ごとの件数 (優先度の高い順)。0件の種別は含めない。 */
function statusCounts(statuses: readonly ParadisAgentStatus[]): [ParadisAgentStatus, number][] {
	const counts = new Map<ParadisAgentStatus, number>();
	for (const status of paradisSortAgentStatuses(statuses)) {
		counts.set(status, (counts.get(status) ?? 0) + 1);
	}
	return [...counts];
}

/** ドット列・見出し要約のホバー説明 (「動作中 2 / 完了 1」)。 */
function agentStatusSummaryTooltip(statuses: readonly ParadisAgentStatus[]): string {
	const parts = statusCounts(statuses).map(([status, count]) =>
		localize('paradis.agentStatus.countEntry', "{0} {1}", statusLabel(status), count));
	return parts.join(localize('paradis.agentStatus.separator', " / "));
}

function statusLabel(status: ParadisAgentStatus): string {
	switch (status) {
		// allow-any-unicode-next-line
		case 'working': return localize('paradis.agentStatus.working', "動作中");
		// allow-any-unicode-next-line
		case 'review': return localize('paradis.agentStatus.review', "完了");
		// allow-any-unicode-next-line
		case 'question': return localize('paradis.agentStatus.question', "質問中");
		// allow-any-unicode-next-line
		case 'permission': return localize('paradis.agentStatus.permission', "許可待ち");
	}
}

interface IRepositoryTemplateData {
	readonly row: HTMLElement;
	readonly name: HTMLElement;
	/** SSH で繋いだ先のスペースであることを示すアイコン。手元のスペースでは隠す。 */
	readonly remote: HTMLElement;
	readonly remoteHover: IManagedHover;
	readonly count: HTMLElement;
	/**
	 * 折りたたみ中に配下のエージェント状態を件数で示すバッジ。折りたたむと子行ごと
	 * 状態が見えなくなるため、見出し行だけで中の様子が分かるようにする。
	 */
	readonly summary: HTMLElement;
	readonly summaryHover: IManagedHover;
	readonly actionBar: ActionBar;
	readonly templateDisposables: DisposableStore;
}

/**
 * 状態ごとの件数を「● 1 ● 3」の形で描く (優先度の高い順、0件の種別は出さない)。
 * renderStatusDots と同じ理由で、要素は作り直さず使い回す。
 */
function renderStatusCounts(container: HTMLElement, statuses: readonly ParadisAgentStatus[]): void {
	container.classList.toggle('hidden', statuses.length === 0);
	const counts = statusCounts(statuses);
	counts.forEach(([status, count], index) => {
		const existing = container.children.item(index);
		const group = DOM.isHTMLElement(existing) ? existing : DOM.append(container, DOM.$('.paradis-workspace-summary-group'));
		if (group.childElementCount === 0) {
			DOM.append(group, DOM.$('.paradis-agent-dot'));
			DOM.append(group, DOM.$('span.paradis-workspace-summary-count'));
		}
		group.children[0].className = `paradis-agent-dot ${statusColorClass(status)}`;
		group.children[1].textContent = String(count);
	});
	while (container.childElementCount > counts.length) {
		container.lastElementChild?.remove();
	}
}

interface IWorktreeTemplateData {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly branch: HTMLElement;
	/**
	 * 行の右端は上下2段。上段は「自分が抱えているもの」(エージェントの状態・未完了メモ)、
	 * 下段は「コードとGitHubの状態」(PR・差分)。44pxの1段に5要素を横並びにすると
	 * 名前とブランチの幅が食い潰されるため、2段へ分けている。
	 */
	readonly dots: HTMLElement;
	readonly dotsHover: IManagedHover;
	readonly pr: HTMLElement;
	readonly prIcon: HTMLElement;
	readonly prNumber: HTMLElement;
	readonly prHover: IManagedHover;
	/** クリックリスナーが renderElement 後の最新 PR URL を参照するためのホルダー */
	readonly prContext: { url?: string };
	/** メモの未完了件数バッジ (paradisSpaceNotesPanel と同じ内容の要約表示) */
	readonly note: HTMLElement;
	readonly noteCount: HTMLElement;
	readonly noteHover: IManagedHover;
	readonly diff: HTMLElement;
	readonly diffAdded: HTMLElement;
	readonly diffRemoved: HTMLElement;
	/** ピン留めの留め外しボタン。未ピンは行のホバー時のみ、ピン済みは常に見える (CSS) */
	readonly pin: HTMLElement;
	readonly pinIcon: HTMLElement;
	readonly pinHover: IManagedHover;
	/** クリックリスナーが renderElement 後の最新の行を参照するためのホルダー */
	readonly pinContext: { worktree?: IParadisWorktree };
	readonly templateDisposables: DisposableStore;
}

/** PR 状態 → チップ表示に使う codicon。GitHub 本家のアイコンに合わせる。 */
function prStateIcon(state: ParadisPrState): ThemeIcon {
	switch (state) {
		case 'merged': return Codicon.gitMerge;
		case 'closed': return Codicon.gitPullRequestClosed;
		case 'draft': return Codicon.gitPullRequestDraft;
		default: return Codicon.gitPullRequest;
	}
}

function prStateLabel(state: ParadisPrState): string {
	switch (state) {
		case 'merged': return localize('paradis.pr.merged', "Merged");
		case 'closed': return localize('paradis.pr.closed', "Closed");
		case 'draft': return localize('paradis.pr.draft', "Draft");
		default: return localize('paradis.pr.open', "Open");
	}
}

class WorkspaceTreeDelegate implements IListVirtualDelegate<WorkspaceTreeElement> {
	getHeight(element: WorkspaceTreeElement): number {
		// リポジトリ行は純粋なグルーピング見出し (main checkout も worktree 行として
		// 子要素に含まれる)。worktree 行・作成中行は名前の下に2段目を重ねる表示のため高くする
		return isWorktree(element) || isCreating(element) ? 44 : 30;
	}

	getTemplateId(element: WorkspaceTreeElement): string {
		if (isCreating(element)) {
			return CreatingSpaceRenderer.TEMPLATE_ID;
		}
		return isWorktree(element) ? WorktreeRenderer.TEMPLATE_ID : RepositoryRenderer.TEMPLATE_ID;
	}
}

interface ICreatingSpaceTemplateData {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly stage: HTMLElement;
}

/**
 * バックグラウンド作成中のジョブを表す「作成中」行。worktree 行と同じ2段構成で、
 * 上段に（仮）表示名、下段に現在の工程を出す。クリック・コンテキストメニューは無効。
 */
class CreatingSpaceRenderer implements ITreeRenderer<ICreatingSpaceElement, FuzzyScore, ICreatingSpaceTemplateData> {

	static readonly TEMPLATE_ID = 'paradisCreatingSpace';
	readonly templateId = CreatingSpaceRenderer.TEMPLATE_ID;

	constructor(
		private readonly getRepositoryColorHex: (repositoryId: string) => string | undefined,
	) { }

	renderTemplate(container: HTMLElement): ICreatingSpaceTemplateData {
		const row = DOM.append(container, DOM.$('.paradis-worktree-row.paradis-creating-row'));
		const icon = DOM.append(row, DOM.$('.codicon'));
		const labels = DOM.append(row, DOM.$('.paradis-worktree-labels'));
		const name = DOM.append(labels, DOM.$('.paradis-worktree-name'));
		const stage = DOM.append(labels, DOM.$('.paradis-worktree-branch.paradis-creating-stage'));
		return { row, icon, name, stage };
	}

	renderElement(node: ITreeNode<ICreatingSpaceElement, FuzzyScore>, _index: number, templateData: ICreatingSpaceTemplateData): void {
		const element = node.element;
		applyStatusIcon(templateData.icon, 'working', Codicon.gitBranch);
		templateData.name.textContent = creatingElementLabel(element);
		templateData.stage.textContent = element.creatingJob.stageLabel;
		// リポジトリ見出し行と同じ色を継続させる (WorktreeRenderer.renderElement 参照)
		const colorHex = this.getRepositoryColorHex(element.creatingJob.repositoryId);
		templateData.row.closest<HTMLElement>('.monaco-tl-row')?.style.setProperty('--paradis-workspace-color', colorHex ?? 'transparent');
	}

	disposeTemplate(_templateData: ICreatingSpaceTemplateData): void { }
}

/**
 * リポジトリ行は「グループ見出し」専用 (Superset と異なり、main checkout もリスト内の1行として
 * WorktreeRenderer 側に混ぜ込むため)。クリックでの切り替えは行わず、展開/折りたたみと
 * 件数バッジ・ホバー時の「新規worktree作成」ボタンのみを持つ。
 */
class RepositoryRenderer implements ITreeRenderer<IParadisWorkspaceRepository, FuzzyScore, IRepositoryTemplateData> {

	static readonly TEMPLATE_ID = 'paradisRepository';
	readonly templateId = RepositoryRenderer.TEMPLATE_ID;

	constructor(
		private readonly onCreateWorktree: (repository: IParadisWorkspaceRepository) => void,
		/** 配下スペースのエージェント状態をまとめたもの (折りたたみ中の要約に使う) */
		private readonly getRepositoryBreakdown: (repository: IParadisWorkspaceRepository) => readonly ParadisAgentStatus[],
		private readonly hoverService: IHoverService,
	) { }

	renderTemplate(container: HTMLElement): IRepositoryTemplateData {
		const templateDisposables = new DisposableStore();
		const row = DOM.append(container, DOM.$('.paradis-workspace-row'));
		const name = DOM.append(row, DOM.$('.paradis-workspace-name'));
		// 接続先のスペースだけに付く印。名前のすぐ後ろに置いて、どのマシンのものか一目で分かるようにする
		const remote = DOM.append(row, DOM.$('.paradis-workspace-remote.codicon.codicon-remote'));
		const remoteHover = templateDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), remote, ''));
		const count = DOM.append(row, DOM.$('.paradis-workspace-count'));
		const summary = DOM.append(row, DOM.$('.paradis-workspace-summary'));
		const summaryHover = templateDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), summary, ''));
		const actionsContainer = DOM.append(row, DOM.$('.paradis-workspace-actions'));
		const actionBar = new ActionBar(actionsContainer);
		return { row, name, remote, remoteHover, count, summary, summaryHover, actionBar, templateDisposables };
	}

	renderElement(node: ITreeNode<IParadisWorkspaceRepository, FuzzyScore>, _index: number, templateData: IRepositoryTemplateData): void {
		const repository = node.element;
		templateData.name.textContent = repository.name;
		templateData.count.textContent = String(node.children.length);

		// 接続先のスペースかどうか。手元のものには何も足さない（大半はこちらなので、
		// 印を付けるのは「いつもと違う方」だけにする）
		const remoteHost = repository.uri.scheme === Schemas.vscodeRemote ? repository.uri.authority.replace(/^ssh-remote\+/, '') : undefined;
		templateData.remote.classList.toggle('hidden', remoteHost === undefined);
		templateData.remoteHover.update(remoteHost === undefined
			? ''
			// allow-any-unicode-next-line
			: localize('paradis.workspaces.onRemoteHost', "{0} 上のスペース", remoteHost));

		// 展開中は各行がドット列を持っているので、要約は折りたたみ中だけ出す
		const breakdown = node.collapsed ? this.getRepositoryBreakdown(repository) : [];
		renderStatusCounts(templateData.summary, breakdown);
		const summaryTooltip = agentStatusSummaryTooltip(breakdown);
		templateData.summaryHover.update(summaryTooltip);
		// ドットは色と明滅だけで状態を表すので、支援技術向けに同じ内容を文字でも持たせる
		templateData.summary.ariaLabel = summaryTooltip;

		// Superset と同じ固定パレットの色を行左端の色バーに反映する。
		// 色バーは chevron より左に置くため .monaco-tl-row の ::before で描画し、
		// 色はカスタムプロパティで渡す (media/paradisWorkspaceSwitch.css 参照)。
		// worktree 行 (WorktreeRenderer) 側にも同じ色を継続させ、リポジトリ内で
		// 色の帯が途切れないようにする (getRepositoryColorHex 経由)
		const colorHex = paradisWorkspaceColorHex(repository.color);
		templateData.row.closest<HTMLElement>('.monaco-tl-row')?.style.setProperty('--paradis-workspace-color', colorHex ?? 'transparent');

		templateData.actionBar.clear();
		templateData.actionBar.push(new Action(
			'paradis.workspaceSwitch.createWorktreeInline',
			localize('paradis.workspaceSwitch.createWorktreeContext', "New Worktree Space..."),
			ThemeIcon.asClassName(Codicon.add),
			true,
			() => this.onCreateWorktree(repository)
		), { icon: true, label: false });
	}

	disposeTemplate(templateData: IRepositoryTemplateData): void {
		templateData.actionBar.dispose();
		templateData.templateDisposables.dispose();
	}
}

class WorktreeRenderer implements ITreeRenderer<IParadisWorktree, FuzzyScore, IWorktreeTemplateData> {

	static readonly TEMPLATE_ID = 'paradisWorktree';
	readonly templateId = WorktreeRenderer.TEMPLATE_ID;

	constructor(
		private readonly isActive: (worktree: IParadisWorktree) => boolean,
		private readonly getBreakdown: (stateKey: string) => readonly ParadisAgentStatus[],
		private readonly getDiffStat: (worktree: IParadisWorktree) => IParadisDiffStat | undefined,
		private readonly getPrStatus: (worktree: IParadisWorktree) => IParadisPrStatus | undefined,
		private readonly getNoteSummary: (worktree: IParadisWorktree) => IParadisSpaceNoteSummary,
		private readonly getRepositoryColorHex: (repositoryId: string) => string | undefined,
		/** バックグラウンド作成が進行中なら、その工程ラベル (ブランチ名の代わりに出す) */
		private readonly getPendingStage: (worktree: IParadisWorktree) => string | undefined,
		private readonly isPinned: (worktree: IParadisWorktree) => boolean,
		private readonly togglePin: (worktree: IParadisWorktree) => void,
		/** ツリーのインデント1段ぶんの幅 (控え行を子行の位置に揃えるのに使う) */
		private readonly getTreeIndent: () => number,
		private readonly openPrUrl: (url: string) => void,
		private readonly hoverService: IHoverService,
	) { }

	renderTemplate(container: HTMLElement): IWorktreeTemplateData {
		const templateDisposables = new DisposableStore();
		const row = DOM.append(container, DOM.$('.paradis-worktree-row'));
		const icon = DOM.append(row, DOM.$('.codicon'));
		// 名前の下にブランチ名を重ねる2段表示 (リポジトリ行が見出し化される前の従来スタイルを踏襲)
		const labels = DOM.append(row, DOM.$('.paradis-worktree-labels'));
		const name = DOM.append(labels, DOM.$('.paradis-worktree-name'));
		const branch = DOM.append(labels, DOM.$('.paradis-worktree-branch'));
		// 右端の2段。上段 = エージェントのドット列 + メモ、下段 = PR チップ + 差分
		const stack = DOM.append(row, DOM.$('.paradis-worktree-stack'));
		const upperTier = DOM.append(stack, DOM.$('.paradis-worktree-tier'));
		const lowerTier = DOM.append(stack, DOM.$('.paradis-worktree-tier'));
		// スコープ内のエージェント1体につき1つのドット (集約アイコンでは消えてしまう内訳を出す)
		const dots = DOM.append(upperTier, DOM.$('.paradis-worktree-dots'));
		const dotsHover = templateDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), dots, ''));
		// ブランチに紐づく GitHub PR のチップ (Superset の WorkspaceStatusBadge 相当)。
		// クリックは行の切り替えではなく PR ページを開くため、リスト側のハンドラへ届く前に止める
		const pr = DOM.append(lowerTier, DOM.$('.paradis-worktree-pr'));
		const prIcon = DOM.append(pr, DOM.$('.codicon'));
		const prNumber = DOM.append(pr, DOM.$('span.paradis-worktree-pr-number'));
		const prContext: { url?: string } = {};
		for (const eventType of [DOM.EventType.MOUSE_DOWN, DOM.EventType.CLICK]) {
			templateDisposables.add(DOM.addDisposableListener(pr, eventType, event => {
				if (!prContext.url) {
					return;
				}
				DOM.EventHelper.stop(event, true);
				if (eventType === DOM.EventType.CLICK) {
					this.openPrUrl(prContext.url);
				}
			}));
		}
		const prHover = templateDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), pr, ''));
		// メモの未完了件数。行の情報量を増やしすぎないよう、未完了が1件以上あるときだけ出す
		const note = DOM.append(upperTier, DOM.$('.paradis-worktree-note'));
		const noteIcon = DOM.append(note, DOM.$('.codicon'));
		noteIcon.className = `codicon ${ThemeIcon.asClassName(Codicon.checklist).replace('codicon ', '')}`;
		const noteCount = DOM.append(note, DOM.$('span.paradis-worktree-note-count'));
		const noteHover = templateDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), note, ''));
		const diff = DOM.append(lowerTier, DOM.$('.paradis-worktree-diff'));
		const diffAdded = DOM.append(diff, DOM.$('span.paradis-worktree-diff-added'));
		const diffRemoved = DOM.append(diff, DOM.$('span.paradis-worktree-diff-removed'));
		// ピンの留め外し。PR チップと同じく、行のクリック (切り替え) へ届く前に止める
		const pinContext: { worktree?: IParadisWorktree } = {};
		const pin = DOM.append(row, DOM.$('.paradis-worktree-pin'));
		const pinIcon = DOM.append(pin, DOM.$('.codicon'));
		for (const eventType of [DOM.EventType.MOUSE_DOWN, DOM.EventType.CLICK]) {
			templateDisposables.add(DOM.addDisposableListener(pin, eventType, event => {
				if (!pinContext.worktree) {
					return;
				}
				DOM.EventHelper.stop(event, true);
				if (eventType === DOM.EventType.CLICK) {
					this.togglePin(pinContext.worktree);
				}
			}));
		}
		const pinHover = templateDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), pin, ''));
		return { row, icon, name, branch, dots, dotsHover, pr, prIcon, prNumber, prHover, prContext, note, noteCount, noteHover, diff, diffAdded, diffRemoved, pin, pinIcon, pinHover, pinContext, templateDisposables };
	}

	renderElement(node: ITreeNode<IParadisWorktree, FuzzyScore>, _index: number, templateData: IWorktreeTemplateData): void {
		const worktree = node.element;
		const active = this.isActive(worktree);
		// 作成直後で setup 等がまだ走っている間は、エージェント状態の有無に関わらず稼働中として見せる
		const pendingStage = worktree.missing ? undefined : this.getPendingStage(worktree);
		// 作成中は実際のエージェント状態がまだ無いので、1体が動いている扱いで見せる
		const breakdown: readonly ParadisAgentStatus[] = worktree.missing ? []
			: pendingStage !== undefined ? ['working']
				: this.getBreakdown(worktreeStateKeyFor(worktree));
		const status = paradisAggregateAgentStatus(breakdown);
		const fallback = worktree.missing ? Codicon.warning : active ? Codicon.check : worktree.isMainCheckout ? Codicon.repo : Codicon.gitBranch;
		applyStatusIcon(templateData.icon, status, fallback);
		renderStatusDots(templateData.dots, breakdown);
		const dotsTooltip = agentStatusSummaryTooltip(breakdown);
		templateData.dotsHover.update(dotsTooltip);
		// ドットは色と明滅だけで状態を表すので、支援技術向けに同じ内容を文字でも持たせる
		templateData.dots.ariaLabel = dotsTooltip;
		templateData.name.textContent = worktree.name;
		templateData.branch.textContent = worktree.missing
			? localize('paradis.workspaceSwitch.worktreeMissing', "missing")
			: pendingStage ?? worktree.branch ?? '';
		templateData.branch.classList.toggle('paradis-creating-stage', pendingStage !== undefined);
		templateData.row.classList.toggle('active', active);
		templateData.row.classList.toggle('missing', !!worktree.missing);
		// 折りたたまれたリポジトリの下に残している控え行 (updateTree が差し込むルート要素)。
		// ルート要素はツリーが字下げしないため、子行と同じ位置に見えるよう1段ぶん自分で寄せる
		const keep = isPinnedKeep(worktree);
		templateData.row.classList.toggle('paradis-pinned-keep', keep);
		templateData.row.style.paddingLeft = keep ? `${this.getTreeIndent()}px` : '';

		const pinned = this.isPinned(worktree);
		templateData.pinContext.worktree = worktree;
		templateData.pin.classList.toggle('pinned', pinned);
		templateData.pinIcon.className = ThemeIcon.asClassName(pinned ? Codicon.pinned : Codicon.pin);
		templateData.pinHover.update(pinned
			// allow-any-unicode-next-line
			? localize('paradis.workspaceSwitch.unpinTooltip', "ピン留めを解除")
			// allow-any-unicode-next-line
			: localize('paradis.workspaceSwitch.pinTooltip', "ピン留めする（リポジトリを折りたたんでも表示したままにする）"));

		// リポジトリ見出し行と同じ色を worktree 行にも継続させる (RepositoryRenderer.renderElement 参照)。
		// 別要素の .monaco-tl-row なのでカスタムプロパティは継承されず、ここで明示的に設定する必要がある
		const colorHex = this.getRepositoryColorHex(worktree.repositoryId);
		templateData.row.closest<HTMLElement>('.monaco-tl-row')?.style.setProperty('--paradis-workspace-color', colorHex ?? 'transparent');

		const diffStat = worktree.missing ? undefined : this.getDiffStat(worktree);
		const hasDiff = !!diffStat && (diffStat.insertions > 0 || diffStat.deletions > 0);
		templateData.diff.classList.toggle('hidden', !hasDiff);
		if (hasDiff && diffStat) {
			templateData.diffAdded.textContent = diffStat.insertions > 0 ? `+${diffStat.insertions}` : '';
			templateData.diffRemoved.textContent = diffStat.deletions > 0 ? `-${diffStat.deletions}` : '';
		}

		const noteSummary = worktree.missing ? undefined : this.getNoteSummary(worktree);
		const hasOpenTasks = !!noteSummary && noteSummary.open > 0;
		templateData.note.classList.toggle('hidden', !hasOpenTasks);
		if (hasOpenTasks && noteSummary) {
			templateData.noteCount.textContent = String(noteSummary.open);
			// allow-any-unicode-next-line
			templateData.noteHover.update(localize('paradis.spaceNotes.badgeTooltip', "メモ: 未完了 {0} 件 / 全 {1} 件", noteSummary.open, noteSummary.open + noteSummary.done));
		} else {
			templateData.noteCount.textContent = '';
			templateData.noteHover.update('');
		}

		const prStatus = worktree.missing ? undefined : this.getPrStatus(worktree);
		templateData.pr.classList.toggle('hidden', !prStatus);
		templateData.prContext.url = prStatus?.url;
		for (const state of ['open', 'draft', 'merged', 'closed'] as const) {
			templateData.pr.classList.toggle(`paradis-pr-${state}`, prStatus?.state === state);
		}
		if (prStatus) {
			templateData.prIcon.className = ThemeIcon.asClassName(prStateIcon(prStatus.state));
			templateData.prNumber.textContent = `#${prStatus.number}`;
			templateData.prHover.update(prStatus.title
				// allow-any-unicode-next-line
				? localize('paradis.pr.tooltip', "#{0} {1} — {2}", prStatus.number, prStateLabel(prStatus.state), prStatus.title)
				: localize('paradis.pr.tooltipNoTitle', "#{0} {1}", prStatus.number, prStateLabel(prStatus.state)));
		} else {
			// テンプレート再利用時に前回行のアイコン/番号が残らないようリセットする
			templateData.prIcon.className = 'codicon';
			templateData.prNumber.textContent = '';
			templateData.prHover.update('');
		}
	}

	disposeTemplate(templateData: IWorktreeTemplateData): void {
		templateData.templateDisposables.dispose();
	}
}

/**
 * ツリーのドラッグ&ドロップ並び替え (案B)。
 * - リポジトリ行同士: reorderRepositories で並べ替え
 * - worktree 行同士: 同一リポジトリ内でのみ setWorktreeOrder で並べ替え
 * - main checkout (isMainCheckout) 行・「作成中」(isCreating) 行はドラッグ不可・ドロップ先不可
 *   (main checkout は常に先頭固定を維持する)
 * targetSector の上寄り/下寄りで挿入位置 (before/after) を判定する。
 */
class ParadisWorkspacesDragAndDrop implements ITreeDragAndDrop<WorkspaceTreeElement> {

	constructor(
		private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		private readonly worktreeService: IParadisWorktreeService,
	) { }

	getDragURI(element: WorkspaceTreeElement): string | null {
		// 折りたたみ中の控え行は実体の写しなので、並び替えの対象にしない
		if (isCreating(element) || isPinnedKeep(element)) {
			return null;
		}
		if (isWorktree(element)) {
			// main checkout (リポジトリ本体) は常に先頭固定のためドラッグ不可
			return element.isMainCheckout ? null : `worktree:${worktreeStateKeyFor(element)}`;
		}
		return `repo:${element.id}`;
	}

	getDragLabel(elements: WorkspaceTreeElement[]): string | undefined {
		const element = elements[0];
		return element && !isCreating(element) ? element.name : undefined;
	}

	onDragOver(data: IDragAndDropData, targetElement: WorkspaceTreeElement | undefined, targetIndex: number | undefined, targetSector: ListViewTargetSector | undefined): boolean | ITreeDragOverReaction {
		const dragged = this.singleDragged(data);
		if (!dragged || !targetElement || !this.isSameKindReorderTarget(dragged, targetElement)) {
			return false;
		}
		const placeAfter = targetSector === ListViewTargetSector.CENTER_BOTTOM || targetSector === ListViewTargetSector.BOTTOM;
		const position = placeAfter ? ListDragOverEffectPosition.After : ListDragOverEffectPosition.Before;
		return { accept: true, effect: { type: ListDragOverEffectType.Move, position }, feedback: [targetIndex ?? -1] };
	}

	drop(data: IDragAndDropData, targetElement: WorkspaceTreeElement | undefined, _targetIndex: number | undefined, targetSector: ListViewTargetSector | undefined): void {
		const dragged = this.singleDragged(data);
		if (!dragged || !targetElement || !this.isSameKindReorderTarget(dragged, targetElement)) {
			return;
		}
		const placeAfter = targetSector === ListViewTargetSector.CENTER_BOTTOM || targetSector === ListViewTargetSector.BOTTOM;

		if (isWorktree(dragged) && isWorktree(targetElement)) {
			const siblings = this.worktreeService.getWorktrees(dragged.repositoryId);
			const orderedUris = siblings.map(worktree => worktree.uri.toString());
			const reordered = paradisReorderByDrop(orderedUris, dragged.uri.toString(), targetElement.uri.toString(), placeAfter);
			if (reordered) {
				this.worktreeService.setWorktreeOrder(dragged.repositoryId, reordered);
			}
			return;
		}

		if (!isWorktree(dragged) && !isCreating(targetElement) && !isWorktree(targetElement)) {
			const ids = this.workspaceSwitchService.repositories.map(repository => repository.id);
			const reordered = paradisReorderByDrop(ids, dragged.id, targetElement.id, placeAfter);
			if (reordered) {
				this.workspaceSwitchService.reorderRepositories(reordered);
			}
		}
	}

	dispose(): void { }

	/** 単一要素のドラッグのみ扱う (複数選択の並び替えは非対応)。 */
	private singleDragged(data: IDragAndDropData): IParadisWorkspaceRepository | IParadisWorktree | undefined {
		if (!(data instanceof ElementsDragAndDropData)) {
			return undefined;
		}
		const elements = (data as ElementsDragAndDropData<WorkspaceTreeElement>).elements;
		if (elements.length !== 1) {
			return undefined;
		}
		const dragged = elements[0];
		if (isCreating(dragged) || (isWorktree(dragged) && dragged.isMainCheckout)) {
			return undefined;
		}
		return dragged;
	}

	/**
	 * dragged と target が同じ階層で並べ替え可能か。worktree は同一リポジトリ内、かつ
	 * main checkout / 作成中行を除く実 worktree のみ。リポジトリはリポジトリ行同士のみ。
	 */
	private isSameKindReorderTarget(dragged: IParadisWorkspaceRepository | IParadisWorktree, target: WorkspaceTreeElement): boolean {
		if (isPinnedKeep(target)) {
			return false;
		}
		if (isWorktree(dragged)) {
			return isWorktree(target) && !target.isMainCheckout && target.repositoryId === dragged.repositoryId;
		}
		return !isCreating(target) && !isWorktree(target);
	}
}

/**
 * FleetView 風のリポジトリ一覧ビュー (機能1 Phase 4 / Phase B)。
 * リポジトリを親、git worktree を子とする2階層ツリー。クリックで即座に切り替える。
 */
export class ParadisWorkspacesView extends ViewPane {

	private tree: WorkbenchObjectTree<WorkspaceTreeElement, FuzzyScore> | undefined;
	/** worktree の uri.fsPath → 未コミット差分統計。ポーリングでのみ更新する (refreshDiffStats 参照) */
	private readonly _diffStats = new Map<string, IParadisDiffStat>();
	private readonly _diffStatsScheduler: RunOnceScheduler;
	/** worktree の uri.fsPath → 現在ブランチに紐づく PR 状態。ポーリングでのみ更新する (refreshPrStatuses 参照) */
	private readonly _prStatuses = new Map<string, IParadisPrStatus>();
	private readonly _prStatusScheduler: RunOnceScheduler;
	private readonly _collapsedRepositoryState: ParadisCollapsedRepositoryStateController;
	/** 折りたたみ操作の最中にツリーを組み直さないための遅延実行 (onDidChangeCollapseState 参照) */
	private readonly _updateTreeScheduler: RunOnceScheduler;
	/** ツリーのインデント1段ぶんの幅 (workbench.tree.indent に追従する) */
	private treeIndent = DEFAULT_TREE_INDENT;
	/** ビュー下端に固定される「いま開いているスペースのメモ」欄 */
	private notesPanel: ParadisSpaceNotesPanel | undefined;
	/** メモ欄の高さが変わったときにツリーを再レイアウトするため、直近のレイアウト値を覚えておく */
	private lastLayout: { height: number; width: number } | undefined;

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
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IParadisAgentStatusStore private readonly agentStatusStore: IParadisAgentStatusStore,
		@IParadisWorktreeCreateProgressStore private readonly createProgressStore: IParadisWorktreeCreateProgressStore,
		@IParadisSpaceNotesService private readonly spaceNotesService: IParadisSpaceNotesService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._diffStatsScheduler = this._register(new RunOnceScheduler(() => this.refreshDiffStats(), DIFF_STATS_POLL_INTERVAL_MS));
		this._prStatusScheduler = this._register(new RunOnceScheduler(() => this.refreshPrStatuses(), PR_STATUS_POLL_INTERVAL_MS));
		this._collapsedRepositoryState = this._register(new ParadisCollapsedRepositoryStateController(this.storageService, this.logService));
		this._updateTreeScheduler = this._register(new RunOnceScheduler(() => this.updateTree(), 0));

		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => { this.updateTree(); this.updateNotesPanelSpace(); this._diffStatsScheduler.schedule(0); this._prStatusScheduler.schedule(0); }));
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => { this.updateTree(); this.updateNotesPanelSpace(); }));
		// メモの未完了バッジは行の表示内容なので、メモが変わったらツリーを描き直す
		this._register(this.spaceNotesService.onDidChangeNotes(() => this.updateTree()));
		this._register(this.worktreeService.onDidChangeWorktrees(() => { this.updateTree(); this.updateNotesPanelSpace(); this._diffStatsScheduler.schedule(0); this._prStatusScheduler.schedule(0); }));
		// 注意: 引数なしの tree.rerender() は行の renderElement を再実行しないため、
		// setChildren で作り直す (identityProvider により選択/折りたたみ状態は保持される)
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => this.updateTree()));
		// バックグラウンド作成の進行状況（「作成中」行の追加・工程更新・完了時の除去）
		this._register(this.createProgressStore.onDidChangeJobs(() => this.updateTree()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// ツリーとメモ欄を縦に積む (メモ欄は下端固定、ツリーが残りを占める)
		container.classList.add('paradis-workspaces-pane-body');
		const treeContainer = DOM.append(container, DOM.$('.paradis-workspaces-list'));
		// ピン留めの控え行を子行と同じ位置に見せるため、ツリーと同じインデント幅を持っておく
		// (listService が同じ設定値でツリーの indent を決めている)
		this.updateTreeIndent();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TREE_INDENT_CONFIGURATION_KEY)) {
				this.updateTreeIndent();
				this.updateTree();
			}
		}));
		const getBreakdown = (stateKey: string) => this.agentStatusStore.getScopeBreakdown(stateKey);
		const repositoryRenderer = new RepositoryRenderer(
			repository => this.commandService.executeCommand('paradis.workspaceSwitch.createWorktree', repository.id),
			repository => this.repositoryBreakdown(repository),
			this.hoverService
		);
		const worktreeRenderer = new WorktreeRenderer(
			worktree => this.workspaceSwitchService.activeStateKey === worktreeStateKeyFor(worktree),
			getBreakdown,
			worktree => this._diffStats.get(worktree.uri.fsPath),
			worktree => this._prStatuses.get(worktree.uri.fsPath),
			worktree => this.spaceNotesService.summary(worktreeStateKeyFor(worktree)),
			repositoryId => paradisWorkspaceColorHex(this.workspaceSwitchService.repositories.find(repository => repository.id === repositoryId)?.color),
			worktree => this.pendingStageFor(worktree),
			worktree => this.worktreeService.isPinned(worktreeStateKeyFor(worktree)),
			worktree => this.togglePin(worktree),
			() => this.treeIndent,
			url => { this.openerService.open(URI.parse(url)).catch(error => this.notificationService.error(error)); },
			this.hoverService
		);
		const creatingRenderer = new CreatingSpaceRenderer(
			repositoryId => paradisWorkspaceColorHex(this.workspaceSwitchService.repositories.find(repository => repository.id === repositoryId)?.color)
		);

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<WorkspaceTreeElement, FuzzyScore>,
			'ParadisWorkspaces',
			treeContainer,
			new WorkspaceTreeDelegate(),
			[repositoryRenderer, worktreeRenderer, creatingRenderer],
			{
				identityProvider: {
					getId: (element: WorkspaceTreeElement) => isCreating(element)
						? `creating:${element.creatingJob.id}`
						// ピン留めの控え行は、折りたたまれた子として隠れている実体と同時に存在するため別IDにする
						: isPinnedKeep(element) ? `pinnedKeep:${worktreeStateKeyFor(element)}`
							: isWorktree(element) ? `worktree:${worktreeStateKeyFor(element)}` : `repo:${element.id}`
				},
				horizontalScrolling: false,
				// ドラッグ&ドロップ並び替え (案B)。リポジトリ同士・同一リポジトリ内 worktree 同士のみ許可
				dnd: new ParadisWorkspacesDragAndDrop(this.workspaceSwitchService, this.worktreeService),
				// worktree 行本体のクリックは「切り替え」専用にし、リポジトリ見出しの開閉は
				// 左端の chevron でのみ行う (見出し行本体のクリックは何もしない)
				expandOnlyOnTwistieClick: true,
				accessibilityProvider: {
					getAriaLabel: (element: WorkspaceTreeElement) => isCreating(element) ? creatingElementLabel(element) : element.name,
					getWidgetAriaLabel: () => localize('paradisWorkspaces', "Workspaces")
				}
			}
		));

		// クリック / Enter で切り替え。リポジトリ行は純粋なグルーピング見出しのため何もしない
		// (main checkout も worktree 行として子要素に含まれ、そちらのクリックで切り替わる)
		this._register(this.tree.onDidOpen(e => {
			const element = e.element;
			if (!element || !isWorktree(element)) {
				return;
			}
			this.openWorktree(element);
		}));

		this._register(this.tree.onContextMenu(e => {
			const element = e.element;
			if (!element || isCreating(element)) {
				return;
			}
			this.contextMenuService.showContextMenu({
				getAnchor: () => e.anchor,
				getActions: () => isWorktree(element)
					? this.buildWorktreeContextMenuActions(element)
					: this.buildRepositoryContextMenuActions(element)
			});
		}));

		this._register(this.tree.onDidChangeCollapseState(e => {
			const element = e.node.element;
			if (!element || isCreating(element)) {
				return;
			}
			if (this._collapsedRepositoryState.recordTreeCollapse(element, e.node.collapsed)) {
				// ピン留めの控え行は折りたたみ中だけ差し込むので、状態が変わったら組み直す。
				// ツリー自身の折りたたみ処理の途中で setChildren を呼び返さないよう、次のタスクへ回す
				this._updateTreeScheduler.schedule();
			}
		}));

		this.notesPanel = this._register(this.instantiationService.createInstance(ParadisSpaceNotesPanel, container));
		this._register(this.notesPanel.onDidChangeHeight(() => this.relayout()));

		this.updateTree();
		this.updateNotesPanelSpace();
		this._diffStatsScheduler.schedule(0);
		this._prStatusScheduler.schedule(0);
	}

	/** メモ欄の対象を、いま開いているスペースに追従させる。 */
	private updateNotesPanelSpace(): void {
		if (!this.notesPanel) {
			return;
		}
		const stateKey = this.workspaceSwitchService.activeStateKey;
		if (stateKey === undefined) {
			this.notesPanel.setSpace(undefined, '', undefined);
			return;
		}
		for (const repository of this.workspaceSwitchService.repositories) {
			const colorHex = paradisWorkspaceColorHex(repository.color);
			if (repository.id === stateKey) {
				this.notesPanel.setSpace(stateKey, `${repository.name} / ${STR_MAIN_CHECKOUT_NAME}`, colorHex);
				return;
			}
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (paradisWorktreeStateKey(worktree.uri) === stateKey) {
					this.notesPanel.setSpace(stateKey, worktree.name, colorHex);
					return;
				}
			}
		}
		// 登録リポジトリの外にあるスペース (固定された補助ウィンドウ等) でもメモは書ける
		this.notesPanel.setSpace(stateKey, '', undefined);
	}

	/** メモ欄の高さが変わったときに、直近のレイアウト値でツリーを配分し直す。 */
	private relayout(): void {
		if (this.lastLayout) {
			this.layoutContents(this.lastLayout.height, this.lastLayout.width);
		}
	}

	/** ビューの高さをメモ欄とツリーへ配分する (layoutBody とメモ欄の高さ変更の共通処理)。 */
	private layoutContents(height: number, width: number): void {
		const notesHeight = this.notesPanel?.layout(height) ?? 0;
		this.tree?.layout(Math.max(0, height - notesHeight), width);
	}

	/** worktree 行 (main checkout の合成行を含む) のクリックで、その作業ツリーへ切り替える。 */
	private openWorktree(worktree: IParadisWorktree): void {
		if (worktree.missing) {
			return;
		}
		// 切り替えは updateFolders / ディスク状態の変化で reject しうる。握り潰さず通知する
		// (放置すると unhandled rejection になりビュー上は「無反応」に見える)。
		const promise = worktree.isMainCheckout
			? this.workspaceSwitchService.switchRepository(worktree.repositoryId)
			: this.workspaceSwitchService.switchToWorktree(worktree);
		promise.catch(error => this.notificationService.error(error));
	}

	/** refreshDiffStats の多重実行防止 (await 中に schedule(0) が割り込むと再入しうる) */
	private _diffStatsInFlight = false;

	/** diff 統計 (+N/-N) をポーリングで取得する。View可視時のみ実行し、非可視時は間隔だけ空けて再チェックする。 */
	private async refreshDiffStats(): Promise<void> {
		if (this._diffStatsInFlight) {
			this._diffStatsScheduler.schedule();
			return;
		}
		if (!this.isBodyVisible()) {
			this._diffStatsScheduler.schedule();
			return;
		}

		const paths = new Set<string>();
		for (const repository of this.workspaceSwitchService.repositories) {
			paths.add(repository.uri.fsPath);
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (!worktree.missing) {
					paths.add(worktree.uri.fsPath);
				}
			}
		}

		if (paths.size === 0) {
			this._diffStatsScheduler.schedule();
			return;
		}

		this._diffStatsInFlight = true;
		try {
			const result = await this.commandService.executeCommand<Record<string, IParadisDiffStat>>(GET_DIFF_STATS_COMMAND_ID, [...paths]);
			if (result) {
				this._diffStats.clear();
				for (const [path, stat] of Object.entries(result)) {
					this._diffStats.set(path, stat);
				}
				this.updateTree();
			}
		} catch {
			// web ビルド等でコマンド未登録の場合は無視 (diff バッジを出さないだけで安全に成立する)
		} finally {
			this._diffStatsInFlight = false;
			this._diffStatsScheduler.schedule();
		}
	}

	/** refreshPrStatuses の多重実行防止 (await 中に schedule(0) が割り込むと再入しうる) */
	private _prStatusesInFlight = false;

	/** 各 worktree の現在ブランチに紐づく PR 状態をポーリングで取得する。仕組みは refreshDiffStats と同じ。 */
	private async refreshPrStatuses(): Promise<void> {
		if (this._prStatusesInFlight) {
			this._prStatusScheduler.schedule();
			return;
		}
		if (!this.isBodyVisible()) {
			this._prStatusScheduler.schedule();
			return;
		}

		const paths = new Set<string>();
		for (const repository of this.workspaceSwitchService.repositories) {
			paths.add(repository.uri.fsPath);
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (!worktree.missing) {
					paths.add(worktree.uri.fsPath);
				}
			}
		}

		if (paths.size === 0) {
			this._prStatusScheduler.schedule();
			return;
		}

		this._prStatusesInFlight = true;
		try {
			const result = await this.commandService.executeCommand<Record<string, IParadisPrStatus>>(GET_PR_STATUSES_COMMAND_ID, [...paths]);
			if (result) {
				this._prStatuses.clear();
				for (const [path, status] of Object.entries(result)) {
					this._prStatuses.set(path, status);
				}
				this.updateTree();
			}
		} catch {
			// web ビルド等でコマンド未登録の場合は無視 (PR チップを出さないだけで安全に成立する)
		} finally {
			this._prStatusesInFlight = false;
			this._prStatusScheduler.schedule();
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.lastLayout = { height, width };
		this.layoutContents(height, width);
	}

	override shouldShowWelcome(): boolean {
		return this.workspaceSwitchService.repositories.length === 0;
	}

	private updateTree(): void {
		if (!this.tree) {
			return;
		}

		const repositoryIds = new Set(this.workspaceSwitchService.repositories.map(repository => repository.id));
		this._collapsedRepositoryState.removeStaleRepositories(repositoryIds);

		const elements: IObjectTreeElement<WorkspaceTreeElement>[] = [];
		for (const repository of this.workspaceSwitchService.repositories) {
			const worktrees = this.worktreeService.getWorktrees(repository.id);
			// リポジトリ行は純粋なグルーピング見出しにしたため、main checkout (リポジトリ本体) も
			// worktree 行として先頭に混ぜ込む。これにより「今開いているのはどれか」の表示・切り替え・
			// diff統計バッジがすべて worktree 行側のロジックだけで完結する
			const mainCheckout: IParadisWorktree = {
				repositoryId: repository.id,
				name: STR_MAIN_CHECKOUT_NAME,
				branch: this.worktreeService.getRepositoryBranch(repository.id),
				uri: repository.uri,
				isMainCheckout: true
			};
			// バックグラウンド作成中のジョブは「作成中」プレースホルダ行として末尾に混ぜ込む。
			// `git worktree add` が済んだジョブは実体の行が既に一覧にあるため、同じ名前の行が
			// 2つ並ばないようここでは出さず、工程は実体の行の2段目に出す (pendingStageFor)
			const creatingJobs: ICreatingSpaceElement[] = this.createProgressStore.jobs
				.filter(job => job.repositoryId === repository.id && job.stateKey === undefined)
				.map(job => ({ creatingJob: job }));
			const children: WorkspaceTreeElement[] = [mainCheckout, ...worktrees, ...creatingJobs];
			const collapsed = this._collapsedRepositoryState.isRepositoryCollapsed(repository.id);
			elements.push({
				element: repository,
				children: children.map(worktree => ({ element: worktree })),
				collapsible: true,
				collapsed: collapsed
					? ObjectTreeElementCollapseState.PreserveOrCollapsed
					: ObjectTreeElementCollapseState.PreserveOrExpanded
			});

			// 折りたたみ中はピン留めした行だけをリポジトリ行の直後に残す。ツリーの折りたたみは
			// 子を一律に隠すため、控えを兄弟 (ルート要素) として差し込む
			if (collapsed) {
				for (const worktree of [mainCheckout, ...worktrees]) {
					if (this.worktreeService.isPinned(worktreeStateKeyFor(worktree))) {
						const keep: IPinnedKeepElement = { ...worktree, paradisPinnedKeep: true };
						elements.push({ element: keep });
					}
				}
			}
		}
		this.tree.setChildren(null, elements);
		this._onDidChangeViewWelcomeState.fire();
	}

	/**
	 * リポジトリ配下 (main checkout + 各 worktree + 作成中ジョブ) のエージェント状態をまとめる。
	 * 折りたたみ中の見出し行に出す要約用。
	 *
	 * ピン留めの控え行として見えているスペースも数に含める。要約は「このリポジトリ全体で
	 * 何体動いているか」を示すものなので、控え行のドットと重複して見えるのは意図どおり
	 * (除外すると、見出しの合計と展開後の内訳が食い違って読み手が混乱する)。
	 */
	private repositoryBreakdown(repository: IParadisWorkspaceRepository): readonly ParadisAgentStatus[] {
		const statuses: ParadisAgentStatus[] = [];
		// 各行の表示と同じ判定にする (作成中の行は実状態の代わりに「動作中1体」として数える)
		const collect = (stateKey: string) => {
			if (this.createProgressStore.jobs.some(job => job.stateKey === stateKey)) {
				statuses.push('working');
				return;
			}
			statuses.push(...this.agentStatusStore.getScopeBreakdown(stateKey));
		};
		collect(repository.id);
		for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
			if (!worktree.missing) {
				// 行側と同じキー導出を使う (getWorktrees は main checkout を含まないが、
				// 将来含むようになったときに要約だけが別のキーを引いてズレないようにする)
				collect(worktreeStateKeyFor(worktree));
			}
		}
		// まだ実体が無い作成中ジョブ (専用の「作成中」行として出ているもの)
		for (const job of this.createProgressStore.jobs) {
			if (job.repositoryId === repository.id && job.stateKey === undefined) {
				statuses.push('working');
			}
		}
		return paradisSortAgentStatuses(statuses);
	}

	/**
	 * その worktree でバックグラウンド作成の続き (setup・エージェント起動) がまだ走っていれば、
	 * 現在の工程ラベルを返す。実体ができた後は専用の「作成中」行を出さず、この工程を
	 * 実体の行の2段目 (ブランチ名の位置) に出す。
	 */
	private pendingStageFor(worktree: IParadisWorktree): string | undefined {
		const stateKey = worktreeStateKeyFor(worktree);
		return this.createProgressStore.jobs.find(job => job.stateKey === stateKey)?.stageLabel;
	}

	/** ツリーのインデント幅 (workbench.tree.indent) を控え行の字下げ用に控えておく。 */
	private updateTreeIndent(): void {
		const configured = this.configurationService.getValue(TREE_INDENT_CONFIGURATION_KEY);
		this.treeIndent = typeof configured === 'number' ? configured : DEFAULT_TREE_INDENT;
	}

	private togglePin(worktree: IParadisWorktree): void {
		const stateKey = worktreeStateKeyFor(worktree);
		this.worktreeService.setPinned(stateKey, !this.worktreeService.isPinned(stateKey));
	}

	/** リポジトリ一覧内での対象リポジトリの位置。存在しなければ -1。 */
	private repositorySiblingIndex(repository: IParadisWorkspaceRepository): { repositories: readonly IParadisWorkspaceRepository[]; index: number } {
		const repositories = this.workspaceSwitchService.repositories;
		const index = repositories.findIndex(candidate => candidate.id === repository.id);
		return { repositories, index };
	}

	/** 隣接するリポジトリと表示順を入れ替える (Move Up/Down)。 */
	private moveRepository(repository: IParadisWorkspaceRepository, direction: -1 | 1): void {
		const { repositories, index } = this.repositorySiblingIndex(repository);
		const reordered = paradisSwapAdjacent(repositories.map(candidate => candidate.id), index, direction);
		if (reordered) {
			this.workspaceSwitchService.reorderRepositories(reordered);
		}
	}

	private buildRepositoryContextMenuActions(repository: IParadisWorkspaceRepository): IAction[] {
		const { repositories, index } = this.repositorySiblingIndex(repository);
		return [
			new Action(
				'paradis.workspaceSwitch.createWorktreeContext',
				localize('paradis.workspaceSwitch.createWorktreeContext', "New Worktree Space..."),
				undefined,
				true,
				// コマンド実体は electron-browser 層 (paradisCreateWorktree.contribution.ts)。
				// browser 層のこのビューからは ID 経由で呼ぶ (web ビルドでは未登録のため no-op)
				() => this.commandService.executeCommand('paradis.workspaceSwitch.createWorktree', repository.id)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.rename',
				localize('paradis.workspaceSwitch.renameContext', "Rename..."),
				undefined,
				true,
				() => this.promptRename(repository)
			),
			// 色選択は QuickPick で行う。以前はコンテキストメニューのサブメニュー + CSS の
			// aria-label 属性セレクタでスウォッチを描画していたが、macOS のコンテキストメニューは
			// ネイティブ (HTML でない) ため色が一切表示されなかった。QuickPick なら全プラットフォームで
			// SVG data URI のスウォッチを表示できる
			new Action(
				'paradis.workspaceSwitch.setColor',
				localize('paradis.workspaceSwitch.setColorPick', "Set Color..."),
				undefined,
				true,
				() => this.promptColor(repository)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.repository.moveUp',
				localize('paradis.workspaceSwitch.moveUp', "Move Up"),
				undefined,
				index > 0,
				() => this.moveRepository(repository, -1)
			),
			new Action(
				'paradis.workspaceSwitch.repository.moveDown',
				localize('paradis.workspaceSwitch.moveDown', "Move Down"),
				undefined,
				index >= 0 && index < repositories.length - 1,
				() => this.moveRepository(repository, 1)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.reveal',
				revealLabel(),
				undefined,
				true,
				() => this.commandService.executeCommand('revealFileInOS', repository.uri)
			),
			new Action(
				'paradis.workspaceSwitch.copyPath',
				localize('paradis.workspaceSwitch.copyPath', "Copy Path"),
				undefined,
				true,
				() => this.clipboardService.writeText(repository.uri.fsPath)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.configureLifecycleScripts',
				localize('paradis.workspaceSwitch.configureLifecycleScriptsContext', "Setup/Teardown Scripts..."),
				undefined,
				true,
				// コマンド実体は electron-browser 層 (paradisCreateWorktree.contribution.ts)。
				// browser 層のこのビューからは ID 経由で呼ぶ (web ビルドでは未登録のため no-op)
				() => this.commandService.executeCommand('paradis.workspaceSwitch.configureLifecycleScripts', repository.id)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.removeFromList',
				localize('paradis.workspaceSwitch.removeContext', "Remove from List"),
				undefined,
				true,
				() => this.workspaceSwitchService.removeRepository(
					repository.id,
					this.worktreeService.getKnownWorktreeStateKeys(repository.id)
				).catch(error => this.notificationService.error(error))
			)
		];
	}

	/** 現在のリポジトリ内での worktree の並び順における位置。存在しない (main checkout 等) 場合は -1。 */
	private worktreeSiblingIndex(worktree: IParadisWorktree): { siblings: readonly IParadisWorktree[]; index: number } {
		const siblings = this.worktreeService.getWorktrees(worktree.repositoryId);
		const index = siblings.findIndex(candidate => candidate.uri.toString() === worktree.uri.toString());
		return { siblings, index };
	}

	/** 隣接する worktree と表示順を入れ替える (Move Up/Down)。 */
	private moveWorktree(worktree: IParadisWorktree, direction: -1 | 1): void {
		const { siblings, index } = this.worktreeSiblingIndex(worktree);
		const reordered = paradisSwapAdjacent(siblings.map(candidate => candidate.uri.toString()), index, direction);
		if (reordered) {
			this.worktreeService.setWorktreeOrder(worktree.repositoryId, reordered);
		}
	}

	private buildWorktreeContextMenuActions(worktree: IParadisWorktree): IAction[] {
		const pinned = this.worktreeService.isPinned(worktreeStateKeyFor(worktree));
		const actions: IAction[] = [
			new Action(
				'paradis.workspaceSwitch.worktree.togglePin',
				pinned
					// allow-any-unicode-next-line
					? localize('paradis.workspaceSwitch.unpinContext', "ピン留めを解除")
					// allow-any-unicode-next-line
					: localize('paradis.workspaceSwitch.pinContext', "ピン留め"),
				undefined,
				// 実体が消えた (missing) 行でもピンは外せるようにする。外せないと、リストから
				// 消すまでピン留めが残り続けてしまう
				true,
				() => this.togglePin(worktree)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.worktree.reveal',
				revealLabel(),
				undefined,
				!worktree.missing,
				() => this.commandService.executeCommand('revealFileInOS', worktree.uri)
			),
			new Action(
				'paradis.workspaceSwitch.worktree.copyPath',
				localize('paradis.workspaceSwitch.copyPath', "Copy Path"),
				undefined,
				true,
				() => this.clipboardService.writeText(worktree.uri.fsPath)
			),
			new Action(
				'paradis.workspaceSwitch.worktree.copyBranchName',
				localize('paradis.workspaceSwitch.copyBranchName', "Copy Branch Name"),
				undefined,
				!!worktree.branch,
				() => this.clipboardService.writeText(worktree.branch ?? '')
			)
		];

		// main checkout (リポジトリ本体) は並び替え・削除の対象外。常に先頭固定で、
		// 削除相当の操作はリポジトリ行側の「Remove from List」で行う
		if (worktree.isMainCheckout) {
			return actions;
		}

		const { siblings, index } = this.worktreeSiblingIndex(worktree);
		actions.push(
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.worktree.rename',
				localize('paradis.workspaceSwitch.worktreeRenameContext', "Rename..."),
				undefined,
				!worktree.missing,
				() => this.promptRenameWorktree(worktree)
			)
		);

		// 折りたたみ中の控え行から並び替えても、動いた結果はリポジトリを開くまで見えない。
		// 何も起きていないように見えるので、控え行では並び替えを出さない
		if (!isPinnedKeep(worktree)) {
			actions.push(
				new Separator(),
				new Action(
					'paradis.workspaceSwitch.worktree.moveUp',
					localize('paradis.workspaceSwitch.moveUp', "Move Up"),
					undefined,
					index > 0,
					() => this.moveWorktree(worktree, -1)
				),
				new Action(
					'paradis.workspaceSwitch.worktree.moveDown',
					localize('paradis.workspaceSwitch.moveDown', "Move Down"),
					undefined,
					index >= 0 && index < siblings.length - 1,
					() => this.moveWorktree(worktree, 1)
				)
			);
		}

		if (worktree.missing) {
			actions.push(
				new Separator(),
				new Action(
					'paradis.workspaceSwitch.worktree.removeFromList',
					localize('paradis.workspaceSwitch.removeContext', "Remove from List"),
					undefined,
					true,
					async () => this.worktreeService.removeKnownWorktree(worktree)
				)
			);
		} else {
			actions.push(
				new Separator(),
				new Action(
					'paradis.workspaceSwitch.worktree.remove',
					// allow-any-unicode-next-line
					localize('paradis.workspaceSwitch.worktreeRemoveContext', "ワークツリーを削除"),
					undefined,
					true,
					// コマンド実体は electron-browser 層 (paradisCreateWorktree.contribution.ts)。
					// browser 層のこのビューからは ID 経由で呼ぶ (web ビルドでは未登録のため no-op)
					() => this.commandService.executeCommand('paradis.workspaceSwitch.removeWorktree', worktree)
				)
			);
		}

		return actions;
	}

	/**
	 * 色選択 QuickPick。スウォッチ (色見本) は SVG の data URI を iconPath として渡して描画する
	 * (QuickPick は HTML 描画なので macOS でも確実に色が見える)。
	 */
	private async promptColor(repository: IParadisWorkspaceRepository): Promise<void> {
		type ColorPickItem = IQuickPickItem & { readonly colorId: string | undefined };
		const swatchIcon = (hex: string): { dark: URI } => {
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5" fill="${hex}"/></svg>`;
			return { dark: URI.parse(`data:image/svg+xml;base64,${btoa(svg)}`) };
		};
		const items: ColorPickItem[] = PARADIS_WORKSPACE_COLORS.map(color => ({
			colorId: color.id,
			label: colorLabel(color.id),
			iconPath: swatchIcon(color.hex),
			description: repository.color === color.id ? localize('paradis.workspaceSwitch.colorCurrent', "current") : undefined
		}));
		items.push({
			colorId: undefined,
			label: localize('paradis.workspaceSwitch.colorDefault', "Default"),
			iconClass: ThemeIcon.asClassName(Codicon.circleSlash),
			description: repository.color === undefined ? localize('paradis.workspaceSwitch.colorCurrent', "current") : undefined
		});

		const picked = await this.quickInputService.pick(items, {
			placeHolder: localize('paradis.workspaceSwitch.setColorPlaceholder', "Select a color for '{0}'", repository.name),
			activeItem: items.find(item => item.colorId === repository.color)
		});
		if (picked) {
			await this.workspaceSwitchService.setRepositoryColor(repository.id, picked.colorId);
		}
	}

	private async promptRename(repository: IParadisWorkspaceRepository): Promise<void> {
		const name = await this.quickInputService.input({
			value: repository.name,
			valueSelection: [0, repository.name.length],
			prompt: localize('paradis.workspaceSwitch.renamePrompt', "Enter a new name for this repository"),
			validateInput: async value => value.trim()
				? undefined
				: localize('paradis.workspaceSwitch.renameEmpty', "Name cannot be empty")
		});
		if (name !== undefined && name.trim()) {
			await this.workspaceSwitchService.renameRepository(repository.id, name.trim());
		}
	}

	/**
	 * worktree の表示名を変更する。専用の rename API は用意せず、既存の
	 * addKnownWorktree (同一 path があれば name を上書きする実装) をそのまま使う
	 * (paradisWorktreeService.ts 参照)。main checkout (isMainCheckout) はこの
	 * 台帳の管理外の合成エントリのため対象外 (呼び出し元でメニュー自体を出さない)。
	 */
	private async promptRenameWorktree(worktree: IParadisWorktree): Promise<void> {
		const name = await this.quickInputService.input({
			value: worktree.name,
			valueSelection: [0, worktree.name.length],
			prompt: localize('paradis.workspaceSwitch.worktreeRenamePrompt', "Enter a new name for this worktree"),
			validateInput: async value => value.trim()
				? undefined
				: localize('paradis.workspaceSwitch.renameEmpty', "Name cannot be empty")
		});
		if (name !== undefined && name.trim()) {
			this.worktreeService.addKnownWorktree({ ...worktree, name: name.trim() });
		}
	}
}
