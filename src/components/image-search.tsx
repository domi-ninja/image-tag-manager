import { useState, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { api } from '../lib/api';
import { formatTagSearch, parseSearch } from '../lib/search';

export function ImageSearch({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const parsed = parseSearch(value);
  const active = parsed.tokens.find((token) => cursor > token.start && cursor <= token.end);
  const expanded = open && active !== undefined;
  const suggestions = useQuery({
    queryKey: ['tagSuggestions', active?.name ?? '', 'prefix'],
    queryFn: () => api.tagSuggestions(active?.name ?? '', true),
    enabled: expanded,
  });
  function select(name: string) {
    if (!active) return;
    const before = value.slice(0, active.start);
    const replacement = formatTagSearch(name);
    onChange(`${before}${replacement} ${value.slice(active.end).trimStart()}`);
    setOpen(false);
    const position = before.length + replacement.length + 1;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
    });
  }
  return (
    <Command
      shouldFilter={false}
      loop
      className="relative min-w-0 flex-1"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <Search
        className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
        aria-hidden
      />
      <Command.Input
        asChild
        ref={inputRef}
        aria-label="Search images"
        value={value}
        onValueChange={(next) => {
          onChange(next);
          setCursor(inputRef.current?.selectionStart ?? next.length);
          setOpen(true);
        }}
        onSelect={(event) => {
          setCursor(event.currentTarget.selectionStart ?? 0);
        }}
        onFocus={() => {
          setCursor(inputRef.current?.selectionStart ?? value.length);
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && expanded) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && active) setOpen(true);
          // Outside the popup, preserve the textbox's normal cursor navigation.
          if (!expanded) event.stopPropagation();
        }}
        placeholder={'Search images or #tags…'}
        className="h-9 w-full min-w-0 rounded-md border bg-background pl-9 pr-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <input aria-expanded={expanded} aria-labelledby={undefined} />
      </Command.Input>
      {expanded && (
        <Command.List
          aria-label="Search tag suggestions"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border bg-background p-1 shadow-md"
        >
          {suggestions.isPending ? (
            <p role="status" className="px-3 py-2 text-muted-foreground">
              Loading tags…
            </p>
          ) : suggestions.isError ? (
            <p role="status" className="px-3 py-2 text-destructive">
              Could not load tag suggestions.
            </p>
          ) : !suggestions.data?.length ? (
            <p role="status" className="px-3 py-2 text-muted-foreground">
              No matching tags.
            </p>
          ) : (
            suggestions.data.map((tag) => (
              <Command.Item
                key={tag.id}
                value={tag.name}
                onMouseDown={(event) => event.preventDefault()}
                onSelect={() => select(tag.name)}
                className="flex cursor-pointer items-center justify-between gap-3 rounded px-3 py-2 data-[selected=true]:bg-muted"
              >
                <span className="truncate">{formatTagSearch(tag.name)}</span>
                <span
                  className="text-muted-foreground tabular-nums"
                  aria-label={`${tag.count} images`}
                >
                  {tag.count}
                </span>
              </Command.Item>
            ))
          )}
        </Command.List>
      )}
    </Command>
  );
}
