import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';

/**
 * Mutation with consistent UX: success toast, error toast with the API's message,
 * and cache invalidation of the affected queries.
 */
export function useApiMutation<TVars, TData = unknown>(
  fn: (vars: TVars) => Promise<TData>,
  opts: { success?: string | ((data: TData, vars: TVars) => string); invalidate?: QueryKey[]; onSuccess?: (data: TData, vars: TVars) => void; silentError?: boolean } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data, vars) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(data, vars) : opts.success);
      opts.invalidate?.forEach((key) => qc.invalidateQueries({ queryKey: key }));
      opts.onSuccess?.(data, vars);
    },
    onError: (err) => {
      if (!opts.silentError) toast.error(errorMessage(err));
    },
  });
}
