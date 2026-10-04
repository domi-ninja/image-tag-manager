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
      let folders = [folder];
      let automatic = false;
      const entities = new Map<number, string>(
        fixtures.flatMap((photo) => photo.tags.map((tag) => [tag.id, tag.name] as const)),
      );
      entities.set(999, 'unused old tag');
      function catalog(): Tag[] {
        return [...entities].map(([id, name]) => ({
          id,
          name,
          count: images.filter((photo) => photo.tags.some((tag) => tag.id === id)).length,
        }));
      }
      function ensureTag(name: string): PhotoTag {
        let id = [...entities].find(([, existing]) => existing === name)?.[0];
        if (id === undefined) {
          id = Math.max(...entities.keys()) + 1;
          entities.set(id, name);
        }
        return { id, name, sources: ['user'] };
      }
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
              (!f.tag || p.tags.some((tag) => tag.name === f.tag)) &&
              (!f.query ||
                `${p.tags.map((tag) => tag.name).join(' ')} ${p.caption} ${p.filename}`
                  .toLowerCase()
                  .includes(f.query.toLowerCase())),
          );
          return { images: list.slice(f.page * 48, (f.page + 1) * 48), total: list.length };
        }
        if (command === 'tags') return catalog().filter((tag) => tag.count > 0);
        if (command === 'tag_suggestions')
          return catalog().filter((tag) => tag.name.includes(String(args.query).toLowerCase()));
        if (command === 'tag_catalog') {
          const all = catalog();
          const filtered = all.filter(
            (tag) =>
              tag.name.includes(String(args.query).toLowerCase()) &&
              (!args.orphansOnly || tag.count === 0),
          );
          return {
            tags: filtered.slice(Number(args.page) * 50, (Number(args.page) + 1) * 50),
            total: filtered.length,
            orphans: all.filter((tag) => tag.count === 0).length,
          };
        }
        if (command === 'purge_orphan_tags') {
          const unused = catalog().filter((tag) => tag.count === 0);
          for (const tag of unused) entities.delete(tag.id);
          return unused.length;
        }
        if (command === 'delete_tag') {
          entities.delete(Number(args.id));
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
  await page.getByRole('combobox', { name: 'Add tag' }).fill('road trip');
  await page.getByRole('option', { name: 'Add "road trip"' }).click();
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

test('tag editor suggests existing tags, creates tags with Enter, and removes tags without submitting', async ({
  page,
}) => {
  const photo = fixtures[0];
  const suggestion = fixtures
    .flatMap((photo) => photo.tags.map((tag) => tag.name))
    .find((tag) => !photo.tags.some((existing) => existing.name === tag))!;
  await page.getByRole('button', { name: `Open ${photo.filename}` }).click();
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
  await page.getByRole('button', { name: `Open ${photo.filename}` }).click();
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
  await page.getByRole('button', { name: `Open ${photo.filename}` }).click();
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
  await page.getByRole('textbox', { name: 'Search images' }).fill('roadtrip');
  await expect(page.getByRole('button', { name: `Open ${photo.filename}` })).toBeVisible();
});
