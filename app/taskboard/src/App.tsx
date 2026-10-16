// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ITaskBoardRepositoryChoice, ITaskBoardRpc, ITaskBoardSnapshot, ITaskBoardTask, TaskBoardRpcMethod } from '@engine/paradisTaskBoard.js';
import { connect, onNotice, reconnectNow, rpc, RpcError, useBoard } from './api.js';
import { Board, Dock } from './components/Board.js';
import { AddTaskDialog, ConfirmDialog, ShortcutsDialog } from './components/dialogs.js';
import { FlowEditor } from './components/FlowEditor.js';
import { Inbox } from './components/Inbox.js';
import { ListView } from './components/ListView.js';
import { defaultTab, Panel } from './components/Panel.js';
import { Menu, Spinner, tone } from './components/atoms.js';
import { AppContext, useApp, type IApp, type IToast, type TabId, type ViewId } from './context.js';
import { ago, needs, noticeText, number, rpcErrorText } from './format.js';
import { useNow, usePhone, useStored, useTheme, type ThemeMode } from './hooks.js';
import { Icon, type IconName } from './icons.js';

/* ---------------- URL と画面の状態 ---------------- */

interface IRoute {
	readonly view: ViewId;
	readonly taskId?: string;
	readonly tab?: TabId;
}

const VIEWS: readonly ViewId[] = ['board', 'inbox', 'list', 'flow'];
const TABS: readonly TabId[] = ['issue', 'pr', 'progress', 'plan', 'mock', 'artifacts', 'terminal'];

function parseHash(hash: string): IRoute {
	const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
	const view = VIEWS.find(v => v === parts[0]) ?? 'board';
	if (parts[1] === 'task' && parts[2]) {
		return { view, taskId: parts[2], tab: TABS.find(t => t === parts[3]) };
	}
	return { view };
}

function toHash(route: IRoute): string {
	return `#/${route.view}${route.taskId ? `/task/${encodeURIComponent(route.taskId)}${route.tab ? `/${route.tab}` : ''}` : ''}`;
}

function useRoute(): [IRoute, (route: IRoute, replace?: boolean) => void] {
	const [route, setRoute] = useState<IRoute>(() => parseHash(location.hash));
	useEffect(() => {
		const onHash = () => setRoute(parseHash(location.hash));
		window.addEventListener('hashchange', onHash);
		return () => window.removeEventListener('hashchange', onHash);
	}, []);
	const go = useCallback((next: IRoute, replace = false) => {
		const hash = toHash(next);
		if (hash !== location.hash) {
			if (replace) {
				history.replaceState(null, '', hash);
			} else {
				history.pushState(null, '', hash);
			}
		}
		setRoute(next);
	}, []);
	return [route, go];
}

/* ---------------- 上部 ---------------- */

const VIEW_DEFS: { id: ViewId; label: string; icon: IconName }[] = [
	{ id: 'board', label: 'ボード', icon: 'board' },
	{ id: 'inbox', label: 'あなたの番', icon: 'inbox' },
	{ id: 'list', label: '一覧', icon: 'list' },
	{ id: 'flow', label: 'フロー', icon: 'flow' },
];

function Brand() {
	return (
		<div className="brand">
			<img className="logo" src="/logo-64.png" srcSet="/logo-64.png 1x, /logo-128.png 2x" width="26" height="26" alt="Para Code" />
			<span className="bl">タスクボード</span>
		</div>
	);
}

/** 上部のメニューに出すリポジトリの候補。今のリポジトリと Para Code の接続が変わったら読み直す。 */
function useRepositories(current: string | undefined, connected: boolean | undefined): readonly ITaskBoardRepositoryChoice[] {
	const [items, setItems] = useState<readonly ITaskBoardRepositoryChoice[]>([]);
	useEffect(() => {
		let alive = true;
		if (current) {
			rpc('repositories', {}).then(r => alive && setItems(r.items), () => undefined);
		}
		return () => {
			alive = false;
		};
	}, [current, connected]);
	return items;
}

function TopBar({ attention, theme, setTheme }: { attention: number; theme: ThemeMode; setTheme: (m: ThemeMode) => void }) {
	const app = useApp();
	const s = app.snapshot;
	const flow = s.flows.find(f => f.id === s.activeFlowId) ?? s.flows[0];
	const leased = s.tasks.filter(t => t.place && !t.place.startsWith('manual:'));
	const max = flow.workspace.maxRunning;
	const pool = s.slots.filter(x => x.kind === 'clone-pool');
	const freePool = pool.filter(x => !x.leasedBy && !x.dirty && !x.missing).length;
	const repos = useRepositories(s.runtime.repoPath, s.runtime.agentsConnected);
	const switchTo = (repoPath: string, label: string) => {
		const go = () => app.call('switchRepository', { path: repoPath }, { title: 'リポジトリを切り替えています', body: label, tone: 'blue' });
		// 動いているタスクは止まらない（Para Code のターミナルで続き、戻ると結び直す）が、その間は見えなくなる
		const running = s.tasks.filter(t => t.status === 'working' || t.status === 'preparing' || t.status === 'question' || t.status === 'permission').length;
		if (running === 0) {
			void go();
			return;
		}
		app.showDialog(<ConfirmDialog title={`${label} に切り替えますか`} body={`このリポジトリで ${running} 件のタスクが動いています。切り替えてもエージェントは Para Code のターミナルで続きますが、戻るまでボードには出ません。質問や許可にも、戻るまで答えられません。`} ok="切り替える" onOk={go} />);
	};
	const repoItems = s.runtime.repoPath && repos.length > 1 ? [
		{ label: 'リポジトリ', header: true },
		...repos.map(r => ({ label: r.label, sub: r.source === 'para-code' ? 'Para Code' : undefined, on: r.path === s.runtime.repoPath, run: () => r.path !== s.runtime.repoPath && switchTo(r.path, r.label) })),
		{ separator: true, label: '' },
	] : [];
	return (
		<header className="top">
			<Brand />
			<Menu label="リポジトリとフロー" align="left" items={[
				...repoItems,
				{ label: repoItems.length ? 'フロー' : s.runtime.repoLabel ?? 'リポジトリ未指定', header: true },
				...s.flows.map(f => ({ label: f.name, sub: f.scope === 'builtin' ? '組み込み' : f.scope === 'team' ? '共通' : '個人', on: f.id === s.activeFlowId, run: () => void app.call('setActiveFlow', { flowId: f.id }, { title: '使うフローを切り替えました', body: f.name, tone: 'blue' }) })),
				{ separator: true, label: '' },
				{ label: 'フローを編集', icon: 'flow', run: () => app.setView('flow') },
			]} trigger={(open, toggle) => (
				<button className="picker" onClick={toggle} aria-expanded={open} title="リポジトリとフロー">
					<span className="ellipsis">{s.runtime.repoLabel ?? 'タスクボード'}</span><span className="faint ellipsis">{flow.name}</span><Icon name="chevron" size={12} />
				</button>
			)} />
			<nav className="views" aria-label="表示">
				{VIEW_DEFS.map(v => (
					<button key={v.id} className={app.view === v.id ? 'on' : ''} onClick={() => app.setView(v.id)} aria-current={app.view === v.id ? 'page' : undefined} title={v.label}>
						<Icon name={v.icon} size={14} /><span className="vl">{v.label}</span>{v.id === 'inbox' && attention > 0 && <span className="badge">{attention}</span>}
					</button>
				))}
			</nav>
			<span className="grow" />
			{s.runtime.agents === 'simulated' && (
				<Menu label="シミュレーション" items={[
					{ label: 'エージェントはシミュレーションです', header: true },
					...[0.5, 1, 2, 5, 10].map(v => ({ label: `速さ ×${v}`, on: s.runtime.speed === v, run: () => void app.call('setSpeed', { speed: v }) })),
				]} trigger={(open, toggle) => <button className="sim-chip" onClick={toggle} aria-expanded={open} title="本物の Claude Code / Codex はまだつないでいません"><Icon name="bolt" size={13} /><span className="sl">シミュレーション</span>×{s.runtime.speed}</button>} />
			)}
			{s.runtime.agents === 'para-code' && (
				<span className={`sim-chip ${s.runtime.agentsConnected ? 'live' : ''}`} title={s.runtime.agentsConnected ? '本物の Claude Code / Codex を Para Code で動かしています' : s.runtime.agentsDetail ?? 'Para Code につながっていません'}>
					<Icon name={s.runtime.agentsConnected ? 'bolt' : 'info'} size={13} /><span className="sl">{s.runtime.agentsConnected ? 'Para Code' : 'Para Code 未接続'}</span>
				</span>
			)}
			<div className="meter" title={`作業場所を借りているタスク ${leased.length} / 同時に動かす上限 ${max}`}>
				<span className="lbl">動作中</span>
				<div className="slots">{Array.from({ length: max }, (_, i) => { const t = leased[i]; return <i key={i} className={t ? (needs(t) ? 'need' : t.status === 'preparing' ? 'prep' : 'on') : ''} />; })}</div>
				<b className="num">{leased.length}/{max}</b>
			</div>
			{flow.workspace.kind === 'clone-pool' && pool.length > 0 && <div className="meter pool" title={pool.map(p => `${p.name}${p.leasedBy ? '（貸し出し中）' : p.dirty ? '（未コミットの変更あり）' : p.missing ? '（見つからない）' : ''}`).join('\n')}><span className="lbl">作業場所</span><b className="num">空き {freePool}/{pool.length}</b></div>}
			<Menu label="表示の設定" items={[
				{ label: 'テーマ', header: true },
				{ label: 'ダーク', icon: 'moon', on: theme === 'dark', run: () => setTheme('dark') },
				{ label: 'ライト', icon: 'sun', on: theme === 'light', run: () => setTheme('light') },
				{ label: 'OS に合わせる', icon: 'monitor', on: theme === 'system', run: () => setTheme('system') },
				{ separator: true, label: '' },
				{ label: 'キーボード', icon: 'keyboard', sub: '?', run: () => app.showDialog(<ShortcutsDialog />) },
			]} trigger={(open, toggle) => <button className="btn ghost icon" onClick={toggle} aria-expanded={open} aria-label="表示の設定"><Icon name={theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor'} /></button>} />
			<button className="btn primary" onClick={() => app.showDialog(<AddTaskDialog />)} title="タスクを追加（n）"><Icon name="plus" size={14} /><span className="addlabel">タスクを追加</span></button>
		</header>
	);
}

function FilterBar({ query, setQuery, onlyMine, setOnlyMine }: { query: string; setQuery: (q: string) => void; onlyMine: boolean; setOnlyMine: (v: boolean) => void }) {
	const app = useApp();
	const now = useNow();
	const gh = app.snapshot.github;
	const inputRef = useRef<HTMLInputElement>(null);
	const [syncing, setSyncing] = useState(false);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === '/' && !(e.target as HTMLElement).closest('input, textarea, select, [contenteditable]') && !document.querySelector('.modal-back')) {
				e.preventDefault();
				inputRef.current?.focus();
			}
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, []);
	const limit = gh.graphql;
	return (
		<div className="bar">
			<div className="search">
				<Icon name="search" size={14} />
				<input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} placeholder="タイトル・番号・ラベル・ブランチで絞り込む" aria-label="絞り込み" spellCheck={false} />
				{query ? <button className="clear" onClick={() => setQuery('')} aria-label="絞り込みを消す"><Icon name="close" size={13} /></button> : <kbd>/</kbd>}
			</div>
			<label className="toggle only" title="人の出番があるタスクだけを出す"><input type="checkbox" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} /><Icon name="inbox" size={15} /><span className="tl">自分の番だけ</span></label>
			<span className="grow" />
			<div className="sync" title={gh.error ?? (gh.lastSyncAt ? `最後の同期 ${new Date(gh.lastSyncAt).toLocaleTimeString('ja-JP')}` : '')}>
				<span className={`dotlive ${gh.mode === 'error' ? 'err' : gh.mode === 'off' ? 'off' : ''}`} />
				{gh.mode === 'off' && <span>GitHub につないでいません（見本）</span>}
				{gh.mode === 'connecting' && <span>GitHub に接続しています</span>}
				{gh.mode === 'error' && <span style={{ color: 'var(--red)' }} className="ellipsis">GitHub: {gh.error}</span>}
				{gh.mode === 'ok' && <>
					<span className="lbl">{gh.sourceLabel}</span>
					<span>{gh.syncing ? '同期しています' : gh.lastSyncAt ? `同期 ${ago(gh.lastSyncAt, now)}` : ''}</span>
					{limit && <span className="api num" title="GitHub API（GraphQL）の残り。1 時間ごとに戻ります">API 残り {number(limit.remaining)} / {number(limit.limit)}</span>}
				</>}
				{gh.mode !== 'off' && <button className="btn ghost sm" disabled={syncing || gh.syncing} onClick={async () => { setSyncing(true); await app.call('sync', {}); setSyncing(false); }}>{syncing || gh.syncing ? <Spinner small /> : <Icon name="sync" size={13} />}今すぐ同期</button>}
			</div>
		</div>
	);
}

function NavBar({ attention }: { attention: number }) {
	const app = useApp();
	return (
		<nav className="navbar" aria-label="表示">
			{VIEW_DEFS.map(v => (
				<button key={v.id} className={app.view === v.id ? 'on' : ''} onClick={() => app.setView(v.id)} aria-current={app.view === v.id ? 'page' : undefined}>
					<Icon name={v.icon} />{v.label}{v.id === 'inbox' && attention > 0 && <span className="badge">{attention}</span>}
				</button>
			))}
		</nav>
	);
}

function Toasts({ toasts, dismiss }: { toasts: (IToast & { id: number })[]; dismiss: (id: number) => void }) {
	const app = useApp();
	return (
		<div className="toasts" aria-live="polite">
			{toasts.map(t => (
				<div key={t.id} className={`toast ${t.taskId ? 'click' : ''}`} role="status" onClick={() => { if (t.taskId) { app.openTask(t.taskId); dismiss(t.id); } }}>
					<span className="dot" style={tone(t.tone)} />
					<div style={{ minWidth: 0 }}><b>{t.title}</b>{t.body && <span className="body">{t.body}</span>}</div>
					<button className="btn ghost icon sm" onClick={e => { e.stopPropagation(); dismiss(t.id); }} aria-label="閉じる"><Icon name="close" size={13} /></button>
				</div>
			))}
		</div>
	);
}

/* ---------------- 本体 ---------------- */

function Shell({ snapshot, theme, setTheme }: { snapshot: ITaskBoardSnapshot; theme: ThemeMode; setTheme: (mode: ThemeMode) => void }) {
	const [route, go] = useRoute();
	const phone = usePhone();
	const [query, setQuery] = useState('');
	const [onlyMine, setOnlyMine] = useStored('onlyMine', false);
	const [dialog, setDialog] = useState<ReactNode>(null);
	const [toasts, setToasts] = useState<(IToast & { id: number })[]>([]);
	const seq = useRef(0);
	const snapRef = useRef(snapshot);
	snapRef.current = snapshot;

	const dismiss = useCallback((id: number) => setToasts(list => list.filter(t => t.id !== id)), []);
	const toast = useCallback((t: IToast) => {
		const id = ++seq.current;
		setToasts(list => [...list.slice(-3), { ...t, id }]);
		setTimeout(() => dismiss(id), t.tone === 'red' ? 8000 : 4500);
	}, [dismiss]);

	useEffect(() => onNotice(notice => {
		const text = noticeText(notice, snapRef.current);
		if (text && notice.kind !== 'started') {
			toast({ ...text, taskId: notice.taskId });
		}
	}), [toast]);

	const routeRef = useRef(route);
	routeRef.current = route;
	const app = useMemo<IApp>(() => {
		const flowOf = (task: ITaskBoardTask) => snapshot.flows.find(f => f.id === task.flowId) ?? snapshot.flows.find(f => f.id === snapshot.activeFlowId) ?? snapshot.flows[0];
		const q = query.trim().toLowerCase();
		return {
			snapshot,
			view: route.view,
			selectedId: route.taskId,
			tab: route.tab ?? 'issue',
			query,
			onlyMine,
			setView: view => go({ view }),
			openTask: (taskId, tab) => {
				const task = snapRef.current.tasks.find(t => t.id === taskId);
				go({ view: routeRef.current.view, taskId, tab: tab ?? (task ? defaultTab(task) : 'issue') }, Boolean(routeRef.current.taskId));
			},
			closeTask: () => go({ view: routeRef.current.view }),
			setTab: tab => go({ ...routeRef.current, tab }, true),
			toast,
			showDialog: node => setDialog(node),
			closeDialog: () => setDialog(null),
			call: async <M extends TaskBoardRpcMethod>(method: M, params: ITaskBoardRpc[M]['params'], success?: IToast) => {
				try {
					const result = await rpc(method, params);
					if (success) {
						toast(success);
					}
					return result;
				} catch (err) {
					const e = err instanceof RpcError ? err : new RpcError('internal', (err as Error).message);
					toast({ title: 'できませんでした', body: rpcErrorText(e.code, e.message), tone: 'red' });
					return undefined;
				}
			},
			flowOf,
			matches: task => {
				if (onlyMine && !needs(task)) {
					return false;
				}
				if (!q) {
					return true;
				}
				const hay = [task.title, task.issue ? `#${task.issue.number}` : '', task.branch ?? '', task.agent ?? '', ...task.labels.map(l => l.name), task.pr ? `#${task.pr.number}` : ''].join(' ').toLowerCase();
				return q.split(/\s+/).every(word => hay.includes(word.replace(/^#/, '#')));
			},
		};
	}, [snapshot, route, query, onlyMine, go, toast]);

	const attention = snapshot.tasks.filter(needs).length + snapshot.manual.filter(m => m.status === 'permission' || m.status === 'question').length;
	useEffect(() => {
		document.title = attention ? `(${attention}) タスクボード` : 'タスクボード';
	}, [attention]);

	// 選んでいたタスクが消えたら閉じる（足した直後で、まだスナップショットに届いていないものは待つ）
	const seenIds = useRef(new Set<string>());
	useEffect(() => {
		const ids = new Set(snapshot.tasks.map(t => t.id));
		if (route.taskId && !ids.has(route.taskId) && seenIds.current.has(route.taskId)) {
			go({ view: route.view }, true);
		}
		seenIds.current = ids;
	}, [snapshot.tasks, route, go]);

	// 全体のキー操作
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			if (e.key === 'Escape' && !dialog && route.taskId && !target.closest('input, textarea, select')) {
				go({ view: route.view });
				return;
			}
			if (target.closest('input, textarea, select, [contenteditable]') || dialog || e.metaKey || e.ctrlKey || e.altKey) {
				return;
			}
			if (e.key === '?') {
				setDialog(<ShortcutsDialog />);
			} else if (e.key === 'n') {
				e.preventDefault();
				setDialog(<AddTaskDialog />);
			} else if (!route.taskId && 'bilf'.includes(e.key) && e.key.length === 1) {
				go({ view: ({ b: 'board', i: 'inbox', l: 'list', f: 'flow' } as const)[e.key as 'b'] });
			}
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [dialog, route, go]);

	const showBar = route.view !== 'flow';
	return (
		<AppContext.Provider value={app}>
			<div className={`app ${showBar ? '' : 'no-bar'}`}>
				<TopBar attention={attention} theme={theme} setTheme={setTheme} />
				{showBar ? <FilterBar query={query} setQuery={setQuery} onlyMine={onlyMine} setOnlyMine={setOnlyMine} /> : <div />}
				<ConnectionBanner />
				<main className="main">
					{route.view === 'board' && <Board />}
					{route.view === 'inbox' && <Inbox />}
					{route.view === 'list' && <ListView />}
					{route.view === 'flow' && <FlowEditor />}
					<Panel />
				</main>
				{route.view === 'board' && !route.taskId ? <Dock /> : <div />}
				{phone && <NavBar attention={attention} />}
			</div>
			<Toasts toasts={toasts} dismiss={dismiss} />
			{dialog}
		</AppContext.Provider>
	);
}

function ConnectionBanner() {
	const { connection } = useBoard();
	if (connection === 'open' || connection === 'connecting') {
		return <CodexApprovalBanner />;
	}
	return <div className="banner warn"><Spinner small t="amber" />サーバーとの接続が切れました。再接続しています…<span className="grow" /><button className="btn sm" onClick={reconnectNow}>今すぐ再接続</button></div>;
}

/** Codex がボードへの報告のたびに許可を求める設定のままなら、常に許可にするかを聞く。 */
function CodexApprovalBanner() {
	const app = useApp();
	const [hidden, setHidden] = useState(false);
	const [busy, setBusy] = useState(false);
	const missing = app.snapshot.runtime.codexApprovalMissing ?? [];
	if (hidden || app.snapshot.runtime.agents !== 'para-code' || missing.length === 0) {
		return <div />;
	}
	const approve = async () => {
		setBusy(true);
		const result = await app.call('approveCodexTools', {}, { title: 'Codex の設定に許可を足しました', body: missing.join('、'), tone: 'green' });
		setBusy(false);
		if (result) {
			setHidden(true);
		}
	};
	return (
		<div className="banner warn">
			<Icon name="info" size={14} />
			<span>Codex はボードへの報告（{missing.join('、')}）のたびに許可を求めます。Codex の設定（{(app.snapshot.runtime.codexConfigPaths ?? []).map((p, i) => <code key={p}>{i ? '、' : ''}{p}</code>)}）に、この {missing.length} つだけを常に許可する設定を足しますか。</span>
			<span className="grow" />
			<button className="btn sm" onClick={() => setHidden(true)}>あとで</button>
			<button className="btn sm primary" disabled={busy} onClick={() => void approve()}>設定に足す</button>
		</div>
	);
}

function Splash({ connection }: { connection: string }) {
	return (
		<div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
			<div style={{ textAlign: 'center' }}>
				<Brand />
				<div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center' }}>
					{connection === 'unauthorized' ? <span>トークンが変わりました。サーバーを起動したターミナルの URL を開き直してください。</span> : <><Spinner />サーバーに接続しています</>}
				</div>
			</div>
		</div>
	);
}

export function App() {
	const { snapshot, connection } = useBoard();
	const [theme, setTheme] = useTheme();
	useEffect(() => {
		connect();
	}, []);
	if (!snapshot) {
		return <Splash connection={connection} />;
	}
	return <Shell snapshot={snapshot} theme={theme} setTheme={setTheme} />;
}
