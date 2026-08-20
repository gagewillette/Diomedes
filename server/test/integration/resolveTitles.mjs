// End-to-end for POST /api/pages/resolve-titles — the lookup a machine writing
// `[[links]]` uses instead of the autocomplete. Run against a server pointed at
// a throwaway database:
//   DATABASE_URL=... PORT=3111 node src/index.js
//   BASE_URL=http://localhost:3111 node test/integration/resolveTitles.mjs
const B = process.env.BASE_URL || 'http://localhost:3111';

let cookie = '';
async function api(method, path, body) {
  const res = await fetch(`${B}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${method} ${path}: ${text}`);
  }
  return data;
}

const ok = (msg) => console.log(`  ok  ${msg}`);
function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL ${msg}`);
    process.exit(1);
  }
  ok(msg);
}

await api('POST', '/api/auth/setup', {
  workspaceName: 'E2E',
  name: 'Tester',
  username: 'tester',
  password: 'password123',
});
const { spaces } = await api('GET', '/api/spaces');
const space = spaces[0].id;
ok(`space ${space}`);

const secondSpace = (await api('POST', '/api/spaces', { name: 'Other', slug: 'other' })).space.id;
ok(`second space ${secondSpace}`);

const newPage = async (spaceId, title) =>
  (await api('POST', '/api/pages', { spaceId, title })).page.id;

// ---- cause #1: the answer sits outside link-search's twelve-row window ----
//
// The page actually titled "Overview", then twenty whose titles merely contain
// the word. Ranked by `updated_at DESC`, the twenty newer ones fill the whole
// window and the exact match is never returned.
const overview = await newPage(space, 'Overview');
for (let i = 0; i < 20; i++) await newPage(space, `Service Overview ${i}`);

const search = await (
  await fetch(`${B}/api/pages/link-search?q=Overview&spaceId=${space}`, { headers: { cookie } })
).json();
assert(
  search.pages.length === 12 && !search.pages.some((p) => p.id === overview),
  'link-search truncates: the exact match is not in its twelve rows'
);

const one = await api('POST', '/api/pages/resolve-titles', { spaceId: space, titles: ['Overview'] });
assert(
  one.results.Overview.status === 'ok' && one.results.Overview.id === overview,
  'resolve-titles finds it anyway — the regression case from issue #66'
);

// ---- normalization matches how links are written ----
const arch = await newPage(space, 'Architecture');
const norm = await api('POST', '/api/pages/resolve-titles', {
  spaceId: space,
  titles: ['  ARCHITECTURE  ', 'architecture'],
});
assert(
  norm.results['  ARCHITECTURE  '].id === arch && norm.results.architecture.id === arch,
  'case and surrounding whitespace do not change the answer'
);

// ---- a batch is one round trip, and answers every title asked ----
const auth = await newPage(space, 'Auth Service');
const batch = await api('POST', '/api/pages/resolve-titles', {
  spaceId: space,
  titles: ['Architecture', 'Auth Service', 'Never Written'],
});
assert(
  batch.results.Architecture.id === arch &&
    batch.results['Auth Service'].id === auth &&
    batch.results['Never Written'].status === 'not_found',
  'a whole document of links resolves in one request'
);
assert(
  batch.results.Architecture.space_slug === spaces[0].slug,
  'a resolved page carries the slug a link needs for its href'
);

// ---- the space being written in wins; a real tie is reported ----
await newPage(secondSpace, 'Architecture');
const preferred = await api('POST', '/api/pages/resolve-titles', {
  spaceId: space,
  titles: ['Architecture'],
});
assert(
  preferred.results.Architecture.status === 'ok' && preferred.results.Architecture.id === arch,
  'the same title in another space does not make the local one ambiguous'
);

const crossSpace = await api('POST', '/api/pages/resolve-titles', { titles: ['Architecture'] });
assert(
  crossSpace.results.Architecture.status === 'ambiguous' &&
    crossSpace.results.Architecture.candidates.length === 2,
  'with no space to prefer, two pages titled the same are ambiguous'
);

const dupe = await newPage(space, 'Architecture');
const tie = await api('POST', '/api/pages/resolve-titles', {
  spaceId: space,
  titles: ['Architecture'],
});
assert(
  tie.results.Architecture.status === 'ambiguous' &&
    tie.results.Architecture.candidates.map((p) => p.id).includes(dupe),
  'two pages titled the same in one space are reported, never guessed'
);

// ---- a deleted page stops answering ----
await api('DELETE', `/api/pages/${dupe}`);
const afterDelete = await api('POST', '/api/pages/resolve-titles', {
  spaceId: space,
  titles: ['Architecture'],
});
assert(
  afterDelete.results.Architecture.status === 'ok' && afterDelete.results.Architecture.id === arch,
  'trashing the duplicate resolves the ambiguity'
);

// ---- limits and empty input ----
const empty = await api('POST', '/api/pages/resolve-titles', { spaceId: space, titles: [] });
assert(Object.keys(empty.results).length === 0, 'an empty batch is an empty answer, not an error');

const tooMany = await fetch(`${B}/api/pages/resolve-titles`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({ titles: Array.from({ length: 201 }, (_, i) => `T${i}`) }),
});
assert(tooMany.status === 400, 'a batch over the cap is refused rather than silently truncated');

console.log('resolve-titles: all checks passed');
