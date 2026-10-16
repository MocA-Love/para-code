/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// GitHub の枠を使い切った後、定期の PR・Issue の取得を窓が回るまで止めるための台帳。
// 枠を使い切った後の呼び出しは点を消費しないが、失敗をポーリングの数だけ積み上げ、窓が回った
// 直後にエージェントと残りを奪い合う。shared process と接続先（REH）でプロセスごとに1つ持つ
// （gh の認証情報もプロセスのある側のもの）。

import { IParadisGithubCallResource, IParadisGithubRateLimitEntry, IParadisGithubRateLimitPauseEntry } from './paradisGithubMetrics.js';

/**
 * 窓の終わりが分からないとき（残量のプローブがまだ走っていない、WSL のディストロの gh など）に止めておく時間。
 * GitHub の枠は1時間の窓なので、その 1/4 ごとに1回だけ確かめ直す。
 */
const PARADIS_GITHUB_PAUSE_FALLBACK_MS = 15 * 60_000;

/** 止める時間の上限。窓は1時間なので、それより先のリセット時刻（時計のずれ等）は信用しない。 */
const PARADIS_GITHUB_PAUSE_MAX_MS = 61 * 60_000;

/**
 * 資源（core / graphql）と実行名前空間（手元は ''、WSL は `wsl:<distro>`）ごとに、gh を止めている期限を持つ。
 * 残量のプローブは手元の gh で走るため、プローブの結果は名前空間 '' にだけ効かせる。
 */
export class ParadisGithubRateLimitPause {

	/** 名前空間 '' の、プローブが最後に見たリセット時刻。 */
	private readonly knownResetAt = new Map<IParadisGithubCallResource, number>();
	private readonly pausedUntil = new Map<string, { readonly resource: IParadisGithubCallResource; readonly until: number }>();

	constructor(private readonly now: () => number = Date.now) { }

	/**
	 * 残量のプローブの結果を受け取る。残量0ならリセット時刻まで止め、残量があれば止めているのを解く
	 * （窓が回った、または二次制限が解けた）。
	 */
	noteRateLimits(entries: readonly IParadisGithubRateLimitEntry[]): void {
		const now = this.now();
		for (const entry of entries) {
			const resource = paradisAsGithubCallResource(entry.resource);
			if (resource === undefined) {
				continue;
			}
			if (entry.resetAt > 0) {
				this.knownResetAt.set(resource, entry.resetAt);
			}
			if (entry.remaining <= 0 && entry.resetAt > now) {
				this.pause('', resource, entry.resetAt, now);
			} else if (entry.remaining > 0) {
				this.pausedUntil.delete(pauseKey('', resource));
			}
		}
	}

	/**
	 * gh が枠の上限で断られたことを記録し、再開する時刻を返す。手元はプローブが知っているリセット時刻まで、
	 * 分からなければ {@link PARADIS_GITHUB_PAUSE_FALLBACK_MS} だけ止める。
	 */
	noteRateLimited(namespace: string, resource: IParadisGithubCallResource): number {
		const now = this.now();
		const knownResetAt = namespace === '' ? this.knownResetAt.get(resource) : undefined;
		return this.pause(namespace, resource, knownResetAt !== undefined && knownResetAt > now ? knownResetAt : now + PARADIS_GITHUB_PAUSE_FALLBACK_MS, now);
	}

	/** その名前空間・資源の gh を止めているなら再開する時刻を、止めていなければ undefined を返す。 */
	pausedUntilFor(namespace: string, resource: IParadisGithubCallResource): number | undefined {
		const key = pauseKey(namespace, resource);
		const entry = this.pausedUntil.get(key);
		if (entry === undefined) {
			return undefined;
		}
		if (entry.until <= this.now()) {
			this.pausedUntil.delete(key);
			return undefined;
		}
		return entry.until;
	}

	/** 止めている資源の一覧（名前空間をまたいで、資源ごとに一番遅い再開時刻）。使用量の画面に出す。 */
	activePauses(): IParadisGithubRateLimitPauseEntry[] {
		const now = this.now();
		const byResource = new Map<IParadisGithubCallResource, number>();
		for (const [key, entry] of [...this.pausedUntil]) {
			if (entry.until <= now) {
				this.pausedUntil.delete(key);
				continue;
			}
			byResource.set(entry.resource, Math.max(byResource.get(entry.resource) ?? 0, entry.until));
		}
		return [...byResource].map(([resource, until]) => ({ resource, until })).sort((a, b) => a.resource.localeCompare(b.resource));
	}

	private pause(namespace: string, resource: IParadisGithubCallResource, until: number, now: number): number {
		const key = pauseKey(namespace, resource);
		const capped = Math.min(until, now + PARADIS_GITHUB_PAUSE_MAX_MS);
		const previous = this.pausedUntil.get(key);
		const next = previous !== undefined && previous.until > capped ? previous.until : capped;
		this.pausedUntil.set(key, { resource, until: next });
		return next;
	}
}

function pauseKey(namespace: string, resource: IParadisGithubCallResource): string {
	return `${namespace}\n${resource}`;
}

function paradisAsGithubCallResource(resource: string): IParadisGithubCallResource | undefined {
	return resource === 'core' || resource === 'graphql' ? resource : undefined;
}

const processPause = new ParadisGithubRateLimitPause();

/**
 * このプロセスの台帳。使用量の監視（プローブ）と worktree の gh 呼び出しは同じプロセスで動くので、
 * 記録シンク（paradisSetGithubCallSink）と同じくモジュール単位で1つを共有する。
 */
export function paradisGithubRateLimitPause(): ParadisGithubRateLimitPause {
	return processPause;
}
