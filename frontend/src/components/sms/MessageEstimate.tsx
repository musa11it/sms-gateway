import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import type { MessageEstimate } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { useDebounce } from '@/hooks/useDebounce';
import { smsService } from '@/services/smsService';
import { cn, fmtNumber } from '@/utils/format';

/** Live encoding/segment analysis from the server (the backend is the only place segments are calculated). */
export function useMessageEstimate(message: string) {
  const debounced = useDebounce(message, 250);
  const q = useQuery({
    queryKey: ['sms-estimate', debounced],
    queryFn: () => smsService.estimate(debounced),
    enabled: debounced.length > 0,
    placeholderData: (p) => p,
    staleTime: 30_000,
  });
  return { estimate: message.length > 0 ? q.data : undefined, pending: message !== debounced || q.isFetching };
}

/** Characters · encoding · segments · credits per recipient, shown under a message box. */
export function MessageEstimateBar({ estimate, pending }: { estimate?: MessageEstimate; pending?: boolean }) {
  if (!estimate) return <p className="mt-2 text-xs text-slate-500">Long messages may use more than one SMS credit per recipient.</p>;
  const e = estimate;
  return (
    <div className={cn('mt-2 space-y-1.5 text-xs text-slate-500 transition-opacity', pending && 'opacity-60')} aria-live="polite">
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="flex items-center gap-1"><dt>Characters</dt><dd className={cn('font-semibold tabular-nums text-slate-800', e.tooLong && 'text-red-600')}>{fmtNumber(e.characterCount)}</dd></div>
        <div className="flex items-center gap-1"><dt>Encoding</dt><dd><Badge color={e.encoding === 'GSM7' ? 'gray' : 'amber'}>{e.encoding === 'GSM7' ? 'GSM-7' : 'Unicode'}</Badge></dd></div>
        <div className="flex items-center gap-1"><dt>SMS segments</dt><dd className="font-semibold tabular-nums text-slate-800">{e.segmentCount}</dd></div>
        <div className="flex items-center gap-1"><dt>Credits per recipient</dt><dd className="font-semibold tabular-nums text-slate-800">{e.creditsPerRecipient}</dd></div>
      </dl>
      {e.tooLong ? (
        <p className="font-medium text-red-600">This message is longer than the {fmtNumber(e.maxMessageCharacters)}-character maximum.</p>
      ) : (
        <p className="flex items-start gap-1">
          <Info className="mt-px h-3 w-3 shrink-0" />
          <span>
            Long messages may use more than one SMS credit per recipient. {e.encoding === 'GSM7' ? 'Standard' : 'Unicode (emoji or special characters)'} messages fit {e.charactersPerSingleSegment} characters in one SMS, or{' '}
            {e.charactersPerMultipartSegment} per SMS when split{e.segmentCount > 0 ? ` · ${e.remainingInSegment} left before the next segment` : ''}.
          </span>
        </p>
      )}
    </div>
  );
}
