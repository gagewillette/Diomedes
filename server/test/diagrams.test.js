import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDiagrams,
  isMermaidLanguage,
  looksLikeMermaid,
  isDrawioLanguage,
  looksLikeDrawio,
} from '../src/lib/diagrams.js';

const codeBlock = (language, code) => ({
  type: 'codeBlock',
  attrs: { language },
  content: [{ type: 'text', text: code }],
});

const doc = (...content) => ({ type: 'doc', content });

const GRAPH = 'graph TD\n  A[Start] --> B[End]';

test('an exact ```mermaid fence becomes a diagram node', () => {
  const out = normalizeDiagrams(doc(codeBlock('mermaid', GRAPH)));
  assert.deepEqual(out.content[0], { type: 'mermaidDiagram', attrs: { code: GRAPH } });
});

test('the language is matched case-insensitively and past info-string attributes', () => {
  for (const language of ['Mermaid', 'MERMAID', 'mmd', 'mermaid title="flow"', 'mermaid,linenos']) {
    const out = normalizeDiagrams(doc(codeBlock(language, GRAPH)));
    assert.equal(out.content[0].type, 'mermaidDiagram', language);
    assert.equal(out.content[0].attrs.code, GRAPH);
  }
});

test('an unlabelled fence whose body is a diagram is sniffed', () => {
  const bodies = [
    GRAPH,
    'flowchart LR\n  A --> B',
    'sequenceDiagram\n  Alice->>Bob: hi',
    'erDiagram\n  USER ||--o{ PAGE : writes',
    'gantt\n  title Roadmap',
    'classDiagram\n  Page <|-- Space',
    'stateDiagram-v2\n  [*] --> Draft',
    'mindmap\n  root((wiki))',
    '---\ntitle: Flow\n---\ngraph LR\n  A --> B',
    '%%{init: {"theme":"dark"}}%%\ngraph TD\n  A --> B',
  ];
  for (const body of bodies) {
    const out = normalizeDiagrams(doc(codeBlock(null, body)));
    assert.equal(out.content[0].type, 'mermaidDiagram', body.split('\n')[0]);
    assert.equal(out.content[0].attrs.code, body);
  }
});

test('ordinary code is left alone', () => {
  const bodies = [
    ['js', 'const graph = new Graph();'],
    [null, 'const graph = new Graph();'],
    [null, 'graph = load()\nprint(graph)'],
    ['python', 'def journey():\n    pass'],
    [null, ''],
  ];
  for (const [language, code] of bodies) {
    const out = normalizeDiagrams(doc(codeBlock(language, code)));
    assert.equal(out.content[0].type, 'codeBlock', code);
  }
});

test('a labelled fence wins over the body, even a body that looks like code', () => {
  const out = normalizeDiagrams(doc(codeBlock('mermaid', 'not really a diagram')));
  assert.equal(out.content[0].type, 'mermaidDiagram');
});

test('diagrams nested inside lists, quotes, callouts and tables are converted', () => {
  const nest = (type, child) => ({ type, content: [child] });
  const inList = doc(
    nest('bulletList', nest('listItem', codeBlock('mermaid', GRAPH))),
    nest('blockquote', codeBlock('mermaid', GRAPH)),
    { type: 'callout', attrs: { variant: 'info' }, content: [codeBlock(null, GRAPH)] },
    nest('table', nest('tableRow', nest('tableCell', codeBlock('mermaid', GRAPH))))
  );
  const out = normalizeDiagrams(inList);
  assert.equal(out.content[0].content[0].content[0].type, 'mermaidDiagram');
  assert.equal(out.content[1].content[0].type, 'mermaidDiagram');
  assert.equal(out.content[2].content[0].type, 'mermaidDiagram');
  assert.equal(out.content[3].content[0].content[0].content[0].type, 'mermaidDiagram');
});

test('a diagram node carrying its source as text has it lifted into attrs.code', () => {
  const out = normalizeDiagrams(
    doc({ type: 'mermaidDiagram', attrs: {}, content: [{ type: 'text', text: GRAPH }] })
  );
  assert.deepEqual(out.content[0], { type: 'mermaidDiagram', attrs: { code: GRAPH } });
});

test('an already-correct document comes back untouched, by identity', () => {
  const input = doc({ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }, codeBlock('js', 'x'));
  assert.equal(normalizeDiagrams(input), input);
});

test('the language and body predicates stand on their own', () => {
  assert.equal(isMermaidLanguage('mermaid'), true);
  assert.equal(isMermaidLanguage('mermaidjs'), false);
  assert.equal(isMermaidLanguage(''), false);
  assert.equal(isMermaidLanguage(null), false);
  assert.equal(looksLikeMermaid('graph TD\n A-->B'), true);
  assert.equal(looksLikeMermaid('graph\n A-->B'), false);
  assert.equal(looksLikeMermaid('  \n\nsequenceDiagram\n A->>B: x'), true);
});

const MXFILE =
  '<mxfile host="app.diagrams.net"><diagram name="Page-1"><mxGraphModel dx="800">' +
  '<root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel></diagram></mxfile>';

test('a ```drawio fence becomes a draw.io diagram node', () => {
  const out = normalizeDiagrams(doc(codeBlock('drawio', MXFILE)));
  assert.deepEqual(out.content[0], { type: 'drawioDiagram', attrs: { xml: MXFILE, svg: '' } });
});

test('draw.io language aliases and info strings are matched like mermaid ones', () => {
  for (const lang of ['draw.io', 'MxGraph', 'drawio title="net"']) {
    assert.equal(normalizeDiagrams(doc(codeBlock(lang, MXFILE))).content[0].type, 'drawioDiagram', lang);
  }
});

test('an unlabelled fence holding mxGraph XML becomes a diagram', () => {
  const out = normalizeDiagrams(doc(codeBlock(null, MXFILE)));
  assert.equal(out.content[0].type, 'drawioDiagram');
});

test('a fence that names another language keeps its diagram XML as code', () => {
  // Someone documenting mxGraph in a ```xml block chose a code block; the MCP
  // server resolves that ambiguity before the document ever gets here.
  const out = normalizeDiagrams(doc(codeBlock('xml', MXFILE)));
  assert.equal(out.content[0].type, 'codeBlock');
});

test('a draw.io node carrying its XML as text has it lifted into attrs.xml', () => {
  const out = normalizeDiagrams(
    doc({ type: 'drawioDiagram', attrs: {}, content: [{ type: 'text', text: MXFILE }] })
  );
  assert.deepEqual(out.content[0], { type: 'drawioDiagram', attrs: { xml: MXFILE, svg: '' } });
});

test('a draw.io diagram that already has its xml is left alone', () => {
  const input = doc({ type: 'drawioDiagram', attrs: { xml: MXFILE, svg: 'data:image/svg+xml;base64,x' } });
  assert.equal(normalizeDiagrams(input), input);
});

test('the draw.io predicates stand on their own', () => {
  assert.equal(isDrawioLanguage('drawio'), true);
  assert.equal(isDrawioLanguage('drawiothing'), false);
  assert.equal(isDrawioLanguage(null), false);
  assert.equal(looksLikeDrawio('\n  <?xml version="1.0"?>\n<mxfile>'), true);
  assert.equal(looksLikeDrawio('<mxGraphModel dx="1">'), true);
  assert.equal(looksLikeDrawio('<mxfilething>'), false);
  assert.equal(looksLikeDrawio(''), false);
});
