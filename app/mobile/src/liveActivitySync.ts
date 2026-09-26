// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { AppState, type AppStateStatus } from 'react-native';
import {
	endLiveActivity,
	finishLiveActivity,
	isLiveActivitySupported,
	upsertLiveActivity,
	type LiveActivityAttributes,
	type LiveActivityState,
} from '../modules/para-live-activity/index.js';
import { useAppStore } from './appState.js';
import { startStatusSinceTracking, useStatusSince } from './features/pc/statusSinceStore.js';
import {
	buildLiveActivityState,
	decideLiveActivity,
	EMPTY_LIVE_MEMORY,
	fitLiveActivityBudget,
	isOfflineConfirmed,
	isShownForOtherPc,
	LIVE_HEARTBEAT_MS,
	LIVE_OFFLINE_GRACE_MS,
	LIVE_STALE_AFTER_MS,
	liveActivityAttributes,
	liveActivityContentKey,
	nextLiveMemory,
	nextUnreachableSince,
	toOfflineState,
	withoutAttentionDetail,
	type LiveAction,
	type LiveMemory,
	type LiveMode,
} from './liveActivityState.js';
import { reportMobileDiagnosticError } from './mobileDiagnostics.js';
import { loadWidgetSettings, useWidgetSettings } from './widgets/widgetSettingsStore.js';

/**
 * アプリの状態を Live Activity（案 D「状態で切り替え」）へ同期する。中身の組み立てと判断は純関数の
 * `src/liveActivityState.ts`、ここはストアの購読・時刻・ネイティブへの受け渡しだけを持つ。
 *
 * 段階 1（いま）: 更新はアプリの JS が動いている間だけ。止まったら `staleDate`（最後の更新の 2 分後）を
 * 過ぎて灰色の「◯時点」表示になる。動いている間は 1 分ごとに送り直して staleDate を先へ送る。
 * 段階 2 では、`upsert` で受け取る push token を PC へ登録し、PC が同じ形の content-state を作って
 * リレーが `apns-push-type: liveactivity` で送る（ここの判断は PC 側へ移る）。
 */

type AppStoreState = ReturnType<typeof useAppStore.getState>;

/** ストアが変わってから組み立てるまでの間引き（ターミナルの出力で毎秒何度も変わるため）。 */
const EVALUATE_THROTTLE_MS = 500;
/** 中身が同じでも送り直すまでの間（1 分ごとの見直しで確実に送り直すよう、少し短くする）。 */
const RESEND_AFTER_MS = LIVE_HEARTBEAT_MS - 5_000;

let started = false;
let mode: LiveMode = { kind: 'none' };
let memory: LiveMemory = EMPTY_LIVE_MEMORY;
/** 最後に出した「繋がっていたときの」中身（オフライン表示と、背面へ移るときの送り直しに使う）。 */
let lastLive: { attributes: LiveActivityAttributes; state: LiveActivityState } | undefined;
/** 最後に出した中身（オフライン表示を含む）。背面へ移るときに時刻だけ新しくして送り直す。 */
let lastShown: { attributes: LiveActivityAttributes; state: LiveActivityState } | undefined;
let lastKey = '';
let lastShownAt = 0;
let unreachableSince: number | undefined;
let appActive = AppState.currentState === 'active';
let cleanedUp = false;
let wasUnsupported = false;
let evaluateTimer: ReturnType<typeof setTimeout> | undefined;
let offlineTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
/** ネイティブへの呼び出しを順に流す（開始と終了が入れ違わないように）。 */
let queue: Promise<void> = Promise.resolve();

export function startLiveActivitySync(): void {
	if (started) {
		return;
	}
	started = true;
	startStatusSinceTracking();
	useAppStore.subscribe(() => scheduleEvaluate());
	useStatusSince.subscribe(() => scheduleEvaluate());
	// 質問文とコマンドを載せるかはウィジェットの設定に従う。読み終えた・変えたら出し直す。
	useWidgetSettings.subscribe((next, before) => {
		if (next.settings.showDetail !== before.settings.showDetail) {
			scheduleEvaluate();
		}
	});
	void loadWidgetSettings().catch(() => undefined);
	AppState.addEventListener('change', onAppStateChange);
	startHeartbeat();
	// subscribe はストア変化時にしか発火しないため、購読開始時点の状態も反映する。
	evaluate();
}

function scheduleEvaluate(): void {
	if (evaluateTimer !== undefined) {
		return;
	}
	evaluateTimer = setTimeout(() => {
		evaluateTimer = undefined;
		evaluate();
	}, EVALUATE_THROTTLE_MS);
}

function onAppStateChange(next: AppStateStatus): void {
	const wasActive = appActive;
	appActive = next === 'active';
	if (appActive && !wasActive) {
		// 背面の間に切れていたのは PC が落ちたのではない。繋ぎ直しを待つ猶予を数え直す。
		unreachableSince = undefined;
		evaluate();
		return;
	}
	if (next === 'background') {
		clearOfflineTimer();
		refreshBeforeSuspend();
	}
}

/**
 * 1 分ごとに見直す（中身が同じでも送り直して staleDate を先へ送る）。アプリが止まれば発火しないので
 * 止める必要は無い。音声通知で背面でも動いていて PC に繋がっている間は、送り直しが続く。
 */
function startHeartbeat(): void {
	if (heartbeatTimer !== undefined) {
		return;
	}
	heartbeatTimer = setInterval(() => evaluate(), LIVE_HEARTBEAT_MS);
}

function clearOfflineTimer(): void {
	if (offlineTimer !== undefined) {
		clearTimeout(offlineTimer);
		offlineTimer = undefined;
	}
}

function isReachable(state: AppStoreState): boolean {
	return state.connection === 'online' && state.pcOnline && state.workspace?.complete === true;
}

function evaluate(): void {
	if (!isLiveActivitySupported()) {
		// ライブアクティビティの許可（設定アプリで切り替えられる）を含むので、毎回問い合わせる。
		wasUnsupported = true;
		return;
	}
	if (wasUnsupported) {
		// 許可がオンに戻った。前回の比較を捨てて出し直す。
		wasUnsupported = false;
		lastKey = '';
	}
	const state = useAppStore.getState();
	if (!state.ready) {
		return;
	}
	const now = Date.now();
	const pcId = state.activePcId;
	const pc = pcId === undefined ? undefined : state.pcs.find(item => item.id === pcId);
	if (pcId === undefined || pc === undefined) {
		if (mode.kind !== 'none') {
			mode = { kind: 'none' };
			run({ kind: 'end' }, undefined);
		}
		return;
	}
	const reachable = isReachable(state);
	unreachableSince = nextUnreachableSince(unreachableSince, reachable, now);
	const attributes = liveActivityAttributes(pcId, pc.name);
	let next: LiveActivityState;
	if (reachable) {
		clearOfflineTimer();
		const terminals = state.workspace?.terminals ?? [];
		const statusSince = useStatusSince.getState().map;
		memory = nextLiveMemory(memory, { pcId, terminals, statusSince, alive: mode.kind === 'active', now });
		next = buildLiveActivityState({
			terminals,
			chats: state.agentChats,
			statusSince,
			memory,
			...(state.workspace?.battery !== undefined ? { battery: state.workspace.battery } : {}),
			includeDetail: useWidgetSettings.getState().settings.showDetail,
			now,
		});
	} else {
		// 繋がっていない間は、ターミナルの一覧から「全部終わった」を判断しない（一覧が空になっていることがある）。
		// 前面で出している間だけ、猶予を過ぎたらオフライン表示にする。背面では止まる前の中身のまま置く。
		if (isShownForOtherPc(mode, pcId)) {
			// 繋がらない PC へ切り替えた。前の PC の中身を出したままにしない。
			clearOfflineTimer();
			mode = { kind: 'none' };
			run({ kind: 'end' }, undefined);
			return;
		}
		const last = lastLive;
		if (!appActive || mode.kind !== 'active' || last === undefined || last.attributes.pcId !== pcId) {
			return;
		}
		if (!isOfflineConfirmed(unreachableSince, now)) {
			scheduleOfflineCheck(now);
			return;
		}
		next = toOfflineState(applyDetailSetting(last.state), pc.lastOnlineAt, now);
	}
	const decision = decideLiveActivity(mode, next, pcId, now);
	mode = decision.mode;
	if (decision.action.kind === 'keep' && !cleanedUp && mode.kind === 'none') {
		// 前回の起動で出したまま残っているもの（アプリが落ちて終えられなかった）を片付ける。
		// 完了の要約として残しているものは消さない。
		cleanedUp = true;
		enqueue(() => endLiveActivity(false), 'end');
		return;
	}
	cleanedUp = true;
	run(decision.action, attributes);
}

function scheduleOfflineCheck(now: number): void {
	if (offlineTimer !== undefined || unreachableSince === undefined) {
		return;
	}
	const wait = Math.max(0, unreachableSince + LIVE_OFFLINE_GRACE_MS - now) + 50;
	offlineTimer = setTimeout(() => {
		offlineTimer = undefined;
		evaluate();
	}, wait);
}

function run(action: LiveAction, attributes: LiveActivityAttributes | undefined): void {
	const now = Date.now();
	switch (action.kind) {
		case 'keep':
			return;
		case 'show': {
			if (attributes === undefined) {
				return;
			}
			const fitted = fitLiveActivityBudget(attributes, action.state);
			const key = liveActivityContentKey(attributes, fitted);
			if (action.state.phase !== 'offline') {
				lastLive = { attributes, state: action.state };
			}
			lastShown = { attributes, state: action.state };
			if (key === lastKey && now - lastShownAt < RESEND_AFTER_MS) {
				return;
			}
			lastKey = key;
			lastShownAt = now;
			enqueue(() => upsertLiveActivity(attributes, fitted, now + LIVE_STALE_AFTER_MS), 'upsert');
			return;
		}
		case 'finish': {
			lastKey = '';
			lastLive = undefined;
			lastShown = undefined;
			const fitted = attributes === undefined ? action.state : fitLiveActivityBudget(attributes, action.state);
			enqueue(() => finishLiveActivity(fitted, action.dismissAt), 'finish');
			return;
		}
		case 'end':
			lastKey = '';
			lastLive = undefined;
			lastShown = undefined;
			enqueue(() => endLiveActivity(true), 'end');
			return;
	}
}

/**
 * 背面へ移るとき、最後の中身を時刻だけ新しくして送り直す（ここから staleDate の 2 分を数える）。
 * 背面へ移るとアプリがリレーとの接続を止めるので、ストアから組み立て直さず直前に出した中身を使う。
 */
function refreshBeforeSuspend(): void {
	const last = lastShown;
	if (mode.kind !== 'active' || last === undefined || !isLiveActivitySupported()) {
		return;
	}
	const now = Date.now();
	const state = { ...applyDetailSetting(last.state), updatedAt: now };
	const fitted = fitLiveActivityBudget(last.attributes, state);
	lastKey = liveActivityContentKey(last.attributes, fitted);
	lastShownAt = now;
	enqueue(() => upsertLiveActivity(last.attributes, fitted, now + LIVE_STALE_AFTER_MS), 'upsert');
}

/** 設定で質問文とコマンドをオフにしたら、前に出した中身からも外す（オフライン表示・背面へ移るときの送り直し）。 */
function applyDetailSetting(state: LiveActivityState): LiveActivityState {
	return useWidgetSettings.getState().settings.showDetail ? state : withoutAttentionDetail(state);
}

function enqueue(task: () => Promise<void>, operation: string): void {
	queue = queue
		.then(task)
		.catch((error: unknown) => {
			// 次の変化で出し直す。
			lastKey = '';
			reportMobileDiagnosticError('liveActivity', operation, error);
		});
}
