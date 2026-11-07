/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IParadisExactBrowserViewDescriptor, paradisExactViewKey } from './paradisAgentBrowser.js';

/**
 * エージェントが手にしているタブで、最後の道具の呼び出しからこの時間が過ぎたら、背景の抑制（backgroundThrottling）を戻す。
 *
 * 抑制を切ったタブは、隠れていてもタイマーと描画が全速で回る（重いページ 20 枚で CPU 155% を実測）。共有は明示的に
 * 外すかターミナルを閉じるまで続くので、使っていない間も抑制を切ったままにしない。
 */
export const PARADIS_AGENT_VIEW_IDLE_THROTTLE_MS = 60_000;

/** 抑制を切る・戻す実際の操作（electron-main がビューへ当てる）。 */
export interface IParadisAgentViewIdleThrottleHost {
	/** 抑制を切る（エージェントが使い始めた・使い直した）。 */
	wake(descriptor: IParadisExactBrowserViewDescriptor): void;
	/** 抑制を戻す（しばらく使われていない）。手にしていること自体は変わらない。 */
	sleep(descriptor: IParadisExactBrowserViewDescriptor): void;
}

/** テストで差し替えるタイマー。 */
export interface IParadisAgentViewIdleTimer {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const defaultTimer: IParadisAgentViewIdleTimer = {
	set: (callback, ms) => {
		const handle = setTimeout(callback, ms);
		// 片付けのためのタイマーなので、プロセスを生かしておく理由にしない
		(handle as unknown as { unref?(): void }).unref?.();
		return handle;
	},
	clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface IHeldView {
	readonly descriptor: IParadisExactBrowserViewDescriptor;
	awake: boolean;
	timer: unknown;
}

/**
 * エージェントが手にしているタブの「今使っているか」だけを持つ台帳。
 *
 * 手にしている（hold）間ずっと抑制を切るのではなく、使ったときに切り、{@link PARADIS_AGENT_VIEW_IDLE_THROTTLE_MS}
 * 使われなければ戻す。手にしていること（ダウンロードの由来・上書きの片付けなど）は呼び出し元がこれまでどおり扱い、
 * ここは抑制の値だけを決める。
 */
export class ParadisAgentViewIdleThrottle {

	private readonly views = new Map<string, IHeldView>();

	constructor(
		private readonly host: IParadisAgentViewIdleThrottleHost,
		private readonly idleMs: number = PARADIS_AGENT_VIEW_IDLE_THROTTLE_MS,
		private readonly timer: IParadisAgentViewIdleTimer = defaultTimer,
	) { }

	/** エージェントがタブを手にした。呼び出し元が抑制を切った直後に呼ぶ（ここでは wake しない）。 */
	hold(descriptor: IParadisExactBrowserViewDescriptor): void {
		const key = paradisExactViewKey(descriptor);
		const existing = this.views.get(key);
		if (existing) {
			existing.awake = true;
			this.arm(key, existing);
			return;
		}
		const held: IHeldView = { descriptor, awake: true, timer: undefined };
		this.views.set(key, held);
		this.arm(key, held);
	}

	/** エージェントがタブを手放した。呼び出し元が抑制を戻すので、ここでは sleep しない。 */
	release(descriptor: IParadisExactBrowserViewDescriptor): void {
		const key = paradisExactViewKey(descriptor);
		const held = this.views.get(key);
		if (!held) {
			return;
		}
		this.timer.clear(held.timer);
		this.views.delete(key);
	}

	/**
	 * エージェントがこのタブを使った。眠っていれば起こす。
	 * @returns 手にしているタブなら true（眠っていたかどうかは問わない）
	 */
	noteActivity(descriptor: IParadisExactBrowserViewDescriptor): boolean {
		const key = paradisExactViewKey(descriptor);
		const held = this.views.get(key);
		if (!held) {
			return false;
		}
		if (!held.awake) {
			held.awake = true;
			this.host.wake(held.descriptor);
		}
		this.arm(key, held);
		return true;
	}

	/** 手にしていて、今は抑制を切っているか（テストと診断用）。 */
	isAwake(descriptor: IParadisExactBrowserViewDescriptor): boolean {
		return this.views.get(paradisExactViewKey(descriptor))?.awake === true;
	}

	get size(): number {
		return this.views.size;
	}

	dispose(): void {
		for (const held of this.views.values()) {
			this.timer.clear(held.timer);
		}
		this.views.clear();
	}

	private arm(key: string, held: IHeldView): void {
		this.timer.clear(held.timer);
		held.timer = this.timer.set(() => {
			if (this.views.get(key) !== held || !held.awake) {
				return;
			}
			held.awake = false;
			held.timer = undefined;
			this.host.sleep(held.descriptor);
		}, this.idleMs);
	}
}
