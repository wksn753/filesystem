// src/services/tenantInvitation/TenantInvitationService.ts
import { Prisma, PrismaClient, UserRole } from "../../generated/prisma/client";
import crypto from "crypto";

export enum InvitationStatus {
  PENDING = "PENDING",
  ACCEPTED = "ACCEPTED",
  DECLINED = "DECLINED",
  EXPIRED = "EXPIRED",
  CANCELLED = "CANCELLED",
}

export enum JoinRequestStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  CANCELLED = "CANCELLED",
}

export interface MailService {
  sendMail(
    from: string,
    to: string,
    subject: string,
    htmlBody: string
  ): Promise<void>;
}

export interface CreateInvitationDto {
  tenantId: string;
  email: string;
  role: UserRole;
  invitedByUserId: string;
  permissions?: Record<string, any>;
  expiresInHours?: number;
  message?: string;
}

export interface CreateJoinRequestDto {
  tenantId: string;
  userId: string;
  message?: string;
}

export class TenantInvitationService {
  constructor(
    private prisma: PrismaClient,
    private mailService: MailService,
    private appUrl: string = process.env.APP_URL || "http://localhost:3000"
  ) {}

  // ========================================================================
  // INVITATIONS (Admin invites users)
  // ========================================================================

  /**
   * Create and send an invitation to join a tenant
   */
  async createInvitation(dto: CreateInvitationDto) {
    const {
      tenantId,
      email,
      role,
      invitedByUserId,
      permissions,
      expiresInHours = 168,
      message,
    } = dto;

    // Verify tenant exists
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    });

    if (!tenant) {
      throw new Error("Tenant not found");
    }

    // Verify inviter has permission
    const inviter = await this.prisma.tenantMember.findUnique({
      where: {
        userId_tenantId: { userId: invitedByUserId, tenantId },
      },
      include: {
        user: { select: { displayName: true, email: true } },
      },
    });

    if (!inviter || inviter.role !== UserRole.TENANT_ADMIN) {
      throw new Error("Only tenant admins can send invitations");
    }

    // Check if user already exists in tenant
    const invitedUser = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true },
    });

    if (invitedUser) {
      const existingMember = await this.prisma.tenantMember.findUnique({
        where: {
          userId_tenantId: { userId: invitedUser.id, tenantId },
        },
      });

      if (existingMember) {
        throw new Error("User is already a member of this tenant");
      }
    }

    // Check for existing pending invitation
    const existingInvitation = await this.prisma.tenantInvitation.findFirst({
      where: {
        tenantId,
        email: email.toLowerCase(),
        status: InvitationStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
    });

    if (existingInvitation) {
      throw new Error("A pending invitation already exists for this email");
    }

    // Generate secure token
    const token = this.generateSecureToken();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + expiresInHours);

    // Create invitation
    const invitation = await this.prisma.tenantInvitation.create({
      data: {
        tenantId,
        email: email.toLowerCase(),
        role,
        permissions: permissions || this.getDefaultPermissions(role),
        token,
        expiresAt,
        invitedBy: invitedByUserId,
        message,
        status: InvitationStatus.PENDING,
      },
      include: {
        tenant: { select: { name: true } },
        inviter: { select: { displayName: true } },
      },
    });

    // Send invitation email
    await this.sendInvitationEmail(invitation, inviter.user.displayName??"");

    return invitation;
  }

  /**
   * Accept an invitation
   */
  async acceptInvitation(token: string, userId: string) {
    const invitation = await this.prisma.tenantInvitation.findUnique({
      where: { token },
      include: { tenant: true },
    });

    if (!invitation) {
      throw new Error("Invitation not found");
    }

    if (invitation.status !== InvitationStatus.PENDING) {
      throw new Error(`Invitation is ${invitation.status.toLowerCase()}`);
    }

    if (invitation.expiresAt < new Date()) {
      await this.prisma.tenantInvitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.EXPIRED },
      });
      throw new Error("Invitation has expired");
    }

    // Verify user email matches invitation
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user || user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new Error("This invitation is for a different email address");
    }

    // Check if already a member
    const existingMember = await this.prisma.tenantMember.findUnique({
      where: {
        userId_tenantId: { userId, tenantId: invitation.tenantId },
      },
    });

    if (existingMember) {
      throw new Error("You are already a member of this tenant");
    }

    // Create membership and update invitation in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Create membership
      const membership = await tx.tenantMember.create({
        data: {
          userId,
          tenantId: invitation.tenantId,
          role: invitation.role,
          permissions: invitation.permissions??Prisma.DbNull,
        },
        include: {
          tenant: { select: { id: true, name: true, rootFolderId: true } },
          user: { select: { id: true, email: true, displayName: true } },
        },
      });

      // Update invitation status
      await tx.tenantInvitation.update({
        where: { id: invitation.id },
        data: {
          status: InvitationStatus.ACCEPTED,
          acceptedAt: new Date(),
          acceptedBy: userId,
        },
      });

      return membership;
    });

    return result;
  }

  /**
   * Decline an invitation
   */
  async declineInvitation(token: string, userId: string) {
    const invitation = await this.prisma.tenantInvitation.findUnique({
      where: { token },
    });

    if (!invitation) {
      throw new Error("Invitation not found");
    }

    if (invitation.status !== InvitationStatus.PENDING) {
      throw new Error(`Invitation is ${invitation.status.toLowerCase()}`);
    }

    // Verify user email matches invitation
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user || user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new Error("This invitation is for a different email address");
    }

    await this.prisma.tenantInvitation.update({
      where: { id: invitation.id },
      data: {
        status: InvitationStatus.DECLINED,
        declinedAt: new Date(),
      },
    });
  }

  /**
   * Cancel an invitation (admin only)
   */
  async cancelInvitation(invitationId: string, adminUserId: string) {
    const invitation = await this.prisma.tenantInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new Error("Invitation not found");
    }

    // Verify admin permission
    const admin = await this.prisma.tenantMember.findUnique({
      where: {
        userId_tenantId: {
          userId: adminUserId,
          tenantId: invitation.tenantId,
        },
      },
    });

    if (!admin || admin.role !== UserRole.TENANT_ADMIN) {
      throw new Error("Only tenant admins can cancel invitations");
    }

    if (invitation.status !== InvitationStatus.PENDING) {
      throw new Error("Only pending invitations can be cancelled");
    }

    await this.prisma.tenantInvitation.update({
      where: { id: invitationId },
      data: {
        status: InvitationStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });
  }

  /**
   * Get all invitations for a tenant
   */
  async getTenantInvitations(tenantId: string, adminUserId: string) {
    // Verify admin permission
    const admin = await this.prisma.tenantMember.findUnique({
      where: {
        userId_tenantId: { userId: adminUserId, tenantId },
      },
    });

    if (!admin || admin.role !== UserRole.TENANT_ADMIN) {
      throw new Error("Only tenant admins can view invitations");
    }

    return this.prisma.tenantInvitation.findMany({
      where: { tenantId },
      include: {
        inviter: {
          select: { displayName: true, email: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Get user's pending invitations
   */
  async getUserInvitations(userEmail: string) {
    return this.prisma.tenantInvitation.findMany({
      where: {
        email: userEmail.toLowerCase(),
        status: InvitationStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      include: {
        tenant: { select: { id: true, name: true } },
        inviter: { select: { displayName: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  // ========================================================================
  // JOIN REQUESTS (Users request to join)
  // ========================================================================

  /**
   * Create a join request
   */
  async createJoinRequest(dto: CreateJoinRequestDto) {
    const { tenantId, userId, message } = dto;

    // Verify tenant exists
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    });

    if (!tenant) {
      throw new Error("Tenant not found");
    }

    // Check if user is already a member
    const existingMember = await this.prisma.tenantMember.findUnique({
      where: {
        userId_tenantId: { userId, tenantId },
      },
    });

    if (existingMember) {
      throw new Error("You are already a member of this tenant");
    }

    // Check for existing pending request
    const existingRequest = await this.prisma.tenantJoinRequest.findFirst({
      where: {
        tenantId,
        userId,
        status: JoinRequestStatus.PENDING,
      },
    });

    if (existingRequest) {
      throw new Error(
        "You already have a pending join request for this tenant"
      );
    }

    // Create join request
    const joinRequest = await this.prisma.tenantJoinRequest.create({
      data: {
        tenantId,
        userId,
        message,
        status: JoinRequestStatus.PENDING,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            avatarUrl: true,
          },
        },
        tenant: { select: { name: true } },
      },
    });

    // Notify tenant admins
    await this.notifyAdminsOfJoinRequest(joinRequest);

    return joinRequest;
  }

  /**
   * Approve a join request
   */
  async approveJoinRequest(
    requestId: string,
    adminUserId: string,
    role: UserRole = UserRole.USER,
    permissions?: Record<string, any>
  ) {
    const request = await this.prisma.tenantJoinRequest.findUnique({
      where: { id: requestId },
      include: {
        user: { select: { email: true, displayName: true } },
        tenant: { select: { name: true } },
      },
    });

    if (!request) {
      throw new Error("Join request not found");
    }

    // Verify admin permission
    const admin = await this.prisma.tenantMember.findUnique({
      where: {
        userId_tenantId: {
          userId: adminUserId,
          tenantId: request.tenantId,
        },
      },
    });

    if (!admin || admin.role !== UserRole.TENANT_ADMIN) {
      throw new Error("Only tenant admins can approve join requests");
    }

    if (request.status !== JoinRequestStatus.PENDING) {
      throw new Error(`Join request is ${request.status.toLowerCase()}`);
    }

    // Check if user is already a member (race condition check)
    const existingMember = await this.prisma.tenantMember.findUnique({
      where: {
        userId_tenantId: {
          userId: request.userId,
          tenantId: request.tenantId,
        },
      },
    });

    if (existingMember) {
      throw new Error("User is already a member of this tenant");
    }

    // Create membership and update request in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Create membership
      const membership = await tx.tenantMember.create({
        data: {
          userId: request.userId,
          tenantId: request.tenantId,
          role,
          permissions: permissions || this.getDefaultPermissions(role),
        },
        include: {
          tenant: { select: { id: true, name: true, rootFolderId: true } },
          user: { select: { id: true, email: true, displayName: true } },
        },
      });

      // Update request status
      await tx.tenantJoinRequest.update({
        where: { id: requestId },
        data: {
          status: JoinRequestStatus.APPROVED,
          reviewedBy: adminUserId,
          reviewedAt: new Date(),
        },
      });

      return membership;
    });

    // Send approval email
    await this.sendJoinRequestApprovedEmail(
      request.user.email,
      request.tenant.name,
      role
    );

    return result;
  }

  /**
   * Reject a join request
   */
  async rejectJoinRequest(
    requestId: string,
    adminUserId: string,
    reason?: string
  ) {
    const request = await this.prisma.tenantJoinRequest.findUnique({
      where: { id: requestId },
      include: {
        user: { select: { email: true } },
        tenant: { select: { name: true } },
      },
    });

    if (!request) {
      throw new Error("Join request not found");
    }

    // Verify admin permission
    const admin = await this.prisma.tenantMember.findUnique({
      where: {
        userId_tenantId: {
          userId: adminUserId,
          tenantId: request.tenantId,
        },
      },
    });

    if (!admin || admin.role !== UserRole.TENANT_ADMIN) {
      throw new Error("Only tenant admins can reject join requests");
    }

    if (request.status !== JoinRequestStatus.PENDING) {
      throw new Error("Only pending requests can be rejected");
    }

    await this.prisma.tenantJoinRequest.update({
      where: { id: requestId },
      data: {
        status: JoinRequestStatus.REJECTED,
        reviewedBy: adminUserId,
        reviewedAt: new Date(),
        rejectionReason: reason,
      },
    });

    // Send rejection email
    if (reason) {
      await this.sendJoinRequestRejectedEmail(
        request.user.email,
        request.tenant.name,
        reason
      );
    }
  }

  /**
   * Cancel a join request (user cancels their own request)
   */
  async cancelJoinRequest(requestId: string, userId: string) {
    const request = await this.prisma.tenantJoinRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new Error("Join request not found");
    }

    if (request.userId !== userId) {
      throw new Error("You can only cancel your own join requests");
    }

    if (request.status !== JoinRequestStatus.PENDING) {
      throw new Error("Only pending requests can be cancelled");
    }

    await this.prisma.tenantJoinRequest.update({
      where: { id: requestId },
      data: {
        status: JoinRequestStatus.CANCELLED,
        reviewedAt: new Date(),
      },
    });
  }

  /**
   * Get all join requests for a tenant
   */
  async getTenantJoinRequests(tenantId: string, adminUserId: string) {
    // Verify admin permission
    const admin = await this.prisma.tenantMember.findUnique({
      where: {
        userId_tenantId: { userId: adminUserId, tenantId },
      },
    });

    if (!admin || admin.role !== UserRole.TENANT_ADMIN) {
      throw new Error("Only tenant admins can view join requests");
    }

    return this.prisma.tenantJoinRequest.findMany({
      where: { tenantId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            createdAt: true,
          },
        },
        reviewer: {
          select: { displayName: true, email: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Get user's join requests
   */
  async getUserJoinRequests(userId: string) {
    return this.prisma.tenantJoinRequest.findMany({
      where: { userId },
      include: {
        tenant: { select: { id: true, name: true } },
        reviewer: { select: { displayName: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  // ========================================================================
  // EMAIL NOTIFICATIONS
  // ========================================================================

  private async sendInvitationEmail(invitation: any, inviterName: string) {
    const acceptUrl = `${this.appUrl}/invitations/${invitation.token}/accept`;
    const declineUrl = `${this.appUrl}/invitations/${invitation.token}/decline`;

    const htmlBody = `
      <h2>You've been invited to join ${invitation.tenant.name}</h2>
      <p>${inviterName} has invited you to join their team on our platform.</p>
      ${
        invitation.message
          ? `<p><strong>Message:</strong> ${invitation.message}</p>`
          : ""
      }
      <p><strong>Role:</strong> ${invitation.role}</p>
      <p>This invitation expires on ${invitation.expiresAt.toLocaleDateString()}.</p>
      <p>
        <a href="${acceptUrl}" style="background: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Accept Invitation</a>
        <a href="${declineUrl}" style="background: #f44336; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-left: 10px;">Decline</a>
      </p>
    `;

    await this.mailService.sendMail(
      process.env.SMTP_FROM || "noreply@example.com",
      invitation.email,
      `Invitation to join ${invitation.tenant.name}`,
      htmlBody
    );
  }

  private async notifyAdminsOfJoinRequest(request: any) {
    // Get all tenant admins
    const admins = await this.prisma.tenantMember.findMany({
      where: {
        tenantId: request.tenantId,
        role: UserRole.TENANT_ADMIN,
      },
      include: {
        user: { select: { email: true } },
      },
    });

    const reviewUrl = `${this.appUrl}/tenants/${request.tenantId}/join-requests`;

    const htmlBody = `
      <h2>New join request for ${request.tenant.name}</h2>
      <p><strong>${request.user.displayName}</strong> (${
      request.user.email
    }) has requested to join your tenant.</p>
      ${
        request.message
          ? `<p><strong>Message:</strong> ${request.message}</p>`
          : ""
      }
      <p><a href="${reviewUrl}">Review Join Request</a></p>
    `;

    // Send email to all admins
    for (const admin of admins) {
      try {
        await this.mailService.sendMail(
          process.env.SMTP_FROM || "noreply@example.com",
          admin.user.email,
          `New join request for ${request.tenant.name}`,
          htmlBody
        );
      } catch (error) {
        console.error(`Failed to notify admin ${admin.user.email}:`, error);
      }
    }
  }

  private async sendJoinRequestApprovedEmail(
    userEmail: string,
    tenantName: string,
    role: UserRole
  ) {
    const htmlBody = `
      <h2>Your join request has been approved!</h2>
      <p>You've been accepted to join <strong>${tenantName}</strong> with the role of ${role}.</p>
      <p><a href="${this.appUrl}/tenants">Go to Dashboard</a></p>
    `;

    await this.mailService.sendMail(
      process.env.SMTP_FROM || "noreply@example.com",
      userEmail,
      `Join request approved for ${tenantName}`,
      htmlBody
    );
  }

  private async sendJoinRequestRejectedEmail(
    userEmail: string,
    tenantName: string,
    reason: string
  ) {
    const htmlBody = `
      <h2>Join request declined</h2>
      <p>Your request to join <strong>${tenantName}</strong> has been declined.</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
    `;

    await this.mailService.sendMail(
      process.env.SMTP_FROM || "noreply@example.com",
      userEmail,
      `Join request declined for ${tenantName}`,
      htmlBody
    );
  }

  // ========================================================================
  // UTILITIES
  // ========================================================================

  private generateSecureToken(length: number = 32): string {
    return crypto.randomBytes(length).toString("hex");
  }

  private getDefaultPermissions(role: UserRole): Record<string, any> {
    switch (role) {
      case UserRole.TENANT_ADMIN:
        return {
          canManageMembers: true,
          canManageFolders: true,
          canManageFiles: true,
          canDeleteTenant: true,
        };
      case UserRole.USER:
      default:
        return {
          canUploadFiles: true,
          canCreateFolders: true,
          canViewFiles: true,
        };
    }
  }

  /**
   * Clean up expired invitations (run as cron job)
   */
  async cleanupExpiredInvitations() {
    await this.prisma.tenantInvitation.updateMany({
      where: {
        status: InvitationStatus.PENDING,
        expiresAt: { lt: new Date() },
      },
      data: { status: InvitationStatus.EXPIRED },
    });
  }
}
