import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hydrateDiagramBlocks, isDrawioXml } from './diagramBlocks.js';

const XML =
  '<mxfile host="app.diagrams.net"><diagram name="Page-1"><mxGraphModel dx="800">' +
  '<root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel></diagram></mxfile>';

const codeBlock = (language, text) => ({
  type: 'doc',
  content: [{ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text }] }],
});

test('a drawio fence becomes a draw.io diagram node', () => {
  const doc = hydrateDiagramBlocks(codeBlock('drawio', XML));
  assert.equal(doc.content[0].type, 'drawioDiagram');
  assert.equal(doc.content[0].attrs.xml, XML);
  assert.equal(doc.content[0].attrs.svg, '');
});

test('mxGraph XML is recognised whatever the fence is labelled', () => {
  for (const lang of [null, '', 'xml', 'mxgraph', 'draw.io']) {
    assert.equal(hydrateDiagramBlocks(codeBlock(lang, XML)).content[0].type, 'drawioDiagram', `lang ${lang}`);
  }
});

test('an ordinary xml fence stays a code block', () => {
  const doc = hydrateDiagramBlocks(codeBlock('xml', '<note><to>you</to></note>'));
  assert.equal(doc.content[0].type, 'codeBlock');
});

test('a mermaid fence becomes a mermaid node', () => {
  const doc = hydrateDiagramBlocks(codeBlock('mermaid', 'graph TD\n  A --> B'));
  assert.equal(doc.content[0].type, 'mermaidDiagram');
  assert.equal(doc.content[0].attrs.code, 'graph TD\n  A --> B');
});

test('the block keeps its id across the swap', () => {
  const doc = hydrateDiagramBlocks({
    type: 'doc',
    content: [
      {
        type: 'codeBlock',
        attrs: { language: 'drawio', blockId: 'blk_TEST' },
        content: [{ type: 'text', text: XML }],
      },
    ],
  });
  assert.equal(doc.content[0].attrs.blockId, 'blk_TEST');
});

test('diagrams nested inside other blocks are converted too', () => {
  const doc = hydrateDiagramBlocks({
    type: 'doc',
    content: [
      {
        type: 'blockquote',
        content: [{ type: 'codeBlock', attrs: { language: 'drawio' }, content: [{ type: 'text', text: XML }] }],
      },
    ],
  });
  assert.equal(doc.content[0].content[0].type, 'drawioDiagram');
});

test('an empty code block is left alone', () => {
  const doc = hydrateDiagramBlocks({ type: 'doc', content: [{ type: 'codeBlock', attrs: { language: null } }] });
  assert.equal(doc.content[0].type, 'codeBlock');
});

test('isDrawioXml tolerates a leading xml declaration and whitespace', () => {
  assert.equal(isDrawioXml('\n  <?xml version="1.0"?>\n<mxfile>'), true);
  assert.equal(isDrawioXml('<mxGraphModel dx="1">'), true);
  assert.equal(isDrawioXml('<mxfilething>'), false);
  assert.equal(isDrawioXml(''), false);
});
