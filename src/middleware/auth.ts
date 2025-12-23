// src/middleware/auth.ts
import { Request, Response, NextFunction } from "express";
import { PrismaClient, UserRole } from "../generated/prisma/client";
import { AuthService, AuthError } from "../services/auth/AuthService";

// ============================================================================
// EXTEND EXPRESS REQUEST TYPE
// ============================================================================

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role?: UserRole;
        tenantId?: string;
      };
      sessionId?: string;
    }
  }
}

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================

export class AuthMiddleware {
  private authService: AuthService;
  private prisma: PrismaClient;

  constructor(authService: AuthService, prisma: PrismaClient) {
    this.authService = authService;
    this.prisma = prisma;
  }

  /**
   * Verify JWT token and attach user to request
   */
  authenticate = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      // Extract token from Authorization header
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(401).json({
          success: false,
          error: "No token provided",
          code: "NO_TOKEN",
        });
        return;
      }

      const token = authHeader.substring(7); // Remove 'Bearer '

      // Verify token
      const payload = this.authService.verifyAccessToken(token);

      // Verify session is still valid
      const session = await this.prisma.session.findUnique({
        where: { id: payload.sessionId },
        include: { user: true },
      });

      if (!session) {
        res.status(401).json({
          success: false,
          error: "Session not found",
          code: "INVALID_SESSION",
        });
        return;
      }

      if (session.expiresAt < new Date()) {
        res.status(401).json({
          success: false,
          error: "Session expired",
          code: "SESSION_EXPIRED",
        });
        return;
      }

      // Check if user is active
      if (session.user.isSuspended) {
        res.status(403).json({
          success: false,
          error: "Account suspended",
          code: "ACCOUNT_SUSPENDED",
        });
        return;
      }

      if (!session.user.isActive) {
        res.status(403).json({
          success: false,
          error: "Account not active",
          code: "ACCOUNT_INACTIVE",
        });
        return;
      }

      // Update session activity
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastActivityAt: new Date() },
      });

      // Attach user to request
      req.user = {
        id: session.user.id,
        email: session.user.email,
      };
      req.sessionId = session.id;

      next();
    } catch (error) {
      if (error instanceof AuthError) {
        res.status(error.statusCode).json({
          success: false,
          error: error.message,
          code: error.code,
        });
        return;
      }

      res.status(401).json({
        success: false,
        error: "Authentication failed",
        code: "AUTH_FAILED",
      });
    }
  };

  /**
   * Optional authentication - doesn't fail if no token provided
   */
  optionalAuth = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        next();
        return;
      }

      const token = authHeader.substring(7);
      const payload = this.authService.verifyAccessToken(token);

      const session = await this.prisma.session.findUnique({
        where: { id: payload.sessionId },
        include: { user: true },
      });

      if (session && session.expiresAt > new Date() && session.user.isActive) {
        req.user = {
          id: session.user.id,
          email: session.user.email,
        };
        req.sessionId = session.id;
      }

      next();
    } catch (error) {
      // Silently continue without auth
      next();
    }
  };

  /**
   * Require tenant access
   */
  requireTenantAccess = (requiredRole?: UserRole) => {
    return async (
      req: Request,
      res: Response,
      next: NextFunction
    ): Promise<void> => {
      try {
        if (!req.user) {
          res.status(401).json({
            success: false,
            error: "Authentication required",
            code: "AUTH_REQUIRED",
          });
          return;
        }

        const { tenantId } = req.params;


        if (!tenantId) {
          res.status(400).json({
            success: false,
            error: "Tenant ID required",
            code: "TENANT_ID_REQUIRED",
          });
          return;
        }

        // Check tenant membership
        const membership = await this.prisma.tenantMember.findUnique({
          where: {
            userId_tenantId: {
              userId: req.user.id,
              tenantId,
            },
          },
          include: {
            tenant: true,
          },
        });

        if (!membership) {
          res.status(403).json({
            success: false,
            error: "Access denied to tenant",
            code: "TENANT_ACCESS_DENIED",
          });
          return;
        }

        if (requiredRole) {
          const roleHierarchy = {
            [UserRole.SUPER_ADMIN]: 3,
            [UserRole.TENANT_ADMIN]: 2,
            [UserRole.USER]: 1,
          };

          if (roleHierarchy[membership.role] < roleHierarchy[requiredRole]) {
            res.status(403).json({
              success: false,
              error: "Insufficient permissions",
              code: "INSUFFICIENT_PERMISSIONS",
            });
            return;
          }
        }

        // Attach tenant info to request
        req.user.role = membership.role;
        req.user.tenantId = tenantId;

        next();
      } catch (error) {
        next(error);
      }
    };
  };

  /**
   * Require specific role
   */
  requireRole = (role: UserRole) => {
    return async (
      req: Request,
      res: Response,
      next: NextFunction
    ): Promise<void> => {
      if (!req.user?.role) {
        res.status(403).json({
          success: false,
          error: "Role information not available",
          code: "ROLE_REQUIRED",
        });
        return;
      }

      const roleHierarchy = {
        [UserRole.SUPER_ADMIN]: 3,
        [UserRole.TENANT_ADMIN]: 2,
        [UserRole.USER]: 1,
      };

      if (roleHierarchy[req.user.role] < roleHierarchy[role]) {
        res.status(403).json({
          success: false,
          error: "Insufficient permissions",
          code: "INSUFFICIENT_PERMISSIONS",
        });
        return;
      }

      next();
    };
  };

  /**
   * Rate limiting middleware
   */
  rateLimit = (maxRequests: number, windowMs: number) => {
    const requests = new Map<string, { count: number; resetTime: number }>();

    return (req: Request, res: Response, next: NextFunction): void => {
      // Use multiple fallbacks for better identification
      const identifier =
        req.user?.id ||
        req.ip ||
        req.headers["x-forwarded-for"]?.toString() ||
        req.socket.remoteAddress ||
        "anonymous";

      const now = Date.now();
      const userRequests = requests.get(identifier);

      if (!userRequests || now > userRequests.resetTime) {
        requests.set(identifier, {
          count: 1,
          resetTime: now + windowMs,
        });
        next();
        return;
      }

      if (userRequests.count >= maxRequests) {
        res.status(429).json({
          success: false,
          error: "Too many requests",
          code: "RATE_LIMIT_EXCEEDED",
          retryAfter: Math.ceil((userRequests.resetTime - now) / 1000),
        });
        return;
      }

      userRequests.count++;
      next();
    };
  };
}

// ============================================================================
// CONVENIENCE EXPORTS
// ============================================================================

export function createAuthMiddleware(
  authService: AuthService,
  prisma: PrismaClient
) {
  const middleware = new AuthMiddleware(authService, prisma);

  return {
    authenticate: middleware.authenticate,
    optionalAuth: middleware.optionalAuth,
    requireTenantAccess: middleware.requireTenantAccess,
    requireRole: middleware.requireRole,
    rateLimit: middleware.rateLimit,
  };
}
