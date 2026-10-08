/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisOfficeChange, ParadisOfficeChangeValue } from '../../common/paradisOfficeProtocol.js';
import type { IParadisWordAnalysisResult, IParadisWordComparisonResult } from '../../common/word/paradisWordSemanticSummary.js';
import { alignParadisWordParagraphs, compactParadisWordText } from '../../common/word/paradisWordRenderOutline.js';
import { ParadisWordSemanticChannel } from '../../node/word/paradisWordSemanticChannel.js';
import { ParadisWordSemanticService } from '../../node/word/paradisWordSemanticService.js';
import { PARADIS_WORD_SEMANTIC_ANALYZE_DEADLINE_MS, PARADIS_WORD_SEMANTIC_QUEUE_BYTES_LIMIT, PARADIS_WORD_SEMANTIC_QUEUE_DEADLINE_MS, PARADIS_WORD_SEMANTIC_QUEUE_LIMIT, ParadisWordSemanticWorkerBackend, type IParadisWordSemanticWorker } from '../../node/word/paradisWordSemanticWorkerBackend.js';
import type { ParadisWordSemanticWorkerMessage, ParadisWordSemanticWorkerRequest } from '../../node/word/paradisWordSemanticWorkerProtocol.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const officeDocumentRelationship = `${relationshipNamespace}/officeDocument`;

interface FixtureOptions {
	readonly title?: string;
	readonly headingBold?: boolean;
}

/** 架空の最小文書。変更履歴・コメント・脚注・ヘッダー・フッター・テキストボックス・未知の要素を 1 つずつ持つ。 */
async function wordFixture(options: FixtureOptions = {}): Promise<Uint8Array> {
	const title = options.title ?? 'Equipment request';
	const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${wordNamespace}" xmlns:r="${relationshipNamespace}" xmlns:v="urn:schemas-microsoft-com:vml">
	<w:body>
		<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${title}</w:t></w:r></w:p>
		<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Return by Friday</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>
			<w:del w:id="3" w:author="Clerk" w:date="2026-09-30T10:12:00Z"><w:r><w:delText> strictly</w:delText></w:r></w:del>
			<w:ins w:id="4" w:author="Clerk" w:date="2026-09-30T10:12:00Z"><w:r><w:t> and tell the office</w:t></w:r></w:ins>
			<w:proofErr w:type="spellStart"/><w:r><w:t>.</w:t></w:r><w:proofErr w:type="spellEnd"/><w:r><w:footnoteReference w:id="1"/></w:r></w:p>
		<w:p><w:r><w:t>Empty lines follow</w:t></w:r></w:p>
		<w:p/>
		<w:p/>
		<w:p><w:r><w:pict><v:shape id="stamp"><v:textbox><w:txbxContent><w:p><w:r><w:t>Stamp</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>
		<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/></w:sectPr>
	</w:body>
</w:document>`;
	const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${wordNamespace}"><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr>${options.headingBold === false ? '' : '<w:b/>'}<w:sz w:val="32"/></w:rPr></w:style></w:styles>`;
	return buildOpcFixture({
		parts: [
			['/word/document.xml', document, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
			['/word/styles.xml', styles, 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
			['/word/header1.xml', `<w:hdr xmlns:w="${wordNamespace}"><w:p><w:r><w:t>Sample company</w:t></w:r></w:p></w:hdr>`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'],
			['/word/footer1.xml', `<w:ftr xmlns:w="${wordNamespace}"><w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml'],
			['/word/footnotes.xml', `<w:footnotes xmlns:w="${wordNamespace}"><w:footnote w:id="1"><w:p><w:r><w:t>Cord length is three meters</w:t></w:r></w:p></w:footnote></w:footnotes>`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml'],
			['/word/comments.xml', `<w:comments xmlns:w="${wordNamespace}"><w:comment w:id="0" w:author="Reviewer" w:date="2026-09-29T09:00:00Z"><w:p><w:r><w:t>Use the calendar year</w:t></w:r></w:p></w:comment></w:comments>`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'],
		],
		relationships: [
			{ id: 'rIdRoot', type: officeDocumentRelationship, target: 'word/document.xml' },
			{ source: '/word/document.xml', id: 'rIdStyles', type: `${relationshipNamespace}/styles`, target: 'styles.xml' },
			{ source: '/word/document.xml', id: 'rIdHeader', type: `${relationshipNamespace}/header`, target: 'header1.xml' },
			{ source: '/word/document.xml', id: 'rIdFooter', type: `${relationshipNamespace}/footer`, target: 'footer1.xml' },
			{ source: '/word/document.xml', id: 'rIdFootnotes', type: `${relationshipNamespace}/footnotes`, target: 'footnotes.xml' },
			{ source: '/word/document.xml', id: 'rIdComments', type: `${relationshipNamespace}/comments`, target: 'comments.xml' },
		],
	});
}

function text(value: ParadisOfficeChangeValue): string | undefined {
	if (value.kind === 'scalar') {
		return typeof value.value === 'string' ? value.value : undefined;
	}
	if (value.kind === 'record') {
		return value.fields.map(field => `${field.name}=${text(field.value) ?? ''}`).join(' ');
	}
	return undefined;
}

function changeShape(change: ParadisOfficeChange): readonly [string, string, string | undefined, string | undefined] {
	return [change.category, change.subject.kind, text(change.before), text(change.after)];
}

suite('ParadisWordSemanticService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('summarizes counts, in-document revisions and comments, and a search index across stories', async () => {
		const result = await new ParadisWordSemanticService().analyze(await wordFixture(), CancellationToken.None);
		if (!result.ok) {
			throw new Error(`analysis failed: ${result.code}`);
		}
		deepStrictEqual({
			format: result.counts.format,
			stories: result.counts.storyKinds,
			unknown: result.counts.unknownElements,
			changes: result.changes.map(changeShape),
			search: result.searchItems.map(item => [item.locationBadge.label, item.fields.map(field => `${field.kind}:${field.text}`).join('|')]),
		}, {
			format: 'docx',
			stories: { body: 1, header: 1, footer: 1, footnote: 1, comment: 1, textbox: 1 },
			unknown: [{ name: 'pict', count: 1, disposition: 'unrendered' }, { name: 'proofErr', count: 2, disposition: 'ignorable' }],
			changes: [
				['revision', 'revision.deleted', 'strictly', 'revisionKind=deleted author=Clerk date=2026-09-30T10:12:00Z'],
				['revision', 'revision.inserted', undefined, 'text=and tell the office revisionKind=inserted author=Clerk date=2026-09-30T10:12:00Z'],
				['annotation', 'comment.text', undefined, 'text=Use the calendar year author=Reviewer date=2026-09-29T09:00:00Z'],
			],
			search: [
				['body', 'formatted:Equipment request'],
				['body', 'formatted:Return by Friday and tell the office.|hidden: strictly'],
				['body', 'formatted:Empty lines follow'],
				['header', 'formatted:Sample company'],
				['footer', 'formatted:1'],
				['footnote', 'formatted:Cord length is three meters'],
				['comment', 'comment:Use the calendar year'],
				['textbox', 'formatted:Stamp'],
			],
		});
		// コメントの移動先は、コメントが付いた本文の段落。
		const comment = result.changes.find(change => change.category === 'annotation');
		strictEqual(comment?.navigableAnchor, result.searchItems[1].navigableAnchor);
	});

	test('outlines rendered stories with inline marks and aligns them to the rendered paragraphs', async () => {
		const result = await new ParadisWordSemanticService().analyze(await wordFixture(), CancellationToken.None);
		if (!result.ok) {
			throw new Error(`analysis failed: ${result.code}`);
		}
		const outline = result.outline;
		const body = outline.stories.find(story => story.key === 'b')!;
		const returnParagraph = body.paragraphs[1];
		deepStrictEqual({
			keys: outline.stories.map(story => story.key),
			body: body.paragraphs.map(paragraph => paragraph.text),
			marks: returnParagraph.marks.map(mark => [mark.kind, mark.start, mark.end, mark.ordinal, mark.rows.find(row => row[0] === 'author' || row[0] === 'noteId')?.[1]]),
		}, {
			keys: ['b', 'p:word/header1.xml', 'p:word/footer1.xml', 'fn:1', 't:word/document.xml:0'],
			body: ['Equipment request', 'Return by Friday and tell the office.', 'Empty lines follow', '', '', ''],
			marks: [
				['comment', 0, 14, undefined, 'Reviewer'],
				['revision', 14, 14, 0, 'Clerk'],
				['revision', 14, 30, 0, 'Clerk'],
				['noteReference', 31, 31, 0, '1'],
			],
		});
		// 表示の側で段落が 1 つ欠け（docx-preview が描かなかった）、フィールドの結果が違って見えても、
		// 文字の並びと数の揃った区間で対応が取れる。
		const markers = alignParadisWordParagraphs(outline, {
			b: [compactParadisWordText('Equipment request'), compactParadisWordText('Return by Friday and tell the office.'), '', '', ''],
			'p:word/footer1.xml': ['2'],
		});
		const footer = outline.stories.find(story => story.key === 'p:word/footer1.xml')!;
		deepStrictEqual({
			body: body.paragraphs.map(paragraph => markers.get(paragraph.locator)),
			footer: markers.get(footer.paragraphs[0].locator),
		}, {
			body: ['b#0', 'b#1', undefined, 'b#2', 'b#3', 'b#4'],
			footer: 'p:word/footer1.xml#0',
		});
	});

	test('compares two versions into categorized changes and reports an identical pair as complete with no changes', async () => {
		const service = new ParadisWordSemanticService();
		const original = await wordFixture();
		const same = await service.compare(original, original.slice(), CancellationToken.None);
		const edited = await service.compare(original, await wordFixture({ title: 'Equipment loan request', headingBold: false }), CancellationToken.None);
		if (!same.ok || !edited.ok) {
			throw new Error('comparison failed');
		}
		const textChange = edited.changes.find(change => change.subject.kind === 'paragraph.text')!;
		deepStrictEqual({
			same: [same.outcome, same.noChanges, same.changes.length, same.omittedModels],
			edited: [...new Set(edited.changes.map(change => `${change.category}:${change.subject.kind}`))].sort(),
			// 文字の変更は、変更後の側の段落へ移れる。スタイルのような文書全体の変更は移動先を持たない。
			navigation: Object.values(edited.navigation).map(target => [target.side, edited.modifiedOutline.stories[0].paragraphs.findIndex(paragraph => paragraph.locator === target.paragraph)]),
			textTarget: edited.navigation[textChange.id]?.side,
		}, {
			same: ['complete', true, 0, []],
			edited: ['content:paragraph.text', 'formatting:package.style'],
			navigation: [['modified', 0]],
			textTarget: 'modified',
		});
	});

	test('reports unsupported, invalid, and cancelled inputs as sanitized codes', async () => {
		const service = new ParadisWordSemanticService();
		const spreadsheet = await buildOpcFixture({
			parts: [['/xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml']],
			relationships: [{ id: 'rIdRoot', type: officeDocumentRelationship, target: 'xl/workbook.xml' }],
		});
		const cancelled = new CancellationTokenSource();
		cancelled.cancel();
		const codes = await Promise.all([
			service.analyze(spreadsheet, CancellationToken.None),
			service.analyze(new TextEncoder().encode('not a zip'), CancellationToken.None),
			service.analyze(await wordFixture(), cancelled.token),
		]);
		cancelled.dispose();
		deepStrictEqual(codes.map(result => result.ok ? 'ok' : result.code), ['unsupported', 'invalid', 'cancelled']);
	});

	test('worker backend: one request at a time, run deadlines only for the running request, queue deadlines and limits for waiting ones, and no in-process retry', async () => {
		class FakeWorker implements IParadisWordSemanticWorker {
			readonly posted: ParadisWordSemanticWorkerRequest[] = [];
			terminated = false;
			private readonly listeners = new Map<string, ((value: never) => void)[]>();
			postMessage(message: ParadisWordSemanticWorkerRequest): void { this.posted.push(message); }
			on(event: string, listener: (value: never) => void): unknown {
				this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
				return this;
			}
			async terminate(): Promise<number> { this.terminated = true; return 0; }
			reply(code: 'unsupported' | 'invalid'): void {
				const last = this.posted.filter(message => message.op !== 'cancel').at(-1)!;
				this.emit('message', { kind: 'result', id: last.id, result: { ok: false, code } } satisfies ParadisWordSemanticWorkerMessage as never);
			}
			crash(error?: Error): void {
				if (error) { this.emit('error', error as never); }
				this.emit('exit', 1 as never);
			}
			private emit(event: string, value: never): void {
				for (const listener of this.listeners.get(event) ?? []) { listener(value); }
			}
		}
		const scheduled: { readonly handler: () => void; readonly delay: number; cleared: boolean }[] = [];
		const timers = {
			setTimeout: (handler: () => void, delay: number) => { const entry = { handler, delay, cleared: false }; scheduled.push(entry); return entry; },
			clearTimeout: (handle: unknown) => { if (handle) { (handle as { cleared: boolean }).cleared = true; } },
		};
		const fire = (delay: number) => {
			const entry = scheduled.find(candidate => candidate.delay === delay && !candidate.cleared)!;
			entry.cleared = true;
			entry.handler();
		};
		const workers: FakeWorker[] = [];
		let createFailures = 1;
		const backend = new ParadisWordSemanticWorkerBackend(() => {
			if (createFailures-- > 0) { throw new Error('missing entry'); }
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		}, 45_000, timers);
		const bytes = new Uint8Array([1]);
		const code = async (promise: Promise<IParadisWordAnalysisResult | IParadisWordComparisonResult>) => { const result = await promise; return result.ok ? 'ok' : result.code; };
		try {
			// 起動できなければ失敗を返し、次の依頼でもう一度起動を試す（本体では解析しない）。
			const notStarted = await code(backend.analyze(bytes, CancellationToken.None));

			// 比較を走らせている間に、待っている解析が待ち行列の締め切りを過ぎても、比較は止めずに最後まで終わる。
			const comparing = code(backend.compare(bytes, bytes, CancellationToken.None));
			const waiting = code(backend.analyze(bytes, CancellationToken.None));
			fire(PARADIS_WORD_SEMANTIC_QUEUE_DEADLINE_MS);
			const waitingResult = await waiting;
			workers[0].reply('unsupported');
			const compareResult = await comparing;

			// 走っている依頼の締め切りは、その依頼だけを失敗にし、待っていた依頼は新しい worker で続ける。
			const hung = code(backend.analyze(bytes, CancellationToken.None));
			const next = code(backend.analyze(bytes, CancellationToken.None));
			fire(PARADIS_WORD_SEMANTIC_ANALYZE_DEADLINE_MS);
			const hungResult = await hung;
			workers[1].reply('invalid');
			const nextResult = await next;

			// worker が落ちたら、走っていた依頼は失敗（メモリ不足なら大きすぎる扱い）。本体で解析し直さない。
			// メモリ不足で落とした文書は覚えておき、次からは worker を起動せずに断る。
			const heavy = new Uint8Array([9, 9]);
			const outOfMemory = code(backend.analyze(heavy, CancellationToken.None));
			workers[1].crash(Object.assign(new Error('heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }));
			const rememberedOutOfMemory = await code(backend.analyze(heavy.slice(), CancellationToken.None));
			const crashed = code(backend.analyze(bytes, CancellationToken.None));
			workers[2].crash();

			// 待ち行列の長さ（件数とバイト数）には上限がある。超えた依頼は「混み合っている」。
			const running = backend.analyze(bytes, CancellationToken.None);
			const big = new Uint8Array(PARADIS_WORD_SEMANTIC_QUEUE_BYTES_LIMIT / 2 + 1);
			const queuedBig = backend.analyze(big, CancellationToken.None);
			const overBytes = await code(backend.analyze(big.slice(), CancellationToken.None));
			const queued = Array.from({ length: PARADIS_WORD_SEMANTIC_QUEUE_LIMIT - 1 }, () => backend.analyze(bytes, CancellationToken.None));
			const overflow = await code(backend.analyze(bytes, CancellationToken.None));

			deepStrictEqual({
				notStarted, waitingResult, compareResult, comparisonWorkerTerminated: workers[0].terminated, hungResult, nextResult,
				outOfMemory: await outOfMemory, rememberedOutOfMemory, crashed: await crashed, overBytes, overflow,
				posted: workers.map(worker => worker.posted.map(message => message.op)),
			}, {
				notStarted: 'failed', waitingResult: 'busy', compareResult: 'unsupported', comparisonWorkerTerminated: true, hungResult: 'limitExceeded', nextResult: 'invalid',
				outOfMemory: 'limitExceeded', rememberedOutOfMemory: 'limitExceeded', crashed: 'failed', overBytes: 'busy', overflow: 'busy',
				posted: [['compare', 'analyze'], ['analyze', 'analyze'], ['analyze'], ['analyze']],
			});
			backend.dispose();
			deepStrictEqual(await Promise.all([running, queuedBig, ...queued].map(code)), Array.from({ length: PARADIS_WORD_SEMANTIC_QUEUE_LIMIT + 1 }, () => 'cancelled'));
		} finally {
			backend.dispose();
		}
	});

	test('channel passes VSBuffer bytes and the cancellation token to the backend', async () => {
		const seen: string[] = [];
		const channel = new ParadisWordSemanticChannel(async () => ({
			analyze: async (bytes, token) => {
				seen.push(`analyze:${bytes.byteLength}:${token === CancellationToken.None}`);
				return { ok: false, code: 'failed' } satisfies IParadisWordAnalysisResult;
			},
			compare: async (original, modified) => {
				seen.push(`compare:${original.byteLength}:${modified.byteLength}`);
				return { ok: false, code: 'failed' } satisfies IParadisWordComparisonResult;
			},
		}));
		await channel.call('', 'analyze', [VSBuffer.fromString('abc')]);
		await channel.call('', 'compare', [VSBuffer.fromString('ab'), VSBuffer.fromString('abcd')]);
		const invalid = await channel.call<IParadisWordAnalysisResult>('', 'analyze', ['not bytes']);
		deepStrictEqual({ seen, invalid }, { seen: ['analyze:3:true', 'compare:2:4'], invalid: { ok: false, code: 'invalid' } });
	});
});
