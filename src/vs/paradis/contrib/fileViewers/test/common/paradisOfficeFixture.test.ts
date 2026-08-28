/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { importAMDNodeModule } from '../../../../../amdX.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildOpcFixture } from './paradisOfficeFixture.js';

suite('ParadisOfficeFixture', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds a deterministic OPC package independent of input ordering', async () => {
		const a = await buildOpcFixture({ parts: [['/a.xml', '<a/>'], ['/b.bin', new Uint8Array([1])]] });
		const b = await buildOpcFixture({ parts: [['/b.bin', new Uint8Array([1])], ['/a.xml', '<a/>']] });

		deepStrictEqual(a, b);
	});

	test('writes canonical OPC parts, escapes XML attributes, and orders Unicode names by code unit', async () => {
		const bytes = await buildOpcFixture({
			parts: [
				['/ä.xml', '<ä/>'],
				['/word/document.xml', '<document/>'],
				['/z.xml', '<z/>', 'application/example+xml; label="z&<>"'],
			],
			relationships: [
				{ id: 'root&<>"', type: 'urn:test?value=&<>"', target: 'word/document.xml' },
				{ source: '/word/document.xml', id: 'ä', type: 'urn:ä', target: 'ä.xml' },
				{ source: '/word/document.xml', id: 'z&<>"', type: 'urn:test?value=&<>"', target: 'https://example.test/a?x=&<>"', targetMode: 'External' },
			],
		});
		const JSZip = await importAMDNodeModule<typeof import('jszip')>('jszip', 'dist/jszip.min.js');
		const zip = await JSZip.loadAsync(bytes);

		deepStrictEqual(Object.keys(zip.files), [
			'[Content_Types].xml',
			'_rels/.rels',
			'word/_rels/document.xml.rels',
			'word/document.xml',
			'z.xml',
			'ä.xml',
		]);
		deepStrictEqual(await zip.file('[Content_Types].xml')?.async('string'), '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/xml"/><Override PartName="/z.xml" ContentType="application/example+xml; label=&quot;z&amp;&lt;&gt;&quot;"/><Override PartName="/ä.xml" ContentType="application/xml"/></Types>');
		deepStrictEqual(await zip.file('_rels/.rels')?.async('string'), '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root&amp;&lt;&gt;&quot;" Type="urn:test?value=&amp;&lt;&gt;&quot;" Target="word/document.xml"/></Relationships>');
		deepStrictEqual(await zip.file('word/_rels/document.xml.rels')?.async('string'), '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="z&amp;&lt;&gt;&quot;" Type="urn:test?value=&amp;&lt;&gt;&quot;" Target="https://example.test/a?x=&amp;&lt;&gt;&quot;" TargetMode="External"/><Relationship Id="ä" Type="urn:ä" Target="ä.xml"/></Relationships>');
	});
});
