/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// こちらで描いた図形を、docx-preview が残した枠のどれに入れるかを決める。
//
// 出現順で対応づけると実運用でずれる。docx-preview は mc:AlternateContent の Fallback(VML)を
// 必ず描くので、Word が書く図形の多くでは枠がそもそも作られない。画像は <img> になり、
// ヘッダーはページごとに複製される。ずれたまま入れると「別の図の場所に描く」ことになる。
//
// そこで vendored docx-preview に wp:docPr@id を枠へ出させ(data-paradis-drawing-id)、
// その値だけで対応づける。対応する枠が無いものは描かない。

/** 差し込む側(こちらで描いた図形)。 */
export interface IParadisWordOverlayCandidate {
	readonly id: string;
	/** wp:docPr@id。これが枠の目印と一致したときだけ描く。 */
	readonly drawingId?: string;
}

/** 差し込まれる側(docx-preview が残した枠)。 */
export interface IParadisWordOverlaySlot {
	/** 枠に付いた data-paradis-drawing-id。 */
	readonly drawingId?: string;
}

export interface IParadisWordOverlayPlacement {
	/** candidates の添字。 */
	readonly candidateIndex: number;
	/** slots の添字。 */
	readonly slotIndex: number;
}

export interface IParadisWordOverlayPlacementResult {
	readonly placements: readonly IParadisWordOverlayPlacement[];
	/** 対応する枠が無く描かなかった図形の数。 */
	readonly unmatchedCandidates: number;
}

/**
 * 図形と枠を wp:docPr@id で対応づける。
 *
 * 同じ id の枠が複数あることは正常で(ヘッダーの図はページごとに複製される)、その全部に描く。
 * id を持たない図形・枠は対応づけない(取り違えるより描かない方を選ぶ)。
 * 同じ id の図形が複数あるファイルは曖昧なので、その id はまとめて捨てる。
 */
export function planParadisWordOverlayPlacements(
	candidates: readonly IParadisWordOverlayCandidate[],
	slots: readonly IParadisWordOverlaySlot[],
): IParadisWordOverlayPlacementResult {
	const candidateIndexById = new Map<string, number>();
	const ambiguous = new Set<string>();
	for (let index = 0; index < candidates.length; index++) {
		const drawingId = candidates[index].drawingId;
		if (drawingId === undefined || drawingId === '') {
			continue;
		}
		if (candidateIndexById.has(drawingId)) {
			ambiguous.add(drawingId);
			continue;
		}
		candidateIndexById.set(drawingId, index);
	}
	for (const drawingId of ambiguous) {
		candidateIndexById.delete(drawingId);
	}

	const placements: IParadisWordOverlayPlacement[] = [];
	const used = new Set<number>();
	for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
		const drawingId = slots[slotIndex].drawingId;
		if (drawingId === undefined || drawingId === '') {
			continue;
		}
		const candidateIndex = candidateIndexById.get(drawingId);
		if (candidateIndex === undefined) {
			continue;
		}
		used.add(candidateIndex);
		placements.push({ candidateIndex, slotIndex });
	}
	return { placements, unmatchedCandidates: candidates.length - used.size };
}
