import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Group, Modal, Radio, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api } from '../lib/api.js';
import { docKindFor } from './nodes/DocumentBlock.jsx';

/**
 * Uploads PDF/PPTX documents for a page. A PPTX first asks how it should be
 * stored — as the original file, or converted to PDF on the server — and the
 * answer travels with the upload as `storeAs`.
 *
 * Returns `{ uploadDocument, prompt }`; render `prompt` inside the editor.
 */
export function useDocumentUpload(pageId) {
  const [pending, setPending] = useState(null); // { file, resolve }
  const [choice, setChoice] = useState('pdf');
  const [canConvert, setCanConvert] = useState(true);
  const resolveRef = useRef(null);

  useEffect(() => {
    if (!pageId) return;
    api
      .get('/api/documents/capabilities', { noRedirect: true })
      .then((d) => setCanConvert(Boolean(d.pdfConversion)))
      .catch(() => setCanConvert(false));
  }, [pageId]);

  // A pending prompt must never leave its caller awaiting forever.
  useEffect(
    () => () => {
      resolveRef.current?.(null);
      resolveRef.current = null;
    },
    []
  );

  const askStoreAs = useCallback(
    (file) =>
      new Promise((resolve) => {
        resolveRef.current = resolve;
        setChoice(canConvert ? 'pdf' : 'original');
        setPending({ file });
      }),
    [canConvert]
  );

  const answer = useCallback((value) => {
    setPending(null);
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(value);
  }, []);

  const uploadDocument = useCallback(
    async (file) => {
      if (!pageId) return null;
      const kind = docKindFor(file);
      if (!kind) return null;

      let storeAs = 'original';
      if (kind === 'pptx') {
        storeAs = await askStoreAs(file);
        if (!storeAs) return null; // cancelled
      }

      const fd = new FormData();
      fd.append('file', file);
      fd.append('storeAs', storeAs);
      try {
        return await api.post(`/api/pages/${pageId}/documents`, fd);
      } catch (err) {
        notifications.show({ color: 'red', message: `Upload failed: ${err.message}` });
        return null;
      }
    },
    [pageId, askStoreAs]
  );

  const prompt = (
    <Modal
      opened={Boolean(pending)}
      onClose={() => answer(null)}
      title="Store this presentation as…"
      centered
      size="md"
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed" truncate="end">
          {pending?.file?.name}
        </Text>
        <Radio.Group value={choice} onChange={setChoice}>
          <Stack gap="sm">
            <Radio
              value="pdf"
              disabled={!canConvert}
              label="PDF"
              description={
                canConvert
                  ? 'Converted on upload. Can be viewed in the browser as well as downloaded.'
                  : 'Unavailable — this server has no PDF converter installed.'
              }
            />
            <Radio
              value="original"
              label="PowerPoint (.pptx)"
              description="Kept as the original file. Download only — it cannot be viewed in the browser."
            />
          </Stack>
        </Radio.Group>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => answer(null)}>
            Cancel
          </Button>
          <Button onClick={() => answer(choice)}>Upload</Button>
        </Group>
      </Stack>
    </Modal>
  );

  return { uploadDocument, prompt };
}
