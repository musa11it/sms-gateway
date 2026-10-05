import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { Toaster } from 'sonner';
import { ApiError, refreshAccessToken } from '@/api/client';
import { LogoMark } from '@/components/layout/Brand';
import { router } from '@/routes/router';
import { useAuthStore } from '@/stores/authStore';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

/** Restores the session from the httpOnly refresh cookie before rendering routes. */
function Bootstrap({ children }: { children: React.ReactNode }) {
  const bootstrapped = useAuthStore((s) => s.bootstrapped);
  const setBootstrapped = useAuthStore((s) => s.setBootstrapped);
  useEffect(() => {
    if (bootstrapped) return;
    if (!useAuthStore.getState().hasSession) {
      setBootstrapped(true);
      return;
    }
    void refreshAccessToken().finally(() => setBootstrapped(true));
  }, [bootstrapped, setBootstrapped]);
  if (!bootstrapped)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LogoMark className="h-10 w-10 animate-pulse" />
      </div>
    );
  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Bootstrap>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </Bootstrap>
      <Toaster position="top-right" richColors closeButton toastOptions={{ style: { fontFamily: 'Inter, sans-serif' } }} />
    </QueryClientProvider>
  );
}
