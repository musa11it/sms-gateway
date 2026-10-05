import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/stores/authStore';
import type { ApiEnvelope, Paginated } from './types';

export const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public errors: { field: string; message: string }[] = [],
  ) {
    super(message);
  }
}

export const http = axios.create({ baseURL: API_BASE, withCredentials: true, timeout: 30_000 });

http.interceptors.request.use((config) => {
  const { accessToken, currentOrgId } = useAuthStore.getState();
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  if (currentOrgId) config.headers['X-Organization-Id'] = currentOrgId;
  return config;
});

// Single-flight refresh: concurrent 401s wait for one refresh call.
let refreshing: Promise<string | null> | null = null;

export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshing) {
    refreshing = axios
      .post<ApiEnvelope<{ accessToken: string }>>(`${API_BASE}/auth/refresh`, null, { withCredentials: true })
      .then((r) => {
        useAuthStore.getState().setAccessToken(r.data.data.accessToken);
        return r.data.data.accessToken;
      })
      .catch(() => {
        useAuthStore.getState().clear();
        return null;
      })
      .finally(() => {
        setTimeout(() => (refreshing = null), 0);
      });
  }
  return refreshing;
}

http.interceptors.response.use(
  (r) => r,
  async (error: AxiosError<{ message?: string; code?: string; errors?: { field: string; message: string }[] }>) => {
    const original = error.config as AxiosRequestConfig & { _retried?: boolean };
    const status = error.response?.status ?? 0;
    const code = error.response?.data?.code ?? '';
    const isAuthCall = original?.url?.startsWith('/auth/');
    if (status === 401 && !original?._retried && !isAuthCall && ['TOKEN_INVALID', 'SESSION_REVOKED', 'UNAUTHENTICATED'].includes(code)) {
      original._retried = true;
      const token = await refreshAccessToken();
      if (token) return http(original);
    }
    // Membership of the stored organization was lost: fall back to the default org.
    if (status === 403 && code === 'NOT_A_MEMBER') useAuthStore.getState().setCurrentOrgId(null);

    const data = error.response?.data;
    if (!error.response) throw new ApiError('Cannot reach the server. Check your connection.', 0, 'NETWORK_ERROR');
    throw new ApiError(data?.message ?? 'Something went wrong', status, data?.code ?? 'UNKNOWN', data?.errors ?? []);
  },
);

/** Unwraps the `{ success, data }` envelope. */
export async function get<T>(url: string, params?: object): Promise<T> {
  const r = await http.get<ApiEnvelope<T>>(url, { params });
  return r.data.data;
}
export async function getPage<T>(url: string, params?: object): Promise<Paginated<T>> {
  const r = await http.get<Paginated<T>>(url, { params });
  return r.data;
}
export async function post<T>(url: string, body?: unknown): Promise<T> {
  const r = await http.post<ApiEnvelope<T>>(url, body);
  return r.data.data;
}
export async function postWithMessage<T>(url: string, body?: unknown): Promise<{ data: T; message?: string }> {
  const r = await http.post<ApiEnvelope<T>>(url, body);
  return { data: r.data.data, message: r.data.message };
}
export async function patch<T>(url: string, body?: unknown): Promise<T> {
  const r = await http.patch<ApiEnvelope<T>>(url, body);
  return r.data.data;
}
export async function put<T>(url: string, body?: unknown): Promise<T> {
  const r = await http.put<ApiEnvelope<T>>(url, body);
  return r.data.data;
}
export async function del<T>(url: string): Promise<T> {
  const r = await http.delete<ApiEnvelope<T>>(url);
  return r.data.data;
}

/** Downloads a protected file (auth header required) and opens/saves it. */
export async function downloadFile(url: string, filename?: string, open = false) {
  const r = await http.get(url, { responseType: 'blob' });
  const blobUrl = URL.createObjectURL(r.data as Blob);
  if (open) window.open(blobUrl, '_blank', 'noopener');
  else {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename ?? 'download';
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
