import { del, get, http, patch, post } from '@/api/client';
import type { Organization, PermissionDef, Role, VerificationStatus } from '@/api/types';

export type RequirementKind = 'FILE' | 'URL' | 'TEXT' | 'DATE' | 'SELECT';
export type FileFormat = 'PDF' | 'PNG' | 'JPEG';

/** One item the super admin asks businesses to provide during verification. */
export interface VerificationRequirement {
  type: string;
  label: string;
  description?: string;
  required: boolean;
  kind: RequirementKind;
  allowedFormats?: FileFormat[];
  maxSizeMb?: number;
  maxLength?: number;
  options?: string[];
}

export interface VerificationItem {
  id: string;
  documentType: string;
  originalName: string;
  value: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  status: string;
  reviewNote: string | null;
  createdAt: string;
  /** Staff recorded that the platform already holds this document (no file was uploaded). */
  onFile?: boolean;
}

export interface VerificationOverview {
  verification: { id: string; status: VerificationStatus; reviewNote: string | null; submittedAt: string | null; reviewedAt: string | null };
  documents: VerificationItem[];
  requirements: VerificationRequirement[];
  businessTypes: string[];
  missingFields: { field: string; label: string }[];
  missingDocuments: { type: string; label: string }[];
  canEdit: boolean;
  canSubmit: boolean;
}

export interface Member {
  id: string;
  isOwner: boolean;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
  user: { id: string; fullName: string; email: string; status: string; lastLoginAt: string | null };
  role: { id: string; name: string; code: string };
}

export interface Invitation {
  id: string;
  email: string;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  expiresAt: string;
  createdAt: string;
  role: { id: string; name: string };
  invitedBy: { fullName: string };
}

export const organizationService = {
  get: () => get<Organization>('/organization'),
  update: (body: Partial<Organization>) => patch<Organization>('/organization', body),
  verification: () => get<VerificationOverview>('/verification'),
  uploadDocument: async (documentType: string, file: File) => {
    const fd = new FormData();
    fd.append('documentType', documentType);
    fd.append('file', file);
    const r = await http.post('/verification/documents', fd);
    return r.data.data;
  },
  submitDocumentValue: (documentType: string, value: string) => post('/verification/documents/value', { documentType, value }),
  deleteDocument: (id: string) => del(`/verification/documents/${id}`),
  submitVerification: () => post<VerificationOverview>('/verification/submit'),
  members: () => get<Member[]>('/organization/members'),
  updateMember: (id: string, body: { roleId?: string; status?: 'ACTIVE' | 'DISABLED' }) => patch(`/organization/members/${id}`, body),
  removeMember: (id: string) => del(`/organization/members/${id}`),
  invitations: () => get<Invitation[]>('/organization/invitations'),
  invite: (email: string, roleId: string) => post('/organization/invitations', { email, roleId }),
  revokeInvitation: (id: string) => del(`/organization/invitations/${id}`),
  roles: () => get<Role[]>('/organization/roles'),
  permissions: () => get<PermissionDef[]>('/organization/permissions'),
  createRole: (body: { name: string; description?: string; permissions: string[] }) => post<Role>('/organization/roles', body),
  updateRole: (id: string, body: { name?: string; description?: string; permissions?: string[] }) => patch<Role>(`/organization/roles/${id}`, body),
  deleteRole: (id: string) => del(`/organization/roles/${id}`),
};
