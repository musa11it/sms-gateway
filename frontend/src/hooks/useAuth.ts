import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { authService } from '@/services/authService';
import { useAuthStore } from '@/stores/authStore';

export const meKey = ['me'] as const;

/** Current user, organization and permissions. The backend is the source of truth. */
export function useMe() {
  const token = useAuthStore((s) => s.accessToken);
  const orgId = useAuthStore((s) => s.currentOrgId);
  return useQuery({ queryKey: [...meKey, orgId], queryFn: authService.me, enabled: !!token, staleTime: 30_000 });
}

export function usePermissions() {
  const { data } = useMe();
  const org = new Set(data?.orgPermissions ?? []);
  const platform = new Set(data?.platform.permissions ?? []);
  return {
    /** Organization-scope permission (customer app). */
    can: (key: string) => org.has(key),
    canAny: (...keys: string[]) => keys.some((k) => org.has(k)),
    /** Platform-scope permission (admin console). */
    canAdmin: (key: string) => platform.has(key),
    isStaff: !!data?.isStaff,
  };
}

export function useLogout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const clear = useAuthStore((s) => s.clear);
  return useCallback(async () => {
    try {
      await authService.logout();
    } catch {
      /* session may already be gone */
    }
    clear();
    qc.clear();
    navigate('/login', { replace: true });
  }, [clear, navigate, qc]);
}

export function useSystemInfo() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({ queryKey: ['system-info'], queryFn: authService.systemInfo, enabled: !!token, staleTime: 5 * 60_000 });
}
