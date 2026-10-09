import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Images, LoaderCircle, Trash2 } from 'lucide-react';
import { api, type DuplicateGroup, type DuplicateImage } from '../lib/api';
import { loadThumbnail } from '../lib/thumbnail-loader';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

function DuplicateThumbnail({ image }: { image: DuplicateImage }) {
  const thumbnail = useQuery({
    queryKey: ['thumbnail', image.id, image.modified],
    queryFn: ({ signal }) => loadThumbnail(image.id, signal),
    staleTime: Infinity,
    gcTime: 0,
  });
  return thumbnail.data ? (
    <img src={thumbnail.data} alt="" className="size-full object-cover" />
  ) : (
    <div className="grid size-full place-items-center bg-muted text-muted-foreground">
      <Images aria-hidden className="size-5" />
    </div>
  );
}

export function DuplicateFinder({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const duplicates = useQuery({ queryKey: ['duplicates'], queryFn: api.findDuplicates, gcTime: 0 });
  const deletion = useMutation({
    mutationFn: api.trashPhoto,
    onSuccess: (_, id) => {
      client.setQueryData<DuplicateGroup[]>(['duplicates'], (groups) =>
        groups
          ?.map((group) => ({ ...group, images: group.images.filter((image) => image.id !== id) }))
          .filter((group) => group.images.length > 1),
      );
      void client.invalidateQueries({
        predicate: (query) =>
          ['folders', 'stats', 'photos', 'tags', 'tagCatalog', 'tagSuggestions'].includes(
            String(query.queryKey[0]),
          ),
      });
    },
  });
  const groups = duplicates.data ?? [];
  const count = groups.reduce((sum, group) => sum + group.images.length, 0);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[calc(100dvh-2rem)] max-h-none w-[calc(100vw-2rem)] max-w-none flex-col overflow-hidden p-0">
        <header className="shrink-0 border-b p-4 pr-14">
          <DialogTitle className="font-medium">Find duplicates</DialogTitle>
          {duplicates.isSuccess && (
            <p className="text-muted-foreground">
              {groups.length} {groups.length === 1 ? 'group' : 'groups'} · {count} images
            </p>
          )}
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          {duplicates.isPending && (
            <p role="status" className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" />
              Finding duplicates…
            </p>
          )}
          {duplicates.isError && (
            <p role="alert" className="text-destructive">
              {String(duplicates.error)}
            </p>
          )}
          {deletion.isError && (
            <p role="alert" className="text-destructive">
              Could not move image to trash: {String(deletion.error)}
            </p>
          )}
          {duplicates.isSuccess && !groups.length && (
            <p className="text-muted-foreground">No duplicates found.</p>
          )}
          {groups.map((group) => (
            <section key={group.hash} className="overflow-hidden rounded-md border">
              <h2 className="border-b bg-muted/40 px-3 py-2 font-medium">
                {group.images.length} matching images · SHA-256 {group.hash.slice(0, 12)}…
              </h2>
              <ul className="divide-y">
                {group.images.map((image) => (
                  <li key={image.id} className="flex min-w-0 items-center gap-3 p-2">
                    <div className="h-16 w-20 shrink-0 overflow-hidden rounded-sm">
                      <DuplicateThumbnail image={image} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium" title={image.filename}>
                        {image.filename}
                      </div>
                      <div className="truncate text-muted-foreground" title={image.path}>
                        {image.path}
                      </div>
                    </div>
                    <Button
                      variant="destructive"
                      disabled={deletion.isPending}
                      aria-label={`Trash ${image.path}`}
                      onClick={() => deletion.mutate(image.id)}
                    >
                      {deletion.isPending && deletion.variables === image.id ? (
                        <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
                      ) : (
                        <Trash2 aria-hidden />
                      )}
                      Trash
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
