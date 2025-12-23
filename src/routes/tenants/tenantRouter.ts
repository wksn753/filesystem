// src/routes/tenantRoutes.ts
import { Router, Request, Response } from "express";
import { prisma } from "../../prisma";
import { UserRole } from "../../generated/prisma/client";
import { createAuthMiddleware } from "../../middleware/auth";
import { AuthService } from "../../services/auth/AuthService";

const router = Router();

// Initialize auth middleware
// Note: Pass your authService and prisma instances when setting up routes
export function setupTenantRoutes(
  authService: AuthService,
  prismaClient: typeof prisma
) {
  const { authenticate, requireTenantAccess, requireRole } =
    createAuthMiddleware(authService, prismaClient);

  /**
   * GET /tenants
   * Get all tenants the authenticated user is a member of
   */
  router.get("/", authenticate, async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Authentication required." });
      }

      const userTenants = await prismaClient.tenantMember.findMany({
        where: { userId: req.user.id },
        include: {
          tenant: {
            select: {
              id: true,
              name: true,
              rootFolderId: true,
              rootFolder: {
                select: {
                  id: true,
                  name: true,
                },
              },
              createdAt: true,
              updatedAt: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const tenants = userTenants.map((membership) => ({
        ...membership.tenant,
        role: membership.role,
        permissions: membership.permissions,
        memberSince: membership.createdAt,
      }));

      return res.status(200).json({
        success: true,
        data: tenants,
      });
    } catch (error) {
      console.error("Error fetching tenants:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to retrieve tenants.",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * GET /tenants/:tenantId
   * Get details of a specific tenant (only if user is a member)
   */
  router.get(
    "/:tenantId",
    authenticate,
    requireTenantAccess(),
    async (req: Request, res: Response) => {
      try {
        const { tenantId } = req.params;

        const tenant = await prismaClient.tenant.findUnique({
          where: { id: tenantId },
          include: {
            rootFolder: {
              select: {
                id: true,
                name: true,
              },
            },
            members: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    firstName: true,
                    lastName: true,
                    displayName: true,
                    avatarUrl: true,
                  },
                },
              },
            },
            _count: {
              select: {
                folders: true,
                files: true,
              },
            },
          },
        });

        if (!tenant) {
          return res.status(404).json({
            success: false,
            message: "Tenant not found.",
          });
        }

        return res.status(200).json({
          success: true,
          data: tenant,
        });
      } catch (error) {
        console.error("Error fetching tenant:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to retrieve tenant.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  /**
   * POST /tenants
   * Create a new tenant and automatically make the user a TENANT_ADMIN
   * Body: { name: string }
   */
  router.post("/", authenticate, async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
      }

      const { name } = req.body;

      // Validate input
      if (!name || typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({
          success: false,
          message: "Tenant name is required and must be a non-empty string.",
        });
      }

      const trimmedName = name.trim();

      // Check if tenant with this name already exists
      const existingTenant = await prismaClient.tenant.findUnique({
        where: { name: trimmedName },
      });

      if (existingTenant) {
        return res.status(409).json({
          success: false,
          message: `Tenant with name "${trimmedName}" already exists.`,
        });
      }

      // Use a transaction to create tenant, root folder, and add user as admin
      const result = await prismaClient.$transaction(async (tx) => {
        // 1. Create the tenant first (without root folder)
        const tenant = await tx.tenant.create({
          data: {
            name: trimmedName,
          },
        });

        // 2. Create root folder with ltree path using raw SQL
        // The path is the tenant ID (sanitized for ltree - replace hyphens with underscores)
        const safePath = tenant.id.replace(/-/g, "_");

        const folders = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "Folder" (id, name, "parentId", "tenantId", path, "createdAt", "updatedAt")
          VALUES (
            gen_random_uuid(),
            'root',
            NULL,
            ${tenant.id},
            ${safePath}::ltree,
            NOW(),
            NOW()
          )
          RETURNING id
        `;

        const rootFolderId = folders[0].id;

        // 3. Update tenant with the root folder reference
        await tx.tenant.update({
          where: { id: tenant.id },
          data: { rootFolderId },
        });

        // 4. Add the creating user as TENANT_ADMIN
        await tx.tenantMember.create({
          data: {
            userId: req.user!.id,
            tenantId: tenant.id,
            role: UserRole.TENANT_ADMIN,
            permissions: {
              canManageMembers: true,
              canManageFolders: true,
              canManageFiles: true,
              canDeleteTenant: true,
            },
          },
        });

        // 5. Fetch the complete tenant data
        const completeTenant = await tx.tenant.findUnique({
          where: { id: tenant.id },
          include: {
            rootFolder: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        });

        return completeTenant;
      });

      return res.status(201).json({
        success: true,
        message: "Tenant created successfully. You are now the admin.",
        data: result,
      });
    } catch (error) {
      console.error("Error creating tenant:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to create tenant.",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * POST /tenants/:tenantId/join
   * Request to join an existing tenant (creates a pending membership or auto-joins)
   * For now, this auto-joins as USER role (you can add approval workflow later)
   */
  router.post(
    "/:tenantId/join",
    authenticate,
    async (req: Request, res: Response) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            message: "Authentication required.",
          });
        }

        const { tenantId } = req.params;

        // Check if tenant exists
        const tenant = await prismaClient.tenant.findUnique({
          where: { id: tenantId },
        });

        if (!tenant) {
          return res.status(404).json({
            success: false,
            message: "Tenant not found.",
          });
        }

        // Check if user is already a member
        const existingMembership = await prismaClient.tenantMember.findUnique({
          where: {
            userId_tenantId: {
              userId: req.user.id,
              tenantId,
            },
          },
        });

        if (existingMembership) {
          return res.status(409).json({
            success: false,
            message: "You are already a member of this tenant.",
            data: {
              role: existingMembership.role,
              memberSince: existingMembership.createdAt,
            },
          });
        }

        // Create membership as USER role
        const membership = await prismaClient.tenantMember.create({
          data: {
            userId: req.user.id,
            tenantId,
            role: UserRole.USER,
            permissions: {
              canUploadFiles: true,
              canCreateFolders: true,
              canViewFiles: true,
            },
          },
          include: {
            tenant: {
              select: {
                id: true,
                name: true,
                rootFolderId: true,
              },
            },
          },
        });

        return res.status(201).json({
          success: true,
          message: `Successfully joined tenant "${tenant.name}".`,
          data: membership,
        });
      } catch (error) {
        console.error("Error joining tenant:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to join tenant.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  /**
   * DELETE /tenants/:tenantId/leave
   * Leave a tenant (remove membership)
   * TENANT_ADMINs cannot leave if they're the last admin
   */
  router.delete(
    "/:tenantId/leave",
    authenticate,
    requireTenantAccess(),
    async (req: Request, res: Response) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            message: "Authentication required.",
          });
        }

        const { tenantId } = req.params;

        // Get current membership
        const membership = await prismaClient.tenantMember.findUnique({
          where: {
            userId_tenantId: {
              userId: req.user.id,
              tenantId,
            },
          },
        });

        if (!membership) {
          return res.status(404).json({
            success: false,
            message: "You are not a member of this tenant.",
          });
        }

        // If user is an admin, check if they're the last admin
        if (membership.role === UserRole.TENANT_ADMIN) {
          const adminCount = await prismaClient.tenantMember.count({
            where: {
              tenantId,
              role: UserRole.TENANT_ADMIN,
            },
          });

          if (adminCount === 1) {
            return res.status(400).json({
              success: false,
              message:
                "You cannot leave as you are the last admin. Transfer admin rights or delete the tenant.",
            });
          }
        }

        // Remove membership
        await prismaClient.tenantMember.delete({
          where: {
            userId_tenantId: {
              userId: req.user.id,
              tenantId,
            },
          },
        });

        return res.status(200).json({
          success: true,
          message: "Successfully left the tenant.",
        });
      } catch (error) {
        console.error("Error leaving tenant:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to leave tenant.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  /**
   * PATCH /tenants/:tenantId
   * Update tenant details (name, etc.)
   * Only TENANT_ADMIN can do this
   */
  router.patch(
    "/:tenantId",
    authenticate,
    requireTenantAccess(UserRole.TENANT_ADMIN),
    async (req: Request, res: Response) => {
      try {
        const { tenantId } = req.params;
        const { name } = req.body;

        if (!name || typeof name !== "string" || name.trim() === "") {
          return res.status(400).json({
            success: false,
            message: "Tenant name is required and must be a non-empty string.",
          });
        }

        const trimmedName = name.trim();

        // Check if another tenant has this name
        const existingTenant = await prismaClient.tenant.findUnique({
          where: { name: trimmedName },
        });

        if (existingTenant && existingTenant.id !== tenantId) {
          return res.status(409).json({
            success: false,
            message: `Tenant with name "${trimmedName}" already exists.`,
          });
        }

        const updatedTenant = await prismaClient.tenant.update({
          where: { id: tenantId },
          data: { name: trimmedName },
          include: {
            rootFolder: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        });

        return res.status(200).json({
          success: true,
          message: "Tenant updated successfully.",
          data: updatedTenant,
        });
      } catch (error) {
        console.error("Error updating tenant:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to update tenant.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  /**
   * DELETE /tenants/:tenantId
   * Delete a tenant and all its data (folders, files, memberships)
   * Only TENANT_ADMIN can do this
   */
  router.delete(
    "/:tenantId",
    authenticate,
    requireTenantAccess(UserRole.TENANT_ADMIN),
    async (req: Request, res: Response) => {
      try {
        const { tenantId } = req.params;

        // Get tenant to confirm it exists
        const tenant = await prismaClient.tenant.findUnique({
          where: { id: tenantId },
        });

        if (!tenant) {
          return res.status(404).json({
            success: false,
            message: "Tenant not found.",
          });
        }

        // Delete everything in a transaction
        await prismaClient.$transaction(async (tx) => {
          // 1. Delete all files (cascade will handle FileVersions)
          await tx.file.deleteMany({
            where: { tenantId },
          });

          // 2. Delete all folders
          await tx.folder.deleteMany({
            where: { tenantId },
          });

          // 3. Delete all memberships
          await tx.tenantMember.deleteMany({
            where: { tenantId },
          });

          // 4. Delete the tenant
          await tx.tenant.delete({
            where: { id: tenantId },
          });
        });

        return res.status(200).json({
          success: true,
          message: "Tenant and all associated data deleted successfully.",
        });
      } catch (error) {
        console.error("Error deleting tenant:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to delete tenant.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  /**
   * GET /tenants/:tenantId/members
   * Get all members of a tenant
   * Any tenant member can view this
   */
  router.get(
    "/:tenantId/members",
    authenticate,
    requireTenantAccess(),
    async (req: Request, res: Response) => {
      try {
        const { tenantId } = req.params;

        const members = await prismaClient.tenantMember.findMany({
          where: { tenantId },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                displayName: true,
                avatarUrl: true,
                createdAt: true,
                lastLoginAt: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        });

        return res.status(200).json({
          success: true,
          data: members,
        });
      } catch (error) {
        console.error("Error fetching members:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to retrieve members.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  /**
   * PATCH /tenants/:tenantId/members/:userId
   * Update a member's role or permissions
   * Only TENANT_ADMIN can do this
   */
  router.patch(
    "/:tenantId/members/:userId",
    authenticate,
    requireTenantAccess(UserRole.TENANT_ADMIN),
    async (req: Request, res: Response) => {
      try {
        const { tenantId, userId } = req.params;
        const { role, permissions } = req.body;

        // Validate role if provided
        if (role && !Object.values(UserRole).includes(role)) {
          return res.status(400).json({
            success: false,
            message: "Invalid role provided.",
          });
        }

        // Check if member exists
        const membership = await prismaClient.tenantMember.findUnique({
          where: {
            userId_tenantId: {
              userId,
              tenantId,
            },
          },
        });

        if (!membership) {
          return res.status(404).json({
            success: false,
            message: "Member not found in this tenant.",
          });
        }

        // If demoting an admin, check if they're the last admin
        if (
          membership.role === UserRole.TENANT_ADMIN &&
          role &&
          role !== UserRole.TENANT_ADMIN
        ) {
          const adminCount = await prismaClient.tenantMember.count({
            where: {
              tenantId,
              role: UserRole.TENANT_ADMIN,
            },
          });

          if (adminCount === 1) {
            return res.status(400).json({
              success: false,
              message:
                "Cannot demote the last admin. Promote another member first.",
            });
          }
        }

        // Update membership
        const updatedMembership = await prismaClient.tenantMember.update({
          where: {
            userId_tenantId: {
              userId,
              tenantId,
            },
          },
          data: {
            ...(role && { role }),
            ...(permissions && { permissions }),
          },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                displayName: true,
              },
            },
          },
        });

        return res.status(200).json({
          success: true,
          message: "Member updated successfully.",
          data: updatedMembership,
        });
      } catch (error) {
        console.error("Error updating member:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to update member.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  /**
   * DELETE /tenants/:tenantId/members/:userId
   * Remove a member from tenant
   * Only TENANT_ADMIN can do this
   */
  router.delete(
    "/:tenantId/members/:userId",
    authenticate,
    requireTenantAccess(UserRole.TENANT_ADMIN),
    async (req: Request, res: Response) => {
      try {
        const { tenantId, userId } = req.params;

        // Check if member exists
        const membership = await prismaClient.tenantMember.findUnique({
          where: {
            userId_tenantId: {
              userId,
              tenantId,
            },
          },
        });

        if (!membership) {
          return res.status(404).json({
            success: false,
            message: "Member not found in this tenant.",
          });
        }

        // If removing an admin, check if they're the last admin
        if (membership.role === UserRole.TENANT_ADMIN) {
          const adminCount = await prismaClient.tenantMember.count({
            where: {
              tenantId,
              role: UserRole.TENANT_ADMIN,
            },
          });

          if (adminCount === 1) {
            return res.status(400).json({
              success: false,
              message:
                "Cannot remove the last admin. Delete the tenant instead.",
            });
          }
        }

        // Remove membership
        await prismaClient.tenantMember.delete({
          where: {
            userId_tenantId: {
              userId,
              tenantId,
            },
          },
        });

        return res.status(200).json({
          success: true,
          message: "Member removed successfully.",
        });
      } catch (error) {
        console.error("Error removing member:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to remove member.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  return router;
}

export default setupTenantRoutes;
