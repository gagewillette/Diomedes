import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';

const MentionList = forwardRef(({ items, command }, ref) => {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowDown') { setSelected((s) => (s + 1) % items.length); return true; }
      if (event.key === 'ArrowUp') { setSelected((s) => (s - 1 + items.length) % items.length); return true; }
      if (event.key === 'Enter') {
        if (items[selected]) command({ id: items[selected].id, label: items[selected].name });
        return true;
      }
      return false;
    },
  }));
  if (!items.length) return null;
  return (
    <div className="gd-slash-menu">
      {items.map((u, i) => (
        <button
          key={u.id}
          className={`gd-slash-item ${i === selected ? 'is-selected' : ''}`}
          onMouseEnter={() => setSelected(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => command({ id: u.id, label: u.name })}
        >
          <span>
            <b>{u.name}</b>
            <small>@{u.username}</small>
          </span>
        </button>
      ))}
    </div>
  );
});
MentionList.displayName = 'MentionList';
export default MentionList;
