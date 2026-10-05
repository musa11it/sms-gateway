import { forwardRef, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { Building2, CheckCircle2, Eye, EyeOff, Lock, Mail, MailCheck, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { Button, LinkButton } from '@/components/ui/Button';
import { Alert, PageLoader } from '@/components/ui/Feedback';
import { Field, Input } from '@/components/ui/Form';
import { AuthLayout } from '@/layouts/AuthLayout';
import { authService } from '@/services/authService';
import { useAuthStore } from '@/stores/authStore';
import { handleFormError } from '@/utils/forms';

const password = z.string().min(8, 'At least 8 characters').regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number');

const PasswordInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>((props, ref) => {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input ref={ref} {...props} type={show ? 'text' : 'password'} leading={<Lock className="h-4 w-4" />} className="pr-10" />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute inset-y-0 right-3 text-slate-400 hover:text-slate-600" aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
});
PasswordInput.displayName = 'PasswordInput';

function DevHint() {
  if (import.meta.env.PROD) return null;
  return (
    <Alert tone="info" className="mt-6" title="Development accounts">
      <span className="block">customer@example.com · admin@example.com · superadmin@example.com</span>
      <span className="block">Password: <code className="font-mono">Password123!</code></span>
    </Alert>
  );
}

// ── Login ───────────────────────────────────────────────────────────────

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setToken = useAuthStore((s) => s.setAccessToken);
  const qc = useQueryClient();
  const schema = z.object({ email: z.string().email('Enter a valid email'), password: z.string().min(1, 'Enter your password') });
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  const m = useMutation({
    mutationFn: (v: z.infer<typeof schema>) => authService.login(v.email, v.password),
    onSuccess: (d) => {
      qc.clear();
      setToken(d.accessToken);
      const next = params.get('next');
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/start', { replace: true });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const { errors } = form.formState;
  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to your SMS Gateway account"
      footer={
        <>
          New here?{' '}
          <Link to="/register" className="link">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={form.handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
        <Field label="Email" error={errors.email?.message}>
          <Input type="email" autoComplete="email" leading={<Mail className="h-4 w-4" />} placeholder="you@company.com" invalid={!!errors.email} {...form.register('email')} />
        </Field>
        <Field
          label={
            <span className="flex items-center justify-between">
              Password
              <Link to="/forgot-password" className="text-xs font-medium text-brand-600 hover:underline">
                Forgot password?
              </Link>
            </span>
          }
          error={errors.password?.message}
        >
          <PasswordInput autoComplete="current-password" placeholder="••••••••" invalid={!!errors.password} {...form.register('password')} />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={m.isPending}>
          Sign in
        </Button>
      </form>
      <DevHint />
    </AuthLayout>
  );
}

// ── Register ────────────────────────────────────────────────────────────

export function RegisterPage() {
  const navigate = useNavigate();
  const setToken = useAuthStore((s) => s.setAccessToken);
  const schema = z.object({
    fullName: z.string().trim().min(2, 'Enter your full name'),
    organizationName: z.string().trim().min(2, 'Enter your business or organization name'),
    email: z.string().email('Enter a valid email'),
    phone: z.string().optional(),
    password,
  });
  type V = z.infer<typeof schema>;
  const form = useForm<V>({ resolver: zodResolver(schema) });
  const m = useMutation({
    mutationFn: (v: V) => authService.register({ ...v, phone: v.phone || undefined }),
    onSuccess: (d) => {
      setToken(d.accessToken);
      toast.success('Account created — check your email to verify your address.');
      navigate('/onboarding', { replace: true });
    },
    onError: (e) => handleFormError(e, form.setError),
  });
  const { errors } = form.formState;
  return (
    <AuthLayout
      title="Create your account"
      subtitle="Start sending SMS in minutes. Verification takes about a business day."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="link">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={form.handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" error={errors.fullName?.message}>
            <Input autoComplete="name" placeholder="Jane Uwase" invalid={!!errors.fullName} {...form.register('fullName')} />
          </Field>
          <Field label="Phone" hint="Optional" error={errors.phone?.message}>
            <Input autoComplete="tel" placeholder="+250 788 000 000" {...form.register('phone')} />
          </Field>
        </div>
        <Field label="Organization name" error={errors.organizationName?.message}>
          <Input leading={<Building2 className="h-4 w-4" />} placeholder="Acme Retail Ltd" invalid={!!errors.organizationName} {...form.register('organizationName')} />
        </Field>
        <Field label="Work email" error={errors.email?.message}>
          <Input type="email" autoComplete="email" leading={<Mail className="h-4 w-4" />} placeholder="you@company.com" invalid={!!errors.email} {...form.register('email')} />
        </Field>
        <Field label="Password" error={errors.password?.message} hint="At least 8 characters with a letter and a number">
          <PasswordInput autoComplete="new-password" invalid={!!errors.password} {...form.register('password')} />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={m.isPending}>
          Create account
        </Button>
        <p className="text-center text-xs text-slate-500">By creating an account you agree to send messages only to recipients who have consented to receive them.</p>
      </form>
    </AuthLayout>
  );
}

// ── Verify email ────────────────────────────────────────────────────────

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const qc = useQueryClient();
  const loggedIn = !!useAuthStore((s) => s.accessToken);
  const started = useRef(false);
  const m = useMutation({ mutationFn: () => authService.verifyEmail(token), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }) });
  useEffect(() => {
    if (token && !started.current) {
      started.current = true;
      m.mutate();
    }
  }, [token, m]);
  return (
    <AuthLayout title="Email verification">
      {m.isPending || (!m.isSuccess && !m.isError && token) ? (
        <PageLoader />
      ) : m.isSuccess ? (
        <div className="text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
          <p className="mt-4 text-base font-semibold text-slate-900">Your email is verified</p>
          <p className="mt-1 text-sm text-slate-500">Next, complete your business profile so we can approve your account.</p>
          <LinkButton to={loggedIn ? '/onboarding' : '/login'} className="mt-6 w-full" size="lg">
            {loggedIn ? 'Continue onboarding' : 'Sign in to continue'}
          </LinkButton>
        </div>
      ) : (
        <div className="text-center">
          <XCircle className="mx-auto h-12 w-12 text-red-500" />
          <p className="mt-4 text-base font-semibold text-slate-900">This link can’t be used</p>
          <p className="mt-1 text-sm text-slate-500">{token ? errorMessage(m.error) : 'The verification link is missing its token.'} You can request a new link from the onboarding page.</p>
          <LinkButton to={loggedIn ? '/onboarding' : '/login'} variant="secondary" className="mt-6 w-full">
            {loggedIn ? 'Back to onboarding' : 'Sign in'}
          </LinkButton>
        </div>
      )}
    </AuthLayout>
  );
}

// ── Forgot / reset password ─────────────────────────────────────────────

export function ForgotPasswordPage() {
  const schema = z.object({ email: z.string().email('Enter a valid email') });
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  const m = useMutation({ mutationFn: (v: { email: string }) => authService.forgotPassword(v.email), onError: (e) => toast.error(errorMessage(e)) });
  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We’ll email you a secure link to choose a new password."
      footer={
        <Link to="/login" className="link">
          Back to sign in
        </Link>
      }
    >
      {m.isSuccess ? (
        <Alert tone="success" title="Check your inbox">
          If an account exists for {form.getValues('email')}, a reset link is on its way. The link expires in 1 hour.
          {!import.meta.env.PROD && (
            <Link to="/dev/mailbox" className="mt-2 block font-medium underline">
              Open the development mailbox →
            </Link>
          )}
        </Alert>
      ) : (
        <form onSubmit={form.handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <Field label="Email" error={form.formState.errors.email?.message}>
            <Input type="email" leading={<Mail className="h-4 w-4" />} placeholder="you@company.com" {...form.register('email')} />
          </Field>
          <Button type="submit" size="lg" className="w-full" loading={m.isPending}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const schema = z.object({ password, confirm: z.string() }).refine((v) => v.password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  const m = useMutation({
    mutationFn: (v: { password: string }) => authService.resetPassword(params.get('token') ?? '', v.password),
    onSuccess: () => {
      toast.success('Password updated. Please sign in.');
      navigate('/login', { replace: true });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const { errors } = form.formState;
  return (
    <AuthLayout title="Choose a new password" subtitle="All other sessions will be signed out.">
      <form onSubmit={form.handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
        <Field label="New password" error={errors.password?.message}>
          <PasswordInput autoComplete="new-password" {...form.register('password')} />
        </Field>
        <Field label="Confirm password" error={errors.confirm?.message}>
          <PasswordInput autoComplete="new-password" {...form.register('confirm')} />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={m.isPending}>
          Update password
        </Button>
      </form>
    </AuthLayout>
  );
}

// ── Accept invitation ───────────────────────────────────────────────────

export function AcceptInvitationPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const accessToken = useAuthStore((s) => s.accessToken);
  const setToken = useAuthStore((s) => s.setAccessToken);
  const setOrg = useAuthStore((s) => s.setCurrentOrgId);
  const qc = useQueryClient();
  const inv = useQuery({ queryKey: ['invitation', token], queryFn: () => authService.invitation(token), enabled: !!token, retry: false });
  const schema = z.object({ fullName: z.string().trim().min(2, 'Enter your name'), password });
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  const m = useMutation({
    mutationFn: (v?: z.infer<typeof schema>) => authService.acceptInvitation({ token, ...v }),
    onSuccess: (d) => {
      if (d.accessToken) setToken(d.accessToken);
      setOrg(d.organizationId);
      qc.clear();
      toast.success('Invitation accepted');
      navigate('/start', { replace: true });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <AuthLayout title="Join your team" subtitle={inv.data ? <>You’ve been invited to <strong>{inv.data.organizationName}</strong> as <strong>{inv.data.roleName}</strong>.</> : undefined}>
      {inv.isLoading ? (
        <PageLoader />
      ) : inv.error || !inv.data ? (
        <Alert tone="danger" title="Invitation unavailable">
          {token ? errorMessage(inv.error) : 'The invitation link is incomplete.'}
        </Alert>
      ) : inv.data.userExists ? (
        accessToken ? (
          <Button size="lg" className="w-full" onClick={() => m.mutate(undefined)} loading={m.isPending}>
            Accept invitation as {inv.data.email}
          </Button>
        ) : (
          <div className="space-y-4">
            <Alert tone="info">An account already exists for {inv.data.email}. Sign in, then open the invitation link again.</Alert>
            <LinkButton to={`/login?next=${encodeURIComponent(`/invitations/accept?token=${token}`)}`} size="lg" className="w-full">
              Sign in to accept
            </LinkButton>
          </div>
        )
      ) : (
        <form onSubmit={form.handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <Field label="Email">
            <Input value={inv.data.email} disabled leading={<MailCheck className="h-4 w-4" />} />
          </Field>
          <Field label="Full name" error={form.formState.errors.fullName?.message}>
            <Input {...form.register('fullName')} />
          </Field>
          <Field label="Password" error={form.formState.errors.password?.message}>
            <PasswordInput autoComplete="new-password" {...form.register('password')} />
          </Field>
          <Button type="submit" size="lg" className="w-full" loading={m.isPending}>
            Create account & join
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
