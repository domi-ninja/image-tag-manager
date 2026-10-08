import { useDeferredValue, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { open } from '@tauri-apps/plugin-dialog';
import {
  FolderPlus,
  Folder as FolderIcon,
  Images,
  Settings2,
  ScanLine,
  Play,
  Pause,
  Download,
  X,
  LoaderCircle,
  Minus,
  Plus,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { api, type Filter, type Folder, type Photo } from './lib/api';
import { ZoomablePreview } from './components/zoomable-preview';
import { VirtualPhotoGrid } from './components/virtual-photo-grid';
import { ImageSearch } from './components/image-search';
import { appendTagSearch, parseSearch } from './lib/search';
import { TagManager } from './components/tag-manager';
import { TagEditor } from './components/tag-editor';
import { PhotoContextMenu } from './components/photo-context-menu';
import { Button } from './components/ui/button';
import { Input, Textarea } from './components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog';
import { cn } from './lib/utils';
import { useThumbnailSize } from './lib/use-thumbnail-size';
import { useViewerPreviews } from './lib/use-viewer-previews';
import { loadThumbnail } from './lib/thumbnail-loader';
import { useIndexUpdates } from './lib/use-index-updates';
import { OptionsMenu } from './components/options-menu';

const initialFilter: Filter = { query: '', folderId: null, status: null, page: 0 };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export default function App() {
  const client = useQueryClient();
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const query = useDeferredValue(filter.query);
  const searchInput = useRef<HTMLInputElement>(null);
  const selectedTags = parseSearch(filter.query).tags;
  const [selected, setSelected] = useState<{ photo: Photo; index: number } | null>(null);
  const [folderEdit, setFolderEdit] = useState<Folder | null>(null);
  const [error, setError] = useState('');
  const [tagManager, setTagManager] = useState(false);
  const thumbnails = useThumbnailSize(!selected && !folderEdit && !tagManager);
  const status = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 1000 });
  useIndexUpdates(status.data);
  const busy = status.data?.busy ?? false;
  const folders = useQuery({
    queryKey: ['folders'],
    queryFn: api.folders,
  });
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: api.stats,
  });
  const photos = useQuery({
    queryKey: ['photos', { ...filter, query }],
    queryFn: () => api.search({ ...filter, query }),
    gcTime: 0,
  });
  const tags = useQuery({
    queryKey: ['tags', filter.folderId],
    queryFn: () => api.tags(filter.folderId),
  });
  const invalidate = () =>
    client.invalidateQueries({
      predicate: (q) => !['thumbnail', 'preview'].includes(String(q.queryKey[0])),
    });
  const action = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setError('');
      void invalidate();
    },
    onError: (e) => setError(message(e)),
  });
  function change(next: Partial<Filter>) {
    thumbnails.galleryRef.current?.scrollTo({ top: 0 });
    setFilter((f) => ({ ...f, ...next, page: next.page ?? 0 }));
  }
  function searchTag(tag: string) {
    change({ query: appendTagSearch(filter.query, tag) });
    requestAnimationFrame(() => {
      searchInput.current?.focus();
      const end = searchInput.current?.value.length ?? 0;
      searchInput.current?.setSelectionRange(end, end);
    });
  }
  function addFolder() {
    action.mutate(async () => {
      const path = await open({
        directory: true,
        multiple: false,
        title: 'Choose an image folder',
      });
      if (typeof path === 'string') await api.addFolder(path);
    });
  }
  const total = photos.data?.total ?? 0;
  const failure =
    error ||
    (folders.error
      ? 'The desktop service is unavailable. Open the installed Image Tag Manager app.'
      : photos.error
        ? message(photos.error)
        : '');
  return (
    <div className="flex h-screen min-h-0 flex-col">
      <a
        href="#library"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-background focus:p-3"
      >
        Skip to images
      </a>
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
        <h1 className="flex items-center gap-3 font-semibold">
          <Images className="size-5 text-primary" aria-hidden />
          Image Tag Manager
        </h1>
        <OptionsMenu status={status.data} />
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r bg-white/40">
          <div className="flex items-center justify-between gap-3 p-3">
            <h2 className="font-medium">Folders</h2>
            <Button
              variant="ghost"
              onClick={addFolder}
              disabled={action.isPending}
              aria-label="Add folder"
            >
              <FolderPlus />
            </Button>
          </div>
          <nav aria-label="Image folders" className="space-y-1 px-3">
            <button
              className={cn(
                'flex w-full items-center gap-3 rounded-md p-3 text-left hover:bg-muted',
                filter.folderId === null && 'bg-muted font-medium',
              )}
              onClick={() => change({ folderId: null })}
              aria-current={filter.folderId === null ? 'page' : undefined}
            >
              <Images className="size-4" />
              <span className="flex-1">All images</span>
              <span className="tabular-nums">{stats.data?.total ?? 0}</span>
            </button>
            {folders.data?.map((folder) => (
              <div className="flex min-w-0 items-center gap-1" key={folder.id}>
                <button
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-3 rounded-md p-3 text-left hover:bg-muted',
                    filter.folderId === folder.id && 'bg-muted font-medium',
                  )}
                  onClick={() => change({ folderId: folder.id })}
                  title={folder.path}
                  aria-current={filter.folderId === folder.id ? 'page' : undefined}
                >
                  <FolderIcon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {folder.name}
                    {!folder.enabled && ' (paused)'}
                  </span>
                  <span className="tabular-nums">{folder.count}</span>
                </button>
                <Button
                  variant="ghost"
                  className="px-2"
                  aria-label={`Configure ${folder.name}`}
                  onClick={() => setFolderEdit(folder)}
                >
                  <Settings2 />
                </Button>
              </div>
            ))}
          </nav>
          <div className="mt-3 flex min-h-0 flex-1 flex-col border-t p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-medium">Tags</h2>
              <Button
                variant="ghost"
                className="px-2"
                aria-label="Manage tags"
                onClick={() => setTagManager(true)}
              >
                <Settings2 />
              </Button>
            </div>
            {!tags.data?.length && (
              <p className="text-muted-foreground">
                Tags appear here as images are scanned and classified.
              </p>
            )}
            <div className="flex-1 space-y-1 overflow-y-auto">
              {tags.data?.map((tag) => (
                <button
                  key={tag.name}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-muted',
                    selectedTags.includes(tag.name) && 'bg-muted font-medium',
                  )}
                  onClick={() => searchTag(tag.name)}
                  aria-pressed={selectedTags.includes(tag.name)}
                >
                  <span className="truncate">{tag.name}</span>
                  <span className="text-muted-foreground tabular-nums">{tag.count}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-3 border-t p-3">
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={status.data?.automatic ?? false}
                onChange={(e) => action.mutate(() => api.automatic(e.target.checked))}
                disabled={!status.data?.modelReady}
                className="size-4 accent-primary"
              />
              Classify automatically
            </label>
            <p className="text-muted-foreground">
              Enabled folders are scanned at startup and hourly. Automatic classification checks the
              queue every 30 seconds.
            </p>
          </div>
        </aside>
        <main id="library" tabIndex={-1} className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 overflow-x-auto whitespace-nowrap border-b p-4">
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {stats.data?.classified ?? 0}/{stats.data?.total ?? 0} classified ·{' '}
              {stats.data?.pending ?? 0} pending
              {Boolean(stats.data?.errors) && ` · ${stats.data?.errors} failed`}
            </span>
            {(busy || status.data?.phase === 'error') && (
              <span
                className="flex min-w-32 flex-1 items-center gap-2 text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                {busy && <LoaderCircle className="size-4 shrink-0 motion-safe:animate-spin" />}
                <span className="truncate" title={status.data?.message}>
                  {status.data?.message}
                  {busy &&
                    Boolean(status.data?.processed) &&
                    ` · ${status.data?.processed} processed`}
                </span>
              </span>
            )}
            <div className="ml-auto flex shrink-0 gap-3">
              {Boolean(stats.data?.errors) && (
                <Button
                  variant="outline"
                  disabled={busy || !status.data?.modelReady}
                  onClick={() =>
                    action.mutate(async () => {
                      await api.retry(filter.folderId);
                      await api.start('classify');
                    })
                  }
                >
                  Retry failed
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy || !folders.data?.length}
                onClick={() => action.mutate(() => api.start('scan'))}
              >
                <ScanLine />
                Scan folders
              </Button>
              {busy ? (
                <Button variant="outline" onClick={() => action.mutate(api.pause)}>
                  <Pause />
                  {status.data?.phase === 'download' ? 'Pause download' : 'Pause after image'}
                </Button>
              ) : (
                <Button
                  disabled={!folders.data?.length || !status.data?.modelReady}
                  onClick={() => action.mutate(() => api.start('classify'))}
                >
                  <Play />
                  Classify pending
                </Button>
              )}
            </div>
          </div>
          {!status.data?.modelReady && !folders.error && (
            <section
              className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/60 p-4"
              aria-label="Model setup"
            >
              <div>
                <p className="font-medium">Set up local classification</p>
                <p className="mt-1 text-muted-foreground">
                  Download Qwen3-VL-2B once (2.65 GB). Images stay on this computer.
                </p>
              </div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => action.mutate(() => api.start('download'))}
              >
                <Download />
                Download model
              </Button>
            </section>
          )}
          <div className="flex gap-3 p-4">
            <ImageSearch
              value={filter.query}
              onChange={(query) => change({ query })}
              inputRef={searchInput}
            />
            <select
              aria-label="Classification status"
              className="h-9 rounded-md border px-3"
              value={filter.status ?? ''}
              onChange={(e) => change({ status: e.target.value || null })}
            >
              <option value="">Any status</option>
              <option value="classified">Classified</option>
              <option value="pending">Pending</option>
              <option value="error">Failed</option>
            </select>
          </div>
          {failure && (
            <div
              role="alert"
              className="mx-4 mb-3 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-red-50 p-3 text-destructive"
            >
              <span>{failure}</span>
              <Button variant="ghost" aria-label="Dismiss error" onClick={() => setError('')}>
                <X />
              </Button>
            </div>
          )}
          <div
            ref={thumbnails.galleryRef}
            aria-label="Image library"
            tabIndex={0}
            className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
          >
            {photos.isPending ? (
              <p role="status" className="py-4 text-muted-foreground">
                Loading images…
              </p>
            ) : !photos.data?.images.length ? (
              <div className="flex min-h-80 flex-col items-center justify-center gap-4 text-center">
                <Images className="size-8 text-muted-foreground" aria-hidden />
                <h3 className="font-medium">
                  {!folders.data?.length
                    ? 'Give your images a home in the index'
                    : filter.query || filter.status
                      ? 'No images match these filters'
                      : 'No images indexed yet'}
                </h3>
                <p className="max-w-md text-muted-foreground">
                  {!folders.data?.length
                    ? 'Add a folder to browse and classify its images. Originals remain untouched.'
                    : 'Try a different search or scan your folders for JPEG, PNG, WebP, GIF, BMP, or TIFF images.'}
                </p>
                <Button
                  variant="outline"
                  onClick={
                    !folders.data?.length
                      ? addFolder
                      : () => {
                          change(initialFilter);
                          action.mutate(() => api.start('scan'));
                        }
                  }
                >
                  {!folders.data?.length ? 'Add a folder' : 'Clear filters and scan'}
                </Button>
              </div>
            ) : (
              <VirtualPhotoGrid
                filter={{ ...filter, query }}
                total={total}
                size={thumbnails.size}
                scrollRef={thumbnails.galleryRef}
                renderPhoto={(photo, index) => (
                  <PhotoCard
                    onError={setError}
                    key={`${photo.id}-${photo.modified}`}
                    photo={photo}
                    onSelect={() => setSelected({ photo, index })}
                    onTag={searchTag}
                  />
                )}
              />
            )}
          </div>
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-3">
            <div
              role="group"
              aria-label="Thumbnail size"
              className="flex items-center gap-2"
              title="Resize thumbnails: Ctrl+scroll over images, or Ctrl+plus/minus"
            >
              <Button
                variant="ghost"
                className="px-2"
                aria-label="Smaller thumbnails"
                disabled={!thumbnails.canShrink}
                onClick={() => thumbnails.resize(-1)}
              >
                <Minus aria-hidden />
              </Button>
              <span className="text-muted-foreground tabular-nums" aria-live="polite">
                {thumbnails.size}px
              </span>
              <Button
                variant="ghost"
                className="px-2"
                aria-label="Larger thumbnails"
                disabled={!thumbnails.canGrow}
                onClick={() => thumbnails.resize(1)}
              >
                <Plus aria-hidden />
              </Button>
            </div>
            <span className="tabular-nums">{total.toLocaleString()} images</span>
          </footer>
        </main>
      </div>
      {tagManager && (
        <TagManager
          onClose={() => setTagManager(false)}
          onChange={async () => {
            await invalidate();
          }}
        />
      )}
      {selected && (
        <PhotoViewer
          initial={selected}
          filter={{ ...filter, query }}
          total={total}
          onClose={() => setSelected(null)}
          onSave={invalidate}
        />
      )}
      {folderEdit && (
        <FolderDialog
          folder={folderEdit}
          busy={busy}
          onClose={() => setFolderEdit(null)}
          onSave={async (removed) => {
            await invalidate();
            if (removed && filter.folderId === folderEdit.id) change({ folderId: null });
          }}
        />
      )}
    </div>
  );
}
function PhotoCard({
  photo,
  onSelect,
  onTag,
  onError,
}: {
  photo: Photo;
  onSelect: () => void;
  onTag: (tag: string) => void;
  onError: (error: string) => void;
}) {
  const thumb = useQuery({
    queryKey: ['thumbnail', photo.id, photo.modified],
    queryFn: ({ signal }) => loadThumbnail(photo.id, signal),
    staleTime: Infinity,
    gcTime: 0,
  });
  const [loadedSource, setLoadedSource] = useState<string>();
  const [failedSource, setFailedSource] = useState<string>();
  const previewFailed = thumb.isError || Boolean(thumb.data && failedSource === thumb.data);
  const previewLoading = !previewFailed && (!thumb.data || loadedSource !== thumb.data);
  return (
    <PhotoContextMenu photoId={photo.id} onError={onError}>
      <article className="group relative min-w-0 bg-muted">
        <button
          onClick={onSelect}
          className="relative block aspect-[4/3] w-full overflow-hidden text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          aria-label={`Open ${photo.filename}`}
          aria-busy={previewLoading}
        >
          {thumb.data && !previewFailed && (
            <img
              src={thumb.data}
              alt={photo.caption || photo.filename}
              className="size-full object-cover"
              loading="lazy"
              width={360}
              height={270}
              onLoad={() => setLoadedSource(thumb.data)}
              onError={() => setFailedSource(thumb.data)}
            />
          )}
          {previewLoading && (
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-3 border border-background bg-muted text-muted-foreground">
              <LoaderCircle aria-hidden className="size-6 motion-safe:animate-spin" />
              <span>Loading preview…</span>
            </span>
          )}
          {previewFailed && (
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-3 border border-background bg-muted p-3 text-center text-muted-foreground">
              <span>Preview unavailable</span>
              <span className="underline">Open image</span>
            </span>
          )}
        </button>
        <div
          aria-label={`Details for ${photo.filename}`}
          className="invisible absolute inset-x-0 bottom-0 z-10 max-h-[75%] space-y-3 overflow-y-auto bg-background/95 p-3 shadow-md group-hover:visible group-focus-within:visible"
        >
          <button onClick={onSelect} className="block w-full space-y-2 text-left">
            <p className="break-all font-medium">{photo.filename}</p>
            <p className="break-words text-muted-foreground">
              {photo.caption ||
                (photo.status === 'error'
                  ? 'Classification failed. Open to review.'
                  : 'Waiting for classification')}
            </p>
            {photo.category && <p className="break-words">Category: {photo.category}</p>}
            {previewFailed && (
              <p className="text-destructive">Preview unavailable. Open to review.</p>
            )}
          </button>
          {photo.tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {photo.tags.map((tag) => (
                <button
                  key={tag.id}
                  onClick={() => onTag(tag.name)}
                  className={cn(
                    'max-w-full break-words rounded border px-2 py-1 text-left hover:bg-muted',
                    tag.sources.some((source) => source === 'user' || source === 'folder') &&
                      'border-sky-200 bg-sky-50',
                  )}
                  title={`Search tag ${tag.name}`}
                >
                  {tag.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </article>
    </PhotoContextMenu>
  );
}
function PhotoViewer({
  initial,
  filter,
  total,
  onClose,
  onSave,
}: {
  initial: { photo: Photo; index: number };
  filter: Filter;
  total: number;
  onClose: () => void;
  onSave: () => Promise<void>;
}) {
  const [current, setCurrent] = useState(initial);
  const previews = useViewerPreviews(current, filter, total);
  const [showDetails, setShowDetails] = useState(true);
  const navigating = useRef(false);
  const navigation = useMutation({
    mutationFn: async (direction: number) => {
      const index = current.index + direction;
      const cached = previews.photoAt(index);
      if (cached) return { photo: cached, index };
      const page = await api.search({ ...filter, page: Math.floor(index / 48) });
      const photo = page.images[index % 48];
      if (!photo)
        throw new Error(
          'This image is no longer in the search results. Close the viewer to refresh.',
        );
      return { photo, index };
    },
    onSuccess: setCurrent,
    onSettled: () => {
      navigating.current = false;
    },
  });
  const deletion = useMutation({
    mutationFn: () => api.trashPhoto(current.photo.id),
    onSuccess: async () => {
      try {
        await onSave();
        let page = await api.search({ ...filter, page: Math.floor(current.index / 48) });
        if (!page.total) {
          onClose();
          return;
        }
        const index = Math.min(current.index, page.total - 1);
        if (Math.floor(index / 48) !== Math.floor(current.index / 48)) {
          page = await api.search({ ...filter, page: Math.floor(index / 48) });
        }
        const photo = page.images[index % 48];
        if (photo) setCurrent({ photo, index });
        else onClose();
      } catch {
        // The file was trashed successfully; close if the refreshed results cannot be loaded.
        onClose();
      }
    },
    onSettled: () => {
      navigating.current = false;
    },
  });
  function moveToTrash() {
    if (navigating.current) return;
    navigating.current = true;
    deletion.mutate();
  }
  function navigate(direction: number) {
    if (navigating.current || current.index + direction < 0 || current.index + direction >= total)
      return;
    navigating.current = true;
    navigation.mutate(direction);
  }
  return (
    <PhotoDialog
      key={current.photo.id}
      photo={current.photo}
      previews={previews}
      onClose={onClose}
      onSave={onSave}
      onNavigate={navigate}
      previous={current.index > 0}
      next={current.index + 1 < total}
      navigating={navigation.isPending || deletion.isPending}
      onTrash={moveToTrash}
      navigationError={
        deletion.error ? message(deletion.error) : navigation.error ? message(navigation.error) : ''
      }
      showDetails={showDetails}
      setShowDetails={setShowDetails}
    />
  );
}
function PhotoDialog({
  photo,
  previews,
  onClose,
  onSave,
  onNavigate,
  onTrash,
  previous,
  next,
  navigating,
  navigationError,
  showDetails,
  setShowDetails,
}: {
  photo: Photo;
  previews: ReturnType<typeof useViewerPreviews>;
  onClose: () => void;
  onSave: () => Promise<void>;
  onNavigate: (direction: number) => void;
  onTrash: () => void;
  previous: boolean;
  next: boolean;
  navigating: boolean;
  navigationError: string;
  showDetails: boolean;
  setShowDetails: (show: boolean) => void;
}) {
  const [contextError, setContextError] = useState('');
  const detailRef = useRef<HTMLDivElement>(null);
  const [tags, setTags] = useState(photo.tags.map((tag) => tag.name));
  const [tagQuery, setTagQuery] = useState('');
  const [caption, setCaption] = useState(photo.caption);
  const [category, setCategory] = useState(photo.category ?? '');
  const save = useMutation({
    mutationFn: () =>
      api.savePhoto(photo.id, {
        tags: [...new Set([...tags, tagQuery.trim().toLowerCase()].filter(Boolean))],
        caption,
        category: category.trim() || null,
      }),
    onSuccess: async () => {
      await onSave();
      onClose();
    },
  });
  const dirty =
    tagQuery.trim() !== '' ||
    tags.length !== photo.tags.length ||
    tags.some((tag) => !photo.tags.some((original) => original.name === tag)) ||
    caption !== photo.caption ||
    category !== (photo.category ?? '');
  const [discard, setDiscard] = useState<'close' | -1 | 1 | null>(null);
  function leave(destination: 'close' | -1 | 1) {
    if (save.isPending || navigating) return;
    if (dirty) {
      setShowDetails(true);
      setDiscard(destination);
    } else if (destination === 'close') onClose();
    else onNavigate(destination);
  }
  function close() {
    leave('close');
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        ref={detailRef}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          detailRef.current?.focus();
        }}
        className="flex h-[calc(100dvh-2rem)] max-h-none w-[calc(100vw-2rem)] max-w-none flex-col overflow-hidden p-0"
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            discard
          )
            return;
          if (
            event.target instanceof HTMLElement &&
            event.target.closest(
              'input, textarea, select, [contenteditable="true"], [role="menu"], [role="combobox"]',
            )
          )
            return;
          if (event.key === 'Delete' && !event.repeat) {
            event.preventDefault();
            if (!save.isPending && !navigating) onTrash();
          }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            if (event.key === 'ArrowLeft' ? previous : next)
              leave(event.key === 'ArrowLeft' ? -1 : 1);
          }
        }}
        onEscapeKeyDown={(event) => {
          // Let an open tag dropdown consume Escape before the dialog closes.
          if (
            event.target instanceof HTMLElement &&
            event.target.matches('[role="combobox"][aria-expanded="true"]')
          )
            event.preventDefault();
        }}
      >
        <div className="flex shrink-0 items-center gap-4 border-b p-4 pr-14">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate font-semibold">{photo.filename}</DialogTitle>
            <DialogDescription className="mt-1 truncate text-muted-foreground" title={photo.path}>
              {photo.path}
            </DialogDescription>
          </div>
          <Button
            variant="outline"
            aria-label="Move image to trash"
            title="Move image to trash (Delete)"
            disabled={navigating || save.isPending}
            onClick={onTrash}
          >
            <Trash2 aria-hidden />
            Trash
          </Button>
          <Button
            variant="outline"
            aria-label="Previous image"
            title="Previous image (Left arrow)"
            disabled={!previous || navigating || save.isPending}
            onClick={() => leave(-1)}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <Button
            variant="outline"
            aria-label="Next image"
            title="Next image (Right arrow)"
            disabled={!next || navigating || save.isPending}
            onClick={() => leave(1)}
          >
            <ChevronRight aria-hidden />
          </Button>
          <Button
            variant="outline"
            aria-expanded={showDetails}
            aria-controls="image-details"
            onClick={() => setShowDetails(!showDetails)}
          >
            {showDetails ? 'Hide details' : 'Show details'}
          </Button>
        </div>
        {navigationError && (
          <p role="alert" className="px-4 text-destructive">
            {navigationError}
          </p>
        )}
        <div
          className={cn(
            'grid min-h-0 flex-1',
            showDetails
              ? 'grid-rows-[minmax(0,1fr)_minmax(0,0.65fr)] md:grid-cols-[minmax(0,1fr)_20rem] md:grid-rows-1'
              : 'grid-cols-1 grid-rows-1',
          )}
        >
          <ZoomablePreview
            photoId={photo.id}
            displayed={previews.displayed}
            loading={previews.loading || navigating}
            failed={previews.failed}
            onError={setContextError}
          />
          <form
            id="image-details"
            className={cn(
              'flex min-h-0 min-w-0 flex-col border-t md:border-l md:border-t-0',
              !showDetails && 'hidden',
            )}
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <TagEditor
                tags={tags}
                originalTags={photo.tags}
                onChange={setTags}
                query={tagQuery}
                onQueryChange={setTagQuery}
              />
              <label className="block space-y-2">
                <span>Caption</span>
                <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} />
              </label>
              <label className="block space-y-2">
                <span>Category</span>
                <Input
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="Optional category…"
                />
              </label>
            </div>
            <div className="shrink-0 space-y-3 border-t p-4">
              {contextError && (
                <p role="alert" className="text-destructive">
                  {contextError}
                </p>
              )}
              {photo.error && (
                <p role="alert" className="break-words text-destructive">
                  {photo.error}
                </p>
              )}
              {save.error && (
                <p role="alert" className="text-destructive">
                  {message(save.error)}
                </p>
              )}
              {discard && (
                <div className="space-y-3 rounded-md border p-3">
                  <p>Discard your unsaved changes?</p>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => {
                      if (discard === 'close') onClose();
                      else if (discard) {
                        setDiscard(null);
                        onNavigate(discard);
                      }
                    }}
                  >
                    Discard changes
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setDiscard(null)}>
                    Keep editing
                  </Button>
                </div>
              )}
              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
function FolderDialog({
  folder,
  busy,
  onClose,
  onSave,
}: {
  folder: Folder;
  busy: boolean;
  onClose: () => void;
  onSave: (removed: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(folder.name);
  const [enabled, setEnabled] = useState(folder.enabled);
  const [categories, setCategories] = useState(folder.categories.join(', '));
  const [instructions, setInstructions] = useState(folder.instructions);
  const [confirm, setConfirm] = useState(false);
  const [discard, setDiscard] = useState(false);
  const dirty =
    name !== folder.name ||
    enabled !== folder.enabled ||
    categories !== folder.categories.join(', ') ||
    instructions !== folder.instructions;
  const mutation = useMutation({
    mutationFn: async (remove: boolean) => {
      if (remove) await api.removeFolder(folder.id);
      else
        await api.saveFolder({
          ...folder,
          name,
          enabled,
          categories: categories
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          instructions,
        });
      return remove;
    },
    onSuccess: async (removed) => {
      await onSave(removed);
      onClose();
    },
  });
  function close() {
    if (dirty) setDiscard(true);
    else onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogTitle className="font-semibold">Folder settings</DialogTitle>
        <DialogDescription className="mt-2 break-all text-muted-foreground">
          {folder.path}
        </DialogDescription>
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate(false);
          }}
        >
          <label className="block space-y-2">
            <span>Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="size-4 accent-primary"
            />
            Scan and classify this folder
          </label>
          <label className="block space-y-2">
            <span>Categories (optional, comma separated)</span>
            <Input
              value={categories}
              onChange={(e) => setCategories(e.target.value)}
              placeholder="landscape, vehicle, food…"
            />
          </label>
          <label className="block space-y-2">
            <span>Classification instructions (optional)</span>
            <Textarea
              maxLength={4000}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="For example, focus on objects useful for finding reference images…"
            />
          </label>
          <p className="text-muted-foreground">
            Includes subfolders. Settings apply to future classifications. Existing tags stay
            editable.
          </p>
          {mutation.error && (
            <p role="alert" className="text-destructive">
              {message(mutation.error)}
            </p>
          )}
          {confirm && (
            <div className="space-y-3 rounded-md border border-destructive/40 p-3">
              <p>Remove this folder and its indexed tags? Original images will remain untouched.</p>
              <Button
                type="button"
                variant="destructive"
                disabled={busy || mutation.isPending}
                onClick={() => mutation.mutate(true)}
              >
                Remove from index
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirm(false)}>
                Keep folder
              </Button>
              {busy && <p>Pause the current task before removing a folder.</p>}
            </div>
          )}
          {discard && (
            <div className="space-y-3 rounded-md border p-3">
              <p>Discard your unsaved settings?</p>
              <Button type="button" variant="destructive" onClick={onClose}>
                Discard changes
              </Button>
              <Button type="button" variant="ghost" onClick={() => setDiscard(false)}>
                Keep editing
              </Button>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <Button type="button" variant="ghost" onClick={() => setConfirm(true)}>
              Remove folder…
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
