/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { $, append } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { paradisFormatPromptCacheRemaining } from '../common/paradisAgentInsights.js';
import { paradisPromptCacheTooltip, paradisPromptCacheTtlLabel } from './paradisAgentInsightsPresentation.js';
import { IParadisScopePromptCacheReading, ParadisPromptCacheClock } from './paradisPromptCacheClock.js';
import './media/paradisAgentInsights.css';

/** スペース一覧の行ごとの残り時間表示（メタ段の1項目）。 */
export interface IParadisPromptCacheChip {
	readonly element: HTMLElement;
	/** この枠が今描いているスペース。undefined なら何も出さない。 */
	setScope(stateKey: string | undefined): void;
}

/**
 * スペース一覧（Workspaces ビュー）のメタ段に出す、プロンプトキャッシュの残り時間。
 *
 * 行のテンプレートは使い回されるので、枠（chip）はテンプレートごとに1つ作り、描く行が
 * 変わるたびに {@link IParadisPromptCacheChip.setScope} で差し替える。数字の書き換えは
 * 時計の合図で全枠をまとめて行い、ツリーの組み直しは「出る・消える」ときだけに絞る
 * （組み直すと行の高さが 44px ⇔ 60px で変わるため）。
 */
export class ParadisPromptCacheChips extends Disposable {

	private readonly clock: ParadisPromptCacheClock;
	private readonly chips = new Map<HTMLElement, { stateKey: string | undefined; readonly render: () => void }>();

	/** 出る・消えるが変わった（行の高さが変わるので、ツリーを組み直す合図）。 */
	readonly onDidChangeVisibility: Event<void>;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this.clock = this._register(instantiationService.createInstance(ParadisPromptCacheClock));
		this.onDidChangeVisibility = this.clock.onDidChangeVisibility;
		this._register(this.clock.onDidTick(() => {
			for (const chip of this.chips.values()) {
				chip.render();
			}
		}));
	}

	/** そのスペースに出すものがあるか（行の高さの判定に使う）。 */
	hasScope(stateKey: string): boolean {
		return this.clock.readScope(stateKey) !== undefined;
	}

	create(container: HTMLElement, disposables: DisposableStore): IParadisPromptCacheChip {
		const element = append(container, $('.paradis-worktree-prompt-cache'));
		append(element, $(ThemeIcon.asCSSSelector(Codicon.flame)));
		const label = append(element, $('span.paradis-worktree-prompt-cache-time'));
		const state = {
			stateKey: undefined as string | undefined,
			render: () => {
				const reading = state.stateKey !== undefined ? this.clock.readScope(state.stateKey) : undefined;
				element.classList.toggle('warning', !!reading?.warning);
				label.textContent = reading ? paradisFormatPromptCacheRemaining(reading.remainingMs) : '';
				element.ariaLabel = reading ? paradisPromptCacheTooltip(reading.remainingMs, reading.ttlMs) : '';
			},
		};
		disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), element, () => {
			const reading = state.stateKey !== undefined ? this.clock.readScope(state.stateKey) : undefined;
			return reading ? scopeTooltip(reading) : '';
		}));
		this.chips.set(element, state);
		disposables.add({ dispose: () => this.chips.delete(element) });
		return {
			element,
			setScope: stateKey => {
				state.stateKey = stateKey;
				state.render();
			},
		};
	}
}

/** 複数ペインがあるときは内訳を並べる（行に出ているのは最も早く切れるペイン）。 */
function scopeTooltip(reading: IParadisScopePromptCacheReading): string {
	const head = paradisPromptCacheTooltip(reading.remainingMs, reading.ttlMs);
	if (reading.panes.length < 2) {
		return head;
	}
	const lines = reading.panes.map(pane => localize(
		'paradis.agentInsights.promptCachePaneLine',
		"{0}  {1}（{2}）",
		pane.title || 'claude',
		paradisFormatPromptCacheRemaining(pane.remainingMs),
		paradisPromptCacheTtlLabel(pane.ttlMs),
	));
	return [head, '', ...lines].join('\n');
}
