import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Photo, Folder, Filter, Classification, PhotoTag, Tag } from '../src/lib/api';
const raw = JSON.parse(readFileSync('results/qwen.json', 'utf8')) as {
  results: { image: string; parsed: Classification }[];
};
const tagNames = [...new Set(raw.results.flatMap((result) => result.parsed.tags))];
const fixtures: Photo[] = raw.results.slice(0, 6).map((r, i) => ({
  id: i + 1,
  folderId: 1,
  path: `/photos/${r.image}`,
  filename: r.image,
  caption: r.parsed.caption,
  tags: r.parsed.tags.map((name, index) => ({
    id: tagNames.indexOf(name) + 1,
    name,
    sources: [index === 0 ? 'folder' : index === 1 ? 'user' : 'ai'],
    hiddenFromSearch: false,
  })),
  category: null,
  status: 'classified',
  error: null,
  modified: 1,
}));
const thumbnails = Object.fromEntries(
  fixtures.map((p) => [
    p.id,
    `data:image/jpeg;base64,${readFileSync(`samples/${p.filename}`).toString('base64')}`,
  ]),
);
const folder: Folder = {
  id: 1,
  path: '/photos',
  name: 'Photos',
  enabled: true,
  categories: [],
  instructions: '',
  count: 6,
  pending: 0,
};
test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ fixtures, thumbnails, folder }) => {
      let images = fixtures;
      if (sessionStorage.getItem('large-library')) {
        images = Array.from({ length: 10000 }, (_, index) => ({
          ...fixtures[index % fixtures.length],
          id: index + 1,
          filename: `image-${index + 1}.jpg`,
        }));
      }
      const requestedPages: number[] = [];
      let firstThumbnailRequests = 0;
      const previewRequests: number[] = [];
      let folders = [folder];
      let automatic = false;
      let cpuThreads = 8;
      const entities = new Map<number, string>(
        fixtures.flatMap((photo) => photo.tags.map((tag) => [tag.id, tag.name] as const)),
      );
      entities.set(999, 'unused old tag');
      const tagOptions = new Map<number, Pick<Tag, 'hiddenFromSearch' | 'disableTagging'>>();
      function catalog(): Tag[] {
        return [...entities].map(([id, name]) => ({
          id,
          name,
          count: images.filter((photo) => photo.tags.some((tag) => tag.id === id)).length,
          hiddenFromSearch: tagOptions.get(id)?.hiddenFromSearch ?? false,
          disableTagging: tagOptions.get(id)?.disableTagging ?? false,
        }));
      }
      function ensureTag(name: string): PhotoTag {
        let id = [...entities].find(([, existing]) => existing === name)?.[0];
        if (id === undefined) {
          id = Math.max(...entities.keys()) + 1;
          entities.set(id, name);
        }
        return { id, name, sources: ['user'], hiddenFromSearch: false };
      }
      const invoke = async (command: string, args: Record<string, unknown> = {}) => {
        if (command === 'update_status')
          return {
            phase: sessionStorage.getItem('update-phase') ?? 'idle',
            version: '0.2.0',
            downloaded: 10,
            total: 100,
            error: null,
          };
        if (command === 'check_update') {
          sessionStorage.setItem('update-phase', 'available');
          return;
        }
        if (command === 'download_update') {
          sessionStorage.setItem('update-phase', 'downloading');
          await new Promise((resolve) => setTimeout(resolve, 1600));
          sessionStorage.setItem('update-phase', 'ready');
          return;
        }
        if (command === 'preview') {
          previewRequests.push(Number(args.id));
          document.body.dataset.previewRequests = JSON.stringify(previewRequests);
          if (sessionStorage.getItem('hold-preview-id') === String(args.id)) {
            await new Promise<void>((resolve) =>
              window.addEventListener('release-preview', () => resolve(), { once: true }),
            );
          }
        }
        if (command === 'trash_photo') {
          if (sessionStorage.getItem('trash-error')) throw new Error('System trash unavailable');
          images = images.filter((photo) => photo.id !== args.id);
          document.body.dataset.trashedImage = String(args.id);
          return;
        }
        if (command === 'status') {
          const classificationStatus = sessionStorage.getItem('classification-status');
          return {
            busy: classificationStatus === 'running' || classificationStatus === 'pausing',
            pausing: classificationStatus === 'pausing',
            phase:
              classificationStatus === 'running' || classificationStatus === 'pausing'
                ? 'classify'
                : 'idle',
            message:
              classificationStatus === 'running' || classificationStatus === 'pausing'
                ? 'Classifying 01.jpg'
                : classificationStatus === 'paused'
                  ? 'Paused. Unfinished images stay queued.'
                  : 'Up to date',
            processed: 0,
            modelReady: true,
            automatic,
            revision: 1,
            cpuThreads,
            maxCpuThreads: 12,
          };
        }
        if (command === 'classification_timings')
          return [
            { threads: 4, images: 5, medianMs: 2400, averageMs: 2600 },
            { threads: 8, images: 7, medianMs: 1800, averageMs: 1900 },
          ];
        if (command === 'set_cpu_threads') {
          cpuThreads = Number(args.threads);
          return;
        }
        if (command === 'image_action') {
          document.body.dataset.imageAction = JSON.stringify(args);
          return;
        }
        if (command === 'folders') return folders;
        if (command === 'stats' && sessionStorage.getItem('large-counts'))
          return { total: 8468, classified: 3442, pending: 5026, errors: 0 };
        if (command === 'stats')
          return { total: images.length, classified: images.length, pending: 0, errors: 0 };
        if (command === 'thumbnail' && sessionStorage.getItem('hold-thumbnails')) {
          await new Promise<void>((resolve) =>
            window.addEventListener('release-thumbnails', () => resolve(), { once: true }),
          );
        }
        if (command === 'thumbnail' && sessionStorage.getItem('failed-thumbnails')) {
          if (args.id === 2) return 'data:image/jpeg;base64,broken';
          if (args.id === 3) throw new Error('Image file unavailable');
        }
        if (command === 'thumbnail' || command === 'preview') {
          if (command === 'thumbnail' && args.id === 1) {
            document.body.dataset.firstThumbnailRequests = String(++firstThumbnailRequests);
          }
          return thumbnails[((Number(args.id) - 1) % fixtures.length) + 1];
        }
        if (command === 'search') {
          const f = args.filter as Filter;
          requestedPages.push(f.page);
          document.body.dataset.requestedPages = JSON.stringify(requestedPages);
          const list = images.filter(
            (p) =>
              (!f.folderId || p.folderId === f.folderId) &&
              (!f.status || p.status === f.status) &&
              (f.tags ?? []).every((name) =>
                p.tags.some(
                  (tag) => tag.name === name && !tagOptions.get(tag.id)?.hiddenFromSearch,
                ),
              ) &&
              (!f.query ||
                `${p.tags
                  .filter((tag) => !tagOptions.get(tag.id)?.hiddenFromSearch)
                  .map((tag) => tag.name)
                  .join(' ')} ${p.caption} ${p.filename}`
                  .toLowerCase()
                  .includes(f.query.toLowerCase())),
          );
          return { images: list.slice(f.page * 48, (f.page + 1) * 48), total: list.length };
        }
        if (command === 'tags')
          return catalog().filter((tag) => tag.count > 0 && !tag.hiddenFromSearch);
        if (command === 'tag_suggestions')
          return catalog().filter((tag) =>
            args.prefix
              ? !tag.hiddenFromSearch &&
                !tag.disableTagging &&
                tag.name.startsWith(String(args.query).toLowerCase())
              : tag.name.includes(String(args.query).toLowerCase()),
          );
        if (command === 'tag_catalog') {
          const all = catalog();
          const filtered = all.filter(
            (tag) =>
              tag.name.includes(String(args.query).toLowerCase()) &&
              (!args.orphansOnly ||
                (tag.count === 0 && !tag.disableTagging && !tag.hiddenFromSearch)),
          );
          return {
            tags: filtered.slice(Number(args.page) * 50, (Number(args.page) + 1) * 50),
            total: filtered.length,
            orphans: all.filter(
              (tag) => tag.count === 0 && !tag.disableTagging && !tag.hiddenFromSearch,
            ).length,
          };
        }
        if (command === 'purge_orphan_tags') {
          const unused = catalog().filter(
            (tag) => tag.count === 0 && !tag.disableTagging && !tag.hiddenFromSearch,
          );
          for (const tag of unused) entities.delete(tag.id);
          return unused.length;
        }
        if (command === 'delete_tag') {
          entities.delete(Number(args.id));
          tagOptions.delete(Number(args.id));
          return;
        }
        if (command === 'set_tag_options') {
          const id = Number(args.id);
          const options = {
            hiddenFromSearch: Boolean(args.hiddenFromSearch),
            disableTagging: Boolean(args.disableTagging),
          };
          tagOptions.set(id, options);
          images = images.map((photo) => ({
            ...photo,
            tags: photo.tags
              .filter((tag) => !options.disableTagging || tag.id !== id)
              .map((tag) =>
                tag.id === id ? { ...tag, hiddenFromSearch: options.hiddenFromSearch } : tag,
              ),
          }));
          return;
        }
        if (command === 'rename_tag') {
          const target = ensureTag(String(args.name).trim().toLowerCase());
          images = images.map((photo) => ({
            ...photo,
            tags: photo.tags
              .map((tag) => (tag.id === args.id ? target : tag))
              .filter((tag, index, all) => all.findIndex((other) => other.id === tag.id) === index),
          }));
          if (target.id !== args.id) entities.delete(Number(args.id));
          return;
        }
        if (command === 'save_photo') {
          const edit = args.classification as Classification;
          images = images.map((photo) =>
            photo.id === args.id
              ? {
                  ...photo,
                  ...edit,
                  tags: edit.tags.map(
                    (name) => photo.tags.find((tag) => tag.name === name) ?? ensureTag(name),
                  ),
                }
              : photo,
          );
          return;
        }
        if (command === 'save_folder') {
          folders = folders.map((f) =>
            f.id === (args.folder as Folder).id ? (args.folder as Folder) : f,
          );
          return;
        }
        if (command === 'remove_folder') {
          folders = folders.filter((f) => f.id !== args.id);
          images = images.filter((p) => p.folderId !== args.id);
          return;
        }
        if (command === 'automatic') {
          automatic = Boolean(args.enabled);
          return;
        }
        if (command === 'pause') {
          sessionStorage.setItem('classification-status', 'pausing');
          return;
        }
        if (command === 'start' || command === 'retry') return;
        if (command === 'plugin:dialog|open') return null;
        throw new Error(`Unexpected command: ${command}`);
      };
      Object.defineProperty(window, '__TAURI_INTERNALS__', { value: { invoke } });
    },
    { fixtures, thumbnails, folder },
  );
  await page.goto('/');
});
test('search, edit tags, and search the edited index', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Open 01.jpg' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Search images' }).fill('steering');
  await expect(page.getByRole('button', { name: /^Open .*jpg$/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Open 01.jpg' }).click({ position: { x: 8, y: 8 } });
  await page.getByRole('combobox', { name: 'Add tag' }).fill('road trip');
  await page.getByRole('option', { name: 'Add "road trip"' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Search images' }).fill('road trip');
  await expect(page.getByRole('button', { name: 'Open 01.jpg' })).toBeVisible();
});
test('classification progress and actions stay in the top bar', async ({ page }) => {
  await page.evaluate(() => {
    sessionStorage.setItem('classification-status', 'running');
    sessionStorage.setItem('large-counts', 'true');
  });
  await page.reload();
  const toolbar = page.locator('header');
  const count = toolbar.getByText('3442/8468 classified', { exact: false });
  const progress = toolbar.getByRole('status');
  const scan = toolbar.getByRole('button', { name: 'Scan folders' });
  await expect(count).toBeVisible();
  await expect(progress).toContainText('Classifying 01.jpg');
  await expect(toolbar.getByText('All images')).toHaveCount(0);
  await expect(
    page.locator('main#library').getByRole('button', { name: 'Scan folders' }),
  ).toHaveCount(0);
  const options = toolbar.getByRole('button', { name: 'Options' });
  const positions = await Promise.all(
    [count, progress, scan, options].map((item) => item.boundingBox()),
  );
  expect(
    positions.every((position) => position && Math.abs(position.y - positions[0]!.y) < 8),
  ).toBe(true);
  await page.setViewportSize({ width: 850, height: 650 });
  const narrowPositions = await Promise.all(
    [count, progress, scan, options].map((item) => item.boundingBox()),
  );
  expect(
    narrowPositions.every(
      (position) => position && Math.abs(position.y - narrowPositions[0]!.y) < 8,
    ),
  ).toBe(true);
  expect(narrowPositions[2]!.x + narrowPositions[2]!.width).toBeLessThanOrEqual(
    narrowPositions[3]!.x,
  );
  const controlsRight = await toolbar.locator(':scope > div').first().boundingBox();
  const pauseRight = await toolbar.getByRole('button', { name: 'Pause after image' }).boundingBox();
  expect(pauseRight!.x + pauseRight!.width).toBeLessThanOrEqual(
    controlsRight!.x + controlsRight!.width + 1,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await toolbar.getByRole('button', { name: 'Pause after image' }).click();
  await expect(toolbar.getByRole('button', { name: 'Finishing current image…' })).toBeDisabled();
  await expect(progress).toContainText('Classifying 01.jpg');

  await page.evaluate(() => sessionStorage.setItem('classification-status', 'paused'));
  await expect(progress).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Classify pending' })).toBeVisible();
  await expect(page.getByText('Paused. Unfinished images stay queued.')).toHaveCount(0);
});
test('folder configuration and deliberate removal', async ({ page }) => {
  await page.getByRole('button', { name: 'Configure Photos' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('References');
  await page
    .getByRole('textbox', { name: 'Categories (optional, comma separated)' })
    .fill('nature, vehicle');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByRole('button', { name: 'Configure References' }).click();
  await page.getByRole('button', { name: 'Remove folder…' }).click();
  await expect(
    page.getByText('Original images will remain untouched.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Keep folder' }).click();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('button', { name: 'Configure References' })).toBeVisible();
});
test('keyboard dialog, unsaved edits, empty search, and visual layout', async ({ page }) => {
  await page.getByRole('button', { name: 'Open 01.jpg' }).click({ position: { x: 8, y: 8 } });
  await page.getByRole('textbox', { name: 'Caption', exact: true }).fill('Unsaved edit');
  await page.keyboard.press('Escape');
  await expect(page.getByText('Discard your unsaved changes?')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page.getByRole('combobox', { name: 'Search images' }).fill('no-such-subject');
  await expect(page.getByText('No images match these filters')).toBeVisible();
  await page.getByRole('combobox', { name: 'Search images' }).clear();
  await page.screenshot({ path: 'test-results/library.png', fullPage: true });
  await page.setViewportSize({ width: 850, height: 650 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('image context menu invokes native actions from cards and the enlarged preview', async ({
  page,
}) => {
  await page.goto('/');
  const photo = fixtures[0];
  const card = page.getByRole('button', { name: `Open ${photo.filename}`, exact: true });
  const actions = [
    ['Copy image', 'copy_image'],
    ['Copy image path', 'copy_path'],
    ['Show in file manager', 'reveal'],
    ['Open image', 'open'],
  ] as const;
  for (const [label, action] of actions) {
    await card.click({ button: 'right', position: { x: 8, y: 8 } });
    await expect(page.getByRole('menuitem')).toHaveText(actions.map(([label]) => label));
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(page.locator('body')).toHaveAttribute(
      'data-image-action',
      JSON.stringify({ id: photo.id, action }),
    );
  }
  await card.click({ position: { x: 8, y: 8 } });
  await page
    .getByRole('dialog')
    .getByRole('img', { name: photo.caption, exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy image path', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute(
    'data-image-action',
    JSON.stringify({ id: photo.id, action: 'copy_path' }),
  );
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('tag editor suggests existing tags, creates tags with Enter, and removes tags without submitting', async ({
  page,
}) => {
  const photo = fixtures[0];
  const suggestion = fixtures
    .flatMap((photo) => photo.tags.map((tag) => tag.name))
    .find((tag) => !photo.tags.some((existing) => existing.name === tag))!;
  await page
    .getByRole('button', { name: `Open ${photo.filename}` })
    .click({ position: { x: 8, y: 8 } });
  const input = page.getByRole('combobox', { name: 'Add tag' });
  await input.fill(suggestion);
  await page.getByRole('option', { name: suggestion, exact: true }).click();
  await expect(
    page.getByRole('button', { name: `Remove tag ${suggestion}`, exact: true }),
  ).toBeVisible();
  await input.fill('weekend memories');
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Remove tag weekend memories', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await input.fill('WEEKEND MEMORIES');
  await expect(page.getByText('This tag is already added.')).toBeVisible();
  await input.press('Escape');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Discard your unsaved changes?')).toHaveCount(0);
  await input.clear();
  await page.getByRole('button', { name: `Remove tag ${photo.tags[0].name}`, exact: true }).click();
  await expect(
    page.getByRole('button', { name: `Remove tag ${photo.tags[0].name}`, exact: true }),
  ).toHaveCount(0);
  await input.fill('week');
  await page.screenshot({ path: 'test-results/tag-editor.png' });
  await input.clear();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page
    .getByRole('button', { name: `Open ${photo.filename}` })
    .click({ position: { x: 8, y: 8 } });
  await expect(
    page.getByRole('button', { name: 'Remove tag weekend memories', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: `Remove tag ${suggestion}`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: `Remove tag ${photo.tags[0].name}`, exact: true }),
  ).toHaveCount(0);
});

test('tag sources are tinted and the manager shows usage, renames and purges unused tags', async ({
  page,
}) => {
  const photo = fixtures[0];
  await page
    .getByRole('button', { name: `Open ${photo.filename}` })
    .click({ position: { x: 8, y: 8 } });
  const folderTag = page.getByRole('button', {
    name: `Remove tag ${photo.tags[0].name}`,
    exact: true,
  });
  await expect(folderTag).toHaveAttribute('title', 'Folder name');
  await expect(folderTag).toHaveClass(/bg-sky-50/);
  const userTag = page.getByRole('button', {
    name: `Remove tag ${photo.tags[1].name}`,
    exact: true,
  });
  await expect(userTag).toHaveAttribute('title', 'User');
  await expect(userTag).toHaveClass(/bg-sky-50/);
  const aiTag = page.getByRole('button', { name: `Remove tag ${photo.tags[2].name}`, exact: true });
  await expect(aiTag).toHaveAttribute('title', 'AI');
  await expect(aiTag).not.toHaveClass(/bg-sky-50/);
  await page.screenshot({ path: 'test-results/tag-sources.png' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Manage tags', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search tags' }).fill(photo.tags[0].name);
  await expect(page.getByRole('row').filter({ hasText: photo.tags[0].name })).toContainText('1');
  await expect(
    page.getByRole('button', { name: `Delete tag ${photo.tags[0].name}`, exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: `Rename tag ${photo.tags[0].name}`, exact: true }).click();
  await page.getByRole('textbox', { name: 'Tag name', exact: true }).fill('roadtrip');
  await page.getByRole('button', { name: 'Save tag name', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search tags' }).clear();
  await expect(
    page.getByRole('button', { name: 'Rename tag roadtrip', exact: true }),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: 'Unused only' }).check();
  await expect(page.getByRole('row').filter({ hasText: 'unused old tag' })).toContainText('0');
  await page.screenshot({ path: 'test-results/tag-manager.png' });
  await page.getByRole('button', { name: 'Purge unused tags (1)' }).click();
  await page.getByRole('button', { name: 'Confirm purge' }).click();
  await expect(page.getByText('Removed 1 unused tags.')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'unused old tag' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('combobox', { name: 'Search images' }).fill('roadtrip');
  await expect(page.getByRole('button', { name: `Open ${photo.filename}` })).toBeVisible();
});

test('tag options hide search matches and block image tagging independently', async ({ page }) => {
  const tag = fixtures[0].tags[0].name;
  await page.setViewportSize({ width: 850, height: 650 });
  await page.getByRole('button', { name: 'Manage tags', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search tags' }).fill(tag);
  const hidden = page.getByRole('checkbox', { name: `Hide ${tag} from search` });
  await hidden.check();
  await expect(hidden).toBeChecked();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page
    .locator('article')
    .first()
    .hover({ position: { x: 8, y: 8 } });
  await expect(page.getByRole('button', { name: tag, exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Search images' }).fill(`#${JSON.stringify(tag)}`);
  await expect(page.getByRole('button', { name: 'Open 01.jpg' })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Search images' }).clear();
  await page.getByRole('button', { name: 'Open 01.jpg' }).click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole('button', { name: `Remove tag ${tag}` })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('button', { name: 'Manage tags', exact: true }).click();
  const disabled = page.getByRole('checkbox', { name: `Do not tag images with ${tag}` });
  await disabled.click();
  await expect(
    page.getByText(`Remove ${tag} from 1 image and block new assignments?`),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Remove and block' }).click();
  await expect(disabled).toBeChecked();
  await expect(page.getByRole('row').filter({ hasText: tag })).toContainText('0');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Open 01.jpg' }).click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole('button', { name: `Remove tag ${tag}` })).toHaveCount(0);
});

test('tag clicks appear in search and hashtag autocomplete supports keyboard, spaces, and mixed queries', async ({
  page,
}) => {
  const search = page.getByRole('combobox', { name: 'Search images' });
  await page
    .getByRole('button', { name: 'Open 01.jpg', exact: true })
    .hover({ position: { x: 8, y: 8 } });
  await page
    .getByRole('button', { name: 'Open 01.jpg', exact: true })
    .locator('xpath=ancestor::article')
    .getByRole('button', { name: 'car interior', exact: true })
    .click();
  await expect(search).toHaveValue('#"car interior"');
  await expect(page.getByRole('button', { name: /^Open .*jpg$/ })).toHaveCount(1);
  await search.fill('vintage #ste');
  const option = page.getByRole('option').filter({ hasText: '#"steering wheel"' });
  await expect(option).toBeVisible();
  await page.screenshot({ path: 'test-results/hashtag-search.png' });
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(search).toHaveValue('vintage #"steering wheel" ');
  await expect(page.getByRole('button', { name: 'Open 01.jpg', exact: true })).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'Search tag suggestions' })).toHaveCount(0);
  await search.fill('#no-such-tag');
  await expect(page.getByText('No matching tags.', { exact: true })).toBeVisible();
  await search.press('Escape');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await search.clear();
  await expect(page.getByRole('button', { name: /^Open .*jpg$/ })).toHaveCount(fixtures.length);
  await page.getByRole('button', { name: 'dashboard 1', exact: true }).click();
  await expect(search).toHaveValue('#dashboard');
  await expect(page.getByRole('button', { name: /^Open .*jpg$/ })).toHaveCount(1);
});

test('thumbnail size migrates the old preference and prefers the current key', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.removeItem('image-tag-manager.thumbnail-size');
    localStorage.setItem('image-shelf.thumbnail-size', '440');
  });
  await page.reload();
  const size = page.getByRole('group', { name: 'Thumbnail size', exact: true });
  await expect(size).toContainText('440px');
  expect(await page.evaluate(() => localStorage.getItem('image-shelf.thumbnail-size'))).toBeNull();
  await page.evaluate(() => localStorage.setItem('image-shelf.thumbnail-size', '200'));
  await page.reload();
  await expect(size).toContainText('440px');
});

test('thumbnail size follows Ctrl shortcuts, stays bounded, and persists without page zoom', async ({
  page,
}) => {
  const grid = page.getByLabel('Image grid', { exact: true });
  const size = page.getByRole('group', { name: 'Thumbnail size', exact: true });
  const width = () =>
    grid
      .locator('article')
      .first()
      .evaluate((element) => element.getBoundingClientRect().width);
  await expect(size).toContainText('320px');
  expect(await width()).toBe(320);
  const fontSize = await page
    .locator('html')
    .evaluate((element) => getComputedStyle(element).fontSize);
  await page.keyboard.press('Control+=');
  await expect(size).toContainText('360px');
  expect(await width()).toBe(360);
  await page.keyboard.press('Control+-');
  await expect(size).toContainText('320px');
  await grid.locator('article').first().hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect(size).toContainText('360px');
  expect(await width()).toBe(360);
  const cancelled = await grid.evaluate((element) => {
    const event = new WheelEvent('wheel', {
      deltaY: 100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(cancelled).toBe(true);
  await expect(size).toContainText('320px');
  await grid.dispatchEvent('wheel', { deltaY: -100, ctrlKey: false });
  await expect(size).toContainText('320px');
  for (let n = 0; n < 12; n++) await page.keyboard.press('Control+=');
  await expect(size).toContainText('640px');
  await expect(page.getByRole('button', { name: 'Larger thumbnails', exact: true })).toBeDisabled();
  expect(await page.locator('html').evaluate((element) => getComputedStyle(element).fontSize)).toBe(
    fontSize,
  );
  await page.setViewportSize({ width: 850, height: 650 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.reload();
  await expect(size).toContainText('640px');
  for (let n = 0; n < 15; n++) await page.keyboard.press('Control+-');
  await expect(size).toContainText('160px');
  await expect(
    page.getByRole('button', { name: 'Smaller thumbnails', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Larger thumbnails', exact: true }).click();
  await expect(size).toContainText('200px');
  await page.screenshot({ path: 'test-results/thumbnail-size.png' });
});

test('image viewer fills the window and can give all space to the image without losing edits', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Open 01.jpg', exact: true })
    .click({ position: { x: 8, y: 8 } });
  const dialog = page.getByRole('dialog');
  const preview = page.getByLabel('Image preview', { exact: true });
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeGreaterThan(1200);
  expect(bounds!.height).toBeGreaterThan(840);
  const initial = await preview.boundingBox();
  expect(initial!.width).toBeGreaterThan(900);
  expect(initial!.height).toBeGreaterThan(700);
  await expect(preview.locator('img')).toHaveCSS('object-fit', 'contain');
  await expect(dialog.getByRole('button', { name: 'Save changes', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'test-results/large-image-viewer.png' });
  await dialog.getByRole('textbox', { name: 'Caption', exact: true }).fill('Unsaved caption');
  await dialog.getByRole('button', { name: 'Hide details', exact: true }).click();
  expect((await preview.boundingBox())!.width).toBeGreaterThan(initial!.width + 200);
  await expect(dialog.getByRole('textbox', { name: 'Caption', exact: true })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Discard your unsaved changes?')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Caption', exact: true })).toHaveValue(
    'Unsaved caption',
  );
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await page.setViewportSize({ width: 850, height: 650 });
  await expect(dialog.getByRole('button', { name: 'Save changes', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/large-image-viewer-small.png' });
});

test('grid is seamless and shows preloaded details only on hover or keyboard focus', async ({
  page,
}) => {
  const grid = page.getByLabel('Image grid', { exact: true });
  const cards = grid.locator('article');
  const first = cards.first();
  const details = first.getByLabel(`Details for ${fixtures[0].filename}`, { exact: true });
  await expect(first.locator('img')).toBeVisible();
  await page.getByRole('combobox', { name: 'Search images' }).focus();
  await expect(details).toBeHidden();
  expect(await details.textContent()).toContain(fixtures[0].tags.at(-1)!.name);
  expect(await grid.locator('svg').count()).toBe(0);
  const boxes = await cards.evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
  expect(boxes[1].x).toBe(boxes[0].x + boxes[0].width);
  const nextRow = boxes.find((box) => box.y > boxes[0].y)!;
  expect(nextRow.y).toBe(boxes[0].y + boxes[0].height);
  await page.screenshot({ path: 'test-results/seamless-grid.png' });
  // With IPC disabled, hovering must still show every detail already in the grid result.
  await page.evaluate(() => {
    Object.assign(Reflect.get(window, '__TAURI_INTERNALS__'), {
      invoke: () => Promise.reject(new Error('No hover requests allowed')),
    });
  });
  await first.hover();
  await expect(details).toBeVisible();
  await expect(details).toContainText(fixtures[0].caption);
  await expect(
    details.getByRole('button', { name: fixtures[0].tags.at(-1)!.name, exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/grid-hover.png' });
  await page.mouse.move(0, 0);
  await expect(details).toBeHidden();
  await first.getByRole('button', { name: `Open ${fixtures[0].filename}`, exact: true }).focus();
  await expect(details).toBeVisible();
});

test('tiles show loading until ready and show failures instead of blank tiles', async ({
  page,
}) => {
  await page.evaluate(() => {
    sessionStorage.setItem('hold-thumbnails', 'true');
    sessionStorage.setItem('failed-thumbnails', 'true');
  });
  await page.reload();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const grid = page.getByLabel('Image grid', { exact: true });
  const tile = grid.getByRole('button', { name: 'Open 01.jpg', exact: true });
  await expect(grid.getByText('Loading preview…', { exact: true })).toHaveCount(fixtures.length);
  await expect(tile).toHaveAttribute('aria-busy', 'true');
  await expect(tile.locator('svg')).toHaveCSS('animation-name', 'none');
  const before = await tile.boundingBox();
  await page.screenshot({ path: 'test-results/tiles-loading.png' });
  // Hover metadata remains available while thumbnails are still pending.
  await tile.hover({ position: { x: 8, y: 8 } });
  await expect(grid.getByLabel('Details for 01.jpg')).toContainText(fixtures[0].caption);
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    sessionStorage.removeItem('hold-thumbnails');
    window.dispatchEvent(new Event('release-thumbnails'));
  });
  await expect(tile).toHaveAttribute('aria-busy', 'false');
  await expect(tile.getByText('Loading preview…')).toHaveCount(0);
  await expect(tile.locator('img')).toBeVisible();
  expect(await tile.boundingBox()).toEqual(before);
  for (const photo of fixtures.slice(1, 3)) {
    const failed = grid.getByRole('button', { name: `Open ${photo.filename}`, exact: true });
    await expect(failed.getByText('Preview unavailable', { exact: true })).toBeVisible();
    await expect(failed).toHaveAttribute('aria-busy', 'false');
  }
  await expect(grid.getByText('Loading preview…', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/tiles-ready-and-failed.png' });
});

test('endless scrolling unloads old tiles and thumbnails and restores them on return', async ({
  page,
}) => {
  await page.evaluate(() => sessionStorage.setItem('large-library', 'true'));
  await page.reload();
  const library = page.getByLabel('Image library', { exact: true });
  const grid = page.getByLabel('Image grid', { exact: true });
  const first = grid.getByRole('button', { name: 'Open image-1.jpg', exact: true });
  await expect(first).toHaveAttribute('aria-busy', 'false');
  const initialRequests = Number(
    await page.locator('body').getAttribute('data-first-thumbnail-requests'),
  );
  // Jump across many database pages without growing the mounted image set.
  for (const top of [4000, 16000, 40000, 80000, 160000]) {
    await library.evaluate((element, top) => {
      element.scrollTop = top;
    }, top);
    await expect
      .poll(async () =>
        (
          JSON.parse(
            (await page.locator('body').getAttribute('data-requested-pages')) ?? '[]',
          ) as number[]
        ).at(-1),
      )
      .toBeGreaterThan(Math.floor(((top / 240) * 3) / 48) - 2);
    await expect(first).toHaveCount(0);
    await expect.poll(() => grid.locator('article').count()).toBeGreaterThan(0);
    expect(await grid.locator('article').count()).toBeLessThanOrEqual(24);
    await expect(grid.getByText('Loading images…', { exact: true })).toHaveCount(0);
  }
  await library.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(first).toHaveAttribute('aria-busy', 'false');
  expect(
    Number(await page.locator('body').getAttribute('data-first-thumbnail-requests')),
  ).toBeGreaterThan(initialRequests);
  await library.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    grid.getByRole('button', { name: 'Open image-10000.jpg', exact: true }),
  ).toBeVisible();
  expect(await grid.locator('article').count()).toBeLessThanOrEqual(24);
  await page.getByRole('combobox', { name: 'Search images' }).fill('image-9999.jpg');
  await expect(
    grid.getByRole('button', { name: 'Open image-9999.jpg', exact: true }),
  ).toBeVisible();
  await expect(grid.locator('article')).toHaveCount(1);
  expect(await library.evaluate((element) => element.scrollTop)).toBe(0);
});

test('middle-button drag scrolls continuously in either direction and stops on release', async ({
  page,
}) => {
  await page.evaluate(() => sessionStorage.setItem('large-library', 'true'));
  await page.reload();
  const library = page.getByLabel('Image library', { exact: true });
  await expect(library.getByRole('button', { name: 'Open image-1.jpg' })).toBeVisible();
  const bounds = (await library.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const scrollTop = () => library.evaluate((element) => element.scrollTop);

  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(x, y + 150);
  await expect.poll(scrollTop).toBeGreaterThan(100);
  const firstPosition = await scrollTop();
  await expect.poll(scrollTop).toBeGreaterThan(firstPosition + 100);
  await page.mouse.up({ button: 'middle' });
  const releasedPosition = await scrollTop();
  await page.waitForTimeout(150);
  expect(await scrollTop()).toBeCloseTo(releasedPosition, 0);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(x, y - 150);
  await expect.poll(scrollTop).toBeLessThan(releasedPosition - 100);
  await page.mouse.up({ button: 'middle' });
});

test('detail arrows follow search order, cross pages, and protect edits', async ({ page }) => {
  await page.evaluate(() => sessionStorage.setItem('large-library', 'true'));
  await page.reload();
  const library = page.getByLabel('Image library', { exact: true });
  await library.evaluate((element) => {
    element.scrollTop = 3600;
  });
  await page
    .getByRole('button', { name: 'Open image-48.jpg', exact: true })
    .click({ position: { x: 8, y: 8 } });
  const dialog = page.getByRole('dialog');
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('heading')).toHaveText('image-49.jpg');
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.getByRole('heading')).toHaveText('image-48.jpg');
  await dialog.getByRole('button', { name: 'Hide details', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('heading')).toHaveText('image-49.jpg');
  await expect(dialog.getByRole('button', { name: 'Show details', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Show details', exact: true }).click();
  const caption = dialog.getByRole('textbox', { name: 'Caption', exact: true });
  await caption.fill('Keep this edit');
  await caption.press('ArrowRight');
  await expect(dialog.getByRole('heading')).toHaveText('image-49.jpg');
  await dialog.getByRole('button', { name: 'Next image', exact: true }).click();
  await expect(dialog.getByText('Discard your unsaved changes?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(caption).toHaveValue('Keep this edit');
  await page.keyboard.press('ArrowRight');
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(dialog.getByRole('heading')).toHaveText('image-50.jpg');
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Search images' }).fill('image-9999.jpg');
  await page
    .getByRole('button', { name: 'Open image-9999.jpg', exact: true })
    .click({ position: { x: 8, y: 8 } });
  await expect(dialog.getByRole('button', { name: 'Previous image', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Next image', exact: true })).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.getByRole('heading')).toHaveText('image-9999.jpg');
});

test('detail trash button and Delete remove immediately, protect typing, and keep failures visible', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Open 01.jpg', exact: true })
    .click({ position: { x: 8, y: 8 } });
  const dialog = page.getByRole('dialog');
  const caption = dialog.getByRole('textbox', { name: 'Caption', exact: true });
  await caption.fill('Unsaved edit');
  await caption.press('Delete');
  await expect(dialog.getByRole('heading')).toHaveText('01.jpg');
  await dialog.getByRole('button', { name: 'Move image to trash', exact: true }).click();
  await expect(dialog.getByRole('heading')).toHaveText('02.jpg');
  await expect(page.locator('body')).toHaveAttribute('data-trashed-image', '1');
  await expect(page.getByText('Discard your unsaved changes?')).toHaveCount(0);
  await dialog.dispatchEvent('keydown', { key: 'Delete', repeat: true });
  await expect(dialog.getByRole('heading')).toHaveText('02.jpg');
  await page.keyboard.press('Delete');
  await expect(dialog.getByRole('heading')).toHaveText('03.jpg');
  await page.evaluate(() => sessionStorage.setItem('trash-error', 'true'));
  await expect(
    dialog.getByRole('button', { name: 'Move image to trash', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('Delete');
  await expect(dialog.getByRole('alert')).toHaveText('System trash unavailable');
  await expect(dialog.getByRole('heading')).toHaveText('03.jpg');
  await page.evaluate(() => sessionStorage.removeItem('trash-error'));
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Search images' }).fill('03.jpg');
  await page
    .getByRole('button', { name: 'Open 03.jpg', exact: true })
    .click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('Delete');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('No images match these filters')).toBeVisible();
});

test('viewer preloads ten neighbors each way and retains the previous image during a slow preview', async ({
  page,
}) => {
  await page.evaluate(() => {
    sessionStorage.setItem('large-library', 'true');
    sessionStorage.setItem('hold-preview-id', '50');
  });
  await page.reload();
  await page.getByLabel('Image library', { exact: true }).evaluate((element) => {
    element.scrollTop = 3840;
  });
  await page
    .getByRole('button', { name: 'Open image-49.jpg', exact: true })
    .click({ position: { x: 8, y: 8 } });
  const dialog = page.getByRole('dialog');
  const stage = dialog.getByLabel('Image preview', { exact: true });
  await expect(stage).toHaveAttribute('aria-busy', 'false');
  await expect
    .poll(async () => {
      const requests = JSON.parse(
        (await page.locator('body').getAttribute('data-preview-requests')) ?? '[]',
      ) as number[];
      return [...new Set(requests)].sort((a, b) => a - b);
    })
    .toEqual(Array.from({ length: 21 }, (_, index) => index + 39));
  const previousSrc = await stage.locator('img').getAttribute('src');
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('heading')).toHaveText('image-50.jpg');
  await expect(stage.getByRole('status', { name: 'Loading preview' })).toBeVisible();
  await expect(stage.locator('img')).toHaveAttribute('src', previousSrc!);
  await page.screenshot({ path: 'test-results/viewer-preload-wait.png' });
  await page.evaluate(() => {
    sessionStorage.removeItem('hold-preview-id');
    window.dispatchEvent(new Event('release-preview'));
  });
  await expect(stage).toHaveAttribute('aria-busy', 'false');
  await expect(stage.locator('img')).not.toHaveAttribute('src', previousSrc!);
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.getByRole('heading')).toHaveText('image-49.jpg');
  await expect(stage).toHaveAttribute('aria-busy', 'false');
  await expect(stage.locator('img')).toHaveAttribute('src', previousSrc!);
});

test('detail image zooms at the pointer, pans, stays bounded, and resets on navigation', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Open 01.jpg', exact: true })
    .click({ position: { x: 8, y: 8 } });
  const dialog = page.getByRole('dialog');
  const stage = dialog.getByLabel('Image preview', { exact: true });
  await expect(stage).toHaveAttribute('aria-busy', 'false');
  const zoom = dialog.getByLabel('Zoom level', { exact: true });
  await expect(zoom).toHaveText('100%');
  const rect = (await stage.boundingBox())!;
  const x = rect.x + rect.width * 0.65;
  const y = rect.y + rect.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -350);
  await expect(zoom).not.toHaveText('100%');
  const transform = () =>
    stage.locator('img').evaluate((img) => {
      const matrix = new DOMMatrix(getComputedStyle(img).transform);
      return { scale: matrix.a, x: matrix.e, y: matrix.f };
    });
  const before = await transform();
  expect(before.scale).toBeGreaterThan(1.9);
  expect(before.x).toBeLessThan(0);
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 40, { steps: 4 });
  await page.mouse.up();
  const after = await transform();
  expect(after.x).toBeCloseTo(before.x + 80, 0);
  expect(after.y).toBeCloseTo(before.y + 40, 0);
  await page.screenshot({ path: 'test-results/viewer-zoom-pan.png' });
  await dialog.getByRole('button', { name: 'Fit', exact: true }).click();
  await expect(zoom).toHaveText('100%');
  expect(await transform()).toEqual({ scale: 1, x: 0, y: 0 });
  await stage.focus();
  await page.keyboard.press('+');
  await expect(zoom).toHaveText('125%');
  await page.keyboard.press('0');
  await expect(zoom).toHaveText('100%');
  await stage.dblclick({ position: { x: 100, y: 100 } });
  await expect(zoom).toHaveText('200%');
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('heading')).toHaveText('02.jpg');
  await expect(zoom).toHaveText('100%');
  for (let i = 0; i < 10; i++)
    await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(zoom).toHaveText('800%');
  await expect(dialog.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled();
});

test('downloads an update while the library stays usable', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await page.getByRole('button', { name: 'Download update' }).click();
  await expect(page.getByText('Downloading update 10%')).toBeVisible();
  await expect(page.getByPlaceholder('Search images or #tags…')).toBeEnabled();
  await expect(page.getByText('Update ready · applies next launch')).toBeVisible();
});
test('options compare classification timings and change CPU threads', async ({ page }) => {
  await expect(page.getByText('Local image library · Qwen · 8 CPU threads')).toHaveCount(0);
  await page.getByRole('button', { name: 'Options' }).click();
  const threads = page.getByRole('combobox', { name: 'CPU threads' });
  await expect(threads).toHaveValue('8');
  await expect(page.getByRole('row', { name: '4 5 2.4 2.6' })).toBeVisible();
  await expect(page.getByRole('row', { name: '8 7 1.8 1.9' })).toBeVisible();
  await page.screenshot({ path: 'test-results/options.png' });
  await threads.selectOption('4');
  await expect(threads).toHaveValue('4');

  await page.evaluate(() => sessionStorage.setItem('classification-status', 'running'));
  await page.reload();
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByRole('combobox', { name: 'CPU threads' })).toBeDisabled();
});
