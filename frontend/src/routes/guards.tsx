import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { LinkButton } from '@/components/ui/Button';
import { EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { useMe, usePermissions } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';

/**
 * Client-side guards only shape navigation. Every API call is still authorised by the
 * backend, which is the source of truth for authentication, status and permissions.
 */
export function ProtectedRoute() {
  const token = useAuthStore((s) => s.accessToken);
  const location = useLocation();
  if (!token) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <Outlet />;
}

export function GuestRoute() {
  const token = useAuthStore((s) => s.accessToken);
  return token ? <Navigate to="/start" replace /> : <Outlet />;
}

/** Customer workspace: needs an organization; unverified organizations go to onboarding. */
export function CustomerRoute() {
  const { data: me, isLoading, error, refetch } = useMe();
  if (isLoading) return <PageLoader />;
  if (error || !me) return <ErrorState error={error} onRetry={() => void refetch()} className="min-h-screen" />;
  if (!me.organization) return <Navigate to={me.isStaff ? '/admin' : '/onboarding'} replace />;
  const needsOnboarding = me.user.status === 'PENDING_EMAIL_VERIFICATION' || ['DRAFT', 'PENDING_REVIEW', 'REJECTED'].includes(me.organization.status);
  if (needsOnboarding) return <Navigate to="/onboarding" replace />;
  return <Outlet />;
}

export function AdminRoute() {
  const { data: me, isLoading } = useMe();
  if (isLoading) return <PageLoader />;
  if (!me?.isStaff) return <Navigate to="/app" replace />;
  return <Outlet />;
}

export function Forbidden({ home = '/' }: { home?: string }) {
  return (
    <div className="card mx-auto mt-10 max-w-lg">
      <EmptyState
        icon={<ShieldOff />}
        title="You don’t have access to this page"
        description="Your role doesn’t include the permission required here. Ask an administrator or your organization owner if you need access."
        action={<LinkButton to={home} variant="secondary">Go back</LinkButton>}
      />
    </div>
  );
}

/** Renders children only when the permission is held (org scope by default, or admin scope). */
export function PermissionRoute({ permission, admin, children }: { permission: string | string[]; admin?: boolean; children: ReactNode }) {
  const { can, canAdmin } = usePermissions();
  const { isLoading } = useMe();
  if (isLoading) return <PageLoader />;
  const keys = Array.isArray(permission) ? permission : [permission];
  const ok = keys.some((k) => (admin ? canAdmin(k) : can(k)));
  return ok ? <>{children}</> : <Forbidden home={admin ? '/admin' : '/app'} />;
}

export function HomeRedirect() {
  const { data: me, isLoading } = useMe();
  if (isLoading || !me) return <PageLoader />;
  if (me.organization) {
    const pending = me.user.status === 'PENDING_EMAIL_VERIFICATION' || ['DRAFT', 'PENDING_REVIEW', 'REJECTED'].includes(me.organization.status);
    if (me.isStaff && pending) return <Navigate to="/admin" replace />;
    return <Navigate to={pending ? '/onboarding' : '/app'} replace />;
  }
  return <Navigate to={me.isStaff ? '/admin' : '/onboarding'} replace />;
}
