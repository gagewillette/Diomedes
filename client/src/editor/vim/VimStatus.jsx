import { useEffect, useState } from 'react';
import { vimPluginKey } from './VimMode.js';

const LABELS = { normal: 'NORMAL', insert: '-- INSERT --', visual: '-- VISUAL --' };

/**
 * The status line. Without it modal editing is a guessing game: which mode you
 * are in only shows up once a keystroke does the wrong thing.
 */
export default function VimStatus({ editor }) {
  const [vim, setVim] = useState(null);

  useEffect(() => {
    if (!editor) return undefined;
    const sync = () => setVim(vimPluginKey.getState(editor.state) || null);
    sync();
    editor.on('transaction', sync);
    return () => { editor.off('transaction', sync); };
  }, [editor]);

  if (!vim) return null;
  const pending = [vim.count, vim.operator].filter(Boolean).join('');

  return (
    <div className={`gd-vim-status is-${vim.mode}`} aria-live="polite">
      {vim.mode === 'command' ? (
        <span className="gd-vim-cmdline">:{vim.command}<span className="gd-vim-cmdcaret" /></span>
      ) : (
        <>
          <span className="gd-vim-mode">{LABELS[vim.mode] || 'NORMAL'}</span>
          {vim.message && <span className="gd-vim-message">{vim.message}</span>}
          {pending && <span className="gd-vim-pending">{pending}</span>}
        </>
      )}
    </div>
  );
}
