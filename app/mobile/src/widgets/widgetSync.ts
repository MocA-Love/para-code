// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { AppState, type AppStateStatus } from 'react-native';
import {
	isWidgetStoreAvailable,
	readWidgetFile,
	reloadWidgets,
	removeWidgetOutboxEntries,
	writeWidgetFileIfUnchanged,
} from '../../modules/para-live-activity/index.js';
import { useAppStore } from '../appState.js';
import { localRelayWindowId } from '../relayHosts.js';
import { startStatusSinceTracking, useStatusSince } from '../features/pc/statusSinceStore.js';
import {
	buildWidgetSnapshot,
	mergeUnviewedPcsFromDisk,
	outboxSentKey,
	parseWidgetOutbox,
	parseWidgetSnapshot,
	planWidgetOutbox,
	snapshotContentKey,
	type SnapshotActiveInput,
	type WidgetOutboxEntry,
	type WidgetSnapshot,
	type WidgetUsage,
} from './snapshot.js';
import { buildWidgetUsage } from './usage.js';
import { loadWidgetSettings, persistWidgetSettings, startWidgetThemeWatch, useWidgetSettings } from './widgetSettingsStore.js';

/**
 * アプリの状態をウィジェットの要約（App Group の `widget-snapshot.json`）へ書き出す
 * （`src/liveActivitySync.ts` と同じく、起動時に1回 `startWidgetSync()` を呼ぶ）。
 *
 * 書く場面は2つ（調査の結論の (a)）:
 *  - アプリが前面にいる間: ストアが変わったら間引いて書く（中身が同じでも1分に1回は書き、「◯分前」を 0 に戻す）
 *  - バックグラウンドへ移るとき: その時点の状態で必ず書く
 * 書いたら WidgetCenter でリロードする（前面にいる間のリロードはウィジェットの予算に数えられない）。
 *
 * あわせて、ウィジェットの「確認済みにする」の積み置きを読み、いま見ている PC に繋がったら既存の
 * 「確認済みにする」（`ackAgentStatus`）で送る。PC 上で未確認でなくなったら積み置きから消す。
 *
 * C（PC の状態）のコストと上限、D（スペース）の変更とコミットは、アプリが前面にいる間だけ既存の要求
 * （`rateLimits` / `usageDashboard` / `scmStatus` / `scmLog`）で取る。どちらも間隔を空けて取り、
 * PC への負荷を増やしすぎない。
 */

const SNAPSHOT_FILE = 'widget-snapshot.json';
const OUTBOX_FILE = 'widget-outbox.json';
/** 前面にいる間、変化があってから書くまでの間引き。 */
const WRITE_THROTTLE_MS = 2_000;
/** 中身が同じでも書き直す間隔（「◯分前の状態」を 0 に戻すため）。 */
const REFRESH_INTERVAL_MS = 60_000;
/** コストと上限を取り直す間隔。PC 側もキャッシュを持つ。 */
const USAGE_INTERVAL_MS = 10 * 60_000;
/** スペースの変更・コミットを取り直す間隔。 */
const SCM_INTERVAL_MS = 5 * 60_000;
/** 変更・コミットを取るスペースの数の上限（エージェントのいるスペースと、いま見ているスペースを優先）。 */
const SCM_SPACES_MAX = 6;

type AppStoreState = ReturnType<typeof useAppStore.getState>;
type ScmEntry = SnapshotActiveInput['scm'] extends ReadonlyMap<string, infer V> ? V : never;

let started = false;
let previous: WidgetSnapshot | undefined;
let lastKey = '';
let lastWriteAt = 0;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let writing: Promise<void> = Promise.resolve();
/** 組み立てるたびに進める。書き終えた要約を `previous` に戻すのは、その後に組み立て直していないときだけ。 */
let generation = 0;
let outbox: WidgetOutboxEntry[] = [];
const sentOutbox = new Set<string>();
const usageByPc = new Map<string, { usage: WidgetUsage | undefined; at: number }>();
const scmByPc = new Map<string, Map<string, ScmEntry>>();
const scmFetchedAt = new Map<string, number>();
let usageInFlight = false;
let scmInFlight = false;
let appActive = AppState.currentState === 'active';

export function startWidgetSync(): void {
	if (started) {
		return;
	}
	started = true;
	if (!isWidgetStoreAvailable()) {
		return;
	}
	startStatusSinceTracking();
	startWidgetThemeWatch();
	void Promise.all([
		readPreviousSnapshot(),
		readOutbox(),
		// 設定はアプリが書くまでウィジェットに届かないので、読み終えたら1度書き戻す（accentHex を入れるため）。
		loadWidgetSettings().then(() => persistWidgetSettings()).catch(() => undefined),
	]).finally(() => {
		useAppStore.subscribe(() => scheduleWrite());
		useStatusSince.subscribe(() => scheduleWrite());
		useWidgetSettings.subscribe((next, before) => {
			if (next.settings.showDetail !== before.settings.showDetail) {
				scheduleWrite();
			}
		});
		AppState.addEventListener('change', onAppStateChange);
		startRefreshTimer();
		scheduleWrite();
	});
}

function onAppStateChange(state: AppStateStatus): void {
	const wasActive = appActive;
	appActive = state === 'active';
	if (appActive && !wasActive) {
		// ウィジェットで確認済みにしたもの・閉じている間に通知拡張が書き換えたもの（見ていない PC の要対応）を
		// 拾い直す。いま見ている PC のぶんは、繋がり次第ストアの状態で作り直される。
		void Promise.all([readOutbox(), readPreviousSnapshot()]).then(() => scheduleWrite());
		startRefreshTimer();
		return;
	}
	if (state === 'background') {
		stopRefreshTimer();
		// 閉じる時点の状態を必ず書く（閉じている間ウィジェットはこの状態から「◯分前」だけ進む）。
		flush(true);
	}
}

function startRefreshTimer(): void {
	if (refreshTimer !== undefined) {
		return;
	}
	refreshTimer = setInterval(() => {
		if (appActive) {
			flush(false);
		}
	}, REFRESH_INTERVAL_MS);
}

function stopRefreshTimer(): void {
	if (refreshTimer !== undefined) {
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	}
}

function scheduleWrite(): void {
	if (!appActive || writeTimer !== undefined) {
		return;
	}
	const wait = Math.max(0, WRITE_THROTTLE_MS - (Date.now() - lastWriteAt));
	writeTimer = setTimeout(() => {
		writeTimer = undefined;
		flush(false);
	}, wait);
}

function flush(force: boolean): void {
	if (writeTimer !== undefined) {
		clearTimeout(writeTimer);
		writeTimer = undefined;
	}
	const state = useAppStore.getState();
	if (!state.ready) {
		return;
	}
	const now = Date.now();
	processOutbox(state);
	const active = activeInput(state);
	const includeDetail = useWidgetSettings.getState().settings.showDetail;
	if (appActive) {
		maybeFetchUsage(state, now);
		maybeFetchScm(state, now);
	}
	const snapshot = buildWidgetSnapshot({
		ready: state.ready,
		pcs: appActive ? state.pcs : keepOnlineWhileBackgrounding(state.pcs),
		activePcId: state.activePcId,
		active,
		includeDetail,
		outbox,
	}, previous, now);
	const key = snapshotContentKey(snapshot);
	if (!force && key === lastKey && now - lastWriteAt < REFRESH_INTERVAL_MS) {
		return;
	}
	lastKey = key;
	lastWriteAt = now;
	previous = snapshot;
	const livePcId = active !== undefined ? state.activePcId : undefined;
	const written = ++generation;
	writing = writing
		.then(() => writeMergedSnapshot(snapshot, livePcId, includeDetail))
		.then(merged => {
			if (written === generation) {
				previous = merged;
			}
			reloadWidgets();
		})
		.catch(() => { lastKey = ''; /* 次の変化で書き直す */ });
}

/** 読み直しても書く間に変わり続けたときに諦めるまでの回数。 */
const MERGE_WRITE_ATTEMPTS = 3;

/**
 * 書く直前に App Group の要約を読み直し、前面の間に通知拡張が書いた「見ていない PC の要対応」を
 * 合わせてから書く（`mergeUnviewedPcsFromDisk`）。読んでから書くまでに書き換えられていたら読み直す。
 */
async function writeMergedSnapshot(snapshot: WidgetSnapshot, livePcId: string | undefined, includeDetail: boolean): Promise<WidgetSnapshot> {
	for (let attempt = 0; attempt < MERGE_WRITE_ATTEMPTS; attempt++) {
		const raw = await readWidgetFile(SNAPSHOT_FILE);
		const merged = mergeUnviewedPcsFromDisk(snapshot, parseWidgetSnapshot(raw), livePcId, includeDetail);
		if (await writeWidgetFileIfUnchanged(SNAPSHOT_FILE, raw, JSON.stringify(merged))) {
			return merged;
		}
	}
	throw new Error('widget snapshot changed while writing');
}

/**
 * 背面へ移るときはアプリ側がリレーとの接続を止める（`suspendForBackground` が PC を「オフライン」に落とす）。
 * それは PC が落ちたのではないので、ウィジェットには直前まで前面で見ていた接続の状態を残す。
 */
function keepOnlineWhileBackgrounding(pcs: AppStoreState['pcs']): AppStoreState['pcs'] {
	return pcs.map(pc => {
		const before = previous?.pcs.find(item => item.id === pc.id);
		if (before === undefined || (pc.connection === 'online' && pc.pcOnline)) {
			return pc;
		}
		return { ...pc, connection: before.online ? 'online' : pc.connection, pcOnline: before.online };
	});
}

function activeInput(state: AppStoreState): SnapshotActiveInput | undefined {
	const workspace = state.workspace;
	const pcId = state.activePcId;
	if (workspace === undefined || pcId === undefined || workspace.complete !== true) {
		return undefined;
	}
	return {
		workspaces: workspace.workspaces,
		terminals: workspace.terminals,
		chats: state.agentChats,
		...(workspace.resources !== undefined ? { resources: workspace.resources } : {}),
		statusSince: useStatusSince.getState().map,
		...(usageByPc.get(pcId)?.usage !== undefined ? { usage: usageByPc.get(pcId)?.usage } : {}),
		scm: scmByPc.get(pcId) ?? new Map(),
	};
}

function isOnline(state: AppStoreState): boolean {
	return state.connection === 'online' && state.pcOnline && state.workspace?.complete === true;
}

// --- 積み置き（確認済みにする） ------------------------------------------------------

async function readPreviousSnapshot(): Promise<void> {
	try {
		previous = parseWidgetSnapshot(await readWidgetFile(SNAPSHOT_FILE)) ?? previous;
	} catch {
		// 読めなければ手元の前回ぶんのまま。
	}
}

async function readOutbox(): Promise<void> {
	try {
		outbox = parseWidgetOutbox(await readWidgetFile(OUTBOX_FILE), Date.now());
	} catch {
		// 読めなければ次の前面復帰で読み直す。
	}
}

function processOutbox(state: AppStoreState): void {
	if (outbox.length === 0) {
		return;
	}
	const plan = planWidgetOutbox({
		entries: outbox,
		activePcId: state.activePcId,
		online: isOnline(state),
		terminals: state.workspace?.terminals,
		statusSince: useStatusSince.getState().map,
		alreadySent: sentOutbox,
	});
	for (const entry of plan.send) {
		sentOutbox.add(outboxSentKey(entry));
		state.ackAgentStatus(entry.key);
	}
	if (plan.remove.length > 0) {
		const removed = new Set(plan.remove.map(entry => `${entry.pcId}\u0000${entry.key}\u0000${entry.at}`));
		outbox = outbox.filter(entry => !removed.has(`${entry.pcId}\u0000${entry.key}\u0000${entry.at}`));
		void removeWidgetOutboxEntries(plan.remove).catch(() => undefined);
	}
}

// --- C: コストと上限 ---------------------------------------------------------------

function maybeFetchUsage(state: AppStoreState, now: number): void {
	const pcId = state.activePcId;
	if (pcId === undefined || usageInFlight || !isOnline(state)) {
		return;
	}
	const cached = usageByPc.get(pcId);
	if (cached !== undefined && now - cached.at < USAGE_INTERVAL_MS) {
		return;
	}
	usageInFlight = true;
	usageByPc.set(pcId, { usage: cached?.usage, at: now });
	void Promise.all([
		// この PC のアカウントの値（SSH のウィンドウの接続先のログインに入れ替わらないように）
		state.rateLimits(false, localRelayWindowId(state.workspace?.renderers)).catch(() => undefined),
		state.usageDashboard().catch(() => undefined),
	]).then(([limits, dashboard]) => {
		// 取っている間に PC を切り替えたら捨てる（別の PC の値を混ぜない）。
		if (useAppStore.getState().activePcId !== pcId) {
			return;
		}
		const usage = buildWidgetUsage(limits, dashboard, Date.now());
		usageByPc.set(pcId, { usage: usage ?? cached?.usage, at: Date.now() });
		scheduleWrite();
	}).finally(() => {
		usageInFlight = false;
	});
}

// --- D: スペースの変更とコミット ----------------------------------------------------------

function scmTargets(state: AppStoreState): string[] {
	const workspace = state.workspace;
	if (workspace === undefined) {
		return [];
	}
	const ids = new Set(workspace.workspaces.map(space => space.id));
	const ordered: string[] = [];
	const push = (id: string | undefined) => {
		if (id !== undefined && ids.has(id) && !ordered.includes(id)) {
			ordered.push(id);
		}
	};
	const defaultSpace = useWidgetSettings.getState().settings.space.defaultSpace;
	if (defaultSpace !== undefined && defaultSpace.pcId === state.activePcId) {
		push(defaultSpace.spaceId);
	}
	push(state.selectedWs);
	push(workspace.activeWs);
	for (const terminal of workspace.terminals) {
		if (terminal.agent === true) {
			push(terminal.ws);
		}
	}
	return ordered.slice(0, SCM_SPACES_MAX);
}

function maybeFetchScm(state: AppStoreState, now: number): void {
	const pcId = state.activePcId;
	if (pcId === undefined || scmInFlight || !isOnline(state)) {
		return;
	}
	const due = scmTargets(state).filter(ws => now - (scmFetchedAt.get(`${pcId}\u0000${ws}`) ?? 0) >= SCM_INTERVAL_MS);
	if (due.length === 0) {
		return;
	}
	scmInFlight = true;
	for (const ws of due) {
		scmFetchedAt.set(`${pcId}\u0000${ws}`, now);
	}
	// 1つずつ順に取る（同時に投げて PC を詰まらせない）。
	void due.reduce<Promise<void>>((chain, ws) => chain.then(async () => {
		const current = useAppStore.getState();
		if (current.activePcId !== pcId) {
			return;
		}
		const [status, log] = await Promise.all([
			current.scmStatus(ws).catch(() => undefined),
			current.scmLog(ws, { limit: 3 }).catch(() => undefined),
		]);
		if (status === undefined && log === undefined) {
			return;
		}
		if (useAppStore.getState().activePcId !== pcId) {
			return;
		}
		const spaces = scmByPc.get(pcId) ?? new Map<string, ScmEntry>();
		const before = spaces.get(ws);
		spaces.set(ws, {
			...(status?.branch !== undefined ? { branch: status.branch } : before?.branch !== undefined ? { branch: before.branch } : {}),
			files: status?.files ?? before?.files ?? [],
			commits: log?.commits.map(commit => ({ subject: commit.subject, ...(commit.at !== undefined ? { at: commit.at } : {}) })) ?? before?.commits ?? [],
			at: Date.now(),
		});
		scmByPc.set(pcId, spaces);
	}), Promise.resolve()).finally(() => {
		scmInFlight = false;
		scheduleWrite();
	});
}
