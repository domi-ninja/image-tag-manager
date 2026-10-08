import * as Primitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;

export function PopoverContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align="end"
        sideOffset={6}
        className={cn(
          'z-50 max-h-[calc(100dvh-4rem)] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border bg-background p-4 shadow-lg',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
