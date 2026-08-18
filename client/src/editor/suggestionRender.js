import { ReactRenderer } from '@tiptap/react';
import tippy from 'tippy.js';

// Wires a React list component into a TipTap suggestion popup.
export function makeSuggestionRender(Component) {
  return () => {
    let reactRenderer;
    let popup;
    return {
      onStart: (props) => {
        if (!props.clientRect) return;
        reactRenderer = new ReactRenderer(Component, { props, editor: props.editor });
        popup = tippy('body', {
          getReferenceClientRect: props.clientRect,
          appendTo: () => document.body,
          content: reactRenderer.element,
          showOnCreate: true,
          interactive: true,
          trigger: 'manual',
          placement: 'bottom-start',
        });
      },
      onUpdate: (props) => {
        reactRenderer?.updateProps(props);
        if (props.clientRect) popup?.[0]?.setProps({ getReferenceClientRect: props.clientRect });
      },
      onKeyDown: (props) => {
        if (props.event.key === 'Escape') {
          popup?.[0]?.hide();
          return true;
        }
        return reactRenderer?.ref?.onKeyDown(props) ?? false;
      },
      onExit: () => {
        popup?.[0]?.destroy();
        reactRenderer?.destroy();
      },
    };
  };
}
