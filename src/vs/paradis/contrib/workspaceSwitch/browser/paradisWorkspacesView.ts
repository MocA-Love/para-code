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
import { Action, IAction, Separator, SubmenuAction } from '../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { FuzzyScore } from '../../../../base/common/filters.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { createMarkdownLink, escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../base/common/htmlContent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
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
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusStore, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, PARADIS_WORKSPACE_COLORS, paradisAggregateAgentStatus, paradisSortAgentStatuses, paradisWorkspaceColorHex, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import { IParadisSpaceNotesService, IParadisSpaceNoteSummary } from '../common/paradisSpaceNotes.js';
import { ParadisCollapsedRepositoryStateController } from './paradisCollapsedRepositoryStateController.js';
import { ParadisSpaceNotesPanel } from './paradisSpaceNotesPanel.js';
import { ParadisWorkspacesPollingController } from './paradisWorkspacesPollingLifecycle.js';
import { paradisReorderByDrop, paradisSwapAdjacent } from '../common/paradisWorkspaceTreeState.js';
import { IParadisDiffStat, IParadisPrStatus, IParadisWorktreeCreateJobSnapshot, IParadisWorktreeCreateProgressStore, ParadisPrState } from '../common/paradisWorktreeCreate.js';
import { IParadisIssueStatus, IParadisIssueStatusesResult, paradisSelectIssueLookupBatch, ParadisIssueState } from '../../../common/paradisIssueDetection.js';
import { IParadisWorktreeMetaEntry, IParadisWorktreeMetaPresence, PARADIS_DEFAULT_WORKTREE_ROW_META, PARADIS_WORKTREE_ROW_HEIGHT, PARADIS_WORKTREE_ROW_META_SETTING_ID, ParadisWorktreeMetaId, paradisCanMoveWorktreeMeta, paradisMoveWorktreeMeta, paradisNormalizeWorktreeRowMeta, paradisSetWorktreeMetaAlign, paradisSetWorktreeMetaVisible, paradisWorktreeMetaLabel, paradisWorktreeMetaOrder, paradisWorktreeMetaShown, paradisWorktreeRowHasMeta, paradisWorktreeRowHeight } from '../common/paradisWorktreeRowMeta.js';

/** browser 層は electron-browser 層のコマンドIDを直接 import できないため、既存の
 * createWorktree/removeWorktree コマンドと同様に ID 文字列を直書きする (web ビルドでは
 * 未登録 = executeCommand が undefined を返すだけで安全に無効化される)。 */
const GET_DIFF_STATS_COMMAND_ID = 'paradis.workspaceSwitch.getDiffStats';
const GET_PR_STATUSES_COMMAND_ID = 'paradis.workspaceSwitch.getPrStatuses';
const GET_ISSUE_STATUSES_COMMAND_ID = 'paradis.workspaceSwitch.getIssueStatuses';
/**
 * 1回のポーリングで解決を試みる Issue の上限 — **全 worktree 合計**であって worktree ごとではない。
 * paradisWorktreeGitChannel.ts の PARADIS_ISSUE_STATUS_LOOKUPS_PER_CALL と値を揃えること。
 *
 * worktree ごとにこの件数を割り当てると、サーバー側 (ParadisGetIssueStatusesAction) が
 * ホスト単位で複数 worktree ぶんの URL を1回の gh 呼び出しへ集約してから同じ上限で丸めるため、
 * 分母が「worktreeごと」と「ホスト全体」でズレる。3スペースが4件ずつ (合計12件) のような
 * ごく普通の構成でも、先行 worktree が予算を食い切って後続 worktree の URL が一度もサーバーへ
 * 送られない状態が固定化し、hasUnresolvedIssueUrls() が恒久的に真を返し続けて即時ポーリングが
 * 無限に再発火する不具合が実際にあった。paradisSelectIssueLookupBatch で全 target 横断の
 * 合計としてこの上限を適用すること。
 */
const ISSUE_STATUS_LOOKUPS_PER_CALL = 8;

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
		// allow-any-unicode-next-line
		? localize('paradis.workspaceSwitch.revealWindows', "エクスプローラーで表示")
		: isMacintosh
			// allow-any-unicode-next-line
			? localize('paradis.workspaceSwitch.revealMac', "Finder で表示")
			// allow-any-unicode-next-line
			: localize('paradis.workspaceSwitch.revealLinux', "含むフォルダーを開く");
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

/** 位相合わせの対象にする keyframes 名 (paradisWorkspaceSwitch.css と対応)。 */
const PARADIS_STATUS_BLINK_ANIMATIONS = new Set(['paradis-status-breathe', 'paradis-status-pulse']);

/** animationName → 周期(ms)。CSS の duration を唯一の情報源にするための読み取りキャッシュ。 */
const paradisStatusBlinkPeriods = new Map<string, number>();

/**
 * 明滅の位相を、いつ生えた要素でも揃える。
 *
 * CSS アニメーションは「そのアニメーションが開始した瞬間」を起点に走るため、素直に書くと
 * ドットが生えた時刻・状態が変わった時刻・行がスクロールで DOM を出入りした時刻の差が
 * そのまま位相差になり、同じ「動作中」でも濃い橙と薄い黄に割れて見える。開始時点の位相ぶんを
 * 負の delay として与えると、どの時刻に始まった要素も共有の時計上の同じ位相から走り出す。
 *
 * **`animationstart` で呼ぶこと。** 開始時刻は後から動く: 要素が DOM から外れる (リストの行の
 * 使い回し)、`display: none` になる (ドット列やサマリの `.hidden`、ビュー自体の非表示) と
 * アニメーションは cancel され、復帰時に「その時刻」から新規に開始する。このとき状態クラスは
 * 変わらないので、クラス変更を起点にすると貼り直せず、古い delay が残って位相がずれる。
 * 開始のたびに必ず1回発火するこのイベントなら、その全経路を取りこぼさない。
 *
 * delay は常に負なので現在時刻が待機フェーズへ戻ることはなく、貼り直しで再発火もしない。
 */
function syncStatusBlinkPhase(element: HTMLElement, animationName: string): void {
	if (!PARADIS_STATUS_BLINK_ANIMATIONS.has(animationName)) {
		return;
	}
	let periodMs = paradisStatusBlinkPeriods.get(animationName);
	if (periodMs === undefined) {
		// 周期は CSS 側だけが決める (ここで定数を持つと duration との二重管理になる)。
		const seconds = parseFloat(DOM.getWindow(element).getComputedStyle(element).animationDuration);
		if (!isFinite(seconds) || seconds <= 0) {
			return;
		}
		periodMs = Math.round(seconds * 1000);
		paradisStatusBlinkPeriods.set(animationName, periodMs);
	}
	// アニメーションの時計は document ごと (補助ウィンドウは別の time origin を持つ) なので、
	// その document のタイムラインで測る。
	const timelineTime = element.ownerDocument.timeline.currentTime;
	if (typeof timelineTime !== 'number') {
		return;
	}
	element.style.animationDelay = `${-Math.round(timelineTime % periodMs)}ms`;
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
	 * 案E のメタ専用段。PR・Issue・差分・メモをユーザー設定の順序で並べ、left 寄せの
	 * ものを spacer の前、right 寄せのものを spacer の後ろへ置く。表示対象の情報を
	 * 1つも持たない行ではこの段ごと隠れ、行は従来どおりの2段 (44px) に戻る。
	 */
	readonly meta: HTMLElement;
	readonly metaSpacer: HTMLElement;
	/** メタ段に並べる要素の実体。並べ替えは要素を作り直さず、この対応表から順に append し直す */
	readonly metaElements: ReadonlyMap<ParadisWorktreeMetaId, HTMLElement>;
	/**
	 * エージェント1体につき1つのドット。1段目 (名前の右) に置き、幅を食う情報とは
	 * 場所を奪い合わせない。要素を作り直すと明滅アニメが巻き戻るため使い回す。
	 */
	readonly dots: HTMLElement;
	readonly dotsHover: IManagedHover;
	readonly pr: HTMLElement;
	readonly prIcon: HTMLElement;
	readonly prNumber: HTMLElement;
	readonly prHover: IManagedHover;
	/** クリックリスナーが renderElement 後の最新 PR URL を参照するためのホルダー */
	readonly prContext: { url?: string };
	/**
	 * そのスペースのペインでエージェントが対話から検出した GitHub Issue のマーク。ペインが
	 * 生きている限り（一時的にアイドルでも）出る。PR と違い個々の番号は出さず、アイコン＋
	 * 検出件数のみ（.paradis-worktree-note と同じ語彙）。ホバーまたはクリックで一覧を出す。
	 */
	readonly issue: HTMLElement;
	readonly issueCount: HTMLElement;
	readonly issueHover: IManagedHover;
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

function issueStateLabel(state: ParadisIssueState): string {
	switch (state) {
		case 'closed': return localize('paradis.issue.closed', "Closed");
		default: return localize('paradis.issue.open', "Open");
	}
}

/**
 * Issueマーク用の低遅延ホバーdelegate。既存の共有 'mouse' delegate (getDefaultHoverDelegate)
 * の showHover をそのまま使い、delay だけ固定の短い値へ差し替える。呼び出しごとに new する
 * だけで dispose 不要 (中身は使い回しの共有インスタンスへの薄いラッパーのため)。
 */
function lowDelayHoverDelegate(): IHoverDelegate {
	const base = getDefaultHoverDelegate('mouse');
	return {
		showHover: (options, focus) => base.showHover(options, focus),
		placement: base.placement,
		delay: 200,
	};
}

/**
 * Issueマークのホバー内容。番号をクリック可能なリンクにする (createMarkdownLink)。まだ
 * gh 解決が終わっていない URL はタイトル抜きで番号だけの行になる。ネイティブホバー
 * (title属性、markdown非対応) 用に同じ内容のプレーンテキスト版も一緒に組み立てる。
 */
function issueHoverContent(issueUrls: readonly string[], getIssueStatus: (url: string) => IParadisIssueStatus | undefined): { markdown: MarkdownString; markdownNotSupportedFallback: string } {
	// allow-any-unicode-next-line
	const header = localize('paradis.issue.hoverHeader', "検出されたIssue · {0}件", issueUrls.length);
	const markdownLines = [`**${escapeMarkdownSyntaxTokens(header)}**`, ''];
	const plainLines = [header];
	for (const url of issueUrls) {
		const status = getIssueStatus(url);
		if (status === undefined) {
			markdownLines.push(`- ${createMarkdownLink('#…', url)}`);
			plainLines.push('#…');
			continue;
		}
		const label = `${issueStateLabel(status.state)} — ${status.title}`;
		markdownLines.push(`- ${createMarkdownLink(`#${status.number}`, url)} ${escapeMarkdownSyntaxTokens(label)}`);
		plainLines.push(`#${status.number} ${label}`);
	}
	return {
		markdown: new MarkdownString(markdownLines.join('\n'), { supportThemeIcons: false, isTrusted: false }),
		markdownNotSupportedFallback: plainLines.join('\n'),
	};
}

function prStateLabel(state: ParadisPrState): string {
	switch (state) {
		case 'merged': return localize('paradis.pr.merged', "Merged");
		case 'closed': return localize('paradis.pr.closed', "Closed");
		case 'draft': return localize('paradis.pr.draft', "Draft");
		default: return localize('paradis.pr.open', "Open");
	}
}

/** メタを1つも持たない行の presence (毎回オブジェクトを作らないよう共有する)。 */
const PARADIS_NO_WORKTREE_META: IParadisWorktreeMetaPresence = Object.freeze({ pr: false, issues: false, diff: false, notes: false });

class WorkspaceTreeDelegate implements IListVirtualDelegate<WorkspaceTreeElement> {

	/**
	 * 案E (メタ専用段): worktree 行は「名前 + ドット列」「ブランチ名」の2段が基本で、
	 * 表示対象のメタ情報 (PR / Issue / 差分 / メモ) を1つでも持つ行だけ3段目が生えて高くなる。
	 * ListView は行の高さをここでしか決められないため、可変高の入口はこの1箇所に集約する。
	 */
	constructor(private readonly getWorktreeHeight: (worktree: IParadisWorktree) => number) { }

	getHeight(element: WorkspaceTreeElement): number {
		// リポジトリ行は純粋なグルーピング見出し (main checkout も worktree 行として
		// 子要素に含まれる)。worktree 行・作成中行は名前の下に2段目を重ねる表示のため高くする
		if (isWorktree(element)) {
			return this.getWorktreeHeight(element);
		}
		return isCreating(element) ? PARADIS_WORKTREE_ROW_HEIGHT : 30;
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
		/** そのスペースのペインでエージェントが対話から検出した Issue URL (未検出なら空配列)。 */
		private readonly getIssueUrls: (worktree: IParadisWorktree) => readonly string[],
		private readonly getIssueStatus: (url: string) => IParadisIssueStatus | undefined,
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
		/** そのスペースへの切り替えが進行中か (チェックの代わりにスピナーを出す) */
		private readonly isSwitchTarget: (worktree: IParadisWorktree) => boolean,
		/** メタ段の表示/並び順/寄せの現在設定 (paradis.workspaceSwitch.rowMeta) */
		private readonly getMetaEntries: () => readonly IParadisWorktreeMetaEntry[],
		/**
		 * その行が実際にどのメタ情報を持っているか。行の高さを決める WorkspaceTreeDelegate と
		 * **同じ Map** を読む。既定値を持たせない (片方だけ渡した実装が高さと中身を食い違わせ、
		 * 3段の中身が2段の高さに押し込まれる形で静かに壊れるため)。
		 */
		private readonly getMetaPresence: (worktree: IParadisWorktree) => IParadisWorktreeMetaPresence,
	) { }

	/**
	 * メタ段の子要素を設定どおりの並びへ揃える。要素は作り直さず append で移動するだけ
	 * (使い回しの原則)。順序が既に一致していれば DOM には触らない。
	 */
	private applyMetaOrder(templateData: IWorktreeTemplateData, entries: readonly IParadisWorktreeMetaEntry[]): void {
		const { left, right } = paradisWorktreeMetaOrder(entries);
		const desired: HTMLElement[] = [
			...left.map(id => templateData.metaElements.get(id)!),
			templateData.metaSpacer,
			...right.map(id => templateData.metaElements.get(id)!),
		];
		const current = templateData.meta.children;
		if (desired.length === current.length && desired.every((element, index) => current.item(index) === element)) {
			return;
		}
		// replaceChildren は既にある要素をそのまま使い回す (再マウントしない) ので、
		// チップのホバーや状態は保たれる。append の繰り返しと違い、desired に無い子が
		// 置き去りにならない点も明示的
		templateData.meta.replaceChildren(...desired);
	}

	renderTemplate(container: HTMLElement): IWorktreeTemplateData {
		const templateDisposables = new DisposableStore();
		const row = DOM.append(container, DOM.$('.paradis-worktree-row'));
		const icon = DOM.append(row, DOM.$('.codicon'));
		// 案E: 1段目 = 名前 + エージェントのドット列、2段目 = ブランチ名 (行幅をいっぱいに使える)、
		// 3段目 = メタ段 (表示対象の情報を持つ行にだけ生える)
		const body = DOM.append(row, DOM.$('.paradis-worktree-body'));
		const line1 = DOM.append(body, DOM.$('.paradis-worktree-line1'));
		const name = DOM.append(line1, DOM.$('.paradis-worktree-name'));
		const line2 = DOM.append(body, DOM.$('.paradis-worktree-line2'));
		const branch = DOM.append(line2, DOM.$('.paradis-worktree-branch'));
		const meta = DOM.append(body, DOM.$('.paradis-worktree-meta'));
		const metaSpacer = DOM.append(meta, DOM.$('.paradis-worktree-meta-spacer'));
		// スコープ内のエージェント1体につき1つのドット (集約アイコンでは消えてしまう内訳を出す)
		const dots = DOM.append(line1, DOM.$('.paradis-worktree-dots'));
		const dotsHover = templateDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), dots, ''));
		// ブランチに紐づく GitHub PR のチップ (Superset の WorkspaceStatusBadge 相当)。
		// クリックは行の切り替えではなく PR ページを開くため、リスト側のハンドラへ届く前に止める
		const pr = DOM.append(meta, DOM.$('.paradis-worktree-pr'));
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
		// 検出済み Issue のマーク。PR チップのすぐ隣 (同じ下段) に置く。番号は持たず、
		// アイコン＋件数のみ（メモ件数バッジと同じ語彙）。行の切り替えには繋げず、
		// クリックでホバーカードを即時表示する (ホバー待ちが長いというフィードバックへの対応。
		// 複数件を束ねているため、開くリンクの選択はホバー内の各番号で行う)。
		const issue = DOM.append(meta, DOM.$('.paradis-worktree-issue'));
		issue.setAttribute('role', 'button');
		const issueIcon = DOM.append(issue, DOM.$('.codicon'));
		issueIcon.className = `codicon ${ThemeIcon.asClassName(Codicon.issueOpened).replace('codicon ', '')}`;
		const issueCount = DOM.append(issue, DOM.$('span.paradis-worktree-issue-count'));
		// 通常のホバー遅延 (workbench.hover.delay、macOS既定で1500ms) だと「検出されているのか
		// 反応が無いのか」が分かりにくいというフィードバックがあったため、他の行内ホバー
		// (dots/pr/note/pin) とは別に短い固定遅延にする。createInstantHoverDelegate() は
		// 「直前のホバーが隠れてから200ms以内」だけ delay=0 になる仕組みで、単発の初回ホバーには
		// 効かないため使わない (lowDelayHoverDelegate 参照)。
		const issueHover = templateDisposables.add(this.hoverService.setupManagedHover(lowDelayHoverDelegate(), issue, ''));
		templateDisposables.add(DOM.addDisposableListener(issue, DOM.EventType.CLICK, event => {
			DOM.EventHelper.stop(event, true);
			issueHover.show(true);
		}));
		// メモの未完了件数。行の情報量を増やしすぎないよう、未完了が1件以上あるときだけ出す
		const note = DOM.append(meta, DOM.$('.paradis-worktree-note'));
		const noteIcon = DOM.append(note, DOM.$('.codicon'));
		noteIcon.className = `codicon ${ThemeIcon.asClassName(Codicon.checklist).replace('codicon ', '')}`;
		const noteCount = DOM.append(note, DOM.$('span.paradis-worktree-note-count'));
		const noteHover = templateDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), note, ''));
		const diff = DOM.append(meta, DOM.$('.paradis-worktree-diff'));
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
		return { row, icon, name, branch, meta, metaSpacer, metaElements: new Map<ParadisWorktreeMetaId, HTMLElement>([['pr', pr], ['issues', issue], ['diff', diff], ['notes', note]]), dots, dotsHover, pr, prIcon, prNumber, prHover, prContext, issue, issueCount, issueHover, note, noteCount, noteHover, diff, diffAdded, diffRemoved, pin, pinIcon, pinHover, pinContext, templateDisposables };
	}

	renderElement(node: ITreeNode<IParadisWorktree, FuzzyScore>, _index: number, templateData: IWorktreeTemplateData): void {
		const worktree = node.element;
		const active = this.isActive(worktree);
		// 案E のメタ段。並びは設定 (rowMeta) が、出す/出さないは「設定で表示 かつ その行が実際に持っている」
		// の両方が揃ったときだけ。1つも残らなければ段ごと隠れ、行は2段 (44px) に戻る
		// (高さ側の判定は WorkspaceTreeDelegate.getHeight が同じ getMetaPresence で行う)
		const metaEntries = this.getMetaEntries();
		const metaPresence = worktree.missing ? { pr: false, issues: false, diff: false, notes: false } : this.getMetaPresence(worktree);
		this.applyMetaOrder(templateData, metaEntries);
		templateData.meta.classList.toggle('hidden', !paradisWorktreeRowHasMeta(metaEntries, metaPresence));
		// この行への切り替えが進行中。チェックはもう付いている (active) が、まだ着いていないことを
		// 同時に伝える必要があるので、アイコンだけスピナーに差し替える
		const switching = !worktree.missing && this.isSwitchTarget(worktree);
		// 作成直後で setup 等がまだ走っている間は、エージェント状態の有無に関わらず稼働中として見せる
		const pendingStage = worktree.missing ? undefined : this.getPendingStage(worktree);
		// 作成中は実際のエージェント状態がまだ無いので、1体が動いている扱いで見せる
		const breakdown: readonly ParadisAgentStatus[] = worktree.missing ? []
			: pendingStage !== undefined ? ['working']
				: this.getBreakdown(worktreeStateKeyFor(worktree));
		const status = paradisAggregateAgentStatus(breakdown);
		const fallback = worktree.missing ? Codicon.warning : active ? Codicon.check : worktree.isMainCheckout ? Codicon.repo : Codicon.gitBranch;
		// 切り替え中だけは回転を許す。常時動くエージェント状態と違って、ユーザーが今起こした
		// 一過性の待ちであり、同時に回るのも1行だけなので、明滅より「まだ待ち」が伝わる
		// (回転を避けている理由は applyStatusIcon のコメント参照)。エージェント状態のドットに
		// 上書きされないよう、この間は status を渡さない
		applyStatusIcon(templateData.icon, switching ? undefined : status, switching ? Codicon.loading : fallback);
		templateData.icon.classList.toggle('codicon-modifier-spin', switching);
		renderStatusDots(templateData.dots, breakdown);
		const dotsTooltip = agentStatusSummaryTooltip(breakdown);
		templateData.dotsHover.update(dotsTooltip);
		// ドットは色と明滅だけで状態を表すので、支援技術向けに同じ内容を文字でも持たせる
		templateData.dots.ariaLabel = dotsTooltip;
		templateData.name.textContent = worktree.name;
		// 2段目は「今この行に起きていること」の欄。切り替えは作成の工程より前に出す
		// (ユーザーが今起こした操作なので、待たされている理由として先に読まれるべき)
		const rowStage = switching
			// allow-any-unicode-next-line
			? localize('paradis.workspaceSwitch.switchingStage', "切り替えています…")
			: pendingStage;
		templateData.branch.textContent = worktree.missing
			? localize('paradis.workspaceSwitch.worktreeMissing', "missing")
			: rowStage ?? worktree.branch ?? '';
		templateData.branch.classList.toggle('paradis-creating-stage', rowStage !== undefined);
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
		templateData.diff.classList.toggle('hidden', !paradisWorktreeMetaShown(metaEntries, metaPresence, 'diff'));
		if (hasDiff && diffStat) {
			templateData.diffAdded.textContent = diffStat.insertions > 0 ? `+${diffStat.insertions}` : '';
			templateData.diffRemoved.textContent = diffStat.deletions > 0 ? `-${diffStat.deletions}` : '';
		} else {
			// テンプレートは使い回されるので、消さないと前にこの枠を使っていた行の増減が残る
			// (メモ・PR と同じ後始末)。
			templateData.diffAdded.textContent = '';
			templateData.diffRemoved.textContent = '';
		}

		const noteSummary = worktree.missing ? undefined : this.getNoteSummary(worktree);
		const hasOpenTasks = !!noteSummary && noteSummary.open > 0;
		templateData.note.classList.toggle('hidden', !paradisWorktreeMetaShown(metaEntries, metaPresence, 'notes'));
		if (hasOpenTasks && noteSummary) {
			templateData.noteCount.textContent = String(noteSummary.open);
			// allow-any-unicode-next-line
			templateData.noteHover.update(localize('paradis.spaceNotes.badgeTooltip', "メモ: 未完了 {0} 件 / 全 {1} 件", noteSummary.open, noteSummary.open + noteSummary.done));
		} else {
			templateData.noteCount.textContent = '';
			templateData.noteHover.update('');
		}

		const prStatus = worktree.missing ? undefined : this.getPrStatus(worktree);
		templateData.pr.classList.toggle('hidden', !paradisWorktreeMetaShown(metaEntries, metaPresence, 'pr'));
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

		// Issueマーク: そのスペースにペイン(生存中、一時的なアイドルも含む)があるときだけ出す。
		// 件数の変化がなくても getIssueUrls は毎回配列を作るため、空配列との比較で
		// hidden の付け外しだけ行う。
		const issueUrls = worktree.missing ? [] : this.getIssueUrls(worktree);
		templateData.issue.classList.toggle('hidden', !paradisWorktreeMetaShown(metaEntries, metaPresence, 'issues'));
		if (issueUrls.length > 0) {
			templateData.issueCount.textContent = String(issueUrls.length);
			const content = issueHoverContent(issueUrls, this.getIssueStatus);
			templateData.issueHover.update(content);
			// マークはアイコン＋件数のみで文字情報が乏しいので、支援技術向けに同じ内容を
			// aria-label でも持たせる (dots.ariaLabel と同じ考え方)。
			templateData.issue.ariaLabel = content.markdownNotSupportedFallback;
		} else {
			templateData.issueCount.textContent = '';
			templateData.issueHover.update('');
			templateData.issue.ariaLabel = '';
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
	/** worktree の uri.fsPath → 現在ブランチに紐づく PR 状態。ポーリングでのみ更新する (refreshPrStatuses 参照) */
	private readonly _prStatuses = new Map<string, IParadisPrStatus>();
	/**
	 * Issue URL → 解決済みの番号・タイトル・状態。ポーリングでのみ更新する (refreshIssueStatuses 参照)。
	 * PR/差分と違い worktree のパスではなく URL をキーにする (同じ Issue を複数のスペースが
	 * 参照していても gh 呼び出しは1回で済み、解決結果もどちらの行からも同じ内容で引ける)。
	 */
	private readonly _issueStatuses = new Map<string, IParadisIssueStatus>();
	/**
	 * サーバーが実際に gh へ問い合わせ済みと確認した Issue URL（成功・失敗を問わない）。
	 * ループ防止には使わない（下の _issueLookupRequested の役目）。ここは
	 * paradisSelectIssueLookupBatch が「次にどの未解決 URL を優先して送るか」を決めるための
	 * 優先度情報としてのみ使う。
	 */
	private readonly _issueLookupAttempted = new Set<string>();
	/**
	 * クライアントが実際に送信を決めた（=リクエストへ含めた）Issue URL。hasUnresolvedIssueUrls()
	 * のループ防止判定はこちらで行う。**「試みた (_issueLookupAttempted)」ではなくこちらで
	 * 判定すること** — サーバー側 (ParadisGetIssueStatusesAction) はホスト単位で複数 worktree
	 * ぶんの URL を1回の gh 呼び出しへ集約するため、クライアントが送った URL の一部だけが
	 * 実際に gh へ問い合わせられ、残りは attempted に含まれないまま返ってくることがある。
	 * この区別を怠ると、複数スペースの合計が1回あたりの上限を超える (ごく普通の) 構成で
	 * 一部 URL が二度と送られないまま「未解決」扱いが固定化し、即時ポーリングが無限に
	 * 再発火して gh レート枠を枯渇させる (実際に再発した)。
	 */
	private readonly _issueLookupRequested = new Set<string>();
	private readonly _pollingController: ParadisWorkspacesPollingController;
	private readonly _collapsedRepositoryState: ParadisCollapsedRepositoryStateController;
	/** 折りたたみ操作の最中にツリーを組み直さないための遅延実行 (onDidChangeCollapseState 参照) */
	private readonly _updateTreeScheduler: RunOnceScheduler;
	/** ツリーのインデント1段ぶんの幅 (workbench.tree.indent に追従する) */
	private treeIndent = DEFAULT_TREE_INDENT;
	/** メタ段 (案E) の表示/並び順/寄せ。設定 paradis.workspaceSwitch.rowMeta に追従する */
	private rowMeta = PARADIS_DEFAULT_WORKTREE_ROW_META;
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

		this._pollingController = this._register(new ParadisWorkspacesPollingController(
			{
				isBodyVisible: () => this.isBodyVisible(),
				onDidChangeVisibility: this.onDidChangeBodyVisibility,
				onDidChangeRepositories: this.workspaceSwitchService.onDidChangeRepositories,
				onDidChangeWorktrees: this.worktreeService.onDidChangeWorktrees,
			},
			() => this.refreshDiffStats(),
			() => this.refreshPrStatuses(),
			undefined,
			undefined,
			() => this.refreshIssueStatuses(),
		));
		this._collapsedRepositoryState = this._register(new ParadisCollapsedRepositoryStateController(this.storageService, this.logService));
		this._updateTreeScheduler = this._register(new RunOnceScheduler(() => this.updateTree(), 0));

		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => { this.updateTree(); this.updateNotesPanelSpace(); }));
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => { this.updateTree(); this.updateNotesPanelSpace(); }));
		// 切り替えの開始・終了。チェックを行き先へ前倒しし、進行中の行にスピナーを出すため、
		// 完了 (onDidSwitchScope) を待たずにここでも描き直す
		this._register(this.workspaceSwitchService.onDidChangeSwitchState(() => this.updateTree()));
		// メモの未完了バッジは行の表示内容なので、メモが変わったらツリーを描き直す
		this._register(this.spaceNotesService.onDidChangeNotes(() => this.updateTree()));
		this._register(this.worktreeService.onDidChangeWorktrees(() => { this.updateTree(); this.updateNotesPanelSpace(); }));
		// 注意: 引数なしの tree.rerender() は行の renderElement を再実行しないため、
		// setChildren で作り直す (identityProvider により選択/折りたたみ状態は保持される)
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => {
			this.updateTree();
			// 新規に検出された (まだ番号・タイトルを解決していない) Issue があれば、通常の300秒
			// 周期を待たずに解決を前倒しする。件数バッジ自体は即座に出せるが、ホバー内容が
			// 長時間「#…」のままだと検出が効いているのか分かりにくいため。
			if (this.hasUnresolvedIssueUrls()) {
				this._pollingController.requestImmediateIssueStatusRefresh();
			}
		}));
		// バックグラウンド作成の進行状況（「作成中」行の追加・工程更新・完了時の除去）
		this._register(this.createProgressStore.onDidChangeJobs(() => this.updateTree()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// ツリーとメモ欄を縦に積む (メモ欄は下端固定、ツリーが残りを占める)
		container.classList.add('paradis-workspaces-pane-body');
		const treeContainer = DOM.append(container, DOM.$('.paradis-workspaces-list'));
		// 明滅の位相合わせ。個々のドットではなくルート1箇所で受ける (行は使い回されるので、
		// 要素ごとに張ると付け外しの管理が要る)。詳細は syncStatusBlinkPhase を参照。
		this._register(DOM.addDisposableListener(treeContainer, 'animationstart', (event: AnimationEvent) => {
			const target = event.target;
			if (DOM.isHTMLElement(target)) {
				syncStatusBlinkPhase(target, event.animationName);
			}
		}));
		// ピン留めの控え行を子行と同じ位置に見せるため、ツリーと同じインデント幅を持っておく
		// (listService が同じ設定値でツリーの indent を決めている)
		this.updateTreeIndent();
		this.updateRowMeta();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TREE_INDENT_CONFIGURATION_KEY)) {
				this.updateTreeIndent();
				this.updateTree();
			}
			// メタ段の設定は行の中身だけでなく高さも変えるため、必ずツリーを組み直す
			// (setChildren を通さないと ListView が高さを測り直さない)
			if (e.affectsConfiguration(PARADIS_WORKTREE_ROW_META_SETTING_ID)) {
				this.updateRowMeta();
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
			// 切り替えの最中は行き先を「今ここ」として見せる。activeStateKey は folders が
			// 入れ替わるまで切り替え元を指したままなので、そのまま使うと**遅い切り替えの間ずっと
			// 前のスペースにチェックが付いたまま**になり、もう切り替わったものとして操作されてしまう
			worktree => (this.workspaceSwitchService.pendingSwitchTargetKey ?? this.workspaceSwitchService.activeStateKey) === worktreeStateKeyFor(worktree),
			getBreakdown,
			worktree => this._diffStats.get(worktree.uri.fsPath),
			worktree => this._prStatuses.get(worktree.uri.fsPath),
			worktree => this.agentStatusStore.getScopeIssueUrls(worktreeStateKeyFor(worktree)),
			url => this._issueStatuses.get(url),
			worktree => this.spaceNotesService.summary(worktreeStateKeyFor(worktree)),
			repositoryId => paradisWorkspaceColorHex(this.workspaceSwitchService.repositories.find(repository => repository.id === repositoryId)?.color),
			worktree => this.pendingStageFor(worktree),
			worktree => this.worktreeService.isPinned(worktreeStateKeyFor(worktree)),
			worktree => this.togglePin(worktree),
			() => this.treeIndent,
			url => { this.openerService.open(URI.parse(url)).catch(error => this.notificationService.error(error)); },
			this.hoverService,
			worktree => this.workspaceSwitchService.pendingSwitchTargetKey === worktreeStateKeyFor(worktree),
			() => this.rowMeta,
			worktree => this.worktreeMetaPresence(worktree)
		);
		const creatingRenderer = new CreatingSpaceRenderer(
			repositoryId => paradisWorkspaceColorHex(this.workspaceSwitchService.repositories.find(repository => repository.id === repositoryId)?.color)
		);

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<WorkspaceTreeElement, FuzzyScore>,
			'ParadisWorkspaces',
			treeContainer,
			new WorkspaceTreeDelegate(worktree => paradisWorktreeRowHeight(this.rowMeta, this.worktreeMetaPresence(worktree))),
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
		// ユーザー起点の切り替えは連打を畳み込む (中間スペースを経由しない)。
		const promise = worktree.isMainCheckout
			? this.workspaceSwitchService.switchRepository(worktree.repositoryId, { coalesce: true })
			: this.workspaceSwitchService.switchToWorktree(worktree, { coalesce: true });
		promise.catch(error => this.notificationService.error(error));
	}

	/**
	 * 一覧に出ているリポジトリと作業ツリーの URI。git を動かすマシンは URI にしか書かれていない
	 * ため、パス文字列ではなく URI のまま渡す（手元と接続先に同じ絶対パスがありうる）。
	 */
	private pollTargets(): URI[] {
		const targets = new ResourceMap<URI>();
		for (const repository of this.workspaceSwitchService.repositories) {
			targets.set(repository.uri, repository.uri);
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (!worktree.missing) {
					targets.set(worktree.uri, worktree.uri);
				}
			}
		}
		return [...targets.values()];
	}

	/** diff 統計 (+N/-N) をポーリングで取得する。非表示中の実行・再スケジュールは lifecycle が抑止する。 */
	private async refreshDiffStats(): Promise<void> {
		const targets = this.pollTargets();
		if (targets.length === 0) {
			return;
		}
		const result = await this.commandService.executeCommand<Record<string, IParadisDiffStat>>(GET_DIFF_STATS_COMMAND_ID, targets);
		if (result) {
			this._diffStats.clear();
			for (const [path, stat] of Object.entries(result)) {
				this._diffStats.set(path, stat);
			}
			this.updateTree();
		}
	}

	/** 各 worktree の現在ブランチに紐づく PR 状態をポーリングで取得する。仕組みは refreshDiffStats と同じ。 */
	private async refreshPrStatuses(): Promise<void> {
		const targets = this.pollTargets();
		if (targets.length === 0) {
			return;
		}
		const result = await this.commandService.executeCommand<Record<string, IParadisPrStatus>>(GET_PR_STATUSES_COMMAND_ID, targets);
		if (result) {
			this._prStatuses.clear();
			for (const [path, status] of Object.entries(result)) {
				this._prStatuses.set(path, status);
			}
			this.updateTree();
		}
	}

	/**
	 * ペインが存在するスペースぶんだけ「そのworktree(main checkout含む)で検出済みのIssue URL」を
	 * まとめる(一時的なアイドルでは対象から外れない)。pollTargets と同じく main checkout も
	 * 対象に含める(main checkout も1つのスペースであり、
	 * そこで動くエージェントの対話からも Issue を検出するため)。
	 */
	private pollIssueTargets(): { resource: UriComponents; issueUrls: readonly string[] }[] {
		const targets: { resource: UriComponents; issueUrls: readonly string[] }[] = [];
		for (const repository of this.workspaceSwitchService.repositories) {
			// main checkout は getWorktrees() に含まれず、updateTree() が毎回合成行として描き足す
			// (WorktreeRenderer 参照)。ここでも同じ合成をしないと、main checkout での対話から
			// 検出した Issue が一覧には表示されるのに永遠に番号・タイトルへ解決されなくなる
			// (実機で確認: 表示側は worktreeStateKeyFor(合成行) を見るのに、ポーリング側は
			// getWorktrees() だけを見ていて main checkout を素通りしていた)。
			const mainCheckoutIssueUrls = this.agentStatusStore.getScopeIssueUrls(repository.id);
			if (mainCheckoutIssueUrls.length > 0) {
				targets.push({ resource: repository.uri, issueUrls: mainCheckoutIssueUrls });
			}
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (worktree.missing) {
					continue;
				}
				const issueUrls = this.agentStatusStore.getScopeIssueUrls(worktreeStateKeyFor(worktree));
				if (issueUrls.length > 0) {
					targets.push({ resource: worktree.uri, issueUrls });
				}
			}
		}
		return targets;
	}

	/**
	 * 現在の一覧に、まだ送信していない検出済み Issue URL があるか。「試みた
	 * (_issueLookupAttempted、サーバーが実際に gh を呼んだか)」ではなく「送った
	 * (_issueLookupRequested、クライアントがリクエストに含めたか)」で判定する。この違いが
	 * 重要な理由は _issueLookupRequested のコメント参照。
	 */
	private hasUnresolvedIssueUrls(): boolean {
		return this.pollIssueTargets().some(target => target.issueUrls.some(url => !this._issueLookupRequested.has(url)));
	}

	/** 検出済みの Issue URL を番号・タイトル・状態へ解決する。仕組みは refreshPrStatuses と同じ。 */
	private async refreshIssueStatuses(): Promise<void> {
		const targets = this.pollIssueTargets();
		if (targets.length === 0) {
			return;
		}
		// 全 worktree 横断で ISSUE_STATUS_LOOKUPS_PER_CALL 件までに絞ってから worktree ごとへ
		// 再分配する (worktree ごとに個別へこの件数を割り当てては絶対にいけない — 理由は
		// ISSUE_STATUS_LOOKUPS_PER_CALL のコメント参照)。まだ一度も gh へ問い合わせていない
		// URL を優先することで、会話が長引いて合計件数が上限を超えても、直近に検出した分から
		// 遅れて解決されていく。
		const requestTargets = paradisSelectIssueLookupBatch(targets, this._issueLookupAttempted, ISSUE_STATUS_LOOKUPS_PER_CALL);
		if (requestTargets.length === 0) {
			return;
		}
		// クライアントが実際に送信を決めた URL は、この後の成否やサーバー側のホスト集約・
		// 丸めの結果に関わらず、全経路で「送った」ことを記録する。ここが Critical#2 の本質的な
		// 修正: サーバー応答 (attempted) を待ってから記録すると、ホスト単位の集約で
		// 弾かれた分が「送っていないのに未送信のまま」で残り続け、即時ポーリングが無限に
		// 再発火してしまう。
		for (const target of requestTargets) {
			for (const url of target.issueUrls) {
				this._issueLookupRequested.add(url);
			}
		}
		let response: IParadisIssueStatusesResult | undefined;
		try {
			response = await this.commandService.executeCommand<IParadisIssueStatusesResult>(GET_ISSUE_STATUSES_COMMAND_ID, requestTargets);
		} catch {
			// コマンド自体が失敗した (未登録・チャネル未接続等)。上の requested マーキングだけで
			// ループ防止には十分 (attempted は優先度付けにのみ使うため、更新しなくても安全。
			// 次回ホストが復旧すれば通常の300秒周期で再試行される)。
		}
		if (response) {
			for (const url of response.attempted) {
				this._issueLookupAttempted.add(url);
			}
			// clear しない: PR/差分と違い解決に時間差がある (新規URLはgh呼び出しが終わるまで
			// 空のまま)。ここで毎回クリアすると、他worktreeの解決待ちの間に既知分の
			// タイトル・状態までホバーから一瞬消えてしまう。
			for (const [url, status] of Object.entries(response.resolved)) {
				this._issueStatuses.set(url, status);
			}
			this.updateTree();
		}
		// 参照されなくなった (エージェントが対話でもう触れていない、かつどのworktreeの
		// 検出一覧にも無い) URLは3つの台帳全部から溜め込まない
		const referenced = new Set(targets.flatMap(target => target.issueUrls));
		for (const url of this._issueStatuses.keys()) {
			if (!referenced.has(url)) {
				this._issueStatuses.delete(url);
			}
		}
		for (const url of this._issueLookupAttempted) {
			if (!referenced.has(url)) {
				this._issueLookupAttempted.delete(url);
			}
		}
		for (const url of this._issueLookupRequested) {
			if (!referenced.has(url)) {
				this._issueLookupRequested.delete(url);
			}
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
		// 高さ (delegate) と中身 (renderer) が同じ判定を読むよう、setChildren の前に作り直す。
		// **ルート要素だけを見てはいけない**: worktree 行はリポジトリ行の children にいるため、
		// ルートだけを拾うと折りたたみ中のピン留め控え行しか presence に載らず、他の全行が
		// 「メタ無し」= メタ段ごと非表示・行の高さも2段のまま、という状態で固定される。
		this.rebuildMetaPresence(elements
			.flatMap(entry => [entry.element, ...[...entry.children ?? []].map(child => child.element)])
			.filter((element): element is IParadisWorktree => isWorktree(element)));
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
	private updateRowMeta(): void {
		this.rowMeta = paradisNormalizeWorktreeRowMeta(this.configurationService.getValue(PARADIS_WORKTREE_ROW_META_SETTING_ID));
	}

	/**
	 * 描画と高さが読む presence を、setChildren の直前に1回だけ作る。
	 *
	 * 行の描画 (WorktreeRenderer) と行の高さ (WorkspaceTreeDelegate) が食い違うと、3段ぶんの
	 * 中身が2段の高さに押し込まれる。同じ関数を2回呼ぶ約束にしていると、片方だけ条件が
	 * 変わったときに黙って崩れるので、**同じ Map を両方が引く**形にして構造で担保する。
	 *
	 * ついでに、メモの件数は本文を毎回パースして求めている (キャッシュ無し)。行ごとに
	 * 2回呼ぶと、2秒ごとのエージェント状態更新でスペース数×2回のパースが定常的に走る。
	 */
	private rebuildMetaPresence(worktrees: readonly IParadisWorktree[]): void {
		this._metaPresence.clear();
		for (const worktree of worktrees) {
			this._metaPresence.set(worktreeStateKeyFor(worktree), this.computeMetaPresence(worktree));
		}
	}

	/** 作った Map を引く。まだ無い行 (作成中など) は「メタ無し」= 2段扱い。 */
	private worktreeMetaPresence(worktree: IParadisWorktree): IParadisWorktreeMetaPresence {
		return this._metaPresence.get(worktreeStateKeyFor(worktree)) ?? PARADIS_NO_WORKTREE_META;
	}

	/** 行ごとの presence。updateTree のたびに作り直し、delegate と renderer の両方が引く。 */
	private readonly _metaPresence = new Map<string, IParadisWorktreeMetaPresence>();

	private computeMetaPresence(worktree: IParadisWorktree): IParadisWorktreeMetaPresence {
		if (worktree.missing) {
			return PARADIS_NO_WORKTREE_META;
		}
		const stateKey = worktreeStateKeyFor(worktree);
		const diffStat = this._diffStats.get(worktree.uri.fsPath);
		const noteSummary = this.spaceNotesService.summary(stateKey);
		return {
			pr: this._prStatuses.has(worktree.uri.fsPath),
			issues: this.agentStatusStore.getScopeIssueUrls(stateKey).length > 0,
			diff: !!diffStat && (diffStat.insertions > 0 || diffStat.deletions > 0),
			notes: noteSummary.open > 0,
		};
	}

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

	/**
	 * 「色を設定」サブメニュー。12色 + Default を縦並びで出し、現在色にチェックを付ける。
	 * 色ドットは Action の cssClass (paradis-color-*) 経由で media/paradisWorkspaceSwitch.css が
	 * 描画する。HTML コンテキストメニュー (window.menuStyle: custom) のみ色が見える —
	 * ネイティブメニューでは以前と同様に CSS が効かないため色名のみ表示される。
	 */
	private buildColorSubmenuActions(repository: IParadisWorkspaceRepository): IAction[] {
		const colorActions = PARADIS_WORKSPACE_COLORS.map(color => {
			const action = new Action(
				`paradis.workspaceSwitch.color.${color.id}`,
				colorLabel(color.id),
				`paradis-menu-icon paradis-menu-color paradis-color-${color.id}`,
				true,
				() => this.workspaceSwitchService.setRepositoryColor(repository.id, color.id)
			);
			action.checked = repository.color === color.id;
			return action;
		});
		const defaultAction = new Action(
			'paradis.workspaceSwitch.color.default',
			localize('paradis.workspaceSwitch.colorDefault', "Default"),
			'paradis-menu-icon paradis-menu-color paradis-color-default',
			true,
			() => this.workspaceSwitchService.setRepositoryColor(repository.id, undefined)
		);
		// パレット外の colorId (削済みID等) が残っている場合は Default 側にチェックを置く
		defaultAction.checked = repository.color === undefined ||
			!PARADIS_WORKSPACE_COLORS.some(color => color.id === repository.color);
		return [...colorActions, new Separator(), defaultAction];
	}

	private buildRepositoryContextMenuActions(repository: IParadisWorkspaceRepository): IAction[] {
		const { repositories, index } = this.repositorySiblingIndex(repository);
		return [
			new Action(
				'paradis.workspaceSwitch.createWorktreeContext',
				localize('paradis.workspaceSwitch.createWorktreeContext', "New Worktree Space..."),
				'paradis-menu-icon codicon codicon-add',
				true,
				// コマンド実体は electron-browser 層 (paradisCreateWorktree.contribution.ts)。
				// browser 層のこのビューからは ID 経由で呼ぶ (web ビルドでは未登録のため no-op)
				() => this.commandService.executeCommand('paradis.workspaceSwitch.createWorktree', repository.id)
			),
			new Separator(),
			// 色選択はサブメニュー内の縦並びカラーリスト (buildColorSubmenuActions 参照)。
			// 以前は QuickPick で行っていたが、モック (案C) の通りメニュー内で完結させる形に戻した。
			// HTML メニューなら cssClass 経由で色ドットが描画できる
			new SubmenuAction(
				'paradis.workspaceSwitch.setColor',
				// allow-any-unicode-next-line
				localize('paradis.workspaceSwitch.setColorPick', "色を設定"),
				this.buildColorSubmenuActions(repository)
			),
			new Action(
				'paradis.workspaceSwitch.rename',
				// allow-any-unicode-next-line
				localize('paradis.workspaceSwitch.renameContext', "名前を変更..."),
				'paradis-menu-icon codicon codicon-edit',
				true,
				() => this.promptRename(repository)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.repository.moveUp',
				// allow-any-unicode-next-line
				localize('paradis.workspaceSwitch.moveUp', "上へ移動"),
				'paradis-menu-icon codicon codicon-arrow-up',
				index > 0,
				() => this.moveRepository(repository, -1)
			),
			new Action(
				'paradis.workspaceSwitch.repository.moveDown',
				// allow-any-unicode-next-line
				localize('paradis.workspaceSwitch.moveDown', "下へ移動"),
				'paradis-menu-icon codicon codicon-arrow-down',
				index >= 0 && index < repositories.length - 1,
				() => this.moveRepository(repository, 1)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.reveal',
				revealLabel(),
				'paradis-menu-icon codicon codicon-folder-opened',
				true,
				() => this.commandService.executeCommand('revealFileInOS', repository.uri)
			),
			new Action(
				'paradis.workspaceSwitch.copyPath',
				// allow-any-unicode-next-line
				localize('paradis.workspaceSwitch.copyPath', "パスをコピー"),
				'paradis-menu-icon codicon codicon-copy',
				true,
				() => this.clipboardService.writeText(repository.uri.fsPath)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.configureLifecycleScripts',
				localize('paradis.workspaceSwitch.configureLifecycleScriptsContext', "Setup/Teardown Scripts..."),
				'paradis-menu-icon codicon codicon-tools',
				true,
				// コマンド実体は electron-browser 層 (paradisCreateWorktree.contribution.ts)。
				// browser 層のこのビューからは ID 経由で呼ぶ (web ビルドでは未登録のため no-op)
				() => this.commandService.executeCommand('paradis.workspaceSwitch.configureLifecycleScripts', repository.id)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.removeFromList',
				// allow-any-unicode-next-line
				localize('paradis.workspaceSwitch.removeContext', "リストから削除"),
				'paradis-menu-icon codicon codicon-trash paradis-menu-danger',
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

	/**
	 * 「表示する情報」サブメニュー (案E のメタ段の設定)。上半分が各情報の表示/非表示、
	 * 下半分が情報ごとの並び順・寄せ方。VS Code のメニューは SubmenuAction にチェック状態を
	 * 持てないため、トグルは平のアクション (checked) で並べ、並び順と寄せだけを情報ごとの
	 * サブメニューへ1段下げている。既存のリポジトリ行「色を設定」と同じ作り。
	 */
	private buildRowMetaSubmenuAction(): SubmenuAction {
		const entries = this.rowMeta;
		const setEntries = (next: readonly IParadisWorktreeMetaEntry[]) =>
			this.configurationService.updateValue(PARADIS_WORKTREE_ROW_META_SETTING_ID, next);

		const toggles: IAction[] = entries.map(entry => {
			const action = new Action(
				`paradis.workspaceSwitch.rowMeta.toggle.${entry.id}`,
				paradisWorktreeMetaLabel(entry.id),
				undefined,
				true,
				() => setEntries(paradisSetWorktreeMetaVisible(entries, entry.id, !entry.visible))
			);
			action.checked = entry.visible;
			return action;
		});

		const arrangements: IAction[] = entries.map((entry, index) => {
			const left = new Action(
				`paradis.workspaceSwitch.rowMeta.align.left.${entry.id}`,
				// allow-any-unicode-next-line
				localize('paradis.workspaceSwitch.rowMeta.alignLeft', "左に寄せる"),
				undefined,
				true,
				() => setEntries(paradisSetWorktreeMetaAlign(entries, entry.id, 'left'))
			);
			left.checked = entry.align === 'left';
			const right = new Action(
				`paradis.workspaceSwitch.rowMeta.align.right.${entry.id}`,
				// allow-any-unicode-next-line
				localize('paradis.workspaceSwitch.rowMeta.alignRight', "右に寄せる"),
				undefined,
				true,
				() => setEntries(paradisSetWorktreeMetaAlign(entries, entry.id, 'right'))
			);
			right.checked = entry.align === 'right';
			return new SubmenuAction(
				`paradis.workspaceSwitch.rowMeta.arrange.${entry.id}`,
				// allow-any-unicode-next-line
				localize('paradis.workspaceSwitch.rowMeta.arrange', "{0}の並び", paradisWorktreeMetaLabel(entry.id)),
				[
					new Action(
						`paradis.workspaceSwitch.rowMeta.moveUp.${entry.id}`,
						// allow-any-unicode-next-line
						localize('paradis.workspaceSwitch.moveUp', "上へ移動"),
						'paradis-menu-icon codicon codicon-arrow-up',
						// 動かせるのは同じ寄せの中だけ。押しても見た目が変わらない状態では出さない
						paradisCanMoveWorktreeMeta(entries, entry.id, -1),
						() => setEntries(paradisMoveWorktreeMeta(entries, entry.id, -1))
					),
					new Action(
						`paradis.workspaceSwitch.rowMeta.moveDown.${entry.id}`,
						// allow-any-unicode-next-line
						localize('paradis.workspaceSwitch.moveDown', "下へ移動"),
						'paradis-menu-icon codicon codicon-arrow-down',
						paradisCanMoveWorktreeMeta(entries, entry.id, 1),
						() => setEntries(paradisMoveWorktreeMeta(entries, entry.id, 1))
					),
					new Separator(),
					left,
					right
				]
			);
		});

		return new SubmenuAction(
			'paradis.workspaceSwitch.rowMeta',
			// allow-any-unicode-next-line
			localize('paradis.workspaceSwitch.rowMetaMenu', "表示する情報"),
			[
				...toggles,
				new Separator(),
				...arrangements,
				new Separator(),
				new Action(
					'paradis.workspaceSwitch.rowMeta.reset',
					// allow-any-unicode-next-line
					localize('paradis.workspaceSwitch.rowMetaReset', "既定に戻す"),
					'paradis-menu-icon codicon codicon-discard',
					// 設定を消して既定へ戻す (すべて非表示にした状態からも必ずここで戻れる)
					true,
					() => this.configurationService.updateValue(PARADIS_WORKTREE_ROW_META_SETTING_ID, undefined)
				)
			]
		);
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
				`paradis-menu-icon ${ThemeIcon.asClassName(pinned ? Codicon.pinned : Codicon.pin)}`,
				// 実体が消えた (missing) 行でもピンは外せるようにする。外せないと、リストから
				// 消すまでピン留めが残り続けてしまう
				true,
				() => this.togglePin(worktree)
			),
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.worktree.copyBranchName',
				// allow-any-unicode-next-line
				localize('paradis.workspaceSwitch.copyBranchName', "ブランチ名をコピー"),
				'paradis-menu-icon codicon codicon-git-branch',
				!!worktree.branch,
				() => this.clipboardService.writeText(worktree.branch ?? '')
			),
			new Action(
				'paradis.workspaceSwitch.worktree.copyPath',
				// allow-any-unicode-next-line
				localize('paradis.workspaceSwitch.copyPath', "パスをコピー"),
				'paradis-menu-icon codicon codicon-copy',
				true,
				() => this.clipboardService.writeText(worktree.uri.fsPath)
			),
			new Action(
				'paradis.workspaceSwitch.worktree.reveal',
				revealLabel(),
				'paradis-menu-icon codicon codicon-folder-opened',
				!worktree.missing,
				() => this.commandService.executeCommand('revealFileInOS', worktree.uri)
			)
		];

		// main checkout (リポジトリ本体) は並び替え・削除の対象外。常に先頭固定で、
		// 削除相当の操作はリポジトリ行側の「Remove from List」で行う
		if (worktree.isMainCheckout) {
			return [...actions, new Separator(), this.buildRowMetaSubmenuAction()];
		}

		const { siblings, index } = this.worktreeSiblingIndex(worktree);
		actions.push(
			new Separator(),
			new Action(
				'paradis.workspaceSwitch.worktree.rename',
				// allow-any-unicode-next-line
				localize('paradis.workspaceSwitch.worktreeRenameContext', "名前を変更..."),
				'paradis-menu-icon codicon codicon-edit',
				!worktree.missing,
				() => this.promptRenameWorktree(worktree)
			),
			// 行の見え方の設定。取り消せない操作 (削除) より上に置く
			this.buildRowMetaSubmenuAction()
		);

		// 折りたたみ中の控え行から並び替えても、動いた結果はリポジトリを開くまで見えない。
		// 何も起きていないように見えるので、控え行では並び替えを出さない
		if (!isPinnedKeep(worktree)) {
			actions.push(
				new Separator(),
				new Action(
					'paradis.workspaceSwitch.worktree.moveUp',
					// allow-any-unicode-next-line
					localize('paradis.workspaceSwitch.moveUp', "上へ移動"),
					'paradis-menu-icon codicon codicon-arrow-up',
					index > 0,
					() => this.moveWorktree(worktree, -1)
				),
				new Action(
					'paradis.workspaceSwitch.worktree.moveDown',
					// allow-any-unicode-next-line
					localize('paradis.workspaceSwitch.moveDown', "下へ移動"),
					'paradis-menu-icon codicon codicon-arrow-down',
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
					// allow-any-unicode-next-line
					localize('paradis.workspaceSwitch.removeContext', "リストから削除"),
					'paradis-menu-icon codicon codicon-trash paradis-menu-danger',
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
					'paradis-menu-icon codicon codicon-trash paradis-menu-danger',
					true,
					// コマンド実体は electron-browser 層 (paradisCreateWorktree.contribution.ts)。
					// browser 層のこのビューからは ID 経由で呼ぶ (web ビルドでは未登録のため no-op)
					() => this.commandService.executeCommand('paradis.workspaceSwitch.removeWorktree', worktree)
				)
			);
		}

		return actions;
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
