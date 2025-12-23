// src/services/auth/AuthService.ts
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { PrismaClient, AuthProvider, UserRole } from "../../generated/prisma/client";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface RegisterLocalUserDto {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

export interface LoginLocalUserDto {
  email: string;
  password: string;
}

export interface OAuthUserDto {
  email: string;
  provider: AuthProvider;
  providerAccountId: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  idToken?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface JwtPayload {
  userId: string;
  email: string;
  sessionId: string;
}

// ============================================================================
// CUSTOM ERRORS
// ============================================================================

export class AuthError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public code: string = "AUTH_ERROR"
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// ============================================================================
// AUTH SERVICE
// ============================================================================

export class AuthService {
  private prisma: PrismaClient;
  private jwtSecret: string;
  private jwtExpiresIn: string;
  private refreshTokenExpiresIn: number; // in days

  constructor(
    prisma: PrismaClient,
    jwtSecret: string = process.env.JWT_SECRET || "your-secret-key",
    jwtExpiresIn: string = "15m",
    refreshTokenExpiresIn: number = 30
  ) {
    this.prisma = prisma;
    this.jwtSecret = jwtSecret;
    this.jwtExpiresIn = jwtExpiresIn;
    this.refreshTokenExpiresIn = refreshTokenExpiresIn;
  }

  // ==========================================================================
  // LOCAL AUTH (Email/Password)
  // ==========================================================================

  async registerLocal(
    dto: RegisterLocalUserDto,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ user: any; tokens: AuthTokens }> {
    // Validate email
    if (!this.isValidEmail(dto.email)) {
      throw new AuthError("Invalid email format", 400, "INVALID_EMAIL");
    }

    // Validate password strength
    if (!this.isStrongPassword(dto.password)) {
      throw new AuthError(
        "Password must be at least 8 characters with uppercase, lowercase, number, and special character",
        400,
        "WEAK_PASSWORD"
      );
    }

    // Check if user exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (existingUser) {
      throw new AuthError("Email already registered", 409, "EMAIL_EXISTS");
    }

    // Hash password
    const passwordHash = await bcrypt.hash(dto.password, 12);

    // Create user
    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        displayName: dto.firstName
          ? `${dto.firstName} ${dto.lastName || ""}`.trim()
          : dto.email.split("@")[0],
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        displayName: true,
        avatarUrl: true,
        createdAt: true,
      },
    });

    // Create session and generate tokens
    const tokens = await this.createSession(user.id, ipAddress, userAgent);

    return { user, tokens };
  }

  async loginLocal(
    dto: LoginLocalUserDto,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ user: any; tokens: AuthTokens }> {
    // Find user
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      include: {
        accounts: true,
      },
    });

    if (!user) {
      throw new AuthError("Invalid credentials", 401, "INVALID_CREDENTIALS");
    }

    // Check if user registered with OAuth
    if (!user.passwordHash) {
      const providers = user.accounts.map((acc) => acc.provider).join(", ");
      throw new AuthError(
        `This account uses ${providers}. Please sign in with ${providers}.`,
        400,
        "OAUTH_ACCOUNT"
      );
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(
      dto.password,
      user.passwordHash
    );

    if (!isValidPassword) {
      throw new AuthError("Invalid credentials", 401, "INVALID_CREDENTIALS");
    }

    // Check if account is active
    if (user.isSuspended) {
      throw new AuthError("Account is suspended", 403, "ACCOUNT_SUSPENDED");
    }

    if (!user.isActive) {
      throw new AuthError("Account is not active", 403, "ACCOUNT_INACTIVE");
    }

    // Update last login
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Create session and generate tokens
    const tokens = await this.createSession(user.id, ipAddress, userAgent);

    const { passwordHash, ...userWithoutPassword } = user;

    return { user: userWithoutPassword, tokens };
  }

  // ==========================================================================
  // OAUTH
  // ==========================================================================

  async handleOAuthCallback(
    dto: OAuthUserDto,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ user: any; tokens: AuthTokens; isNewUser: boolean }> {
    let isNewUser = false;

    // Check if account already exists
    const existingAccount = await this.prisma.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: dto.provider,
          providerAccountId: dto.providerAccountId,
        },
      },
      include: {
        user: true,
      },
    });

    let user;

    if (existingAccount) {
      // Update OAuth tokens
      await this.prisma.account.update({
        where: { id: existingAccount.id },
        data: {
          accessToken: dto.accessToken,
          refreshToken: dto.refreshToken,
          expiresAt: dto.expiresAt,
          idToken: dto.idToken,
          updatedAt: new Date(),
        },
      });

      user = existingAccount.user;

      // Update last login
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
    } else {
      // Check if user exists with this email
      const existingUser = await this.prisma.user.findUnique({
        where: { email: dto.email.toLowerCase() },
      });

      if (existingUser) {
        // Link OAuth account to existing user
        await this.prisma.account.create({
          data: {
            userId: existingUser.id,
            provider: dto.provider,
            providerAccountId: dto.providerAccountId,
            accessToken: dto.accessToken,
            refreshToken: dto.refreshToken,
            expiresAt: dto.expiresAt,
            idToken: dto.idToken,
          },
        });

        user = existingUser;
      } else {
        // Create new user with OAuth account
        isNewUser = true;
        user = await this.prisma.user.create({
          data: {
            email: dto.email.toLowerCase(),
            firstName: dto.firstName,
            lastName: dto.lastName,
            displayName: dto.firstName
              ? `${dto.firstName} ${dto.lastName || ""}`.trim()
              : dto.email.split("@")[0],
            avatarUrl: dto.avatarUrl,
            emailVerified: new Date(), // OAuth emails are pre-verified
            accounts: {
              create: {
                provider: dto.provider,
                providerAccountId: dto.providerAccountId,
                accessToken: dto.accessToken,
                refreshToken: dto.refreshToken,
                expiresAt: dto.expiresAt,
                idToken: dto.idToken,
              },
            },
          },
        });
      }

      // Update last login
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
    }

    // Create session and generate tokens
    const tokens = await this.createSession(user.id, ipAddress, userAgent);

    const { passwordHash, ...userWithoutPassword } = user;

    return { user: userWithoutPassword, tokens, isNewUser };
  }

  // ==========================================================================
  // TOKEN MANAGEMENT
  // ==========================================================================

  async createSession(
    userId: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<AuthTokens> {
    // Generate session token
    const sessionToken = this.generateSecureToken();

    // Calculate expiry (e.g., 7 days)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Create session
    const session = await this.prisma.session.create({
      data: {
        userId,
        token: sessionToken,
        expiresAt,
        ipAddress,
        userAgent,
      },
    });

    // Generate JWT access token
    const accessToken = this.generateAccessToken({
      userId,
      email: "",
      sessionId: session.id,
    });

    // Generate refresh token
    const refreshToken = await this.createRefreshToken(
      userId,
      ipAddress,
      userAgent
    );

    return { accessToken, refreshToken };
  }

  generateAccessToken(payload: JwtPayload): string {
    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.jwtExpiresIn,
    } as jwt.SignOptions);
  }

  async createRefreshToken(
    userId: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<string> {
    const token = this.generateSecureToken(64);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.refreshTokenExpiresIn);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        token,
        expiresAt,
        ipAddress,
        userAgent,
      },
    });

    return token;
  }

  async refreshTokens(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<AuthTokens> {
    // Find refresh token
    const tokenRecord = await this.prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    });

    if (!tokenRecord) {
      throw new AuthError("Invalid refresh token", 401, "INVALID_TOKEN");
    }

    if (tokenRecord.isRevoked) {
      throw new AuthError("Token has been revoked", 401, "TOKEN_REVOKED");
    }

    if (tokenRecord.expiresAt < new Date()) {
      throw new AuthError("Token has expired", 401, "TOKEN_EXPIRED");
    }

    // Revoke old refresh token
    await this.prisma.refreshToken.update({
      where: { id: tokenRecord.id },
      data: { isRevoked: true, revokedAt: new Date() },
    });

    // Create new session and tokens
    return this.createSession(tokenRecord.userId, ipAddress, userAgent);
  }

  verifyAccessToken(token: string): JwtPayload {
    try {
      return jwt.verify(token, this.jwtSecret) as JwtPayload;
    } catch (error) {
      throw new AuthError("Invalid or expired token", 401, "INVALID_TOKEN");
    }
  }

  // ==========================================================================
  // PASSWORD RESET
  // ==========================================================================

  async requestPasswordReset(email: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      // Don't reveal if user exists
      return "If the email exists, a reset link has been sent";
    }

    // Check if user has password (not OAuth-only)
    if (!user.passwordHash) {
      throw new AuthError(
        "This account uses social login. Password reset is not available.",
        400,
        "OAUTH_ACCOUNT"
      );
    }

    // Generate reset token
    const token = this.generateSecureToken(32);
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1); // 1 hour expiry

    await this.prisma.passwordReset.create({
      data: {
        userId: user.id,
        token,
        expiresAt,
      },
    });

    // In production, send email here
    // await emailService.sendPasswordResetEmail(user.email, token);

    return token; // Return token for testing; in production, return success message
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    // Find reset token
    const resetRecord = await this.prisma.passwordReset.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!resetRecord) {
      throw new AuthError("Invalid reset token", 400, "INVALID_TOKEN");
    }

    if (resetRecord.isUsed) {
      throw new AuthError("Token already used", 400, "TOKEN_USED");
    }

    if (resetRecord.expiresAt < new Date()) {
      throw new AuthError("Token has expired", 400, "TOKEN_EXPIRED");
    }

    // Validate new password
    if (!this.isStrongPassword(newPassword)) {
      throw new AuthError(
        "Password must be at least 8 characters with uppercase, lowercase, number, and special character",
        400,
        "WEAK_PASSWORD"
      );
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update password
    await this.prisma.user.update({
      where: { id: resetRecord.userId },
      data: { passwordHash },
    });

    // Mark token as used
    await this.prisma.passwordReset.update({
      where: { id: resetRecord.id },
      data: { isUsed: true, usedAt: new Date() },
    });

    // Revoke all refresh tokens for security
    await this.prisma.refreshToken.updateMany({
      where: { userId: resetRecord.userId },
      data: { isRevoked: true, revokedAt: new Date() },
    });
  }

  // ==========================================================================
  // LOGOUT
  // ==========================================================================

  async logout(userId: string, sessionId?: string): Promise<void> {
    if (sessionId) {
      // Logout from specific session
      await this.prisma.session.delete({
        where: { id: sessionId },
      });
    } else {
      // Logout from all sessions
      await this.prisma.session.deleteMany({
        where: { userId },
      });
    }
  }

  async revokeRefreshToken(token: string): Promise<void> {
    await this.prisma.refreshToken.update({
      where: { token },
      data: { isRevoked: true, revokedAt: new Date() },
    });
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  private generateSecureToken(length: number = 32): string {
    return crypto.randomBytes(length).toString("hex");
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private isStrongPassword(password: string): boolean {
    // At least 8 chars, 1 uppercase, 1 lowercase, 1 number, 1 special char
    const passwordRegex =
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    return passwordRegex.test(password);
  }
}
