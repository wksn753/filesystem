// src/services/auth/OAuthService.ts
import axios from "axios";
import { AuthProvider } from "../../generated/prisma/client";

// ============================================================================
// TYPES
// ============================================================================

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
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

interface MicrosoftTokenResponse {
  token_type: string;
  scope: string;
  expires_in: number;
  access_token: string;
  refresh_token?: string;
  id_token: string;
}

interface MicrosoftUserInfo {
  id: string;
  userPrincipalName: string;
  mail: string;
  displayName: string;
  givenName: string;
  surname: string;
}

export interface OAuthUserData {
  provider: AuthProvider;
  providerAccountId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  idToken: string;
}

// ============================================================================
// OAUTH SERVICE
// ============================================================================

export class OAuthService {
  private googleClientId: string;
  private googleClientSecret: string;
  private googleRedirectUri: string;

  private microsoftClientId: string;
  private microsoftClientSecret: string;
  private microsoftRedirectUri: string;
  private microsoftTenantId: string;

  constructor() {
    this.googleClientId = process.env.GOOGLE_CLIENT_ID || "";
    this.googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
    this.googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || "";

    this.microsoftClientId = process.env.MICROSOFT_CLIENT_ID || "";
    this.microsoftClientSecret = process.env.MICROSOFT_CLIENT_SECRET || "";
    this.microsoftRedirectUri = process.env.MICROSOFT_REDIRECT_URI || "";
    this.microsoftTenantId = process.env.MICROSOFT_TENANT_ID || "common";
  }

  // ==========================================================================
  // GOOGLE OAUTH
  // ==========================================================================

  getGoogleAuthUrl(state?: string): string {
    const params = new URLSearchParams({
      client_id: this.googleClientId,
      redirect_uri: this.googleRedirectUri,
      response_type: "code",
      scope: "openid email profile",
      access_type: "offline",
      prompt: "consent",
      ...(state && { state }),
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async handleGoogleCallback(code: string): Promise<OAuthUserData> {
    // Exchange code for tokens
    const tokenResponse = await axios.post<GoogleTokenResponse>(
      "https://oauth2.googleapis.com/token",
      {
        code,
        client_id: this.googleClientId,
        client_secret: this.googleClientSecret,
        redirect_uri: this.googleRedirectUri,
        grant_type: "authorization_code",
      }
    );

    const { access_token, refresh_token, expires_in, id_token } =
      tokenResponse.data;

    // Get user info
    const userInfoResponse = await axios.get<GoogleUserInfo>(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    );

    const userInfo = userInfoResponse.data;

    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + expires_in);

    return {
      provider: AuthProvider.GOOGLE,
      providerAccountId: userInfo.id,
      email: userInfo.email,
      firstName: userInfo.given_name,
      lastName: userInfo.family_name,
      avatarUrl: userInfo.picture,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt,
      idToken: id_token,
    };
  }

  // ==========================================================================
  // MICROSOFT OAUTH
  // ==========================================================================

  getMicrosoftAuthUrl(state?: string): string {
    const params = new URLSearchParams({
      client_id: this.microsoftClientId,
      response_type: "code",
      redirect_uri: this.microsoftRedirectUri,
      response_mode: "query",
      scope: "openid email profile User.Read",
      ...(state && { state }),
    });

    return `https://login.microsoftonline.com/${
      this.microsoftTenantId
    }/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async handleMicrosoftCallback(code: string): Promise<OAuthUserData> {
    // Exchange code for tokens
    const tokenResponse = await axios.post<MicrosoftTokenResponse>(
      `https://login.microsoftonline.com/${this.microsoftTenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        code,
        client_id: this.microsoftClientId,
        client_secret: this.microsoftClientSecret,
        redirect_uri: this.microsoftRedirectUri,
        grant_type: "authorization_code",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token, refresh_token, expires_in, id_token } =
      tokenResponse.data;

    // Get user info from Microsoft Graph
    const userInfoResponse = await axios.get<MicrosoftUserInfo>(
      "https://graph.microsoft.com/v1.0/me",
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    );

    const userInfo = userInfoResponse.data;

    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + expires_in);

    return {
      provider: AuthProvider.MICROSOFT,
      providerAccountId: userInfo.id,
      email: userInfo.mail || userInfo.userPrincipalName,
      firstName: userInfo.givenName,
      lastName: userInfo.surname,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt,
      idToken: id_token,
    };
  }

  // ==========================================================================
  // GENERAL OAUTH HANDLER
  // ==========================================================================

  async handleOAuthCallback(
    provider: AuthProvider,
    code: string
  ): Promise<OAuthUserData> {
    switch (provider) {
      case AuthProvider.GOOGLE:
        return this.handleGoogleCallback(code);
      case AuthProvider.MICROSOFT:
        return this.handleMicrosoftCallback(code);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  getAuthUrl(provider: AuthProvider, state?: string): string {
    switch (provider) {
      case AuthProvider.GOOGLE:
        return this.getGoogleAuthUrl(state);
      case AuthProvider.MICROSOFT:
        return this.getMicrosoftAuthUrl(state);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}

