// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { AppState } from 'react-native';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { create } from 'zustand';
import { onPcMessage, pcHasCapabilityFor, sendPcRequest } from '../../appState.js';
import { PcCapability } from '../../pcCompat.js';
import type { MobileDisposable } from '../../store.js';
import { ICON_SVG_BATCH, applyIconThemeReply, parseIconSvgsReply, parseIconThemeReply, parseStoredIconTheme, serializeIconTheme, type IconThemeEntry } from './fileIconTheme.js';

/**
 * PC ごとのアイコンのテーマの写し（`fs.icon-theme.v1`）。
 *
 * - 対応表は `iconTheme` で取り、版（`revision`）を付けて取り直す（同じなら PC は `notModified` だけ返す）。
 *   確かめ直すのは 5 分に 1 回まで。PC はテーマが変わると `iconThemeChanged` を送るので、受けたらすぐ取り直す
 * - SVG は描く行が出てから、必要な ID だけを 60ms まとめて `iconSvgs` で頼む（1 回 200 件まで）
 * - 写しは端末のキャッシュのフォルダーに PC ごとに置く（次に開いたときに PC へつながる前から PC と同じアイコンを出す）。
 *   版が変わったら SVG を捨てる。キャッシュは OS が消すことがあるが、そのときは取り直すだけ
 */
interface FileIconStore {
	readonly themes: Readonly<Record<string, IconThemeEntry>>;
}

export const useFileIconStore = create<FileIconStore>()(() => ({ themes: {} }));

const RECHECK_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const FLUSH_DELAY_MS = 60;
/** 端末へ書くまでの間（SVG が届くたびに書かないよう、まとめる）。アプリが裏へ回るときはすぐ書く。 */
const PERSIST_DELAY_MS = 5_000;

interface PcIconState {
	nextCheckAt: number;
	checking: boolean;
	diskLoaded: Promise<void> | undefined;
	subscription: MobileDisposable | undefined;
	pending: Set<string>;
	inflight: Set<string>;
	flushTimer: ReturnType<typeof setTimeout> | undefined;
	persistTimer: ReturnType<typeof setTimeout> | undefined;
	/** 進展が無かったときに 1 回だけ頼み直した ID（同じ ID を頼み続けない）。 */
	retried: Set<string>;
}

const pcs = new Map<string, PcIconState>();

function stateOf(pcId: string): PcIconState {
	let state = pcs.get(pcId);
	if (state === undefined) {
		state = { nextCheckAt: 0, checking: false, diskLoaded: undefined, subscription: undefined, pending: new Set(), inflight: new Set(), flushTimer: undefined, persistTimer: undefined, retried: new Set() };
		pcs.set(pcId, state);
	}
	return state;
}

function cachePath(pcId: string): string | undefined {
	return LegacyFileSystem.cacheDirectory ? `${LegacyFileSystem.cacheDirectory}para-icon-theme.v1.${pcId.replace(/[^A-Za-z0-9._-]/g, '_')}.json` : undefined;
}

function entryOf(pcId: string): IconThemeEntry | undefined {
	return useFileIconStore.getState().themes[pcId];
}

function setEntry(pcId: string, entry: IconThemeEntry | undefined): void {
	useFileIconStore.setState(state => {
		const { [pcId]: _previous, ...rest } = state.themes;
		return { themes: entry !== undefined ? { ...rest, [pcId]: entry } : rest };
	});
	schedulePersist(pcId);
}

let backgroundListener: { remove(): void } | undefined;

/** 書くのを待っている写しを今すぐ書く（アプリが裏へ回るとき。OS に止められる前に）。 */
function persistNow(): void {
	for (const [pcId, state] of pcs) {
		if (state.persistTimer !== undefined) {
			clearTimeout(state.persistTimer);
			state.persistTimer = undefined;
			writeEntry(pcId);
		}
	}
}

function schedulePersist(pcId: string): void {
	const state = stateOf(pcId);
	if (state.persistTimer !== undefined) {
		return;
	}
	backgroundListener ??= AppState.addEventListener('change', next => {
		if (next !== 'active') {
			persistNow();
		}
	});
	state.persistTimer = setTimeout(() => {
		state.persistTimer = undefined;
		writeEntry(pcId);
	}, PERSIST_DELAY_MS);
}

function writeEntry(pcId: string): void {
	{
		const path = cachePath(pcId);
		const entry = entryOf(pcId);
		if (path === undefined) {
			return;
		}
		const write = entry !== undefined
			? LegacyFileSystem.writeAsStringAsync(path, serializeIconTheme(entry), { encoding: LegacyFileSystem.EncodingType.UTF8 })
			: LegacyFileSystem.deleteAsync(path, { idempotent: true });
		// 書けなくても次に開いたときに PC から取り直すだけ
		void write.catch(() => undefined);
	}
}

function loadFromDisk(pcId: string): Promise<void> {
	const state = stateOf(pcId);
	if (state.diskLoaded === undefined) {
		state.diskLoaded = (async () => {
			const path = cachePath(pcId);
			if (path === undefined || entryOf(pcId) !== undefined) {
				return;
			}
			try {
				const info = await LegacyFileSystem.getInfoAsync(path);
				const stored = info.exists ? parseStoredIconTheme(await LegacyFileSystem.readAsStringAsync(path)) : undefined;
				if (stored !== undefined && entryOf(pcId) === undefined) {
					useFileIconStore.setState(current => ({ themes: { ...current.themes, [pcId]: stored } }));
				}
			} catch {
				// 読めない写しは無いのと同じ
			}
		})();
	}
	return state.diskLoaded;
}

/**
 * その PC のアイコンのテーマを用意する（写しが無い・古いかもしれないときだけ PC に確かめる）。
 * `fs.icon-theme.v1` を持たない PC には何も送らない（アイコンは既定のまま）。
 */
export function ensureIconTheme(pcId: string, force = false): void {
	if (!pcHasCapabilityFor(pcId, PcCapability.FsIconTheme)) {
		return;
	}
	const state = stateOf(pcId);
	if (state.subscription === undefined) {
		state.subscription = onPcMessage(pcId, 'fs', message => {
			if (message.t === 'iconThemeChanged') {
				ensureIconTheme(pcId, true);
			}
		});
	}
	if (state.checking || (!force && Date.now() < state.nextCheckAt)) {
		return;
	}
	state.checking = true;
	void (async () => {
		try {
			await loadFromDisk(pcId);
			const previous = entryOf(pcId);
			const reply = parseIconThemeReply(await sendPcRequest(pcId, 'fs', { t: 'iconTheme', ...(previous !== undefined ? { ifRevision: previous.revision } : {}) }, { timeoutMs: 60_000 }));
			if (reply === undefined) {
				state.nextCheckAt = Date.now() + RETRY_MS;
				return;
			}
			const next = applyIconThemeReply(entryOf(pcId), reply);
			if (next === undefined) {
				// 手元の写しの版と食い違った notModified（写しを入れ替えた直後など）。版を付けずに取り直す
				setEntry(pcId, undefined);
				state.nextCheckAt = 0;
				return;
			}
			if (next !== entryOf(pcId)) {
				state.inflight.clear();
				state.retried.clear();
				setEntry(pcId, next);
			}
			state.nextCheckAt = Date.now() + RECHECK_MS;
		} catch {
			state.nextCheckAt = Date.now() + RETRY_MS;
		} finally {
			state.checking = false;
		}
	})();
}

/** その SVG を PC に頼む（60ms まとめて送る）。もう持っている・頼み中なら何もしない。 */
export function requestIconSvg(pcId: string, id: string): void {
	const entry = entryOf(pcId);
	if (entry?.manifest === undefined || Object.prototype.hasOwnProperty.call(entry.svgs, id)) {
		return;
	}
	const state = stateOf(pcId);
	if (state.inflight.has(id) || state.pending.has(id)) {
		return;
	}
	state.pending.add(id);
	if (state.flushTimer === undefined) {
		state.flushTimer = setTimeout(() => {
			state.flushTimer = undefined;
			flush(pcId);
		}, FLUSH_DELAY_MS);
	}
}

function flush(pcId: string): void {
	const state = stateOf(pcId);
	const entry = entryOf(pcId);
	const ids = [...state.pending];
	state.pending.clear();
	if (entry === undefined || ids.length === 0) {
		return;
	}
	for (let at = 0; at < ids.length; at += ICON_SVG_BATCH) {
		const batch = ids.slice(at, at + ICON_SVG_BATCH);
		for (const id of batch) {
			state.inflight.add(id);
		}
		/**
		 * 応答の上限で入り切らなかった ID。応答が進んでいれば頼み直す。進まなかった（1 つも届かなかった）ときは、
		 * まだ頼み直していない ID だけを 1 回だけ頼み直す（それでも来なければ次に描いたときに頼む）。
		 */
		let retry: readonly string[] = [];
		sendPcRequest(pcId, 'fs', { t: 'iconSvgs', revision: entry.revision, ids: batch }, { timeoutMs: 60_000 })
			.then(value => {
				const reply = parseIconSvgsReply(value, batch);
				const current = entryOf(pcId);
				if (reply === undefined || current === undefined) {
					return;
				}
				if (reply.stale || reply.revision !== current.revision) {
					ensureIconTheme(pcId, true);
					return;
				}
				if (Object.keys(reply.svgs).length > 0) {
					setEntry(pcId, { ...current, svgs: { ...current.svgs, ...reply.svgs } });
					retry = batch.filter(id => !Object.prototype.hasOwnProperty.call(reply.svgs, id));
				} else {
					retry = batch.filter(id => !Object.prototype.hasOwnProperty.call(current.svgs, id) && !state.retried.has(id));
					for (const id of retry) {
						state.retried.add(id);
					}
				}
			})
			.catch(() => undefined)
			.finally(() => {
				for (const id of batch) {
					state.inflight.delete(id);
				}
				for (const id of retry) {
					requestIconSvg(pcId, id);
				}
			});
	}
}
