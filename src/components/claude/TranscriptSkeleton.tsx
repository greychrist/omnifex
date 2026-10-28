/**
 * What a chat shows while its history loads or a large transcript renders:
 * a few turns sketched in shadcn Skeletons — a prompt bubble on the right, a
 * work line, and a paragraph of answer. The pulse is an opacity animation,
 * which WebKit runs off the main thread, so it keeps moving through the
 * transcript's own (blocking) commit.
 */
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// Fixed widths, not random: the sketch must not reflow between renders.
const ANSWER_LINES = [['w-full', 'w-11/12', 'w-2/3'], ['w-full', 'w-4/5'], ['w-11/12', 'w-full', 'w-3/4', 'w-1/2']];
const PROMPT_WIDTHS = ['w-1/2', 'w-2/5', 'w-1/3'];

export function TranscriptSkeleton({ turns = 3, className }: { turns?: number; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={cn('flex w-full flex-col gap-8', className)}>
      <span className="sr-only">Loading conversation</span>
      {Array.from({ length: turns }, (_, i) => (
        <div key={i} data-skeleton-turn className="flex flex-col gap-4">
          <Skeleton className={`h-10 self-end rounded-3xl ${PROMPT_WIDTHS[i % PROMPT_WIDTHS.length]}`} />
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 shrink-0 rounded-full" />
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="flex flex-col gap-2">
            {ANSWER_LINES[i % ANSWER_LINES.length].map((w, j) => <Skeleton key={j} className={`h-4 ${w}`} />)}
          </div>
        </div>
      ))}
    </div>
  );
}
