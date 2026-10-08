import type { ReactElement } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useMutation } from '@tanstack/react-query';
import { api, type FolderAction } from '../lib/api';

const actions = [
  ['copy_path', 'Copy folder path'],
  ['open', 'Open folder'],
] as const satisfies ReadonlyArray<readonly [FolderAction, string]>;

export function FolderContextMenu({
  folderId,
  children,
  onError,
}: {
  folderId: number;
  children: ReactElement;
  onError: (error: string) => void;
}) {
  const action = useMutation({
    mutationFn: (action: FolderAction) => api.folderAction(folderId, action),
    onMutate: () => onError(''),
    onError: (error) => onError(error instanceof Error ? error.message : String(error)),
  });
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-[60] min-w-48 rounded-md border bg-background p-1 shadow-md">
          {actions.map(([value, label]) => (
            <ContextMenu.Item
              key={value}
              disabled={action.isPending}
              onSelect={() => action.mutate(value)}
              className="cursor-default select-none rounded px-3 py-2 outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50"
            >
              {label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
