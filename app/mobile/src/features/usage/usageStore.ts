// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFocusEffect, useIsFocused } from 'expo-router';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { agentSendQueueKey, useAppStore, usePcResources, type PcUsageRequester } from '../../appState.js';
import { buildUsageEntries, githubFetchedAt, type SourceUsageValues, type Timed, type UsageEntry, type UsageKind, type UsageSourceInfo } from './usageAggregate.js';
import { openUsageRecord, pruneUsageRecord, sealUsageRecord, usageRecordSignature, type UsageCacheRecord } from './usageCache.js';
import { onUsagePcForgotten, readUsageCacheFiles, removeUsageCacheFile, removeUsageCacheFileNamed, writeUsageCacheFile } from './usageCacheFile.js';
import { UsageInFlight, UsageRequestLimiter, applyUsageResult, isFreshEnough, mergeLoadedRecords } from './usageFetchCore.js';
import { buildUsageSources, type UsageSourceRoute } from './usageSources.js';
import { carryVoiceResult } from './voiceUsageModel.js';
import type { VoiceUsageResult } from './voiceUsageWire.js';

/**
 * 使用量の値を、全 PC（と SSH の接続先）から集めて持つ場所（全 PC の合計・案 B）。
 *
 * - 要求は PC ごとのコントローラへ名指しで送る（`usageRequesterFor`）。いま見ていない PC も接続を保っていれば届く
 * - 出どころ・指標ごとに、成功から `maxAgeMs` 以内なら送らない（ホームは 5 分）。同時に送るのは 4 本まで
 * - SSH の接続先はホーム・ウィジェットでは取らず（保存済みの値を合計に使う）、使用量の画面でだけ取る
 * - 取れた値は出どころごとに取得時刻つきで持ち、その PC の通知鍵で封緘して端末に 7 日残す（`usageCache.ts`）。
 *   オフラインの PC は、この最後の値を薄く出して合計に入れる
 *
 * 画面は {@link useUsageOverview} で読み、{@link useUsageAutoRefresh} で前面に来たときに取りに行く。
 * システム（6 秒ごとの詳細）はここに入れない（「すべて」では desktop state の CPU・メモリ・SSD だけを使う）。
 *
 * 「今日」は端末の日付で数える（PC と端末のタイムゾーンが違うと、PC の日付の行とずれることがある）。
 */

const PERSIST_DELAY_MS = 1_500;
/** 既定で、成功から何ミリ秒は送り直さないか（使用量の画面）。 */
export const USAGE_SCREEN_MAX_AGE_MS = 60_000;
/** ホーム・ウィジェットでの間隔。 */
export const USAGE_HOME_MAX_AGE_MS = 5 * 60_000;

export interface UsageRefreshOptions {
	/** PC 側のキャッシュを無視して取り直す（引っ張って更新）。成功からの間隔も見ない。 */
	readonly bypassCache?: boolean;
	/** この出どころだけ。 */
	readonly sourceKeys?: readonly string[];
	/** この PC（と、その PC の接続先）だけ。 */
	readonly pcIds?: readonly string[];
	/** 成功からこの時間以内なら送らない（既定は {@link USAGE_SCREEN_MAX_AGE_MS}）。 */
	readonly maxAgeMs?: number;
	/** SSH の接続先も取るか（既定は true。ホーム・ウィジェットは false）。 */
	readonly includeSsh?: boolean;
}

interface UsageStoreState {
	/** 出どころの鍵 → 最後に取れた値。 */
	readonly records: Readonly<Record<string, UsageCacheRecord>>;
	/** `出どころの鍵|指標` → 直近の取得の失敗（成功したら消す）。 */
	readonly errors: Readonly<Record<string, unknown>>;
	/** `出どころの鍵|指標` → 取りに行っている最中。 */
	readonly loading: Readonly<Record<string, true>>;
	readonly loaded: boolean;
	/** ペアリング済みの PC の控えを読む（まだ読んでいない PC だけ）。 */
	load(): Promise<void>;
	/** オンラインの出どころから取り直す。 */
	refresh(kinds: readonly UsageKind[], options?: UsageRefreshOptions): Promise<void>;
}

const loadedPcs = new Set<string>();
/**
 * 解除した PC。解除の後に届いた応答・書き込みは捨てる（その PC の値を残さない）。同じ ID の PC がまたペアリングされ、
 * そのコントローラができたら外す（{@link forgottenStill}）。
 */
const forgottenPcs = new Set<string>();

/** 解除した PC のままか（同じ ID でペアリングし直されていれば外す）。 */
function forgottenStill(pcId: string): boolean {
	if (forgottenPcs.has(pcId) && useAppStore.getState().usageRequesterFor(pcId) !== undefined && useAppStore.getState().pcs.some(pc => pc.id === pcId)) {
		forgottenPcs.delete(pcId);
	}
	return forgottenPcs.has(pcId);
}
const loadingPcs = new Map<string, Promise<void>>();
const inFlight = new UsageInFlight();
const limiter = new UsageRequestLimiter();
/** `出どころ|指標` → 最後に成功した時刻（受け取った時刻）。 */
const lastSuccess = new Map<string, number>();
/** 出どころ → 最後に書いたときの印（変わらなければ書かない）。 */
const lastWritten = new Map<string, string>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function usageStateKey(sourceKey: string, kind: UsageKind): string {
	return `${sourceKey}|${kind}`;
}

function schedulePersist(sourceKey: string): void {
	if (persistTimers.has(sourceKey)) {
		return;
	}
	persistTimers.set(sourceKey, setTimeout(() => {
		persistTimers.delete(sourceKey);
		const record = useUsageStore.getState().records[sourceKey];
		if (record === undefined || forgottenStill(record.pcId)) {
			return;
		}
		const now = Date.now();
		const pruned = pruneUsageRecord(record, now);
		const key = agentSendQueueKey(record.pcId);
		if (key === undefined) {
			return;
		}
		if (pruned === undefined) {
			lastWritten.delete(sourceKey);
			void removeUsageCacheFile(record.pcId, sourceKey).catch(() => undefined);
			return;
		}
		const signature = usageRecordSignature(pruned);
		if (lastWritten.get(sourceKey) === signature) {
			return;
		}
		lastWritten.set(sourceKey, signature);
		writeUsageCacheFile(record.pcId, sourceKey, sealUsageRecord(key, sourceKey, pruned, now))
			// 書いている間に解除されたら、書いたファイルも消す
			.then(() => (forgottenPcs.has(record.pcId) ? removeUsageCacheFile(record.pcId, sourceKey) : undefined))
			.catch((error: unknown) => {
				lastWritten.delete(sourceKey);
				console.warn('[usage] failed to save the last values', error);
			});
	}, PERSIST_DELAY_MS));
}

async function loadPc(pcId: string): Promise<void> {
	const key = agentSendQueueKey(pcId);
	if (key === undefined || forgottenStill(pcId)) {
		return;
	}
	const now = Date.now();
	const loaded: Record<string, UsageCacheRecord> = {};
	try {
		for (const file of await readUsageCacheFiles(pcId)) {
			const opened = openUsageRecord(key, file.content, pcId, now);
			if (opened !== undefined) {
				loaded[opened.sourceKey] = opened.record;
				lastWritten.set(opened.sourceKey, usageRecordSignature(opened.record));
			} else {
				// 開けない（鍵が変わった・壊れた・期限切れで何も残らない）ファイルは、その場で消す
				void removeUsageCacheFileNamed(file.name).catch(() => undefined);
			}
		}
	} catch (error) {
		console.warn('[usage] failed to read the last values', error);
	}
	if (forgottenPcs.has(pcId)) {
		return;
	}
	loadedPcs.add(pcId);
	// 読んでいる間に取れた値（新しい方）を、ファイルの古い値で上書きしない。
	useUsageStore.setState(state => ({ records: mergeLoadedRecords(state.records, loaded) }));
}

async function request(requester: PcUsageRequester, route: UsageSourceRoute, kind: UsageKind, bypassCache: boolean): Promise<Timed<unknown>> {
	const receivedAt = () => Date.now();
	const stamp = (at: number | undefined) => (at !== undefined && Number.isFinite(at) ? at : Date.now());
	switch (kind) {
		case 'limits': {
			const value = await requester.rateLimits(bypassCache, route.windowId, route.remote);
			return { value, at: stamp(value.fetchedAt), receivedAt: receivedAt() };
		}
		case 'cost': {
			const value = await requester.usageDashboard(bypassCache, route.windowId);
			return { value, at: stamp(value.fetchedAt), receivedAt: receivedAt() };
		}
		case 'rtk': {
			const value = await requester.rtkSavings(bypassCache, route.windowId);
			return { value, at: stamp(value.fetchedAt), receivedAt: receivedAt() };
		}
		case 'github': {
			const value = await requester.githubUsage(bypassCache);
			return { value, at: stamp(githubFetchedAt(value)), receivedAt: receivedAt() };
		}
		case 'voice': {
			// `usage.voice.v1` を広告しない PC には送らず、VoiceUsageUnsupportedError で失敗する（画面は「PC を更新すると出ます」）
			const value = await requester.voiceUsage(bypassCache);
			return { value, at: stamp(value.fetchedAt), receivedAt: receivedAt() };
		}
	}
}

function setLoading(key: string, on: boolean): void {
	useUsageStore.setState(state => {
		if (on === (state.loading[key] === true)) {
			return state;
		}
		const loading = { ...state.loading };
		if (on) {
			loading[key] = true;
		} else {
			delete loading[key];
		}
		return { loading };
	});
}

function fetchOne(source: UsageSourceInfo, route: UsageSourceRoute, requester: PcUsageRequester, kind: UsageKind, bypassCache: boolean): Promise<void> {
	const key = usageStateKey(source.key, kind);
	return inFlight.start(key, bypassCache, isCurrent => {
		setLoading(key, true);
		return limiter.run(() => request(requester, route, kind, bypassCache)).then(result => {
			// 送っている間に PC を解除したら捨てる
			if (forgottenPcs.has(source.pcId)) {
				return;
			}
			lastSuccess.set(key, Date.now());
			useUsageStore.setState(state => {
				const errors = { ...state.errors };
				delete errors[key];
				// 取り直しと前後して届いた古い応答で、新しい値を上書きしない。
				// 読み上げは、片方のエンジンが失敗だけを返したら前回の日別・内訳を引き継ぐ（PC を再起動した直後の失敗でも消さない）
				const applied = kind === 'voice' ? carryVoiceResult(state.records[source.key]?.values.voice, result as Timed<VoiceUsageResult>) : result;
				const records = applyUsageResult(state.records, source, kind, applied);
				return records !== undefined ? { records, errors } : { errors };
			});
			schedulePersist(source.key);
		}, (error: unknown) => {
			// 取り直しに追い越された古い要求の失敗は出さない（新しい要求の結果を待つ）。
			if (isCurrent()) {
				useUsageStore.setState(state => ({ errors: { ...state.errors, [key]: error } }));
			}
		}).finally(() => {
			if (isCurrent()) {
				setLoading(key, false);
			}
		});
	});
}

/** いまの出どころの一覧と、要求を送る先。 */
export function currentUsageSources(records: Readonly<Record<string, UsageCacheRecord>>): ReturnType<typeof buildUsageSources> {
	const app = useAppStore.getState();
	return buildUsageSources(app.pcs, app.usageTargets(), records, usePcResources.getState().byPc);
}

export const useUsageStore = create<UsageStoreState>((set, get) => ({
	records: {},
	errors: {},
	loading: {},
	loaded: false,
	async load() {
		const pcIds = useAppStore.getState().pcs.map(pc => pc.id).filter(id => !loadedPcs.has(id));
		await Promise.all(pcIds.map(id => {
			let job = loadingPcs.get(id);
			if (job === undefined) {
				job = loadPc(id).finally(() => loadingPcs.delete(id));
				loadingPcs.set(id, job);
			}
			return job;
		}));
		if (!get().loaded && useAppStore.getState().ready) {
			set({ loaded: true });
		}
	},
	async refresh(kinds, options = {}) {
		await get().load();
		const app = useAppStore.getState();
		const { sources, routes } = currentUsageSources(get().records);
		const bypass = options.bypassCache === true;
		const maxAge = bypass ? 0 : options.maxAgeMs ?? USAGE_SCREEN_MAX_AGE_MS;
		const now = Date.now();
		const jobs: Promise<void>[] = [];
		for (const source of sources) {
			if (!source.online
				|| (options.includeSsh === false && source.kind === 'ssh')
				|| (options.sourceKeys !== undefined && !options.sourceKeys.includes(source.key))
				|| (options.pcIds !== undefined && !options.pcIds.includes(source.pcId))) {
				continue;
			}
			const route = routes.get(source.key);
			const requester = route !== undefined ? app.usageRequesterFor(route.pcId) : undefined;
			if (route === undefined || requester === undefined) {
				continue;
			}
			for (const kind of kinds) {
				// GitHub・読み上げは PC の値（接続先ごとには取れない）
				if (((kind === 'github' || kind === 'voice') && source.kind !== 'pc') || isFreshEnough(lastSuccess.get(usageStateKey(source.key, kind)), now, maxAge)) {
					continue;
				}
				jobs.push(fetchOne(source, route, requester, kind, bypass));
			}
		}
		await Promise.allSettled(jobs);
	},
}));

// PC を解除したら、その PC（と SSH の接続先）の値をメモリからも消す（ファイルは `forgetUsagePc` が消す）。
onUsagePcForgotten(pcId => {
	forgottenPcs.add(pcId);
	loadedPcs.delete(pcId);
	useUsageStore.setState(state => {
		const records: Record<string, UsageCacheRecord> = {};
		for (const [key, record] of Object.entries(state.records)) {
			if (record.pcId === pcId) {
				lastWritten.delete(key);
				const timer = persistTimers.get(key);
				if (timer !== undefined) {
					clearTimeout(timer);
					persistTimers.delete(key);
				}
			} else {
				records[key] = record;
			}
		}
		return { records };
	});
	for (const key of [...lastSuccess.keys()]) {
		if (key.startsWith(`pc:${pcId}|`) || key.startsWith(`ssh:${pcId}:`)) {
			lastSuccess.delete(key);
		}
	}
});

const EMPTY_RESOURCES = {};

function valuesByKeyOf(records: Readonly<Record<string, UsageCacheRecord>>): Record<string, SourceUsageValues> {
	const valuesByKey: Record<string, SourceUsageValues> = {};
	for (const [key, record] of Object.entries(records)) {
		valuesByKey[key] = record.values;
	}
	return valuesByKey;
}

/** 画面の外（ウィジェットの同期）から読む、いまの「PC ごと」の行。 */
export function currentUsageEntries(): UsageEntry[] {
	const records = useUsageStore.getState().records;
	return buildUsageEntries(currentUsageSources(records).sources, valuesByKeyOf(records));
}

/** 使用量の画面が読む、いまの全 PC の値。 */
export interface UsageOverview {
	readonly sources: readonly UsageSourceInfo[];
	/** 機械ごとにまとめた「PC ごと」の行。 */
	readonly entries: readonly UsageEntry[];
	readonly loaded: boolean;
	/** その出どころ・指標の直近の失敗（無ければ undefined）。 */
	errorOf(sourceKey: string, kind: UsageKind): unknown;
	/** その指標をどこかの出どころで取りに行っている最中か（`sourceKey` を渡すとその出どころだけ）。 */
	isLoading(kind: UsageKind, sourceKey?: string): boolean;
	/** 出どころ1つの値（控えを含む）。 */
	valuesOf(sourceKey: string): SourceUsageValues | undefined;
}

/**
 * `resources: false` は CPU・メモリ・SSD を購読しない版（ホーム用。CPU の揺れのたびに描き直さない）。
 * そのときの「PC ごと」の行の `resources` は購読していない時点の値なので、表示には使わない。
 */
export function useUsageOverview(options: { readonly resources?: boolean } = {}): UsageOverview {
	const pcs = useAppStore(s => s.pcs);
	// 見ている PC の接続先（SSH）の増減で出どころを作り直す。見ていない PC の接続先は値が届いたときに追いつく。
	const renderers = useAppStore(s => s.workspace?.renderers);
	const wantResources = options.resources !== false;
	const resources = usePcResources(s => (wantResources ? s.byPc : EMPTY_RESOURCES));
	const { records, errors, loading, loaded } = useUsageStore(useShallow(s => ({ records: s.records, errors: s.errors, loading: s.loading, loaded: s.loaded })));
	useEffect(() => { void useUsageStore.getState().load(); }, [pcs]);
	return useMemo(() => {
		void renderers;
		void resources;
		const { sources } = currentUsageSources(records);
		return {
			sources,
			entries: buildUsageEntries(sources, valuesByKeyOf(records)),
			loaded,
			errorOf: (sourceKey, kind) => errors[usageStateKey(sourceKey, kind)],
			isLoading: (kind, sourceKey) => Object.keys(loading).some(key => key.endsWith(`|${kind}`) && (sourceKey === undefined || key.startsWith(`${sourceKey}|`))),
			valuesOf: sourceKey => records[sourceKey]?.values,
		};
	}, [pcs, renderers, resources, records, errors, loading, loaded]);
}

/**
 * 画面が前面に来たときに取りに行き、前面にいる間に新しくオンラインになった PC があればその PC だけ取りに行く
 * （オンラインの PC の並びが変わっても全台へ送り直さない）。`sourceKeys` を渡すとその出どころだけ。
 */
export function useUsageAutoRefresh(kinds: readonly UsageKind[], sourceKeys?: readonly string[], options: { readonly maxAgeMs?: number; readonly includeSsh?: boolean } = {}): void {
	const onlineKey = useAppStore(s => s.pcs.filter(pc => pc.connection === 'online' && pc.pcOnline).map(pc => pc.id).join('\u0000'));
	const focused = useIsFocused();
	const kindsKey = kinds.join(',');
	const sourcesKey = sourceKeys?.join('\u0000');
	const { maxAgeMs, includeSsh } = options;
	const run = useCallback((pcIds?: readonly string[]) => {
		void useUsageStore.getState().refresh(kindsKey.split(',') as UsageKind[], {
			...(sourcesKey !== undefined ? { sourceKeys: sourcesKey.split('\u0000') } : {}),
			...(pcIds !== undefined ? { pcIds } : {}),
			...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
			...(includeSsh !== undefined ? { includeSsh } : {}),
		});
	}, [kindsKey, sourcesKey, maxAgeMs, includeSsh]);
	useFocusEffect(useCallback(() => { run(); }, [run]));
	const previousOnline = useRef<ReadonlySet<string> | undefined>(undefined);
	useEffect(() => {
		const current = new Set(onlineKey.length > 0 ? onlineKey.split('\u0000') : []);
		const before = previousOnline.current;
		previousOnline.current = current;
		if (before === undefined || !focused) {
			return;
		}
		const added = [...current].filter(id => !before.has(id));
		if (added.length > 0) {
			run(added);
		}
	}, [onlineKey, focused, run]);
}
