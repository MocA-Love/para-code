/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { Channels, encodeNotify, NotifyKind, NotifyPayload } from '../common/paradisMobileProtocol.js';
import { IParadisGitResult, IParadisMobileInboundFrame, IParadisMobileInboundFrame as InboundFrame } from '../common/paradisMobileRelay.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** ワークスペース状態スナップショット（stateチャネルのペイロード）。 */
interface StateSnapshot {
	activeWs: string | undefined;
	workspaces: { id: string; name: string; color?: string; branch?: string }[];
	terminals: { id: number; title: string; ws?: string; agentStatus?: string }[];
}

/** ターミナルのサブプロトコル（termチャネルのペイロード、JSON）。 */
type TermInbound =
	| { t: 'attach'; id: number }
	| { t: 'detach'; id: number }
	| { t: 'input'; id: number; data: string }
	| { t: 'create'; ws?: string };
type TermOutbound =
	| { t: 'data'; id: number; data: string }
	| { t: 'exit'; id: number };

/** scm チャネルのサブプロトコル（JSON、リクエスト/レスポンス）。 */
type ScmInbound =
	| { t: 'status'; id: string; ws: string }
	| { t: 'diff'; id: string; ws: string; path?: string; staged?: boolean }
	| { t: 'commit'; id: string; ws: string; message: string; all?: boolean }
	| { t: 'log'; id: string; ws: string };

/** fs チャネルのサブプロトコル（JSON、リクエスト/レスポンス）。 */
type FsInbound =
	| { t: 'list'; id: string; ws: string; path: string }
	| { t: 'read'; id: string; ws: string; path: string };

const FS_READ_LIMIT = 256 * 1024; // ファイル読み取り上限（バイト）
const TERM_SCROLLBACK_LIMIT = 16 * 1024; // attach時に送る直近バッファ上限（文字）

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

	constructor(
		private readonly sendFrame: (frame: IParadisMobileInboundFrame) => void,
		private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		private readonly terminalService: ITerminalService,
		private readonly terminalScopeService: IParadisTerminalScopeService,
		private readonly agentStatusStore: IParadisAgentStatusStore,
		private readonly logService: ILogService,
		private readonly fileService: IFileService,
		private readonly runGit: (repoPath: string, args: readonly string[]) => Promise<IParadisGitResult>,
	) {
		super();

		// 状態が変わったらスナップショットを再送。エージェント状態の変化は通知判定も行う。
		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => { this.refreshBranches(); this.pushState(); }));
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this.pushState()));
		this._register(this.agentStatusStore.onDidChangeAgentStatuses(() => { this.detectAndNotify(); this.pushState(); }));
		this._register(this.terminalService.onDidChangeInstances(() => this.pushState()));
		this.refreshBranches();
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
	private detectAndNotify(): void {
		for (const inst of this.terminalService.instances) {
			const stateKey = this.terminalScopeService.getStateKeyForInstance(inst.instanceId);
			if (!stateKey) {
				continue;
			}
			const status = this.agentStatusStore.getScopeStatus(stateKey);
			const prev = this.previousScopeStatus.get(stateKey);
			if (status && status !== prev) {
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
		const wsName = this.workspaceSwitchService.repositories.find(r => r.id === ws)?.name ?? ws;
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
		const workspaces = this.workspaceSwitchService.repositories.map(r => ({
			id: r.id,
			name: r.name,
			...(r.color ? { color: r.color } : {}),
			...(this.branchCache.has(r.id) ? { branch: this.branchCache.get(r.id) } : {}),
		}));
		const terminals = this.terminalService.instances.map(inst => {
			const stateKey = this.terminalScopeService.getStateKeyForInstance(inst.instanceId);
			const agentStatus = stateKey ? this.agentStatusStore.getScopeStatus(stateKey) : undefined;
			return {
				id: inst.instanceId,
				title: inst.title,
				...(stateKey ? { ws: stateKey } : {}),
				...(agentStatus ? { agentStatus } : {}),
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

	// --- scm チャネル -----------------------------------------------------------

	private repoPathForWs(ws: string): string | undefined {
		const repo = this.workspaceSwitchService.repositories.find(r => r.id === ws);
		return repo?.uri.scheme === 'file' ? repo.uri.fsPath : undefined;
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
			} else if (msg.t === 'log') {
				const result = await this.runGit(repoPath, ['log', '-n', '8', '--pretty=format:%h%x09%ar%x09%s']);
				const commits = result.stdout.split('\n').filter(l => l.includes('\t')).map(line => {
					const [hash, when, ...subject] = line.split('\t');
					return { hash, when, subject: subject.join('\t') };
				});
				reply({ t: 'log', commits });
			}
		} catch (err) {
			reply({ error: String(err) });
		}
	}

	// --- fs チャネル ------------------------------------------------------------

	/** ワークスペースルート配下に正規化したURIを返す（../ 等の脱出は拒否）。 */
	private resolveWorkspacePath(ws: string, relPath: string): URI | undefined {
		const repo = this.workspaceSwitchService.repositories.find(r => r.id === ws);
		if (!repo) {
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
		return segments.length === 0 ? repo.uri : joinPath(repo.uri, ...segments);
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
		const repo = this.workspaceSwitchService.repositories.find(r => r.id === ws);
		if (!repo) {
			return undefined;
		}
		const real = await this.fileService.realpath(uri);
		if (!real) {
			return undefined;
		}
		const rootPath = repo.uri.path.endsWith('/') ? repo.uri.path : `${repo.uri.path}/`;
		if (real.path !== repo.uri.path && !real.path.startsWith(rootPath)) {
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
		const uri = await this.resolveWorkspacePathReal(msg.ws, msg.path);
		if (!uri) {
			reply({ error: `invalid path: ${msg.path}` });
			return;
		}
		try {
			if (msg.t === 'list') {
				const stat = await this.fileService.resolve(uri);
				const entries = (stat.children ?? [])
					.filter(c => !c.isSymbolicLink) // シンボリックリンク越えの読み取りを防止（設計書 §8）
					.map(c => ({ name: c.name, dir: c.isDirectory, size: c.size }))
					.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
				reply({ t: 'list', entries });
			} else if (msg.t === 'read') {
				const stat = await this.fileService.stat(uri);
				const content = await this.fileService.readFile(uri, { length: FS_READ_LIMIT });
				reply({ t: 'read', content: content.value.toString(), truncated: (stat.size ?? 0) > FS_READ_LIMIT, size: stat.size ?? 0 });
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
			// モバイルからの新規ターミナル作成。ws指定時はそのリポジトリをcwdにする。
			// 作成に伴う onDidChangeInstances で state が自動再送されるため応答は不要。
			const repo = msg.ws ? this.workspaceSwitchService.repositories.find(r => r.id === msg.ws) : undefined;
			this.terminalService.createTerminal(repo ? { cwd: repo.uri } : undefined)
				.catch(err => this.logService.warn('[paradisMobileRelay] createTerminal failed', err));
			return;
		}
		const instance = this.terminalService.instances.find(i => i.instanceId === msg.id);
		if (!instance) {
			return;
		}
		if (msg.t === 'attach') {
			// 出力はattachを要求したモバイルにのみ返す（M-2）。再attachは宛先を更新する。
			this.terminalSubscribers.set(msg.id, mobileId ?? '');
			// scrollback初期同期: 直近バッファ末尾を送って「PCで作業していた続き」を見せる（設計書 §4.2）
			try {
				const contents = instance.xterm?.getContentsAsText();
				if (contents) {
					const tail = contents.length > TERM_SCROLLBACK_LIMIT ? contents.slice(-TERM_SCROLLBACK_LIMIT) : contents;
					this.sendTerm({ t: 'data', id: msg.id, data: tail.endsWith('\n') ? tail : tail + '\r\n' });
				}
			} catch (err) {
				this.logService.warn('[paradisMobileRelay] scrollback sync failed', err);
			}
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

	private sendTerm(msg: TermOutbound): void {
		const target = this.terminalSubscribers.get(msg.id);
		this.sendFrame({ ch: Channels.Terminal, ws: undefined, seq: 0, payload: VSBuffer.wrap(encoder.encode(JSON.stringify(msg))), mobileId: target || undefined });
	}
}
