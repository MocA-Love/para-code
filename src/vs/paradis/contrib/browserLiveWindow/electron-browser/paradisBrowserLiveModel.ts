/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { GroupsOrder, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IParadisAgentBrowserBindingModel, ParadisPaneAgentKind } from '../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import {
	IParadisBrowserScopeService,
	IParadisSpaceInfo,
	IParadisWorkspaceSwitchService,
	IParadisWorktreeService,
	paradisResolveSpaceInfo,
	paradisSpaceInfoLabel,
} from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisBrowserLiveEntry, IParadisBrowserLiveSummary, paradisBrowserLiveInActiveSpace, paradisSummarizeBrowserLiveEntries } from '../common/paradisBrowserLiveWindow.js';

/** 変化の検出を挟むための待ち時間 (ms)。連続する変更をまとめて1回の再計算にする。 */
const RECOMPUTE_DELAY = 80;

function agentLabel(kind: ParadisPaneAgentKind): string {
	switch (kind) {
		case 'claude':
			return 'Claude';
		case 'codex':
			return 'Codex';
		case 'shell':
		default:
			// allow-any-unicode-next-line
			return localize('paradis.browserLive.agent.shell', "ターミナル");
	}
}

/**
 * ブラウザ一覧に出すエントリの供給元。
 *
 * 材料は3つ。
 * - いまのスペースで開いている内蔵ブラウザ …… {@link IBrowserViewWorkbenchService}
 * - 各ページの状態 (タイトル・URL・favicon・読み込み中・表示中か) …… ビューのモデル
 * - どのページをどのエージェントが共有しているか …… {@link IParadisAgentBrowserBindingModel}
 *
 * ウィンドウを開いていない間もタイトルバーのバッジのために動き続けるので、集計は
 * イベント駆動 + 署名比較にして、変化がないときは何も通知しない。
 */
export class ParadisBrowserLiveModel extends Disposable {

	private readonly _onDidChangeEntries = this._register(new Emitter<void>());
	readonly onDidChangeEntries = this._onDidChangeEntries.event;

	/** viewId ごとの購読 (入力とモデルの変化)。ビューの増減に合わせて張り替える。 */
	private readonly viewSubscriptions = this._register(new DisposableMap<string, DisposableStore>());
	private readonly recomputeScheduler: RunOnceScheduler;

	private _entries: readonly IParadisBrowserLiveEntry[] = [];
	private signature = '';

	constructor(
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IParadisAgentBrowserBindingModel private readonly bindingModel: IParadisAgentBrowserBindingModel,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IHostService private readonly hostService: IHostService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisBrowserScopeService private readonly browserScopeService: IParadisBrowserScopeService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();

		this.recomputeScheduler = this._register(new RunOnceScheduler(() => this.recompute(), RECOMPUTE_DELAY));

		this._register(this.browserViewWorkbenchService.onDidChangeBrowserViews(() => this.onSourcesChanged()));
		// タブの並び替え・開閉はエントリの順序に効く。エディタ側の変化はまとめてここで拾う。
		this._register(this.editorService.onDidEditorsChange(() => this.onSourcesChanged()));
		this._register(this.bindingModel.onDidChange(() => this.schedule()));
		// スペース切り替えが終わったら組み直す。切り替え中は下の recompute() が見送るため、
		// 完了の合図が無いと空のまま止まりうる。
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this.onSourcesChanged()));
		// スペースの追加・色替え・worktree の増減で見出しの表示が変わる。
		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => this.schedule()));
		// ページのスコープが確定・変更されたら、どのスペースの下に置くかが変わる。
		this._register(this.browserScopeService.onDidChangeStableScope(() => this.schedule()));

		this.onSourcesChanged();
	}

	get entries(): readonly IParadisBrowserLiveEntry[] {
		return this._entries;
	}

	get summary(): IParadisBrowserLiveSummary {
		return paradisSummarizeBrowserLiveEntries(this._entries);
	}

	/** サムネ取得のために、そのビューのモデルを引く。まだ解決されていなければ undefined。 */
	getViewModel(viewId: string): IBrowserViewModel | undefined {
		return this.inputs().get(viewId)?.model;
	}

	/**
	 * 一覧に載せるブラウザビュー。
	 *
	 * ここは「知っているビュー」を使う —— 一覧はスペースをまたいで全部を見せるため。
	 * スペースを切り替えても他スペースの BrowserEditorInput は破棄されない
	 * (paradisBrowserScope が切り替え中の dispose を veto する) ので、この台帳には
	 * 他スペースのページも残っている。どのスペースのものかは resolveScope で解決し、
	 * エントリの stateKey / inActiveSpace として持たせる。
	 *
	 * 「今のスペースのページだけ」を返すのは contextual 側 (getContextualBrowserViews) だが、
	 * それだと他スペースのページが一切見えなくなるのでここでは使わない。代わりに、
	 * 他スペースのページに対する操作は個別に制限する (閉じるは許さず、開くときは先に
	 * そのスペースへ切り替える)。
	 */
	private inputs(): Map<string, BrowserEditorInput> {
		return this.browserViewWorkbenchService.getKnownBrowserViews();
	}

	/**
	 * そのブラウザのタブを前面に出す。
	 *
	 * 別スペースのページは、先にそのスペースへ切り替えないとエディタが復元されていない。
	 * 切り替えの判断にはエントリが持つ確定済みの状態キーを使う —— 生の resolveScope は
	 * 切り替え中に常に 'pending' を返すので、それを見ると「切り替えずに他スペースのページを
	 * 手元のグループへ開く」経路ができる。
	 *
	 * ウィンドウを前面へ出すのはタブを開いた後 —— 先に focus するとアクティブグループが
	 * 変わる余地が残り、直後の openEditor が意図しないグループへ載りうる
	 * (agentBrowser の共有ページ復帰と同じ順序にしてある)。
	 */
	async reveal(viewId: string): Promise<void> {
		const entry = this._entries.find(item => item.viewId === viewId);
		if (!entry || !this.inputs().has(viewId)) {
			return;
		}
		// 手元かどうかは、状態キーがあるならキーの一致で見る。切り替えの途中では
		// activeStateKey が先に新しいスペースへ動く一方、エントリ側は再計算を止めているため、
		// entry.inActiveSpace だけを見ると「切り替え先のタイルを押しても何も起きない」窓ができる。
		// キーを持たない (スコープ無し・未確定の) ページだけフラグに頼る。
		const isLocal = entry.stateKey !== undefined
			? entry.stateKey === this.workspaceSwitchService.activeStateKey
			: entry.inActiveSpace;
		if (entry.stateKey !== undefined && !isLocal) {
			try {
				await this.workspaceSwitchService.switchToStateKey(entry.stateKey);
			} catch (error) {
				// worktree を消したあとのページなど、切り替え先が既に無い。手元へ引き込むより
				// 何もしない方が安全なので、理由だけ伝えて戻る。
				this.notificationService.warn(localize('paradis.browserLive.switchFailed', "このページがあるスペースへ切り替えられませんでした: {0}", toErrorMessage(error)));
				return;
			}
		} else if (!isLocal) {
			// 所属が確定していないページ。手元のスペースへ勝手に引き出さない。
			return;
		}
		// 切り替えを挟むと台帳が入れ替わりうるので、開く直前に引き直す。
		const input = this.inputs().get(viewId);
		if (!input) {
			return;
		}
		await this.editorService.openEditor(input);
		await this.hostService.focus(mainWindow);
	}

	/**
	 * そのタブを閉じる。どのグループにも載っていない (背景の) ビューでは何もしない。
	 *
	 * 別スペースのページは閉じない。そのスペースのエディタ復元とスコープ台帳に触れることに
	 * なるうえ、いま画面に無いものが黙って消えるのは取り消しようがないため
	 * (View 側でもボタンを出していないが、モデル側でも守る)。
	 */
	async close(viewId: string): Promise<void> {
		if (!this._entries.find(entry => entry.viewId === viewId)?.inActiveSpace) {
			return;
		}
		const input = this.inputs().get(viewId);
		if (!input) {
			return;
		}
		for (const group of this.editorGroupsService.groups) {
			if (group.contains(input)) {
				await group.closeEditor(input);
				return;
			}
		}
	}

	/**
	 * そのページを再読み込みする。閉じると同じく手元のスペースのページに限る —— 画面に無い
	 * ページの読み込み直しは、入力途中のフォームやエージェントが進めている操作を巻き戻す。
	 */
	async reload(viewId: string): Promise<void> {
		if (!this._entries.find(entry => entry.viewId === viewId)?.inActiveSpace) {
			return;
		}
		await this.getViewModel(viewId)?.reload();
	}

	private onSourcesChanged(): void {
		this.refreshSubscriptions();
		this.schedule();
	}

	private schedule(): void {
		if (!this.recomputeScheduler.isScheduled()) {
			this.recomputeScheduler.schedule();
		}
	}

	/**
	 * ビューごとの購読を現状に合わせる。
	 *
	 * 入力の `onDidChangeLabel` はタイトル・favicon・読み込み状態・遷移でまとめて発火する。
	 * 表示中かどうかだけはラベルに出ないので、解決済みのモデルを個別に購読する。
	 */
	private refreshSubscriptions(): void {
		const inputs = this.inputs();
		for (const [viewId] of this.viewSubscriptions) {
			if (!inputs.has(viewId)) {
				this.viewSubscriptions.deleteAndDispose(viewId);
			}
		}
		for (const [viewId, input] of inputs) {
			if (this.viewSubscriptions.get(viewId)) {
				continue;
			}
			const store = new DisposableStore();
			store.add(input.onDidChangeLabel(() => this.schedule()));
			const trackModel = (model: IBrowserViewModel) => {
				store.add(model.onDidChangeVisibility(() => this.schedule()));
				this.schedule();
			};
			store.add(input.onDidResolveModel(model => trackModel(model)));
			if (input.model) {
				trackModel(input.model);
			}
			this.viewSubscriptions.set(viewId, store);
		}
	}

	private recompute(): void {
		if (this.workspaceSwitchService.isSwitching) {
			// 切り替え中はどのページのスコープも 'pending' になる。そのまま反映すると全ページが
			// 一斉に「スペース未確定」へ化け、見出しも操作の可否も切り替えのたびに揺れる。
			// 表示は直前の状態のまま据え置き、完了時に onDidSwitchScope で組み直す。
			return;
		}
		const entries = this.collect();
		const signature = entries.map(entry => [
			entry.viewId, entry.title, entry.url, entry.favicon ?? '', entry.loading ? '1' : '0',
			entry.errorText ?? '', entry.visible ? '1' : '0', entry.agents.join(','), String(entry.order),
			entry.stateKey ?? '', entry.spaceName, entry.spaceColor ?? '', entry.inActiveSpace ? '1' : '0',
		].join('\u0000')).join('\u0001');
		if (signature === this.signature) {
			return;
		}
		this.signature = signature;
		this._entries = entries;
		this._onDidChangeEntries.fire();
	}

	private collect(): IParadisBrowserLiveEntry[] {
		const inputs = this.inputs();
		const agentsByPage = this.collectAgents();
		const activeStateKey = this.workspaceSwitchService.activeStateKey;
		const spaceCache = new Map<string, IParadisSpaceInfo | undefined>();

		// エディタで見えている順を先に決め、どのグループにも載っていないビュー (背景で
		// 作られたページ) は末尾へ回す。upstream のタブ候補一覧と同じ並べ方。
		const order = new Map<string, number>();
		for (const group of this.editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE)) {
			for (const editor of group.editors) {
				if (editor instanceof BrowserEditorInput && !order.has(editor.id)) {
					order.set(editor.id, order.size);
				}
			}
		}

		const entries: IParadisBrowserLiveEntry[] = [];
		for (const [viewId, input] of inputs) {
			const model = input.model;
			const scope = this.browserScopeService.resolveScope(viewId);
			const stateKey = scope.kind === 'managed' ? scope.stateKey : undefined;
			const space = paradisResolveSpaceInfo(stateKey, this.workspaceSwitchService.repositories, this.worktreeService, spaceCache);
			entries.push({
				viewId,
				title: model?.title ?? input.title ?? '',
				url: model?.url ?? input.url ?? '',
				favicon: model?.favicon,
				loading: model?.loading === true,
				errorText: model?.error?.errorDescription,
				visible: model?.visible === true,
				agents: agentsByPage.get(viewId) ?? [],
				order: order.get(viewId) ?? Number.MAX_SAFE_INTEGER,
				stateKey,
				spaceName: paradisSpaceInfoLabel(space),
				spaceColor: space?.color,
				inActiveSpace: paradisBrowserLiveInActiveSpace(scope, activeStateKey),
			});
		}
		entries.sort((a, b) => a.order - b.order);
		return entries;
	}

	/** pageId → 共有しているエージェントの表示名 (重複なし、ペインの並び順)。 */
	private collectAgents(): Map<string, string[]> {
		const kindByToken = new Map<string, ParadisPaneAgentKind>();
		for (const pane of this.bindingModel.getPanes()) {
			kindByToken.set(pane.token, pane.agentKind);
		}
		const result = new Map<string, string[]>();
		for (const binding of this.bindingModel.bindings) {
			const kind = kindByToken.get(binding.token);
			if (!kind) {
				continue;
			}
			const label = agentLabel(kind);
			const labels = result.get(binding.pageId);
			if (!labels) {
				result.set(binding.pageId, [label]);
			} else if (!labels.includes(label)) {
				labels.push(label);
			}
		}
		return result;
	}
}
