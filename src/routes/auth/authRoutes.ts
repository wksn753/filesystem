// src/routes/authRoutes.ts
import { Router } from "express";
import {
  AuthController,
  authErrorHandler,
} from "./AuthController";
import { AuthService } from "../../services/auth/AuthService";
import { createAuthMiddleware } from "../../middleware/auth";
import { PrismaClient } from "../../generated/prisma/client";

// ============================================================================
// ROUTES SETUP
// ============================================================================

export function setupAuthRoutes(
  authService: AuthService,
  prisma: PrismaClient,
  router: Router = Router()
): Router {
  const controller = new AuthController(authService);
  const { authenticate, rateLimit } = createAuthMiddleware(authService, prisma);

  // Rate limiting for auth endpoints
  const authRateLimit = rateLimit(5, 15 * 60 * 1000); // 5 requests per 15 minutes

  // ========================================================================
  // PUBLIC ROUTES (No authentication required)
  // ========================================================================

  /**
   * @route   POST /api/v1/auth/register
   * @desc    Register new user with email/password
   * @access  Public
   */
  router.post("/register", authRateLimit, controller.register);

  /**
   * @route   POST /api/v1/auth/login
   * @desc    Login with email/password
   * @access  Public
   */
  router.post("/login", authRateLimit, controller.login);

  /**
   * @route   POST /api/v1/auth/oauth/callback
   * @desc    Handle OAuth callback (Google, Microsoft, etc.)
   * @access  Public
   */
  router.post("/oauth/callback", controller.oauthCallback);

  /**
   * @route   POST /api/v1/auth/refresh
   * @desc    Refresh access token using refresh token
   * @access  Public
   */
  router.post("/refresh", controller.refreshToken);

  /**
   * @route   POST /api/v1/auth/password/reset-request
   * @desc    Request password reset email
   * @access  Public
   */
  router.post(
    "/password/reset-request",
    authRateLimit,
    controller.requestPasswordReset
  );

  /**
   * @route   POST /api/v1/auth/password/reset
   * @desc    Reset password with token
   * @access  Public
   */
  router.post("/password/reset", authRateLimit, controller.resetPassword);

  // ========================================================================
  // PROTECTED ROUTES (Authentication required)
  // ========================================================================

  /**
   * @route   GET /api/v1/auth/me
   * @desc    Get current user information
   * @access  Private
   */
  router.get("/me", authenticate, controller.getMe);

  /**
   * @route   POST /api/v1/auth/logout
   * @desc    Logout (invalidate session)
   * @access  Private
   */
  router.post("/logout", authenticate, controller.logout);

  /**
   * @route   POST /api/v1/auth/password/change
   * @desc    Change password (for authenticated users)
   * @access  Private
   */
  router.post("/password/change", authenticate, controller.changePassword);

  // ========================================================================
  // ERROR HANDLER (Must be last)
  // ========================================================================

  router.use(authErrorHandler);

  return router;
}

// ============================================================================
// DEPENDENCY INJECTION SETUP
// ============================================================================

export function initializeAuthModule(prisma: PrismaClient) {
  // Initialize Auth Service
  const authService = new AuthService(
    prisma,
    process.env.JWT_SECRET || "",
    process.env.JWT_EXPIRES_IN || "15m",
    parseInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS || "30")
  );

  // Setup routes
  const authRouter = setupAuthRoutes(authService, prisma);

  // Create middleware
  const authMiddleware = createAuthMiddleware(authService, prisma);

  return {
    authService,
    authRouter,
    authMiddleware,
  };
}
