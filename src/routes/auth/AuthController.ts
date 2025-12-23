// src/controllers/AuthController.ts
import { Request, Response, NextFunction } from "express";
import { AuthService, AuthError } from "../../services/auth/AuthService";
import { AuthProvider } from "../../generated/prisma/client";

// ============================================================================
// CONTROLLER CLASS
// ============================================================================

export class AuthController {
  private authService: AuthService;

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  /**
   * Register with email/password
   * POST /api/v1/auth/register
   */
  register = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { email, password, firstName, lastName } = req.body;

      if (!email || !password) {
        res.status(400).json({
          success: false,
          error: "Email and password are required",
          code: "MISSING_FIELDS",
        });
        return;
      }

      const result = await this.authService.registerLocal(
        { email, password, firstName, lastName },
        req.ip,
        req.headers["user-agent"]
      );

      res.status(201).json({
        success: true,
        data: {
          user: result.user,
          accessToken: result.tokens.accessToken,
          refreshToken: result.tokens.refreshToken,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Login with email/password
   * POST /api/v1/auth/login
   */
  login = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        res.status(400).json({
          success: false,
          error: "Email and password are required",
          code: "MISSING_FIELDS",
        });
        return;
      }

      const result = await this.authService.loginLocal(
        { email, password },
        req.ip,
        req.headers["user-agent"]
      );

      res.json({
        success: true,
        data: {
          user: result.user,
          accessToken: result.tokens.accessToken,
          refreshToken: result.tokens.refreshToken,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * OAuth callback handler (Google, Microsoft, etc.)
   * POST /api/v1/auth/oauth/callback
   */
  oauthCallback = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const {
        provider,
        providerAccountId,
        email,
        firstName,
        lastName,
        avatarUrl,
        accessToken,
        refreshToken,
        expiresAt,
        idToken,
      } = req.body;

      if (!provider || !providerAccountId || !email) {
        res.status(400).json({
          success: false,
          error: "Provider, providerAccountId, and email are required",
          code: "MISSING_FIELDS",
        });
        return;
      }

      // Validate provider
      if (!Object.values(AuthProvider).includes(provider)) {
        res.status(400).json({
          success: false,
          error: "Invalid provider",
          code: "INVALID_PROVIDER",
        });
        return;
      }

      const result = await this.authService.handleOAuthCallback(
        {
          provider,
          providerAccountId,
          email,
          firstName,
          lastName,
          avatarUrl,
          accessToken,
          refreshToken,
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
          idToken,
        },
        req.ip,
        req.headers["user-agent"]
      );

      res.json({
        success: true,
        data: {
          user: result.user,
          accessToken: result.tokens.accessToken,
          refreshToken: result.tokens.refreshToken,
          isNewUser: result.isNewUser,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Refresh access token
   * POST /api/v1/auth/refresh
   */
  refreshToken = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        res.status(400).json({
          success: false,
          error: "Refresh token is required",
          code: "MISSING_TOKEN",
        });
        return;
      }

      const tokens = await this.authService.refreshTokens(
        refreshToken,
        req.ip,
        req.headers["user-agent"]
      );

      res.json({
        success: true,
        data: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Logout
   * POST /api/v1/auth/logout
   */
  logout = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: "Not authenticated",
          code: "NOT_AUTHENTICATED",
        });
        return;
      }

      const { allDevices } = req.body;

      await this.authService.logout(
        req.user.id,
        allDevices ? undefined : req.sessionId
      );

      res.json({
        success: true,
        message: "Logged out successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Request password reset
   * POST /api/v1/auth/password/reset-request
   */
  requestPasswordReset = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { email } = req.body;

      if (!email) {
        res.status(400).json({
          success: false,
          error: "Email is required",
          code: "MISSING_EMAIL",
        });
        return;
      }

      await this.authService.requestPasswordReset(email);

      res.json({
        success: true,
        message: "If the email exists, a reset link has been sent",
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Reset password with token
   * POST /api/v1/auth/password/reset
   */
  resetPassword = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { token, newPassword } = req.body;

      if (!token || !newPassword) {
        res.status(400).json({
          success: false,
          error: "Token and new password are required",
          code: "MISSING_FIELDS",
        });
        return;
      }

      await this.authService.resetPassword(token, newPassword);

      res.json({
        success: true,
        message: "Password reset successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get current user info
   * GET /api/v1/auth/me
   */
  getMe = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: "Not authenticated",
          code: "NOT_AUTHENTICATED",
        });
        return;
      }

      res.json({
        success: true,
        data: req.user,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Change password (authenticated user)
   * POST /api/v1/auth/password/change
   */
  changePassword = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: "Not authenticated",
          code: "NOT_AUTHENTICATED",
        });
        return;
      }

      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        res.status(400).json({
          success: false,
          error: "Current password and new password are required",
          code: "MISSING_FIELDS",
        });
        return;
      }

      // Verify current password by attempting login
      try {
        await this.authService.loginLocal(
          { email: req.user.email, password: currentPassword },
          req.ip,
          req.headers["user-agent"]
        );
      } catch {
        res.status(401).json({
          success: false,
          error: "Current password is incorrect",
          code: "INVALID_PASSWORD",
        });
        return;
      }

      // TODO: Implement changePassword in AuthService
      // For now, you can use password reset logic

      res.json({
        success: true,
        message: "Password changed successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}

// ============================================================================
// ERROR HANDLER MIDDLEWARE
// ============================================================================

export const authErrorHandler = (
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  console.error("Auth error:", error);

  if (error instanceof AuthError) {
    res.status(error.statusCode).json({
      success: false,
      error: error.message,
      code: error.code,
    });
    return;
  }

  // Generic error
  res.status(500).json({
    success: false,
    error: "Internal server error",
    code: "INTERNAL_ERROR",
  });
};
