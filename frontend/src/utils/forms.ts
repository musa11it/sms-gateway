import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/api/client';

/** Maps API validation errors onto form fields; falls back to a toast. */
export function handleFormError<T extends FieldValues>(err: unknown, setError?: UseFormSetError<T>, fields?: string[]) {
  if (err instanceof ApiError && err.errors.length && setError) {
    let mapped = false;
    for (const e of err.errors) {
      if (!fields || fields.includes(e.field)) {
        setError(e.field as Path<T>, { message: e.message });
        mapped = true;
      }
    }
    if (mapped) {
      toast.error(err.message);
      return;
    }
  }
  toast.error(errorMessage(err));
}
