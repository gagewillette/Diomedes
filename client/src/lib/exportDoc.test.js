import test from 'node:test';
import assert from 'node:assert/strict';
import { lowerForMarkdown, unescapeCalloutBadges } from './exportDoc.js';
import { hydrateDiagramBlocks } from './diagramBlocks.js';

const doc = (...content) => ({ type: 'doc', content });
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

test('a mermaid diagram goes back to the fence it was imported from', () => {
  const out = lowerForMarkdown(doc({ type: 'mermaidDiagram', attrs: { code: 'graph TD\nA-->B' } }));
  assert.deepEqual(out.content[0], {
    type: 'codeBlock',
    attrs: { language: 'mermaid' },
    content: [{ type: 'text', text: 'graph TD\nA-->B' }],
  });
});

test('a draw.io diagram exports as its XML, which is all it ever was', () => {
  const xml = '<mxfile><diagram /></mxfile>';
  const out = lowerForMarkdown(doc({ type: 'drawioDiagram', attrs: { xml, svg: '<svg/>' } }));
  assert.equal(out.content[0].attrs.language, 'drawio');
  assert.equal(out.content[0].content[0].text, xml);
});

test('lowering a diagram is the exact inverse of hydrating one', () => {
  const original = doc({ type: 'mermaidDiagram', attrs: { code: 'graph TD' } });
  assert.deepEqual(hydrateDiagramBlocks(lowerForMarkdown(original)), original);
});

test('a callout keeps its text, under the badge the importer understands', () => {
  const out = lowerForMarkdown(
    doc({ type: 'callout', attrs: { variant: 'warning' }, content: [para('Mind the gap')] })
  );
  assert.equal(out.content[0].type, 'blockquote');
  assert.equal(out.content[0].content[0].content[0].text, '[!WARNING]');
  assert.equal(out.content[0].content[1].content[0].text, 'Mind the gap');
});

test('a toggle keeps the body it was hiding, with its summary above it', () => {
  const out = lowerForMarkdown(
    doc({ type: 'toggleBlock', attrs: { title: 'Details' }, content: [para('Hidden')] })
  );
  assert.equal(out.content[0].content[0].content[0].marks[0].type, 'bold');
  assert.equal(out.content[0].content[1].content[0].text, 'Hidden');
});

test('a page link exports as a link, not as nothing', () => {
  const out = lowerForMarkdown(
    doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See ' },
        { type: 'pageLink', attrs: { pageId: 'p2', spaceSlug: 'eng', label: 'Onboarding' } },
      ],
    })
  );
  const link = out.content[0].content[1];
  assert.equal(link.type, 'text');
  assert.equal(link.text, 'Onboarding');
  assert.equal(link.marks[0].attrs.href, '/s/eng/p/p2');
});

test('an unresolved page link is still its label', () => {
  const out = lowerForMarkdown(
    doc({ type: 'paragraph', content: [{ type: 'pageLink', attrs: { label: 'Draft' } }] })
  );
  assert.deepEqual(out.content[0].content[0], { type: 'text', text: 'Draft' });
});

test('an attachment exports as a link to where the file still lives', () => {
  const out = lowerForMarkdown(
    doc({ type: 'documentBlock', attrs: { filename: 'Plan.pdf', url: '/api/files/abc' } })
  );
  assert.equal(out.content[0].content[0].text, 'Plan.pdf');
  assert.equal(out.content[0].content[0].marks[0].attrs.href, '/api/files/abc');
});

test('a drawing says so rather than vanishing', () => {
  const out = lowerForMarkdown(doc({ type: 'excalidraw', attrs: { data: {} } }));
  assert.match(out.content[0].content[0].text, /Excalidraw/);
  assert.equal(out.content[0].content[0].marks[0].type, 'italic');
});

test('custom blocks are lowered wherever they are nested, not just at the top', () => {
  const out = lowerForMarkdown(
    doc({
      type: 'blockquote',
      content: [{ type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'mermaidDiagram', attrs: { code: 'graph TD' } }] },
      ] }],
    })
  );
  const item = out.content[0].content[0].content[0].content[0];
  assert.equal(item.type, 'codeBlock');
  assert.equal(item.attrs.language, 'mermaid');
});

test('ordinary blocks come through untouched', () => {
  const original = doc(para('Hello'), { type: 'heading', attrs: { level: 2 }, content: [] });
  assert.deepEqual(lowerForMarkdown(original), original);
});

test('a callout badge survives the serialiser\'s bracket escaping', () => {
  assert.equal(
    unescapeCalloutBadges('> \\[!NOTE\\]\n>\n> Mind the gap'),
    '> [!NOTE]\n>\n> Mind the gap'
  );
});

test('a nested callout badge is unescaped too', () => {
  assert.equal(unescapeCalloutBadges('> > \\[!WARNING\\]'), '> > [!WARNING]');
});

test('escaped brackets that are not a badge are left escaped', () => {
  const text = '> see \\[!NOTE\\] below';
  assert.equal(unescapeCalloutBadges(text), text);
  assert.equal(unescapeCalloutBadges('\\[!NOTE\\]'), '\\[!NOTE\\]');
});
