// src/routes/authRoutes.ts
import { Router } from "express";
import { AuthController, authErrorHandler } from "./AuthController";
import { AuthService } from "../../services/auth/AuthService";
import { createAuthMiddleware } from "../../middleware/auth";
import { PrismaClient } from "../../generated/prisma/client";
import { GoogleOAuthController } from "../../controllers/auth/Oauth.controller";

// ============================================================================
// ROUTES SETUP
// ============================================================================

export function setupAuthRoutes(
  authService: AuthService,
  prisma: PrismaClient,
  router: Router = Router()
): Router {
  const controller = new AuthController(authService);
  const googleOAuthController = new GoogleOAuthController(authService);
  const { authenticate, rateLimit } = createAuthMiddleware(authService, prisma);

  // Rate limiting for auth endpoints
  const authRateLimit = rateLimit(5, 15 * 60 * 1000); // 5 requests per 15 minutes

  // ========================================================================
  // PUBLIC ROUTES (No authentication required)
  // ========================================================================

  /**
   * @swagger
   * /api/v1/auth/register:
   *   post:
   *     tags:
   *       - Authentication
   *     summary: Register a new user
   *     description: Register a new user with email and password
   *     parameters:
   *       - in: body
   *         name: user
   *         description: User registration data
   *         required: true
   *         schema:
   *           type: object
   *           required:
   *             - email
   *             - password
   *           properties:
   *             email:
   *               type: string
   *               format: email
   *               example: user@example.com
   *             password:
   *               type: string
   *               minLength: 6
   *               example: password123
   *             firstName:
   *               type: string
   *               example: John
   *             lastName:
   *               type: string
   *               example: Doe
   *     responses:
   *       201:
   *         description: User registered successfully
   *         schema:
   *           type: object
   *           properties:
   *             success:
   *               type: boolean
   *               example: true
   *             data:
   *               type: object
   *               properties:
   *                 user:
   *                   $ref: '#/definitions/User'
   *                 accessToken:
   *                   type: string
   *                   example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   *                 refreshToken:
   *                   type: string
   *                   example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   *       400:
   *         description: Bad request
   *         schema:
   *           type: object
   *           properties:
   *             success:
   *               type: boolean
   *               example: false
   *             error:
   *               type: string
   *               example: Email and password are required
   *             code:
   *               type: string
   *               example: MISSING_FIELDS
   */
  router.post("/register", authRateLimit, controller.register);

  /**
   * Login user
   * @swagger
   * /api/v1/auth/login:
   *   post:
   *     tags:
   *       - Authentication
   *     summary: Login user
   *     description: Login with email and password
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - email
   *               - password
   *             properties:
   *               email:
   *                 type: string
   *                 format: email
   *                 example: user@example.com
   *               password:
   *                 type: string
   *                 minLength: 6
   *                 example: password123
   *     responses:
   *       200:
   *         description: Login successful
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *                 data:
   *                   type: object
   *                   properties:
   *                     user:
   *                       $ref: '#/components/schemas/User'
   *                     accessToken:
   *                       type: string
   *                       example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   *                     refreshToken:
   *                       type: string
   *                       example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   *       400:
   *         description: Bad request
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: false
   *                 error:
   *                   type: string
   *                   example: Email and password are required
   *                 code:
   *                   type: string
   *                   example: MISSING_FIELDS
   *       401:
   *         description: Invalid credentials
   */
  router.post("/login", authRateLimit, controller.login);

  /**
   * OAuth callback
   * @swagger
   * /api/v1/auth/oauth/callback:
   *   post:
   *     tags:
   *       - Authentication
   *     summary: Handle OAuth callback
   *     description: Handle OAuth callback from providers like Google, Microsoft, etc.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - provider
   *               - providerAccountId
   *               - email
   *             properties:
   *               provider:
   *                 type: string
   *                 enum: [google, microsoft, github]
   *                 example: google
   *               providerAccountId:
   *                 type: string
   *                 example: 123456789
   *               email:
   *                 type: string
   *                 format: email
   *                 example: user@example.com
   *               firstName:
   *                 type: string
   *                 example: John
   *               lastName:
   *                 type: string
   *                 example: Doe
   *               avatarUrl:
   *                 type: string
   *                 format: uri
   *                 example: https://example.com/avatar.jpg
   *               accessToken:
   *                 type: string
   *                 example: ya29.a0AfH6SMC...
   *               refreshToken:
   *                 type: string
   *                 example: 1//0g...
   *               expiresAt:
   *                 type: string
   *                 format: date-time
   *                 example: 2024-12-23T10:00:00Z
   *               idToken:
   *                 type: string
   *                 example: eyJhbGciOiJSUzI1NiIsImtpZCI6...
   *     responses:
   *       200:
   *         description: OAuth callback processed successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *                 data:
   *                   type: object
   *                   properties:
   *                     user:
   *                       $ref: '#/components/schemas/User'
   *                     accessToken:
   *                       type: string
   *                       example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   *                     refreshToken:
   *                       type: string
   *                       example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   *                     isNewUser:
   *                       type: boolean
   *                       example: true
   *       400:
   *         description: Bad request
   */
  router.post("/oauth/callback", controller.oauthCallback);

  /**
   * Refresh access token
   * @swagger
   * /api/v1/auth/refresh:
   *   post:
   *     tags:
   *       - Authentication
   *     summary: Refresh access token
   *     description: Refresh access token using refresh token
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - refreshToken
   *             properties:
   *               refreshToken:
   *                 type: string
   *                 example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   *     responses:
   *       200:
   *         description: Token refreshed successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *                 data:
   *                   type: object
   *                   properties:
   *                     accessToken:
   *                       type: string
   *                       example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   *                     refreshToken:
   *                       type: string
   *                       example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   *       400:
   *         description: Bad request
   *       401:
   *         description: Invalid refresh token
   */
  router.post("/refresh", controller.refreshToken);

  /**
   * Request password reset
   * @swagger
   * /api/v1/auth/password/reset-request:
   *   post:
   *     tags:
   *       - Authentication
   *     summary: Request password reset
   *     description: Send password reset email to user
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - email
   *             properties:
   *               email:
   *                 type: string
   *                 format: email
   *                 example: user@example.com
   *     responses:
   *       200:
   *         description: Password reset email sent
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *                 message:
   *                   type: string
   *                   example: If the email exists, a reset link has been sent
   *       400:
   *         description: Bad request
   */
  router.post(
    "/password/reset-request",
    authRateLimit,
    controller.requestPasswordReset
  );

  /**
   * Reset password
   * @swagger
   * /api/v1/auth/password/reset:
   *   post:
   *     tags:
   *       - Authentication
   *     summary: Reset password with token
   *     description: Reset password using reset token
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - token
   *               - newPassword
   *             properties:
   *               token:
   *                 type: string
   *                 example: abc123def456
   *               newPassword:
   *                 type: string
   *                 minLength: 6
   *                 example: newpassword123
   *     responses:
   *       200:
   *         description: Password reset successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *                 message:
   *                   type: string
   *                   example: Password reset successfully
   *       400:
   *         description: Bad request
   *       401:
   *         description: Invalid or expired token
   */
  router.post("/password/reset", authRateLimit, controller.resetPassword);

  // ========================================================================
  // PROTECTED ROUTES (Authentication required)
  // ========================================================================

  /**
   * Get current user
   * @swagger
   * /api/v1/auth/me:
   *   get:
   *     tags:
   *       - Authentication
   *     summary: Get current user information
   *     description: Get information about the currently authenticated user
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: User information retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *                 data:
   *                   $ref: '#/components/schemas/User'
   *       401:
   *         description: Not authenticated
   */
  router.get("/me", authenticate, controller.getMe);

  /**
   * Logout user
   * @swagger
   * /api/v1/auth/logout:
   *   post:
   *     tags:
   *       - Authentication
   *     summary: Logout user
   *     description: Logout the current user and invalidate their session
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               allDevices:
   *                 type: boolean
   *                 description: Whether to logout from all devices
   *                 example: false
   *     responses:
   *       200:
   *         description: Logout successful
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *                 message:
   *                   type: string
   *                   example: Logged out successfully
   *       401:
   *         description: Not authenticated
   */
  router.post("/logout", authenticate, controller.logout);

  /**
   * Change password
   * @swagger
   * /api/v1/auth/password/change:
   *   post:
   *     tags:
   *       - Authentication
   *     summary: Change password
   *     description: Change the password for the authenticated user
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - currentPassword
   *               - newPassword
   *             properties:
   *               currentPassword:
   *                 type: string
   *                 example: oldpassword123
   *               newPassword:
   *                 type: string
   *                 minLength: 6
   *                 example: newpassword123
   *     responses:
   *       200:
   *         description: Password changed successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *                 message:
   *                   type: string
   *                   example: Password changed successfully
   *       400:
   *         description: Bad request
   *       401:
   *         description: Not authenticated or invalid current password
   */
  router.post("/password/change", authenticate, controller.changePassword);

  router.post("/google/callback", googleOAuthController.handleCallback);
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
