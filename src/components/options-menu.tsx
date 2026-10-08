import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import { api, type Status } from '../lib/api';
import { AppUpdates } from './app-updates';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

const seconds = (milliseconds: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(milliseconds / 1000);

export function OptionsMenu({ status }: { status: Status | undefined }) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const timings = useQuery({
    queryKey: ['classificationTimings'],
    queryFn: api.classificationTimings,
    enabled: open,
  });
  const threads = useMutation({
    mutationFn: api.setCpuThreads,
    onSuccess: () => client.invalidateQueries({ queryKey: ['status'] }),
  });
  const maxThreads = status?.maxCpuThreads ?? 8;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost">
          <Settings2 aria-hidden />
          Options
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="space-y-4">
          <section>
            <label htmlFor="cpu-threads" className="mb-2 block font-medium">
              CPU threads
            </label>
            <select
              id="cpu-threads"
              className="h-9 w-full rounded-md border px-3"
              value={status?.cpuThreads ?? 8}
              disabled={!status || status.busy || threads.isPending}
              onChange={(event) => threads.mutate(Number(event.target.value))}
            >
              {Array.from({ length: maxThreads }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
            {threads.error && (
              <p role="alert" className="mt-2 text-destructive">
                {threads.error instanceof Error ? threads.error.message : String(threads.error)}
              </p>
            )}
          </section>
          <section className="border-t pt-4">
            <h2 className="mb-2 font-medium">Classification times</h2>
            {timings.isPending ? (
              <p className="text-muted-foreground">Loading…</p>
            ) : timings.isError ? (
              <p role="alert" className="text-destructive">
                Could not load classification times.
              </p>
            ) : !timings.data?.length ? (
              <p className="text-muted-foreground">No timings yet.</p>
            ) : (
              <table className="w-full tabular-nums">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="pb-2 font-medium">
                      Threads
                    </th>
                    <th scope="col" className="pb-2 text-right font-medium">
                      Images
                    </th>
                    <th scope="col" className="pb-2 text-right font-medium">
                      Median (s)
                    </th>
                    <th scope="col" className="pb-2 text-right font-medium">
                      Avg (s)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {timings.data.map((timing) => (
                    <tr key={timing.threads} className="border-b last:border-0">
                      <th scope="row" className="py-2 text-left font-normal">
                        {timing.threads}
                      </th>
                      <td className="py-2 text-right">{timing.images.toLocaleString()}</td>
                      <td className="py-2 text-right">{seconds(timing.medianMs)}</td>
                      <td className="py-2 text-right">{seconds(timing.averageMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="border-t pt-4">
            <h2 className="mb-2 font-medium">Updates</h2>
            <AppUpdates />
          </section>
        </div>
      </PopoverContent>
    </Popover>
  );
}
