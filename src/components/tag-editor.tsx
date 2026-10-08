import { useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { X } from 'lucide-react';
import { api, type PhotoTag } from '../lib/api';
import { Button } from './ui/button';

export function TagEditor({
  tags,
  originalTags,
  onChange,
  query,
  onQueryChange,
}: {
  tags: string[];
  originalTags: PhotoTag[];
  onChange: (tags: string[]) => void;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const library = useQuery({
    queryKey: ['tagSuggestions', query.trim()],
    queryFn: () => api.tagSuggestions(query.trim()),
  });
  const text = query.trim().toLowerCase();
  const selected = new Set(tags.map((tag) => tag.toLowerCase()));
  const blocked = library.data?.some((tag) => tag.name === text && tag.disableTagging);
  const suggestions = (library.data ?? [])
    .filter(
      (tag) =>
        !tag.disableTagging &&
        !selected.has(tag.name.toLowerCase()) &&
        tag.name.toLowerCase().includes(text),
    )
    .slice(0, 20);
  const canCreate =
    text &&
    !selected.has(text) &&
    !blocked &&
    !library.isPending &&
    !suggestions.some((tag) => tag.name.toLowerCase() === text);

  function add(tag: string) {
    onChange([...tags, tag]);
    onQueryChange('');
    setOpen(false);
    input.current?.focus();
  }

  return (
    <div className="space-y-2">
      <label id={`${id}-label`} htmlFor={id}>
        Tags
      </label>
      <div className="flex flex-wrap gap-2" aria-label="Selected tags">
        {tags.map((tag) => {
          const sources = originalTags.find((original) => original.name === tag)?.sources ?? [
            'user',
          ];
          const userGiven = sources.includes('user') || sources.includes('folder');
          const origin = sources
            .map(
              (source) =>
                ({
                  ai: 'AI',
                  user: 'User',
                  folder: 'Folder name',
                })[source],
            )
            .join(', ');
          return (
            <Button
              key={tag}
              type="button"
              variant="outline"
              aria-label={`Remove tag ${tag}`}
              title={origin}
              className={
                userGiven
                  ? 'max-w-full border-sky-200 bg-sky-50 hover:bg-sky-100 dark:border-sky-700 dark:bg-sky-900/40 dark:hover:bg-sky-900/60'
                  : 'max-w-full'
              }
              onClick={() => {
                onChange(tags.filter((value) => value !== tag));
                input.current?.focus();
              }}
            >
              <span className="truncate">{tag}</span>
              <X aria-hidden="true" />
            </Button>
          );
        })}
      </div>

      <Command
        shouldFilter={false}
        loop
        className="relative"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
      >
        <Command.Input
          asChild
          ref={input}
          aria-label="Add tag"
          name="tag"
          aria-describedby={`${id}-help`}
          value={query}
          onValueChange={(value) => {
            onQueryChange(value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          autoComplete="off"
          placeholder="Find or add a tag…"
          className="h-9 w-full min-w-0 rounded-md border bg-background px-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape' && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setOpen(true);
            // Enter selects a suggestion without submitting the image form.
            if (event.key === 'Enter' && !open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            }
          }}
        >
          <input id={id} aria-expanded={open} aria-labelledby={undefined} />
        </Command.Input>
        {open && (
          <Command.List
            aria-label="Tag suggestions"
            className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-md border bg-background p-1 shadow-md"
          >
            {suggestions.map((tag) => (
              <Command.Item
                key={tag.name}
                value={tag.name}
                onMouseDown={(event) => event.preventDefault()}
                onSelect={() => add(tag.name)}
                className="cursor-pointer rounded px-3 py-2 data-[selected=true]:bg-muted"
              >
                {tag.name}
              </Command.Item>
            ))}
            {canCreate && (
              <Command.Item
                value={text}
                onSelect={() => add(text)}
                onMouseDown={(event) => event.preventDefault()}
                className="cursor-pointer rounded px-3 py-2 data-[selected=true]:bg-muted"
              >
                Add "{query.trim()}"
              </Command.Item>
            )}
            {!suggestions.length && !canCreate && (
              <p className="px-3 py-2 text-muted-foreground">
                {selected.has(text)
                  ? 'This tag is already added.'
                  : blocked
                    ? 'This tag is disabled for image tagging.'
                    : library.isPending
                      ? 'Loading tags…'
                      : 'Type to add a new tag.'}
              </p>
            )}
          </Command.List>
        )}
      </Command>
      <p id={`${id}-help`} className="text-muted-foreground">
        Click a tag to remove it. Pale blue tags come from you or folder names; hover to see the
        source.
      </p>
      {library.isError && (
        <p role="status" className="text-muted-foreground">
          Suggestions could not load. You can still add tags.
        </p>
      )}
    </div>
  );
}
