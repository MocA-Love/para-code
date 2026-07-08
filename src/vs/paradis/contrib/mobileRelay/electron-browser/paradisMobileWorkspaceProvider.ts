/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { TokenizationRegistry } from '../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { generateTokensCSSForColorMap } from '../../../../editor/common/languages/supports/tokenization.js';
import { tokenizeToString } from '../../../../editor/common/languages/textToHtmlTokenizer.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { editorBackground, editorForeground } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalGroupService } from '../../../../workbench/contrib/terminal/browser/terminalGroupService.js';
import { XtermAddonImporter } from '../../../../workbench/contrib/terminal/browser/xterm/xtermAddonImporter.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisListParkedTerminalEditorInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import { renderSpreadsheetDiffMobileHtml, renderSpreadsheetMobileSheet } from './paradisMobileSpreadsheetHtml.js';
import { Channels, encodeNotify, NotifyKind, NotifyPayload } from '../common/paradisMobileProtocol.js';
import { IParadisGitResult, IParadisMobileInboundFrame, IParadisMobileInboundFrame as InboundFrame } from '../common/paradisMobileRelay.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** ワークスペース状態スナップショット（stateチャネルのペイロード）。 */
interface StateSnapshot {
	activeWs: string | undefined;
	workspaces: { id: string; name: string; color?: string; branch?: string }[];
	terminals: { id: number; title: string; ws?: string; agentStatus?: string; cols?: number; rows?: number }[];
}

/** ターミナルのサブプロトコル（termチャネルのペイロード、JSON）。 */
type TermInbound =
	| { t: 'attach'; id: number }
	| { t: 'detach'; id: number }
	| { t: 'input'; id: number; data: string }
	| { t: 'create'; ws?: string };
type TermOutbound =
	// snapshot=true は attach 時の画面復元用フレーム（VTシーケンス込み）。モバイルは追記せず
	// バッファ全体を置き換える（再attachで画面が二重にならないようにするため）。
	| { t: 'data'; id: number; data: string; snapshot?: boolean }
	| { t: 'exit'; id: number };

/** scm チャネルのサブプロトコル（JSON、リクエスト/レスポンス）。 */
type ScmInbound =
	| { t: 'status'; id: string; ws: string }
	| { t: 'diff'; id: string; ws: string; path?: string; staged?: boolean }
	| { t: 'xlsxDiff'; id: string; ws: string; path: string }
	| { t: 'commit'; id: string; ws: string; message: string; all?: boolean }
	| { t: 'log'; id: string; ws: string; limit?: number; skip?: number }
	| { t: 'commitFiles'; id: string; ws: string; hash: string };

/** fs チャネルのサブプロトコル（JSON、リクエスト/レスポンス）。 */
type FsInbound =
	| { t: 'list'; id: string; ws: string; path: string }
	| { t: 'read'; id: string; ws: string; path: string; highlight?: boolean }
	| { t: 'xlsx'; id: string; ws: string; path: string; sheet?: number }
	| { t: 'pdf'; id: string; ws: string; path: string }
	| { t: 'docx'; id: string; ws: string; path: string }
	| { t: 'media'; id: string; ws: string; path: string }
	| { t: 'find'; id: string; ws: string; query: string }
	| { t: 'grep'; id: string; ws: string; query: string }
	| { t: 'upload'; id: string; name: string; data: string };

const FS_READ_LIMIT = 1024 * 1024; // ファイル読み取り上限（バイト。FrameMuxのチャンク分割転送で1MiB超の応答も送れる）
// バイナリ（PDF・Word・画像・動画・音声）の読み取り上限。base64 で約1.37倍に膨らむため、
// FrameMux の再結合上限（FRAME_REASSEMBLY_LIMIT = 32MiB）に収まるようここで抑える（20MiB → base64 約27MiB）。
const BINARY_READ_LIMIT = 20 * 1024 * 1024;
const UPLOAD_LIMIT = 10 * 1024 * 1024; // モバイルからの添付アップロード上限（バイト）
const UPLOAD_BASE64_LIMIT = Math.ceil(UPLOAD_LIMIT * 4 / 3) + 4; // 同、base64文字列長での事前判定用
const HIGHLIGHT_SOURCE_LIMIT = 128 * 1024; // ハイライト対象の上限（HTML化で数倍に膨らむため読み取り上限より絞る）
const TERM_SCROLLBACK_LIMIT = 16 * 1024; // attach時に送る直近バッファ上限（文字。serialize不可時のフォールバック用）
const TERM_SNAPSHOT_SCROLLBACK_ROWS = 1000; // attach時のVTスナップショットで通常バッファから含めるスクロールバック行数（代替バッファ=TUIは常に全体）

/**
 * shared process のリレーサービスと、このウィンドウのワークスペース/ターミナルを橋渡しする。
 * - state: ワークスペース・ターミナル・エージェント状態のスナップショットを push
 * - term: モバイルからの attach/input を処理し、ターミナル出力を stream 送信
 *
 * SCM / fs / browser チャネルは本スライスでは未実装（設計書 M2/M3。ここに追加していく）。
 */
export class ParadisMobileWorkspaceProvider extends Disposable {
	// ターミナルID → その出力購読(dispose用)。1端末につき最後にattachしたモバイルへ出力を返す。
	private readonly attachedTerminals = this._register(new DisposableMap<number>());
	// ターミナルID → 出力の宛先モバイルID。
	private readonly terminalSubscribers = new Map<number, string>();
	// エージェント状態の遷移検知用（stateKey → 直近の状態）。
	private readonly previousScopeStatus = new Map<string, string>();
	private notifyCounter = 0;
	// attach時のVTスナップショット生成に使う serialize addon（PC側xtermの現画面を
	// エスケープシーケンス込みでシリアライズし、モバイルのxtermで完全再現するため）。
	private readonly xtermAddonImporter = new XtermAddonImporter();
	// raw xterm → その端末に一度だけ load した serialize addon（端末ごとに1つ）。
	private readonly serializeAddons = new WeakMap<object, { serialize(options?: { scrollback?: number }): string }>();

	constructor(
		private readonly sendFrame: (frame: IParadisMobileInboundFrame) => void,
		private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		private readonly terminalService: ITerminalService,
		private readonly terminalGroupService: ITerminalGroupService,
		private readonly terminalScopeService: IParadisTerminalScopeService,
		private readonly worktreeService: IParadisWorktreeService,
		private readonly agentStatusStore: IParadisAgentStatusStore,
		private readonly logService: ILogService,
		private readonly fileService: IFileService,
		private readonly environmentService: IEnvironmentService,
		private readonly languageService: ILanguageService,
		private readonly extensionService: IExtensionService,
		private readonly themeService: IThemeService,
		private readonly sharedProcessService: ISharedProcessService,
		private readonly runGit: (repoPath: string, args: readonly string[]) => Promise<IParadisGitResult>,
		private readonly paneTokenService: IParadisPaneTokenService,
		private readonly syncAgentPanes: (entries: readonly { terminalId: number; token: string; cwd?: string }[]) => void,
		private readonly searchFiles: (rootPath: string, query: string, maxResults: number) => Promise<{ files: string[]; truncated: boolean }>,
		private readonly searchText: (rootPath: string, query: string, maxResults: number) => Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }>,
	) {
		super();

		// 状態が変わったらスナップショットを再送。エージェント状態の変化は通知判定も行う。
		// 再送はイベント起点では100msに集約する（特にウィンドウリサイズ中の
		// onDidChangeInstanceDimensions はインスタンス数×フレーム数で連射されるため、
		// そのまま送るとリレー帯域を浪費する）。
		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => { this.refreshBranches(); this.pushStateSoon(); }));
		// 切替はエディタターミナルのpark/unpark（allInstances の増減）を伴うため、agentペイン対応表も同期し直す
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => { this.pushStateSoon(); this.pushAgentPanes(); }));
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => { this.detectAndNotify(); this.pushStateSoon(); }));
		this._register(this.terminalService.onDidChangeInstances(() => this.pushStateSoon()));
		// park/unpark（ワークスペース切り替えでの退避/復帰）は instances イベントに乗らないため groups 変化でも再送する
		this._register(this.terminalGroupService.onDidChangeGroups(() => this.pushStateSoon()));
		// PC側のリサイズで cols/rows が変わったら再送（モバイルのxtermが同寸法に追従する）
		this._register(this.terminalService.onDidChangeInstanceDimensions(() => this.pushStateSoon()));
		// worktree（スペース）の増減もワークスペース一覧に反映する
		this._register(this.worktreeService.onDidChangeWorktrees(() => this.pushStateSoon()));
		// agentチャネル用: terminalId ⇔ ペイントークンの対応を shared process へ同期する
		// （チャットミラーが attach(id) を transcript へ解決するのに使う）。
		this._register(this.paneTokenService.onDidChange(() => this.pushAgentPanes()));
		this._register(this.terminalService.onDidChangeInstances(() => this.pushAgentPanes()));
		this.pushAgentPanes();
		this.refreshBranches();
	}

	/**
	 * terminalId ⇔ ペイントークン対応表を shared process のチャットミラーへ同期する。
	 * cwd はhook未発火時のセッション探索フォールバック（~/.claude/projects の逆引き）に使う。
	 */
	private pushAgentPanes(): void {
		const instances = this.allInstances();
		Promise.all(instances.map(async inst => {
			const token = this.paneTokenService.getTokenForInstance(inst.instanceId);
			if (token === undefined) {
				return undefined;
			}
			let cwd: string | undefined;
			try {
				const cwdResource = await inst.getCwdResource();
				cwd = cwdResource?.scheme === 'file' ? cwdResource.fsPath : undefined;
			} catch {
				cwd = undefined;
			}
			return { terminalId: inst.instanceId, token, ...(cwd !== undefined ? { cwd } : {}) };
		})).then(entries => {
			this.syncAgentPanes(entries.filter((e): e is { terminalId: number; token: string; cwd?: string } => e !== undefined));
		}).catch(err => this.logService.warn('[paradisMobileRelay] pushAgentPanes failed', err));
	}

	private readonly pushStateScheduler = this._register(new RunOnceScheduler(() => this.pushState(), 100));

	/** イベント起点のスナップショット再送（100msに集約）。 */
	private pushStateSoon(): void {
		if (!this.pushStateScheduler.isScheduled()) {
			this.pushStateScheduler.schedule();
		}
	}

	// リポジトリID → 現在のブランチ名（state スナップショット用の非同期キャッシュ）。
	private readonly branchCache = new Map<string, string>();

	/** 各リポジトリのブランチ名を非同期に更新し、変化があれば state を再送する。 */
	private refreshBranches(): void {
		for (const repo of this.workspaceSwitchService.repositories) {
			if (repo.uri.scheme !== 'file') {
				continue;
			}
			this.runGit(repo.uri.fsPath, ['rev-parse', '--abbrev-ref', 'HEAD']).then(result => {
				const branch = result.stdout.trim();
				if (branch && this.branchCache.get(repo.id) !== branch) {
					this.branchCache.set(repo.id, branch);
					this.pushState();
				}
			}).catch(() => { /* gitが無い等は無視 */ });
		}
	}

	/**
	 * エージェント状態の遷移を検知して notify フレームを送る。
	 * - permission（質問/許可要求）への遷移 → agent-question
	 * - review（作業完了）への遷移 → agent-done
	 * これがモバイルの「エージェントの質問通知」の供給源。全オンラインモバイルへ届ける。
	 */
	/**
	 * park 中（他ワークスペースへ退避中）のグループも含めた全ターミナルインスタンス。
	 * terminalService.instances はアクティブワークスペースの表示中グループしか含まないため、
	 * これを使わないとモバイル側は「PCで選択中のワークスペースのターミナル」しか見えない。
	 */
	private allInstances(): ITerminalInstance[] {
		const seen = new Set<number>();
		const result: ITerminalInstance[] = [];
		const add = (inst: ITerminalInstance) => {
			if (!seen.has(inst.instanceId)) {
				seen.add(inst.instanceId);
				result.push(inst);
			}
		};
		for (const inst of this.terminalService.instances) {
			add(inst);
		}
		if (this.terminalGroupService instanceof TerminalGroupService) {
			for (const group of this.terminalGroupService.paradisParkedGroups) {
				for (const inst of group.terminalInstances) {
					add(inst);
				}
			}
		}
		// エディタエリアのターミナルはワークスペース切り替え時に専用台帳へパークされ、
		// terminalService.instances からも paradisParkedGroups からも消える。ここを列挙しないと
		// 他ワークスペースのエディタターミナル（Claude Code等をエディタタブで開いている場合）が
		// モバイルから一切見えなくなる。
		for (const inst of paradisListParkedTerminalEditorInstances()) {
			add(inst);
		}
		return result;
	}

	private detectAndNotify(): void {
		for (const inst of this.allInstances()) {
			const stateKey = this.terminalScopeService.getStateKeyForInstance(inst.instanceId);
			if (!stateKey) {
				continue;
			}
			const status = this.agentStatusStore.getScopeStatus(stateKey);
			const prev = this.previousScopeStatus.get(stateKey);
			if (status && status !== prev) {
				// 'question' (AskUserQuestion) はここでは通知しない: shared process の
				// transcript ミラーが質問本文・選択肢つきの通知を別経路で全モバイルへ
				// 送るため、状態遷移ベースの汎用通知と二重になるのを防ぐ。
				if (status === 'permission' || status === 'review') {
					this.emitNotify(status === 'permission' ? 'agent-question' : 'agent-done', inst.instanceId, stateKey, inst.title);
				}
			}
			if (status) {
				this.previousScopeStatus.set(stateKey, status);
			} else {
				this.previousScopeStatus.delete(stateKey);
			}
		}
	}

	private emitNotify(kind: NotifyKind, terminalId: number, ws: string, terminalTitle: string): void {
		const wsName = this.wsDisplayName(ws);
		const title = kind === 'agent-question'
			? `${terminalTitle} — ${wsName}`
			: `${terminalTitle} — ${wsName}`;
		const body = kind === 'agent-question'
			? 'エージェントが確認を求めています'
			: 'エージェントが作業を完了しました';
		const payload: NotifyPayload = { kind, id: `n${this.notifyCounter++}`, title, body, ws, terminalId, at: Date.now() };
		this.sendFrame({ ch: Channels.Notify, ws: undefined, seq: 0, payload: VSBuffer.wrap(encodeNotify(payload)) });
	}

	/** 接続確立直後などに全状態を送る。 */
	pushState(): void {
		const snapshot = this.buildSnapshot();
		this.sendFrame({ ch: Channels.State, ws: undefined, seq: 0, payload: VSBuffer.wrap(encoder.encode(JSON.stringify(snapshot))) });
	}

	private buildSnapshot(): StateSnapshot {
		// リポジトリの直後にそのworktree（スペース）を並べる。idはターミナルスコープ等と
		// 同じ状態キー（worktree:<uri>）なので、モバイル側のフィルタがそのまま効く。
		const workspaces: StateSnapshot['workspaces'] = [];
		for (const r of this.workspaceSwitchService.repositories) {
			workspaces.push({
				id: r.id,
				name: r.name,
				...(r.color ? { color: r.color } : {}),
				...(this.branchCache.has(r.id) ? { branch: this.branchCache.get(r.id) } : {}),
			});
			for (const worktree of this.worktreeService.getWorktrees(r.id)) {
				if (worktree.missing) {
					continue;
				}
				workspaces.push({
					id: paradisWorktreeStateKey(worktree.uri),
					name: `✦ ${worktree.name}`,
					...(r.color ? { color: r.color } : {}),
					...(worktree.branch ? { branch: worktree.branch } : {}),
				});
			}
		}
		const terminals = this.allInstances().map(inst => {
			// スコープ未タグのターミナルはPC側では「常に表示」扱いだが、モバイルでは
			// 全ワークスペースに重複表示されてしまうため、アクティブワークスペース所属として送る。
			const stateKey = this.terminalScopeService.getStateKeyForInstance(inst.instanceId) ?? this.workspaceSwitchService.activeStateKey;
			const agentStatus = stateKey ? this.agentStatusStore.getScopeStatus(stateKey) : undefined;
			return {
				id: inst.instanceId,
				title: inst.title,
				...(stateKey ? { ws: stateKey } : {}),
				...(agentStatus ? { agentStatus } : {}),
				...(inst.cols > 0 && inst.rows > 0 ? { cols: inst.cols, rows: inst.rows } : {}),
			};
		});
		return { activeWs: this.workspaceSwitchService.activeStateKey, workspaces, terminals };
	}

	/** オンラインのモバイルが居なくなったら、全ターミナル購読を解放する（M-2: 購読リーク防止）。 */
	detachAll(): void {
		this.attachedTerminals.clearAndDisposeAll();
		this.terminalSubscribers.clear();
	}

	/** shared process から届いたモバイル→PCフレームを処理する。 */
	handleInbound(frame: InboundFrame): void {
		if (frame.ch === Channels.State) {
			// モバイルからの state 要求（空ペイロード）には現在のスナップショットで応答。
			this.pushState();
			return;
		}
		if (frame.ch === Channels.Terminal) {
			this.handleTerminalInbound(frame.payload, frame.mobileId);
			return;
		}
		if (frame.ch === Channels.Scm) {
			this.handleScmInbound(frame.payload, frame.mobileId).catch(err => this.logService.warn('[paradisMobileRelay] scm request failed', err));
			return;
		}
		if (frame.ch === Channels.Fs) {
			this.handleFsInbound(frame.payload, frame.mobileId).catch(err => this.logService.warn('[paradisMobileRelay] fs request failed', err));
		}
	}

	// --- ws（状態キー）の解決 ------------------------------------------------------

	/**
	 * ワークスペースID（リポジトリID or worktree状態キー）をルートURIへ解決する。
	 * scm / fs / ターミナル作成の全チャネルで共通に使う。
	 */
	private resolveWsRoot(ws: string): URI | undefined {
		const repo = this.workspaceSwitchService.repositories.find(r => r.id === ws);
		if (repo) {
			return repo.uri;
		}
		if (ws.startsWith('worktree:')) {
			for (const r of this.workspaceSwitchService.repositories) {
				for (const worktree of this.worktreeService.getWorktrees(r.id)) {
					if (paradisWorktreeStateKey(worktree.uri) === ws) {
						return worktree.uri;
					}
				}
			}
		}
		return undefined;
	}

	/** ワークスペースID → 表示名（通知タイトル用）。 */
	private wsDisplayName(ws: string): string {
		const repo = this.workspaceSwitchService.repositories.find(r => r.id === ws);
		if (repo) {
			return repo.name;
		}
		for (const r of this.workspaceSwitchService.repositories) {
			for (const worktree of this.worktreeService.getWorktrees(r.id)) {
				if (paradisWorktreeStateKey(worktree.uri) === ws) {
					return `${r.name} ✦ ${worktree.name}`;
				}
			}
		}
		return ws;
	}

	// --- scm チャネル -----------------------------------------------------------

	private repoPathForWs(ws: string): string | undefined {
		const root = this.resolveWsRoot(ws);
		return root?.scheme === 'file' ? root.fsPath : undefined;
	}

	private async handleScmInbound(payload: VSBuffer, mobileId: string | undefined): Promise<void> {
		let msg: ScmInbound;
		try {
			msg = JSON.parse(decoder.decode(payload.buffer)) as ScmInbound;
		} catch {
			return;
		}
		const reply = (body: object) => {
			this.sendFrame({ ch: Channels.Scm, ws: undefined, seq: 0, payload: VSBuffer.wrap(encoder.encode(JSON.stringify({ id: msg.id, ...body }))), mobileId: mobileId || undefined });
		};
		const repoPath = this.repoPathForWs(msg.ws);
		if (!repoPath) {
			reply({ error: `unknown workspace: ${msg.ws}` });
			return;
		}
		try {
			if (msg.t === 'status') {
				const [status, branch] = await Promise.all([
					this.runGit(repoPath, ['status', '--porcelain=v1']),
					this.runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
				]);
				const files = status.stdout.split('\n').filter(l => l.length > 3).map(line => ({
					// porcelain v1: XY <path> （リネームは "old -> new"）
					x: line[0],
					y: line[1],
					path: line.slice(3).includes(' -> ') ? line.slice(3).split(' -> ')[1] : line.slice(3),
				}));
				reply({ t: 'status', branch: branch.stdout.trim(), files });
			} else if (msg.t === 'diff') {
				const args = msg.staged ? ['diff', '--cached'] : ['diff'];
				if (msg.path) {
					args.push('--', msg.path);
				}
				const result = await this.runGit(repoPath, args);
				// 未追跡ファイルは diff に出ないため、空なら内容そのものを差分風に返す
				let diff = result.stdout;
				if (!diff && msg.path) {
					const read = await this.readWorkspaceFile(msg.ws, msg.path);
					if (read !== undefined) {
						diff = read.split('\n').map(l => `+${l}`).join('\n');
					}
				}
				reply({ t: 'diff', diff });
			} else if (msg.t === 'commit') {
				if (!msg.message.trim()) {
					reply({ error: 'empty commit message' });
					return;
				}
				if (msg.all) {
					const addResult = await this.runGit(repoPath, ['add', '-A']);
					if (addResult.code !== 0) {
						reply({ error: addResult.stderr || 'git add failed' });
						return;
					}
				}
				const result = await this.runGit(repoPath, ['commit', '-m', msg.message]);
				if (result.code !== 0) {
					reply({ error: result.stderr || result.stdout || 'git commit failed' });
				} else {
					reply({ t: 'commit', output: result.stdout.trim() });
					this.refreshBranches();
				}
			} else if (msg.t === 'xlsxDiff') {
				// Excel差分: HEAD(git:スキーマ、git拡張のFSプロバイダ経由) vs 作業ツリーを
				// PC版差分ビューアと同じ計算・描画でHTML化して返す。
				const modified = await this.resolveWorkspacePathReal(msg.ws, msg.path);
				if (!modified) {
					reply({ error: `invalid path: ${msg.path}` });
					return;
				}
				const original = modified.with({ scheme: 'git', query: JSON.stringify({ path: modified.fsPath, ref: 'HEAD' }) });
				const html = await renderSpreadsheetDiffMobileHtml(this.fileService, this.sharedProcessService, original, modified, 'HEAD', '作業ツリー');
				reply({ t: 'xlsxDiff', html });
			} else if (msg.t === 'log') {
				const limit = Math.min(Math.max(Math.trunc(msg.limit ?? 10), 1), 100);
				const skip = Math.max(Math.trunc(msg.skip ?? 0), 0);
				// limit+1件取得して切り詰めることで、追加ページの有無(hasMore)を1回のgit logで判定する
				const result = await this.runGit(repoPath, ['log', '--skip', String(skip), '-n', String(limit + 1), '--pretty=format:%H%x09%ar%x09%s']);
				// コミット0件のリポジトリも exit 128 になるため、実エラーは「非ゼロ かつ stderr あり」で判定する
				if (result.code !== 0 && result.stderr.trim() && !/does not have any commits yet/.test(result.stderr)) {
					reply({ error: result.stderr.trim() });
					return;
				}
				const all = result.stdout.split('\n').filter(l => l.includes('\t')).map(line => {
					const [hash, when, ...subject] = line.split('\t');
					return { hash, when, subject: subject.join('\t') };
				});
				const hasMore = all.length > limit;
				const commits = hasMore ? all.slice(0, limit) : all;
				// リモートのWeb URLが分かればモバイル側でコミットページへ飛べるようにする。
				// remoteが無い/失敗してもログ本体の応答は返す（履歴表示を巻き添えにしない）。
				const remote = await this.runGit(repoPath, ['remote', 'get-url', 'origin']).catch(() => undefined);
				const webUrl = remote && remote.code === 0 ? remoteToWebUrl(remote.stdout.trim()) : undefined;
				reply({ t: 'log', commits, hasMore, ...(webUrl ? { webUrl } : {}) });
			} else if (msg.t === 'commitFiles') {
				// ハッシュ以外（オプションやrev式）を渡させない。`git show` は引数次第で
				// ファイル内容も出せるサブコマンドなので、40桁以内の16進に厳格に絞る
				if (!/^[0-9a-f]{4,40}$/i.test(msg.hash)) {
					reply({ error: 'invalid commit hash' });
					return;
				}
				const result = await this.runGit(repoPath, ['show', '--name-status', '--pretty=format:', msg.hash]);
				if (result.code !== 0) {
					reply({ error: result.stderr.trim() || 'git show failed' });
					return;
				}
				const files = result.stdout.split('\n').filter(l => l.includes('\t')).map(line => {
					const parts = line.split('\t');
					// リネーム(R100等)は "R100<TAB>old<TAB>new" なので新パスを採用する
					return { status: parts[0][0] ?? '?', path: parts[parts.length - 1] };
				});
				reply({ t: 'commitFiles', files });
			}
		} catch (err) {
			reply({ error: String(err) });
		}
	}

	// --- fs チャネル ------------------------------------------------------------

	/** ワークスペースルート配下に正規化したURIを返す（../ 等の脱出は拒否）。 */
	private resolveWorkspacePath(ws: string, relPath: string): URI | undefined {
		const root = this.resolveWsRoot(ws);
		if (!root) {
			return undefined;
		}
		// モバイル側は常に'/'区切りの相対パスを送る想定。Windows上ではjoinPath内部で
		// path.win32.joinが使われ'\'もセパレータとして解釈・畳み込まれるため、
		// '/'区切りのセグメント検査だけでは`..\..\secrets`のような脱出を検出できない。
		// '\'を含む入力はこの経路では常に不正とみなして拒否する。
		if (relPath.includes('\\')) {
			return undefined;
		}
		const segments = relPath.split('/').filter(s => s.length > 0);
		if (segments.some(s => s === '..' || s === '.')) {
			return undefined;
		}
		return segments.length === 0 ? root : joinPath(root, ...segments);
	}

	/**
	 * resolveWorkspacePathに加え、シンボリックリンク経由でのワークスペース外脱出も検査する
	 * （設計書 §8）。'list'の子要素フィルタだけでは対象自体やパス途中のシンボリックリンクを
	 * 防げないため、実パスを解決してリポジトリルート配下に収まっているかを確認する。
	 */
	private async resolveWorkspacePathReal(ws: string, relPath: string): Promise<URI | undefined> {
		const uri = this.resolveWorkspacePath(ws, relPath);
		if (!uri) {
			return undefined;
		}
		const root = this.resolveWsRoot(ws);
		if (!root) {
			return undefined;
		}
		const real = await this.fileService.realpath(uri);
		if (!real) {
			return undefined;
		}
		const rootPath = root.path.endsWith('/') ? root.path : `${root.path}/`;
		if (real.path !== root.path && !real.path.startsWith(rootPath)) {
			return undefined;
		}
		return uri;
	}

	private async readWorkspaceFile(ws: string, relPath: string): Promise<string | undefined> {
		const uri = await this.resolveWorkspacePathReal(ws, relPath);
		if (!uri) {
			return undefined;
		}
		try {
			const content = await this.fileService.readFile(uri, { length: FS_READ_LIMIT });
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	/**
	 * PCの現行カラーテーマそのままのシンタックスハイライトHTMLを生成する。
	 * トークン色は tokenizeToString が付ける mtk クラス + カラーマップCSSで再現し、
	 * 背景/前景はテーマのエディタ色を添える。失敗時は undefined（モバイル側はプレーン表示）。
	 */
	private async highlightFile(uri: URI, text: string): Promise<{ html: string; css: string; bg?: string; fg?: string; highlightTruncated?: boolean } | undefined> {
		try {
			// TextMate文法は拡張機構経由で登録されるため、登録完了を待ってから言語解決する
			await this.extensionService.whenInstalledExtensionsRegistered();
			const truncated = text.length > HIGHLIGHT_SOURCE_LIMIT;
			const source = truncated ? text.slice(0, HIGHLIGHT_SOURCE_LIMIT) : text;
			const newlineIndex = source.indexOf('\n');
			const firstLine = newlineIndex === -1 ? source : source.slice(0, newlineIndex);
			const languageId = this.languageService.guessLanguageIdByFilepathOrFirstLine(uri, firstLine);
			const html = await tokenizeToString(this.languageService, source, languageId);
			const colorMap = TokenizationRegistry.getColorMap();
			const css = colorMap ? generateTokensCSSForColorMap(colorMap) : '';
			const theme = this.themeService.getColorTheme();
			return {
				html,
				css,
				bg: theme.getColor(editorBackground)?.toString(),
				fg: theme.getColor(editorForeground)?.toString(),
				...(truncated ? { highlightTruncated: true } : {}),
			};
		} catch (err) {
			this.logService.warn('[paradisMobileRelay] highlight failed', err);
			return undefined;
		}
	}

	private async handleFsInbound(payload: VSBuffer, mobileId: string | undefined): Promise<void> {
		let msg: FsInbound;
		try {
			msg = JSON.parse(decoder.decode(payload.buffer)) as FsInbound;
		} catch {
			return;
		}
		const reply = (body: object) => {
			this.sendFrame({ ch: Channels.Fs, ws: undefined, seq: 0, payload: VSBuffer.wrap(encoder.encode(JSON.stringify({ id: msg.id, ...body }))), mobileId: mobileId || undefined });
		};
		// 画像アップロード（エージェントへの添付用）。ワークスペースを汚さないよう
		// userData 配下の専用ディレクトリへ保存し、フルパスを返す（モバイル側がPTYへ
		// パスを貼り付け、エージェントCLIがそのパスの画像を読む）。パスは取らないため
		// パス解決の前に処理する。ファイル名はサニタイズし、脱出の余地を残さない。
		if (msg.t === 'upload') {
			try {
				if (msg.data.length > UPLOAD_BASE64_LIMIT) {
					// allow-any-unicode-next-line
					reply({ error: `ファイルが大きすぎます。添付は ${Math.round(UPLOAD_LIMIT / 1024 / 1024)}MB までです。` });
					return;
				}
				const content = decodeBase64(msg.data);
				const dot = msg.name.lastIndexOf('.');
				const ext = dot >= 0 ? msg.name.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) : '';
				const dir = joinPath(this.environmentService.userRoamingDataHome, 'paraMobileUploads');
				// 同ミリ秒の連続アップロードで上書きしないよう乱数サフィックスを付ける
				const target = joinPath(dir, `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext ? `.${ext}` : ''}`);
				await this.fileService.writeFile(target, content);
				reply({ t: 'upload', path: target.fsPath });
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		// 検索（find/grep）はパスでなくクエリを取るため、パス解決の前に処理する。
		// 実行はshared process（ripgrep）。ワークスペースルート起点なので脱出の余地はない。
		if (msg.t === 'find' || msg.t === 'grep') {
			const root = this.resolveWsRoot(msg.ws);
			if (!root || root.scheme !== 'file') {
				reply({ error: `unknown workspace: ${msg.ws}` });
				return;
			}
			try {
				if (msg.t === 'find') {
					const result = await this.searchFiles(root.fsPath, msg.query, 100);
					reply({ t: 'find', files: result.files, truncated: result.truncated });
				} else {
					const result = await this.searchText(root.fsPath, msg.query, 200);
					reply({ t: 'grep', matches: result.matches, truncated: result.truncated });
				}
			} catch (err) {
				reply({ error: String(err) });
			}
			return;
		}
		const uri = await this.resolveWorkspacePathReal(msg.ws, msg.path);
		if (!uri) {
			reply({ error: `invalid path: ${msg.path}` });
			return;
		}
		try {
			if (msg.t === 'xlsx') {
				// シート単位の遅延読み込み(sheet省略時は先頭)。シート一覧はモバイルの
				// ネイティブタブに使われ、切替時に該当sheetだけ再要求される。
				const result = await renderSpreadsheetMobileSheet(this.fileService, this.sharedProcessService, uri, typeof msg.sheet === 'number' ? msg.sheet : 0);
				reply({ t: 'xlsx', html: result.html, sheets: result.sheets, sheet: result.sheet });
			} else if (msg.t === 'pdf') {
				// PDF はバイナリのまま base64 で返す（'read' の UTF-8 デコード経路はバイナリを壊すため使えない）。
				const stat = await this.fileService.stat(uri);
				if ((stat.size ?? 0) > BINARY_READ_LIMIT) {
					// allow-any-unicode-next-line
					reply({ error: `PDF が大きすぎます（${Math.round((stat.size ?? 0) / 1024 / 1024)}MB）。モバイル表示は ${BINARY_READ_LIMIT / 1024 / 1024}MB までです。` });
					return;
				}
				const content = await this.fileService.readFile(uri, { length: BINARY_READ_LIMIT });
				// 標準base64（パディング付き）。モバイル側は expo-file-system の Base64 エンコーディング指定で
				// ネイティブデコードしながらファイルへ書くため、JSでのデコードは発生しない。
				reply({ t: 'pdf', data: encodeBase64(content.value), size: stat.size ?? 0 });
			} else if (msg.t === 'docx') {
				// Word文書もバイナリのまま base64 で返す（レンダリングはモバイル側の WebView が
				// PC版ビューアと同じ vendored docx-preview で行う。PC側でHTML化しないのは、
				// docx-preview がDOM前提でタブストップ計算等が表示環境のフォント計測に依存するため）。
				const stat = await this.fileService.stat(uri);
				if ((stat.size ?? 0) > BINARY_READ_LIMIT) {
					// allow-any-unicode-next-line
					reply({ error: `Word 文書が大きすぎます（${Math.round((stat.size ?? 0) / 1024 / 1024)}MB）。モバイル表示は ${BINARY_READ_LIMIT / 1024 / 1024}MB までです。` });
					return;
				}
				const content = await this.fileService.readFile(uri, { length: BINARY_READ_LIMIT });
				reply({ t: 'docx', data: encodeBase64(content.value), size: stat.size ?? 0 });
			} else if (msg.t === 'media') {
				// 画像・動画・音声もバイナリのまま base64 で返す（表示はモバイル側。画像は data URI、
				// 動画/音声はキャッシュファイル経由で WKWebView のネイティブ再生を使う）。
				const stat = await this.fileService.stat(uri);
				if ((stat.size ?? 0) > BINARY_READ_LIMIT) {
					// allow-any-unicode-next-line
					reply({ error: `ファイルが大きすぎます（${Math.round((stat.size ?? 0) / 1024 / 1024)}MB）。モバイル表示は ${BINARY_READ_LIMIT / 1024 / 1024}MB までです。` });
					return;
				}
				const content = await this.fileService.readFile(uri, { length: BINARY_READ_LIMIT });
				reply({ t: 'media', data: encodeBase64(content.value), size: stat.size ?? 0 });
			} else if (msg.t === 'list') {
				const stat = await this.fileService.resolve(uri);
				const entries = (stat.children ?? [])
					.filter(c => !c.isSymbolicLink) // シンボリックリンク越えの読み取りを防止（設計書 §8）
					.map(c => ({ name: c.name, dir: c.isDirectory, size: c.size }))
					.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
				reply({ t: 'list', entries });
			} else if (msg.t === 'read') {
				const stat = await this.fileService.stat(uri);
				const content = await this.fileService.readFile(uri, { length: FS_READ_LIMIT });
				const text = content.value.toString();
				const body: Record<string, unknown> = { t: 'read', content: text, truncated: (stat.size ?? 0) > FS_READ_LIMIT, size: stat.size ?? 0 };
				if (msg.highlight) {
					const highlighted = await this.highlightFile(uri, text);
					if (highlighted) {
						Object.assign(body, highlighted);
					}
				}
				reply(body);
			}
		} catch (err) {
			reply({ error: String(err) });
		}
	}

	private handleTerminalInbound(payload: VSBuffer, mobileId: string | undefined): void {
		let msg: TermInbound;
		try {
			msg = JSON.parse(decoder.decode(payload.buffer)) as TermInbound;
		} catch {
			return;
		}
		if (msg.t === 'create') {
			// モバイルからの新規ターミナル作成。ws指定時はそのリポジトリ/worktreeをcwdにする。
			// 作成に伴う onDidChangeInstances で state が自動再送されるため応答は不要。
			const ws = msg.ws;
			const root = ws ? this.resolveWsRoot(ws) : undefined;
			// 作成時点でのPC側アクティブスコープ。指定wsがこれと一致（または未指定）なら
			// PCの現在の作業ワークスペース宛なので、通常の「新規ターミナル」と同じくパネルに表示する。
			const activeStateKey = this.workspaceSwitchService.activeStateKey;
			this.terminalService.createTerminal(root ? { cwd: root } : undefined)
				.then(instance => {
					if (ws && root && ws !== activeStateKey) {
						// PC側で非表示のワークスペース向け: 既定のタグ付け（アクティブスコープ所属）を
						// 指定wsへ付け替える。アクティブ外なので assignInstanceScope が即 park し、
						// そのワークスペースへ切り替えたときにだけ表示される。
						this.terminalScopeService.assignInstanceScope(instance.instanceId, ws);
					} else {
						// PCのアクティブws（または未指定）向け: 既定タグ付けのままアクティブに残る。
						// createTerminal はパネルを開かないため、通常の「新規ターミナル」コマンドと同様に
						// アクティブ化してターミナルパネルを表示し、PC側にちゃんと出るようにする。
						this.terminalService.setActiveInstance(instance);
						if (instance.target !== TerminalLocation.Editor) {
							this.terminalGroupService.showPanel(false)
								.catch(err => this.logService.warn('[paradisMobileRelay] showPanel failed', err));
						}
					}
					this.pushState();
				})
				.catch(err => this.logService.warn('[paradisMobileRelay] createTerminal failed', err));
			return;
		}
		// park 中（他ワークスペースのターミナル）にもモバイルからattach/入力できるようにする
		const instance = this.allInstances().find(i => i.instanceId === msg.id);
		if (!instance) {
			return;
		}
		if (msg.t === 'attach') {
			// 出力はattachを要求したモバイルにのみ返す（M-2）。再attachは宛先を更新する。
			this.terminalSubscribers.set(msg.id, mobileId ?? '');
			// 画面初期同期: 現在の画面状態をエスケープシーケンス込み（serialize addon）で送り、
			// モバイルのxtermで「PCで作業していた続き」を完全再現する（設計書 §4.2）。
			// getContentsAsText のプレーン化では代替バッファ/カーソル/色を持つTUI（claude/codex等）が
			// 崩れるため、VTシリアライズに切り替える。async だが snapshot=true でモバイルが
			// バッファ全体を置換するため、以後の onData 追記との順序ずれでは二重・欠落しない。
			this.sendTerminalSnapshot(instance, msg.id);
			if (this.attachedTerminals.has(msg.id)) {
				return;
			}
			const store = new DisposableStore();
			store.add(instance.onData(data => this.sendTerm({ t: 'data', id: msg.id, data })));
			store.add(instance.onExit(() => {
				this.sendTerm({ t: 'exit', id: msg.id });
				this.attachedTerminals.deleteAndDispose(msg.id);
				this.terminalSubscribers.delete(msg.id);
			}));
			this.attachedTerminals.set(msg.id, store);
		} else if (msg.t === 'detach') {
			this.attachedTerminals.deleteAndDispose(msg.id);
			this.terminalSubscribers.delete(msg.id);
		} else if (msg.t === 'input') {
			// 生入力を送る（改行はモバイル側が明示的に送る）。
			instance.sendText(msg.data, false).catch(err => this.logService.warn('[paradisMobileRelay] sendText failed', err));
		}
	}

	/**
	 * attach したモバイルへ、現在の端末画面をVTスナップショットとして送る。
	 * serialize addon が使えない場合はプレーンテキスト末尾へフォールバックする（従来動作）。
	 */
	private sendTerminalSnapshot(instance: ITerminalInstance, id: number): void {
		this.serializeTerminalSnapshot(instance).then(snapshot => {
			// serialize解決を待つ間に detach された場合は送らない。
			if (!this.terminalSubscribers.has(id)) {
				return;
			}
			let data = snapshot;
			if (data === undefined) {
				const contents = instance.xterm?.getContentsAsText();
				if (!contents) {
					return;
				}
				const tail = contents.length > TERM_SCROLLBACK_LIMIT ? contents.slice(-TERM_SCROLLBACK_LIMIT) : contents;
				data = tail.endsWith('\n') ? tail : tail + '\r\n';
			}
			this.sendTerm({ t: 'data', id, data, snapshot: true });
		}).catch(err => this.logService.warn('[paradisMobileRelay] scrollback sync failed', err));
	}

	/**
	 * PC側xtermの現画面をVTシーケンスへシリアライズする。代替バッファ（TUIの全画面）・
	 * カーソル位置・色・モードを復元できる。serialize addon は端末ごとに一度だけ load する。
	 */
	private async serializeTerminalSnapshot(instance: ITerminalInstance): Promise<string | undefined> {
		const xterm = instance.xterm;
		if (!xterm) {
			return undefined;
		}
		const raw = xterm.raw;
		let addon = this.serializeAddons.get(raw);
		if (!addon) {
			const Ctor = await this.xtermAddonImporter.importAddon('serialize');
			const loaded = new Ctor();
			raw.loadAddon(loaded);
			addon = loaded;
			this.serializeAddons.set(raw, loaded);
		}
		// 通常バッファのスクロールバックは行数で抑える（代替バッファ=TUIは常に全体が含まれる）。
		return addon.serialize({ scrollback: TERM_SNAPSHOT_SCROLLBACK_ROWS });
	}

	private sendTerm(msg: TermOutbound): void {
		const target = this.terminalSubscribers.get(msg.id);
		this.sendFrame({ ch: Channels.Terminal, ws: undefined, seq: 0, payload: VSBuffer.wrap(encoder.encode(JSON.stringify(msg))), mobileId: target || undefined });
	}
}

/**
 * git remote のURLをブラウザで開けるWeb URLへ変換する。
 * 例: git@github.com:owner/repo.git → https://github.com/owner/repo
 */
function remoteToWebUrl(remote: string): string | undefined {
	if (!remote) {
		return undefined;
	}
	let url = remote;
	const scpMatch = url.match(/^(?:ssh:\/\/)?git@(?<host>[^:/]+)[:/](?<repoPath>.+)$/);
	if (scpMatch?.groups) {
		url = `https://${scpMatch.groups.host}/${scpMatch.groups.repoPath}`;
	}
	if (!/^https?:\/\//.test(url)) {
		return undefined;
	}
	// リモートURLに認証情報が埋まっていることがある（x-access-token:<token>@github.com 等）。
	// トークンをモバイルへ送らない・ブラウザURLに露出させないため必ず除去する。
	try {
		const parsed = new URL(url);
		parsed.username = '';
		parsed.password = '';
		url = parsed.toString();
	} catch {
		return undefined;
	}
	return url.replace(/\/$/, '').replace(/\.git$/, '');
}
