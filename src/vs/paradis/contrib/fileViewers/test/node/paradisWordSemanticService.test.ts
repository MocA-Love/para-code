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
import { ParadisWordSemanticChannel } from '../../node/word/paradisWordSemanticChannel.js';
import { ParadisWordSemanticService } from '../../node/word/paradisWordSemanticService.js';
import { ParadisWordSemanticWorkerBackend, type IParadisWordSemanticWorker } from '../../node/word/paradisWordSemanticWorkerBackend.js';
import type { ParadisWordSemanticWorkerReply, ParadisWordSemanticWorkerRequest } from '../../node/word/paradisWordSemanticWorkerProtocol.js';
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

	test('compares two versions into categorized changes and reports an identical pair as complete with no changes', async () => {
		const service = new ParadisWordSemanticService();
		const original = await wordFixture();
		const same = await service.compare(original, original.slice(), CancellationToken.None);
		const edited = await service.compare(original, await wordFixture({ title: 'Equipment loan request', headingBold: false }), CancellationToken.None);
		if (!same.ok || !edited.ok) {
			throw new Error('comparison failed');
		}
		deepStrictEqual({
			same: [same.outcome, same.noChanges, same.changes.length, same.omittedModels],
			edited: [...new Set(edited.changes.map(change => `${change.category}:${change.subject.kind}`))].sort(),
		}, {
			same: ['complete', true, 0, []],
			edited: ['content:paragraph.text', 'formatting:package.style'],
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

	test('worker backend answers through the worker and falls back in-process when the worker never starts', async () => {
		const log: string[] = [];
		class FakeWorker implements IParadisWordSemanticWorker {
			private readonly listeners = new Map<string, ((value: never) => void)[]>();
			constructor(private readonly broken: boolean) { }
			postMessage(message: ParadisWordSemanticWorkerRequest): void {
				log.push(`${this.broken ? 'broken' : 'worker'}:${message.op}`);
				queueMicrotask(() => this.broken
					? this.emit('exit', 1 as never)
					: message.op !== 'cancel' && this.emit('message', { id: message.id, result: { ok: false, code: 'unsupported' } } satisfies ParadisWordSemanticWorkerReply as never));
			}
			on(event: string, listener: (value: never) => void): unknown {
				this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
				return this;
			}
			async terminate(): Promise<number> { log.push('terminate'); return 0; }
			private emit(event: string, value: never): void {
				for (const listener of this.listeners.get(event) ?? []) { listener(value); }
			}
		}
		const fallback = async () => ({
			analyze: async () => { log.push('fallback:analyze'); return { ok: false, code: 'failed' } satisfies IParadisWordAnalysisResult; },
			compare: async () => { log.push('fallback:compare'); return { ok: false, code: 'failed' } satisfies IParadisWordComparisonResult; },
		});
		const working = new ParadisWordSemanticWorkerBackend(() => new FakeWorker(false), fallback, 60_000);
		const viaWorker = await working.analyze(new Uint8Array([1]), CancellationToken.None);
		working.dispose();
		const broken = new ParadisWordSemanticWorkerBackend(() => new FakeWorker(true), fallback, 60_000);
		const first = await broken.analyze(new Uint8Array([1]), CancellationToken.None);
		const second = await broken.compare(new Uint8Array([1]), new Uint8Array([2]), CancellationToken.None);
		broken.dispose();
		deepStrictEqual({ viaWorker, first, second, log }, {
			viaWorker: { ok: false, code: 'unsupported' },
			first: { ok: false, code: 'failed' },
			second: { ok: false, code: 'failed' },
			log: ['worker:analyze', 'terminate', 'broken:analyze', 'fallback:analyze', 'fallback:compare'],
		});
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
