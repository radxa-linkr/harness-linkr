import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

/**
 * The copy lives in four places: the two dictionaries inside `client.js` (plain
 * JavaScript, because the client artifact cannot import JSON at runtime) and the
 * two locale files the Harness reads for the plugin's own title and description.
 * A key added to one and forgotten in another ships as a blank row rather than
 * as a build error, so the drift itself is the test.
 */
test('locale files and the client dictionaries cover the same keys', async () => {
  const [zhSource, enSource, client] = await Promise.all([
    read('locale/zh.json'),
    read('locale/en.json'),
    read('client.js'),
  ]);
  const zh = JSON.parse(zhSource);
  const en = JSON.parse(enSource);

  assert.deepEqual(
    Object.keys(en).sort(),
    Object.keys(zh).sort(),
    'en.json and zh.json must carry the same keys',
  );

  // `meta` is the plugin's title and description for the Harness, not panel
  // copy: it only ever lives in the locale files.
  const missing = Object.keys(zh).filter(
    (key) => key !== 'meta' && !new RegExp(`\\n\\s*${key}:`).test(client),
  );
  assert.deepEqual(missing, [], 'every translated key must also exist in the client dictionary');
});
