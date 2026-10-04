import type { ReactElement } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useMutation } from '@tanstack/react-query';
import { api, type ImageAction } from '../lib/api';

const actions = [
  ['copy_image', 'Copy image'],
  ['copy_path', 'Copy image path'],
  ['reveal', 'Show in file manager'],
  ['open', 'Open image'],
] as const satisfies ReadonlyArray<readonly [ImageAction, string]>;

export function PhotoContextMenu({
  photoId,
  children,
  onError,
}: {
  photoId: number;
  children: ReactElement;
  onError: (error: string) => void;
}) {
  const action = useMutation({
    mutationFn: (action: ImageAction) => api.imageAction(photoId, action),
    onMutate: () => onError(''),
    onError: (error) => onError(error instanceof Error ? error.message : String(error)),
  });
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-[60] min-w-48 rounded-md border bg-white p-1 shadow-md">
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
