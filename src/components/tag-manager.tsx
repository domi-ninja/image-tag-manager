import { useDeferredValue, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type Tag } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

export function TagManager({
  onClose,
  onChange,
}: {
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const search = useDeferredValue(query);
  const [orphansOnly, setOrphansOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [name, setName] = useState('');
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [notice, setNotice] = useState('');
  const catalog = useQuery({
    queryKey: ['tagCatalog', search, orphansOnly, page],
    queryFn: () => api.tagCatalog(search, orphansOnly, page),
  });
  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: async (result) => {
      setEditing(null);
      setConfirmPurge(false);
      setPage(0);
      setNotice(typeof result === 'number' ? `Removed ${result} unused tags.` : 'Tags updated.');
      await onChange();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogTitle className="font-semibold">Manage tags</DialogTitle>
        <DialogDescription className="mt-2 text-muted-foreground">
          Shared across your library. Uses count distinct images, even when a tag has several
          sources.
        </DialogDescription>
        <div className="mt-4 space-y-3">
          <Input
            aria-label="Search tags"
            placeholder="Search tags…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={orphansOnly}
                onChange={(event) => {
                  setOrphansOnly(event.target.checked);
                  setPage(0);
                }}
              />
              Unused only
            </label>
            <Button
              variant="outline"
              disabled={action.isPending || !catalog.data?.orphans}
              onClick={() => setConfirmPurge(true)}
            >
              Purge unused tags ({catalog.data?.orphans ?? 0})
            </Button>
          </div>
          {confirmPurge && (
            <div className="space-y-3 rounded-md border p-3">
              <p>
                Delete all {catalog.data?.orphans ?? 0} unused tags across the library? Tags
                attached to images will be kept.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  disabled={action.isPending}
                  onClick={() => action.mutate(api.purgeOrphanTags)}
                >
                  Confirm purge
                </Button>
                <Button variant="ghost" onClick={() => setConfirmPurge(false)}>
                  Cancel purge
                </Button>
              </div>
            </div>
          )}
          {editing && (
            <form
              className="space-y-3 rounded-md border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                action.mutate(() => api.renameTag(editing.id, name));
              }}
            >
              <label className="block space-y-2">
                <span>Rename {editing.name}</span>
                <Input
                  aria-label="Tag name"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </label>
              <p className="text-muted-foreground">
                Updates {editing.count} images as a user tag. An existing name merges the tags.
                Folder names on disk stay unchanged.
              </p>
              <div className="flex gap-2">
                <Button disabled={action.isPending} type="submit">
                  Save tag name
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel rename
                </Button>
              </div>
            </form>
          )}
          {action.error && (
            <p role="alert" className="text-destructive">
              {String(action.error)}
            </p>
          )}
          {notice && (
            <p role="status" className="text-muted-foreground">
              {notice}
            </p>
          )}
          {catalog.isError ? (
            <div role="alert">
              <p>Could not load tags.</p>
              <Button variant="outline" onClick={() => void catalog.refetch()}>
                Try again
              </Button>
            </div>
          ) : catalog.isPending ? (
            <p>Loading tags…</p>
          ) : (
            <>
              <div className="max-h-80 overflow-auto rounded-md border">
                <table className="w-full text-left">
                  <thead className="sticky top-0 bg-background">
                    <tr>
                      <th className="p-3 font-medium">Tag</th>
                      <th className="p-3 font-medium">Uses</th>
                      <th className="p-3 font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalog.data.tags.map((tag) => (
                      <tr key={tag.id} className="border-t">
                        <td className="max-w-64 break-words p-3">{tag.name}</td>
                        <td className="p-3 tabular-nums">{tag.count}</td>
                        <td className="p-3">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              disabled={action.isPending}
                              aria-label={`Rename tag ${tag.name}`}
                              onClick={() => {
                                setEditing(tag);
                                setName(tag.name);
                              }}
                            >
                              Rename
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={action.isPending || tag.count > 0}
                              title={
                                tag.count ? 'Only unused tags can be deleted' : 'Delete unused tag'
                              }
                              aria-label={`Delete tag ${tag.name}`}
                              onClick={() => action.mutate(() => api.deleteTag(tag.id))}
                            >
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!catalog.data.tags.length && (
                  <p className="p-3 text-muted-foreground">No tags match these filters.</p>
                )}
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>
                  {catalog.data.total} tags · {catalog.data.orphans} unused
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" disabled={!page} onClick={() => setPage(page - 1)}>
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    disabled={(page + 1) * 50 >= catalog.data.total}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
