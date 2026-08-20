import { Modal } from '@mantine/core';
import EmojiPicker from './EmojiPicker.jsx';

/**
 * The "Set icon" dialog. A modal rather than a popover because it is opened
 * from a menu item, and a menu closing under a popover takes the popover with
 * it.
 */
export default function IconPickerModal({ page, onClose, onPick }) {
  return (
    <Modal
      opened={!!page}
      onClose={onClose}
      title={page ? `Icon for “${page.title || 'Untitled'}”` : 'Page icon'}
      size={380}
      centered
    >
      {page && (
        <EmojiPicker
          value={page.icon || ''}
          onSelect={(char) => onPick(char)}
          onRemove={page.icon ? () => onPick('') : undefined}
        />
      )}
    </Modal>
  );
}
