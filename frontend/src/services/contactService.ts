import { del, get, getPage, http, patch, post } from '@/api/client';
import type { Contact, ContactGroup } from '@/api/types';

export interface ImportAnalysis {
  summary: { total: number; valid: number; invalid: number; duplicate: number; missing: number; existing: number };
  rows: {
    line: number;
    name: string | null;
    phone: string | null;
    rawPhone: string;
    email: string | null;
    tags: string[];
    status: 'valid' | 'invalid' | 'duplicate' | 'missing' | 'existing';
    reason?: string;
  }[];
}

export interface ContactInput {
  name?: string | null;
  phone: string;
  email?: string | null;
  tags?: string[];
  status?: Contact['status'];
  groupIds?: string[];
}

export const contactService = {
  list: (params: { page: number; limit?: number; search?: string; groupId?: string; status?: string }) => getPage<Contact>('/contacts', params),
  create: (body: ContactInput) => post<Contact>('/contacts', body),
  update: (id: string, body: Partial<ContactInput>) => patch<Contact>(`/contacts/${id}`, body),
  remove: (id: string) => del(`/contacts/${id}`),
  bulkDelete: (ids: string[]) => post<{ deleted: number }>('/contacts/bulk-delete', { ids }),
  exportCsv: async (params: { search?: string; groupId?: string; status?: string }) => {
    const r = await http.get('/contacts/export', { params, responseType: 'blob' });
    const url = URL.createObjectURL(r.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
  previewImport: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const r = await http.post('/contacts/import/preview', fd);
    return r.data.data as ImportAnalysis;
  },
  commitImport: async (file: File, opts: { groupId?: string; updateExisting?: boolean }) => {
    const fd = new FormData();
    fd.append('file', file);
    if (opts.groupId) fd.append('groupId', opts.groupId);
    fd.append('updateExisting', String(!!opts.updateExisting));
    const r = await http.post('/contacts/import/commit', fd);
    return r.data as { data: ImportAnalysis['summary'] & { created: number; updated: number }; message: string };
  },
  groups: () => get<ContactGroup[]>('/contact-groups'),
  createGroup: (body: { name: string; description?: string; color?: string }) => post<ContactGroup>('/contact-groups', body),
  updateGroup: (id: string, body: { name?: string; description?: string; color?: string }) => patch<ContactGroup>(`/contact-groups/${id}`, body),
  deleteGroup: (id: string) => del(`/contact-groups/${id}`),
  addToGroup: (id: string, contactIds: string[]) => post<{ added: number }>(`/contact-groups/${id}/members`, { contactIds }),
};
