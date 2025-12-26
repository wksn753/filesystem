// src/controllers/GoogleOAuthController.ts

import { Request, Response, NextFunction } from "express";
import { AuthService } from "../../services/auth/AuthService";
import { AuthProvider } from "../../generated/prisma/client";
import fetch from "node-fetch";

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token: string;
}

interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name: string;
  family_name: string;
  picture: string;
}

export class GoogleOAuthController {
  private authService: AuthService;
  private readonly tokenUrl = "https://oauth2.googleapis.com/token";
  private readonly userInfoUrl =
    "https://www.googleapis.com/oauth2/v2/userinfo";

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  /**
   * Exchange Google authorization code for tokens and authenticate user
   * POST /api/v1/auth/google/callback
   */
  handleCallback = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { code } = req.body;

      if (!code) {
        res.status(400).json({
          success: false,
          error: "Authorization code is required",
          code: "MISSING_CODE",
        });
        return;
      }

      // Exchange code for tokens
      const tokens = await this.exchangeCodeForToken(code);

      // Get user info from Google
      const googleUser = await this.getUserInfo(tokens.access_token);

      // Validate email is verified
      if (!googleUser.verified_email) {
        res.status(400).json({
          success: false,
          error: "Email not verified with Google",
          code: "EMAIL_NOT_VERIFIED",
        });
        return;
      }

      // Handle OAuth callback through AuthService
      const result = await this.authService.handleOAuthCallback(
        {
          provider: AuthProvider.GOOGLE,
          providerAccountId: googleUser.id,
          email: googleUser.email,
          firstName: googleUser.given_name,
          lastName: googleUser.family_name,
          avatarUrl: googleUser.picture,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          idToken: tokens.id_token,
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
   * Exchange authorization code for access token
   */
  private async exchangeCodeForToken(
  code: string
): Promise<GoogleTokenResponse> {
  const response = await fetch(this.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      redirect_uri: `${process.env.FRONTEND_URL}/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    let errorBody;
    try {
      errorBody = await response.json();
    } catch (e) {
      errorBody = { message: "Unknown error" };
    }

    console.error("Google token exchange failed:", errorBody);
    throw new Error(
      `Failed to exchange code: ${JSON.stringify(errorBody)}`
    );
  }

  const tokens = (await response.json()) as GoogleTokenResponse;

  // Optional: log tokens for debugging
  console.log("Google tokens received:", tokens);

  return tokens;
}


  /**
   * Get user information from Google
   */
  private async getUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const response = await fetch(this.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error("Failed to fetch user info from Google");
    }

    return response.json() as Promise<GoogleUserInfo>;
  }
}
