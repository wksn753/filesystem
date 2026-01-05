// src/routes/tenantInvitationRoutes.ts
import { Router, Request, Response } from "express";
import { PrismaClient, UserRole } from "../../generated/prisma/client";
import { createAuthMiddleware } from "../../middleware/auth";
import { AuthService } from "../../services/auth/AuthService";
import {
  TenantInvitationService,
  MailService,
} from "../../services/tenants/tenantInvitation.service";

const router = Router();

export function setupTenantInvitationRoutes(
  authService: AuthService,
  prismaClient: PrismaClient,
  mailService: MailService
) {
  const { authenticate, requireTenantAccess } = createAuthMiddleware(
    authService,
    prismaClient
  );

  const invitationService = new TenantInvitationService(
    prismaClient,
    mailService
  );

  // ========================================================================
  // INVITATION ENDPOINTS (Admin invites users)
  // ========================================================================

  /**
   * POST /tenants/invitations/:tenantId
   * Create an invitation to join a tenant (TENANT_ADMIN only)
   * Body: { email: string, role: UserRole, message?: string, permissions?: object }
   */
  router.post(
    "/:tenantId",
    authenticate,
    requireTenantAccess(UserRole.TENANT_ADMIN),
    async (req: Request, res: Response) => {
      try {
        const { tenantId } = req.params;
        const { email, role, message, permissions } = req.body;

        // Validation
        if (!email || typeof email !== "string") {
          return res.status(400).json({
            success: false,
            message: "Email is required",
          });
        }

        if (!role || !Object.values(UserRole).includes(role)) {
          return res.status(400).json({
            success: false,
            message: "Valid role is required",
          });
        }

        const invitation = await invitationService.createInvitation({
          tenantId,
          email,
          role,
          invitedByUserId: req.user!.id,
          permissions,
          message,
        });

        return res.status(201).json({
          success: true,
          message: "Invitation sent successfully",
          data: invitation,
        });
      } catch (error) {
        console.error("Error creating invitation:", error);
        return res.status(500).json({
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Failed to create invitation",
        });
      }
    }
  );

  /**
   * GET /tenants/:tenantId
   * Get all invitations for a tenant (TENANT_ADMIN only)
   */
  router.get(
    "/:tenantId",
    authenticate,
    requireTenantAccess(UserRole.TENANT_ADMIN),
    async (req: Request, res: Response) => {
      try {
        const { tenantId } = req.params;

        const invitations = await invitationService.getTenantInvitations(
          tenantId,
          req.user!.id
        );

        return res.status(200).json({
          success: true,
          data: invitations,
        });
      } catch (error) {
        console.error("Error fetching invitations:", error);
        return res.status(500).json({
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Failed to fetch invitations",
        });
      }
    }
  );

  /**
   * DELETE /tenants/:tenantId/:invitationId
   * Cancel an invitation (TENANT_ADMIN only)
   */
  router.delete(
    "/:tenantId/:invitationId",
    authenticate,
    requireTenantAccess(UserRole.TENANT_ADMIN),
    async (req: Request, res: Response) => {
      try {
        const { invitationId } = req.params;

        await invitationService.cancelInvitation(invitationId, req.user!.id);

        return res.status(200).json({
          success: true,
          message: "Invitation cancelled successfully",
        });
      } catch (error) {
        console.error("Error cancelling invitation:", error);
        return res.status(500).json({
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Failed to cancel invitation",
        });
      }
    }
  );

  /**
   * GET /me
   * Get current user's pending invitations
   */
  router.get(
    "/me",
    authenticate,
    async (req: Request, res: Response) => {
      try {
        const user = await prismaClient.user.findUnique({
          where: { id: req.user!.id },
          select: { email: true },
        });

        if (!user) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        const invitations = await invitationService.getUserInvitations(
          user.email
        );

        return res.status(200).json({
          success: true,
          data: invitations,
        });
      } catch (error) {
        console.error("Error fetching user invitations:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to fetch invitations",
        });
      }
    }
  );

  /**
   * POST /:token/accept
   * Accept an invitation
   */
  router.post(
    "/:token/accept",
    authenticate,
    async (req: Request, res: Response) => {
      try {
        const { token } = req.params;

        const membership = await invitationService.acceptInvitation(
          token,
          req.user!.id
        );

        return res.status(200).json({
          success: true,
          message: `Successfully joined ${membership.tenant.name}`,
          data: membership,
        });
      } catch (error) {
        console.error("Error accepting invitation:", error);
        return res.status(500).json({
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Failed to accept invitation",
        });
      }
    }
  );

  /**
   * POST /:token/decline
   * Decline an invitation
   */
  router.post(
    "/:token/decline",
    authenticate,
    async (req: Request, res: Response) => {
      try {
        const { token } = req.params;

        await invitationService.declineInvitation(token, req.user!.id);

        return res.status(200).json({
          success: true,
          message: "Invitation declined",
        });
      } catch (error) {
        console.error("Error declining invitation:", error);
        return res.status(500).json({
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Failed to decline invitation",
        });
      }
    }
  );

  // ========================================================================
  // JOIN REQUEST ENDPOINTS (Users request to join)
  // ========================================================================

  /**
   * POST /tenants/:tenantId/join-requests
   * Request to join a tenant
   * Body: { message?: string }
   */
  router.post(
    "/:tenantId/join-requests",
    authenticate,
    async (req: Request, res: Response) => {
      try {
        const { tenantId } = req.params;
        const { message } = req.body;

        const joinRequest = await invitationService.createJoinRequest({
          tenantId,
          userId: req.user!.id,
          message,
        });

        return res.status(201).json({
          success: true,
          message: "Join request submitted successfully",
          data: joinRequest,
        });
      } catch (error) {
        console.error("Error creating join request:", error);
        return res.status(500).json({
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Failed to create join request",
        });
      }
    }
  );

  /**
   * GET /tenants/:tenantId/join-requests
   * Get all join requests for a tenant (TENANT_ADMIN only)
   */
  router.get(
    "/:tenantId/join-requests",
    authenticate,
    requireTenantAccess(UserRole.TENANT_ADMIN),
    async (req: Request, res: Response) => {
      try {
        const { tenantId } = req.params;

        const joinRequests = await invitationService.getTenantJoinRequests(
          tenantId,
          req.user!.id
        );

        return res.status(200).json({
          success: true,
          data: joinRequests,
        });
      } catch (error) {
        console.error("Error fetching join requests:", error);
        return res.status(500).json({
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Failed to fetch join requests",
        });
      }
    }
  );

  /**
   * POST /tenants/:tenantId/join-requests/:requestId/approve
   * Approve a join request (TENANT_ADMIN only)
   * Body: { role?: UserRole, permissions?: object }
   */
  router.post(
    "/:tenantId/join-requests/:requestId/approve",
    authenticate,
    requireTenantAccess(UserRole.TENANT_ADMIN),
    async (req: Request, res: Response) => {
      try {
        const { requestId } = req.params;
        const { role, permissions } = req.body;

        const membership = await invitationService.approveJoinRequest(
          requestId,
          req.user!.id,
          role || UserRole.USER,
          permissions
        );

        return res.status(200).json({
          success: true,
          message: "Join request approved",
          data: membership,
        });
      } catch (error) {
        console.error("Error approving join request:", error);
        return res.status(500).json({
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Failed to approve join request",
        });
      }
    }
  );

  /**
   * POST /tenants/:tenantId/join-requests/:requestId/reject
   * Reject a join request (TENANT_ADMIN only)
   * Body: { reason?: string }
   */
  router.post(
    "/:tenantId/join-requests/:requestId/reject",
    authenticate,
    requireTenantAccess(UserRole.TENANT_ADMIN),
    async (req: Request, res: Response) => {
      try {
        const { requestId } = req.params;
        const { reason } = req.body;

        await invitationService.rejectJoinRequest(
          requestId,
          req.user!.id,
          reason
        );

        return res.status(200).json({
          success: true,
          message: "Join request rejected",
        });
      } catch (error) {
        console.error("Error rejecting join request:", error);
        return res.status(500).json({
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Failed to reject join request",
        });
      }
    }
  );

  /**
   * GET /join-requests/me
   * Get current user's join requests
   */
  router.get(
    "/join-requests/me",
    authenticate,
    async (req: Request, res: Response) => {
      try {
        const joinRequests = await invitationService.getUserJoinRequests(
          req.user!.id
        );

        return res.status(200).json({
          success: true,
          data: joinRequests,
        });
      } catch (error) {
        console.error("Error fetching user join requests:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to fetch join requests",
        });
      }
    }
  );

  /**
   * DELETE /join-requests/:requestId
   * Cancel a join request (user cancels their own)
   */
  router.delete(
    "/join-requests/:requestId",
    authenticate,
    async (req: Request, res: Response) => {
      try {
        const { requestId } = req.params;

        await invitationService.cancelJoinRequest(requestId, req.user!.id);

        return res.status(200).json({
          success: true,
          message: "Join request cancelled",
        });
      } catch (error) {
        console.error("Error cancelling join request:", error);
        return res.status(500).json({
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Failed to cancel join request",
        });
      }
    }
  );

  return router;
}

export default setupTenantInvitationRoutes;
