/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisMarkupCanvasContext,
	ParadisMarkupShape,
	paradisArrowHead,
	paradisClearMarkup,
	paradisCommitMarkupShape,
	paradisCreateMarkupDocument,
	paradisDrawMarkupShapes,
	paradisIsMeaningfulMarkupShape,
	paradisRedoMarkup,
	paradisScaleMarkupShape,
	paradisUndoMarkup,
} from '../../common/paradisMarkupModel.js';

const rect: ParadisMarkupShape = { id: 'r', kind: 'rect', color: '#ef4444', width: 4, from: { x: 10, y: 10 }, to: { x: 2, y: 30 } };
const text: ParadisMarkupShape = { id: 't', kind: 'text', color: '#ffffff', at: { x: 5, y: 6 }, text: 'ここ', fontSize: 18 };

/** 呼ばれた描画命令を記録するだけの偽物。 */
class RecordingContext implements IParadisMarkupCanvasContext {
	lineCap = '';
	lineJoin = '';
	lineWidth = 0;
	strokeStyle: unknown = '';
	fillStyle: unknown = '';
	globalAlpha = 1;
	font = '';
	textBaseline = '';
	readonly calls: string[] = [];
	save(): void { this.calls.push('save'); }
	restore(): void { this.calls.push('restore'); }
	beginPath(): void { this.calls.push('beginPath'); }
	moveTo(x: number, y: number): void { this.calls.push(`moveTo ${x},${y}`); }
	lineTo(x: number, y: number): void { this.calls.push(`lineTo ${x},${y}`); }
	arc(x: number, y: number, radius: number): void { this.calls.push(`arc ${x},${y},${radius}`); }
	ellipse(x: number, y: number, radiusX: number, radiusY: number): void { this.calls.push(`ellipse ${x},${y},${radiusX},${radiusY}`); }
	stroke(): void { this.calls.push('stroke'); }
	fill(): void { this.calls.push('fill'); }
	strokeRect(x: number, y: number, width: number, height: number): void { this.calls.push(`strokeRect ${x},${y},${width},${height} w=${this.lineWidth}`); }
	strokeText(value: string, x: number, y: number): void { this.calls.push(`strokeText ${value} ${x},${y} ${String(this.strokeStyle)}`); }
	fillText(value: string, x: number, y: number): void { this.calls.push(`fillText ${value} ${x},${y} ${this.font}`); }
}

suite('paradisMarkupModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('取り消し・やり直し・すべて消すを履歴として扱う', () => {
		let doc = paradisCreateMarkupDocument();
		doc = paradisCommitMarkupShape(doc, rect);
		doc = paradisCommitMarkupShape(doc, text);
		const afterUndo = paradisUndoMarkup(doc);
		const afterRedo = paradisRedoMarkup(afterUndo);
		const cleared = paradisClearMarkup(afterRedo);
		const restored = paradisUndoMarkup(cleared);
		assert.deepStrictEqual(
			[afterUndo, afterRedo, cleared, restored].map(state => state.shapes.map(shape => shape.id)),
			[['r'], ['r', 't'], [], ['r', 't']],
		);
	});

	test('スクリーンショットの実ピクセルへ拡大する', () => {
		assert.deepStrictEqual([paradisScaleMarkupShape(rect, 2), paradisScaleMarkupShape(text, 2)], [
			{ ...rect, width: 8, from: { x: 20, y: 20 }, to: { x: 4, y: 60 } },
			{ ...text, fontSize: 36, at: { x: 10, y: 12 } },
		]);
	});

	test('向きの無い矢印には矢じりを付けない', () => {
		assert.deepStrictEqual(paradisArrowHead({ x: 1, y: 1 }, { x: 1, y: 1 }, 4), undefined);
		assert.ok(paradisArrowHead({ x: 0, y: 0 }, { x: 10, y: 0 }, 4));
	});

	test('押しただけの図形は捨て、文字は空でなければ残す', () => {
		assert.deepStrictEqual([
			paradisIsMeaningfulMarkupShape({ ...rect, to: rect.from }),
			paradisIsMeaningfulMarkupShape(rect),
			paradisIsMeaningfulMarkupShape({ ...text, text: '  ' }),
			paradisIsMeaningfulMarkupShape(text),
		], [false, true, false, true]);
	});

	test('四角と文字を描く（白い文字には暗い縁取り）', () => {
		const ctx = new RecordingContext();
		paradisDrawMarkupShapes(ctx, [rect, text]);
		assert.deepStrictEqual(ctx.calls.filter(call => call.startsWith('stroke') || call.startsWith('fill')), [
			'strokeRect 2,10,8,20 w=4',
			'strokeText ここ 5,6 rgba(0,0,0,0.65)',
			'fillText ここ 5,6 600 18px -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif',
		]);
	});
});
