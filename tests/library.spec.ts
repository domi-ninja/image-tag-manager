import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Photo, Folder, Filter, Classification } from '../src/lib/api';
const raw = JSON.parse(readFileSync('results/qwen.json', 'utf8')) as {
  results: { image: string; parsed: Classification }[];
};
const fixtures: Photo[] = raw.results.slice(0, 6).map((r, i) => ({
  id: i + 1,
  folderId: 1,
  path: `/photos/${r.image}`,
  filename: r.image,
  caption: r.parsed.caption,
  tags: r.parsed.tags,
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
      let folders = [folder];
      let automatic = false;
      const invoke = async (command: string, args: Record<string, unknown> = {}) => {
        if (command === 'status')
          return {
            busy: false,
            phase: 'idle',
            message: 'Up to date',
            processed: 0,
            modelReady: true,
            automatic,
            revision: 1,
          };
        if (command === 'image_action') {
          document.body.dataset.imageAction = JSON.stringify(args);
          return;
        }
        if (command === 'folders') return folders;
        if (command === 'stats')
          return { total: images.length, classified: images.length, pending: 0, errors: 0 };
        if (command === 'thumbnail' || command === 'preview') return thumbnails[Number(args.id)];
        if (command === 'search') {
          const f = args.filter as Filter;
          const list = images.filter(
            (p) =>
              (!f.folderId || p.folderId === f.folderId) &&
              (!f.status || p.status === f.status) &&
              (!f.tag || p.tags.includes(f.tag)) &&
              (!f.query ||
                `${p.tags.join(' ')} ${p.caption} ${p.filename}`
                  .toLowerCase()
                  .includes(f.query.toLowerCase())),
          );
          return { images: list.slice(f.page * 48, (f.page + 1) * 48), total: list.length };
        }
        if (command === 'tags') {
          const tags = new Map<string, number>();
          for (const p of images) for (const t of p.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
          return [...tags].map(([name, count]) => ({ name, count }));
        }
        if (command === 'save_photo') {
          images = images.map((p) =>
            p.id === args.id ? { ...p, ...(args.classification as Classification) } : p,
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
        if (command === 'start' || command === 'pause' || command === 'retry') return;
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
  await page.getByRole('textbox', { name: 'Search images' }).fill('steering');
  await expect(page.getByRole('button', { name: /^Open .*jpg$/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Open 01.jpg' }).click();
  await page.getByRole('textbox', { name: 'Tags (comma separated)' }).fill('car, road trip');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search images' }).fill('road trip');
  await expect(page.getByRole('button', { name: 'Open 01.jpg' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Open 01.jpg' }).click();
  await page.getByRole('textbox', { name: 'Caption', exact: true }).fill('Unsaved edit');
  await page.keyboard.press('Escape');
  await expect(page.getByText('Discard your unsaved changes?')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page.getByRole('textbox', { name: 'Search images' }).fill('no-such-subject');
  await expect(page.getByText('No images match these filters')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search images' }).clear();
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
    await card.click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toHaveText(actions.map(([label]) => label));
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(page.locator('body')).toHaveAttribute(
      'data-image-action',
      JSON.stringify({ id: photo.id, action }),
    );
  }
  await card.click();
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
