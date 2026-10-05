import type { OrganizationStatus, UserStatus } from '@prisma/client';

declare global {
  namespace Express {
    interface AuthUser {
      id: string;
      email: string;
      fullName: string;
      status: UserStatus;
      sessionId: string;
      /** Platform (staff) permission keys. */
      platformPermissions: Set<string>;
      platformRoles: string[];
    }

    interface OrgContext {
      id: string;
      name: string;
      status: OrganizationStatus;
      memberId: string | null;
      roleCode: string | null;
      isOwner: boolean;
      /** Organization-scope permission keys for the current actor. */
      permissions: Set<string>;
    }

    interface ApiKeyContext {
      id: string;
      prefix: string;
      scopes: string[];
      rateLimitPerMinute: number | null;
    }

    interface Request {
      user?: AuthUser;
      org?: OrgContext;
      apiKey?: ApiKeyContext;
    }
  }
}

export {};
