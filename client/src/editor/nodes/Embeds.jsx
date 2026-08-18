import { Node, mergeAttributes } from '@tiptap/core';

export const IframeEmbed = Node.create({
  name: 'iframeEmbed',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      src: { default: null },
      height: { default: 420 },
    };
  },
  parseHTML() {
    return [{ tag: 'iframe[data-type="embed"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'iframe',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'embed',
        class: 'gd-iframe-embed',
        sandbox: 'allow-scripts allow-same-origin allow-popups allow-forms',
        allowfullscreen: 'true',
        loading: 'lazy',
      }),
    ];
  },
});

export const VideoBlock = Node.create({
  name: 'videoBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return { src: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'video[data-type="video"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'video',
      mergeAttributes(HTMLAttributes, { 'data-type': 'video', class: 'gd-video', controls: 'true', preload: 'metadata' }),
    ];
  },
});
