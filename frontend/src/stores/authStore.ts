import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Global client state that genuinely needs to be global:
 *  - the short-lived access token (kept in memory only, never in storage)
 *  - the organization the user is working in (persisted for convenience)
 *  - a non-sensitive hint that a refresh cookie probably exists (avoids a pointless
 *    refresh call for first-time visitors)
 * Everything else (user, permissions, balances…) is server state in TanStack Query.
 */
interface AuthState {
  accessToken: string | null;
  hasSession: boolean;
  bootstrapped: boolean;
  currentOrgId: string | null;
  setAccessToken: (token: string | null) => void;
  setBootstrapped: (v: boolean) => void;
  setCurrentOrgId: (id: string | null) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      hasSession: false,
      bootstrapped: false,
      currentOrgId: null,
      setAccessToken: (accessToken) => set({ accessToken, hasSession: !!accessToken }),
      setBootstrapped: (bootstrapped) => set({ bootstrapped }),
      setCurrentOrgId: (currentOrgId) => set({ currentOrgId }),
      clear: () => set({ accessToken: null, hasSession: false }),
    }),
    { name: 'sgw-auth', partialize: (s) => ({ currentOrgId: s.currentOrgId, hasSession: s.hasSession }) },
  ),
);

interface UiState {
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  sidebarOpen: false,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}));
