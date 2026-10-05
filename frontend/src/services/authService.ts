import { get, http, patch, post } from '@/api/client';
import type { Me } from '@/api/types';

export const authService = {
  login: (email: string, password: string) => post<{ accessToken: string }>('/auth/login', { email, password }),
  register: (body: { fullName: string; email: string; phone?: string; password: string; organizationName: string }) =>
    post<{ accessToken: string }>('/auth/register', body),
  logout: () => post<null>('/auth/logout'),
  verifyEmail: (token: string) => post<null>('/auth/verify-email', { token }),
  resendVerification: () => post<null>('/auth/resend-verification'),
  forgotPassword: (email: string) => post<null>('/auth/forgot-password', { email }),
  resetPassword: (token: string, password: string) => post<null>('/auth/reset-password', { token, password }),
  changePassword: (currentPassword: string, newPassword: string) => post<null>('/auth/change-password', { currentPassword, newPassword }),
  sessions: () =>
    get<{ id: string; userAgent: string | null; ipAddress: string | null; createdAt: string; lastUsedAt: string; current: boolean }[]>('/auth/sessions'),
  revokeSession: (id: string) => http.delete(`/auth/sessions/${id}`),
  sendPhoneCode: () => post<null>('/auth/phone/send-code'),
  verifyPhone: (code: string) => post<null>('/auth/phone/verify', { code }),
  me: () => get<Me>('/me'),
  updateProfile: (body: { fullName?: string; phone?: string | null }) => patch('/me', body),
  systemInfo: () =>
    get<{ smsProvider: string; smsSimulation: boolean; paymentProvider: string; paymentSimulation: boolean; environment: string }>('/system/info'),
  invitation: (token: string) =>
    get<{ email: string; organizationName: string; roleName: string; expiresAt: string; userExists: boolean }>(`/invitations/${token}`),
  acceptInvitation: (body: { token: string; fullName?: string; password?: string }) =>
    post<{ accessToken?: string; organizationId: string }>('/invitations/accept', body),
  devMailbox: (to?: string) =>
    get<{ id: string; to: string; subject: string; text: string; template: string; status: string; createdAt: string }[]>('/dev/mailbox', { to, limit: 50 }),
};
