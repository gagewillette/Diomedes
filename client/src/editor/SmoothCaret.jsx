import { useEffect, useRef } from 'react';

// Word-style gliding caret: the native caret is hidden via CSS and this
// fixed-position element animates to the real caret coordinates on every
// selection change, giving the smooth "typing glide" effect.
export default function SmoothCaret({ editor }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!editor) return;
    let raf = 0;

    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = ref.current;
        if (!el || editor.isDestroyed) return;
        if (!editor.isFocused) {
          el.style.opacity = '0';
          return;
        }
        try {
          const { head } = editor.state.selection;
          const coords = editor.view.coordsAtPos(head);
          const height = Math.max(coords.bottom - coords.top, 14);
          el.style.opacity = '1';
          el.style.left = `${coords.left}px`;
          el.style.top = `${coords.top}px`;
          el.style.height = `${height}px`;
          // restart the blink cycle so the caret is solid while moving
          el.style.animation = 'none';
          void el.offsetWidth;
          el.style.animation = '';
        } catch {
          el.style.opacity = '0';
        }
      });
    };

    editor.on('transaction', update);
    editor.on('focus', update);
    editor.on('blur', update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    update();
    return () => {
      cancelAnimationFrame(raf);
      editor.off('transaction', update);
      editor.off('focus', update);
      editor.off('blur', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [editor]);

  return <div ref={ref} className="gd-smooth-caret" aria-hidden="true" />;
}
