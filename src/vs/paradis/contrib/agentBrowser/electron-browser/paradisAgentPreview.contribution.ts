/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// MCPの `preview_file` ツールの受け口。shared process の ParadisAgentBrowserService が
// 「呼び出し元ペインを所有するウィンドウ」だけへctxフィルタでルーティングして呼ぶので、
// ウィンドウの取り違えは起きない。ただし1つのウィンドウの中には複数のスペースがあり
// （スペースは別ウィンドウではなく、同一ウィンドウで中身が入れ替わる）、非表示スペースの
// ターミナルは park されて生き続けるため、そこで動くエージェントからも preview_file は届く。
// ウィンドウ粒度のルーティングだけではスペースの取り違えを防げないので、ここで
// 「呼び出し元ペインが属するスペース」を解いて振り分ける:
//   - 画面に出ているスペース → そのエディタ領域へ即座に開く
//   - park 中のスペース → 開かずに予約し、ユーザーがそのスペースへ戻ったときに開く
// （ユーザーが見ているスペースへ勝手に割り込まない。エージェント側には予約したことを返す）
// ペインが台帳に無い場合は、表示中スペースへ倒さず再試行させる（倒すと直したはずの
// 割り込みが復活するため）。ペイン→スペースの解決手順自体はメモ系
// （paradisAgentNotes.contribution.ts）と揃えてある。
//
// 開く先のグループは常に明示指定する。省略すると upstream の editorGroupFinder が
// 「フォーカス中のウィンドウの active group」を選ぶため、別スペースにピン留めされた補助
// エディタウィンドウをユーザーがフォーカスしているだけでそちらへ流出する（`revealIfOpen`
// が有効なら、別スペースの補助ウィンドウで既に開いている同名ファイルが reveal されもする）。
//
// 拡張子ごとの分岐は行わない: Markdown/HTML/PDF/Excel等のリッチビューアは fileViewers が
// EditorResolver（exclusive優先度）で登録済みなので、openEditor だけで自動的に選ばれる。

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IParadisPreviewFileResult, PARADIS_AGENT_PREVIEW_CHANNEL } from '../common/paradisAgentBrowser.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import {
	IParadisAuxiliaryWindowScopeService,
	IParadisTerminalScopeService,
	IParadisWorkspaceSwitchService,
	IParadisWorktreeService,
	paradisListSpaces,
} from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

/**
 * 1スペースあたりの予約プレビュー上限。ユーザーが戻ってきた瞬間にタブが大量に開くのを
 * 防ぐための上限で、超えた分は古いものから捨てる（最後に見せたかったものを残す）。
 */
const MAX_DEFERRED_PREVIEWS_PER_SPACE = 8;

/** 呼び出し元ペインから決まる、プレビューを届ける先。 */
type ParadisPreviewTarget =
	/** ペインが属するスペース。 */
	| { readonly kind: 'space'; readonly stateKey: string }
	/** スペースを持たないペイン（管理下でないウィンドウ）。今表示されているものへ届ける。 */
	| { readonly kind: 'active' }
	/** ペインがまだ台帳に無い。どこへ届けるべきか判断できない。 */
	| { readonly kind: 'unresolved' };

export class ParadisAgentPreviewChannel extends Disposable implements IServerChannel {

	/** 非表示スペースへの予約プレビュー（スペースの状態キー → 開く順のリソース）。 */
	private readonly deferredPreviews = new Map<string, URI[]>();

	constructor(
		private readonly editorService: IEditorService,
		private readonly fileService: IFileService,
		private readonly editorGroupsService: IEditorGroupsService,
		private readonly paneTokenService: IParadisPaneTokenService,
		private readonly terminalScopeService: IParadisTerminalScopeService,
		private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		private readonly worktreeService: IParadisWorktreeService,
		private readonly auxiliaryWindowScopeService: IParadisAuxiliaryWindowScopeService,
		private readonly logService: ILogService,
	) {
		super();

		// 切り替え完了（エディタ復元・working set 適用の後）に発火するので、予約分は
		// 復元済みのタブの後ろに積まれる。失敗して元スペースへ巻き戻った場合もここへ来る。
		// この時点で activeStateKey は切り替え先（巻き戻し時は元）へ更新済みであることに
		// 依存している（発火順が変わると resolveVisibleGroup が可視と判定できず予約が滞る）。
		this._register(this.workspaceSwitchService.onDidSwitchScope(stateKey => this.flushDeferredPreviews(stateKey)));
		// 二度と到達できなくなったスペース（リポジトリ削除 / worktree 削除）の予約は捨てる。
		this._register(this.workspaceSwitchService.onDidRetireScope(stateKey => this.deferredPreviews.delete(stateKey)));
		this._register(toDisposable(() => this.deferredPreviews.clear()));
	}

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		if (command === 'previewFile') {
			const args = Array.isArray(arg) ? arg : [];
			const token = typeof args[0] === 'string' ? args[0] : undefined;
			return this._previewFile(token, String(args[1])) as Promise<T>;
		}
		throw new Error(`Method not found: ${command}`);
	}

	private async _previewFile(token: string | undefined, path: string): Promise<IParadisPreviewFileResult> {
		// ここは意図的に paradisResolveExternalPath を使わない（他の URI.file 呼び出しとは事情が違う）。
		// エージェントが送ってくるパスの基準はペインが属するスペースだが、それを基準に写すと
		// 取り違えたときに「別のファイルを黙って開く」ことになる。解決できないまま stat に失敗すれば
		// エージェントには失敗が返り、静かな誤動作にはならない。直すならスペース配下であることの
		// 確認とセットにすること。
		const resource = URI.file(path);
		try {
			const stat = await this.fileService.stat(resource);
			if (stat.isDirectory) {
				return this.failed(resource, 'the path is a directory');
			}
		} catch (error) {
			return this.failed(resource, error);
		}

		// 切り替えの最中は、どちらのスペースへ属させても working set の退避・復元に
		// 巻き込まれてタブがどちらのものか不定になる。開かずに再試行させる。
		// （openEditor の await 中に切り替えが始まる隙は残る。その場合タブは切り替え元＝
		// 目的のスペースの working set に入るのが通常で、実害は「復元順が変わる」程度）
		if (this.workspaceSwitchService.isSwitching) {
			return { ok: false, reason: 'switching' };
		}

		const target = this.resolvePaneTarget(token);
		if (target.kind === 'unresolved') {
			return { ok: false, reason: 'paneUnresolved' };
		}
		const stateKey = target.kind === 'space' ? target.stateKey : this.workspaceSwitchService.activeStateKey;
		if (stateKey === undefined) {
			// スペース管理下に無いウィンドウ（リスト外のフォルダを開いている）。振り分ける
			// 相手がいないので、そのままメインのエディタ領域へ開く。
			return this.openPreview(resource, this.editorGroupsService.mainPart.activeGroup);
		}
		const group = this.resolveVisibleGroup(stateKey, resource);
		return group ? this.openPreview(resource, group) : this.deferPreview(stateKey, resource);
	}

	/**
	 * 呼び出し元ペインから届け先を決める。park 中のグループも引ける台帳を最優先で見る。
	 *
	 * トークンが未知の場合（＝shared process はこのウィンドウへルーティングできたのに、
	 * ウィンドウ側の台帳にはまだ載っていない。リロード直後のターミナル復元中など）と、
	 * 所属が未確定な場合（`pending`。端末の再接続中など）は `unresolved` にして再試行させる。
	 * ここで「今表示されているスペース」へ倒すと、park 中スペースのプレビューが画面へ
	 * 割り込むという直したはずの症状が復活するため。
	 * スペースを持たない `unscoped` なペイン（管理下でないウィンドウ）だけは `active` に倒す。
	 */
	private resolvePaneTarget(token: string | undefined): ParadisPreviewTarget {
		if (token === undefined) {
			// shared process が必ず付けるので、ここへ来るのは想定外。表示中へ倒しておく。
			return { kind: 'active' };
		}
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		if (instanceId === undefined) {
			return { kind: 'unresolved' };
		}
		const recorded = this.terminalScopeService.getStateKeyForInstance(instanceId);
		if (recorded !== undefined) {
			return { kind: 'space', stateKey: recorded };
		}
		const scope = this.terminalScopeService.resolveScope(instanceId);
		return scope.kind === 'managed'
			? { kind: 'space', stateKey: scope.stateKey }
			: scope.kind === 'unscoped' ? { kind: 'active' } : { kind: 'unresolved' };
	}

	/**
	 * そのスペースが今画面に出ているエディタ領域のグループ。メインのエディタ領域が
	 * そのスペースならそこ、違っていてもスペースにピン留めされた補助エディタウィンドウが
	 * あればそこへ開く。どちらも無ければ undefined（= 予約に回す）。
	 *
	 * 1つのスペースが複数のグループを持つことがある（エディタ領域の分割、同じスペースから
	 * 何度も分離した補助ウィンドウ）。その場合は、既にそのファイルを開いているグループを
	 * 優先し、無ければ直近まで使っていたグループを選ぶ。グループを明示指定する以上、
	 * upstream の「既に開いているタブへ reveal する」経路（editorGroupFinder の
	 * revealIfOpen 系）は通らないので、二重タブを避ける判断はここで持つ必要がある。
	 *
	 * `findEditors` にオプションを渡さないのは意図的: 既定では diff / 並べ置きの内側に
	 * 同じリソースがあるだけのグループはマッチしないため、「単独タブとして開いている
	 * グループへ寄せる」というここでの狙いに合う。返る groupId はウィンドウを横断するので、
	 * 必ず `candidates`（このスペースの領域だけ）と突き合わせてから使う。
	 *
	 * なお `parts` と `getPart` の突き合わせは参照の同一性に依存している（スコープ管理が
	 * 保持している IAuxiliaryEditorPart は upstream の実体そのもの）。将来これがラップ
	 * されると候補が空になり、末尾のフォールバックへ落ちる。
	 */
	private resolveVisibleGroup(stateKey: string, resource: URI): IEditorGroup | undefined {
		const parts: readonly IEditorPart[] = this.workspaceSwitchService.activeStateKey === stateKey
			? [this.editorGroupsService.mainPart]
			: [...this.auxiliaryWindowScopeService.getPinnedParts(stateKey)];
		if (!parts.length) {
			return undefined;
		}
		const partSet = new Set(parts);
		const candidates = this.editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)
			.filter(group => partSet.has(this.editorGroupsService.getPart(group)));
		const openedGroupIds = this.editorService.findEditors(resource).map(identifier => identifier.groupId);
		return candidates.find(group => openedGroupIds.includes(group.id))
			?? candidates.at(0)
			?? parts[0].activeGroup;
	}

	private async openPreview(resource: URI, group: IEditorGroup): Promise<IParadisPreviewFileResult> {
		try {
			// preserveFocus: ユーザーは大抵ターミナルでエージェントとやり取り中なので、
			// 入力フォーカスは奪わずエディタを開いて見せるだけにする。
			const editor = await this.editorService.openEditor({ resource, options: { preserveFocus: true } }, group);
			return editor ? { ok: true } : this.failed(resource, 'no editor was opened');
		} catch (error) {
			return this.failed(resource, error);
		}
	}

	/**
	 * 非表示スペースへの予約。ユーザーが到達できないスペース（切り替え先の一覧に無い =
	 * 実体を失った worktree など）は予約しない: 永久に開かないものを「戻ったときに開く」と
	 * 答えてしまうため、開けないことをその場で伝える。
	 */
	private deferPreview(stateKey: string, resource: URI): IParadisPreviewFileResult {
		const spaceName = this.spaceName(stateKey);
		if (spaceName === undefined) {
			this.logService.warn(`[ParadisAgentPreview] not queueing ${resource.toString()}: its space is not reachable any more`);
			return { ok: false, reason: 'unreachableSpace' };
		}
		const queued = this.deferredPreviews.get(stateKey) ?? [];
		const deduped = queued.filter(candidate => candidate.toString() !== resource.toString());
		deduped.push(resource);
		if (deduped.length > MAX_DEFERRED_PREVIEWS_PER_SPACE) {
			this.logService.trace(`[ParadisAgentPreview] dropping ${deduped.length - MAX_DEFERRED_PREVIEWS_PER_SPACE} queued preview(s) over the per-space limit`);
		}
		this.deferredPreviews.set(stateKey, deduped.slice(-MAX_DEFERRED_PREVIEWS_PER_SPACE));
		return { ok: true, deferred: true, spaceName };
	}

	/**
	 * そのスペースへ戻ってきたので予約分を開く。開けなかったもの（消えた・移動した等）は
	 * 黙って捨てる: 呼び出し元のエージェントには予約した時点で応答済みで、ここで報告する
	 * 相手がいない（残すと次に戻ってきたときにまた失敗して溜まり続ける）。
	 *
	 * 契機はスペース切り替えだけなので、スペースBを見たまま「スペースAにピン留めした補助
	 * ウィンドウ」を新しく開いた場合、Aの予約はそこには出ず次の切り替えまで待つ
	 * （ピン留めの変更を知らせるイベントが無いため）。
	 */
	private flushDeferredPreviews(stateKey: string): void {
		const queued = this.deferredPreviews.get(stateKey);
		if (!queued?.length) {
			return;
		}
		this.deferredPreviews.delete(stateKey);
		void (async () => {
			for (const resource of queued) {
				const group = this._store.isDisposed ? undefined : this.resolveVisibleGroup(stateKey, resource);
				if (!group) {
					// 開いている途中で別スペースへ切り替わった（あるいはウィンドウが閉じた）。
					// 残りは捨てる: 次にこのスペースへ戻ったときに開き直すと、いつ出てくるか
					// 分からないタブになるため。
					this.logService.trace(`[ParadisAgentPreview] dropping the rest of the queued previews: the space left the screen`);
					return;
				}
				await this.openPreview(resource, group);
			}
		})().catch(onUnexpectedError);
	}

	/** 予約先スペースの表示名（Workspaces ビューと同じ）。切り替え先の一覧に無ければ undefined。 */
	private spaceName(stateKey: string): string | undefined {
		return paradisListSpaces(this.workspaceSwitchService.repositories, this.worktreeService)
			.find(entry => entry.space === stateKey)?.name;
	}

	/** 失敗の詳細はここだけに残し、呼び出し元へは理由を持たない失敗として返す。 */
	private failed(resource: URI, reason: unknown): IParadisPreviewFileResult {
		this.logService.warn(`[ParadisAgentPreview] failed to open ${resource.toString()}`, reason);
		return { ok: false };
	}
}

/**
 * shared process の IPCServer へ、このウィンドウ宛の {@link PARADIS_AGENT_PREVIEW_CHANNEL}
 * を登録する。登録はウィンドウの生存期間ずっと有効（接続断で自動的に消える）。
 */
class ParadisAgentPreviewContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisAgentPreview';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IEditorService editorService: IEditorService,
		@IFileService fileService: IFileService,
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@IParadisPaneTokenService paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService worktreeService: IParadisWorktreeService,
		@IParadisAuxiliaryWindowScopeService auxiliaryWindowScopeService: IParadisAuxiliaryWindowScopeService,
		@ILogService logService: ILogService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_AGENT_PREVIEW_CHANNEL, this._register(new ParadisAgentPreviewChannel(
			editorService,
			fileService,
			editorGroupsService,
			paneTokenService,
			terminalScopeService,
			workspaceSwitchService,
			worktreeService,
			auxiliaryWindowScopeService,
			logService,
		)));
	}
}

registerWorkbenchContribution2(ParadisAgentPreviewContribution.ID, ParadisAgentPreviewContribution, WorkbenchPhase.AfterRestored);
