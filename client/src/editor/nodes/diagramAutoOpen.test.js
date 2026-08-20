import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimDiagramEditor,
  requestDiagramEditor,
  resetDiagramEditorRequest,
} from './diagramAutoOpen.js';

test('the node view that was asked for claims the request', () => {
  resetDiagramEditorRequest();
  requestDiagramEditor('drawioDiagram', 1000);
  assert.equal(claimDiagramEditor('drawioDiagram', 1010), true);
});

// The whole point: a request is spent once. A second mount of the same diagram —
// a page revisited, a document re-synced — must not open the editor again.
test('a request is claimable only once', () => {
  resetDiagramEditorRequest();
  requestDiagramEditor('drawioDiagram', 1000);
  claimDiagramEditor('drawioDiagram', 1010);
  assert.equal(claimDiagramEditor('drawioDiagram', 1020), false);
});

test('another kind of diagram does not claim the request', () => {
  resetDiagramEditorRequest();
  requestDiagramEditor('drawioDiagram', 1000);
  assert.equal(claimDiagramEditor('excalidraw', 1010), false);
  assert.equal(claimDiagramEditor('drawioDiagram', 1010), true);
});

test('a request nobody claimed in time goes stale', () => {
  resetDiagramEditorRequest();
  requestDiagramEditor('drawioDiagram', 1000);
  assert.equal(claimDiagramEditor('drawioDiagram', 1000 + 5001), false);
});

test('with no request outstanding, mounting claims nothing', () => {
  resetDiagramEditorRequest();
  assert.equal(claimDiagramEditor('drawioDiagram', 1000), false);
});
