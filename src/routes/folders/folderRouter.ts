// src/routes/folderRoutes.ts
import { Router, Request, Response } from "express";
import { prisma } from "../../prisma";
import { UserRole } from "../../generated/prisma/client";
import { createAuthMiddleware } from "../../middleware/auth";
import { AuthService } from "../../services/auth/AuthService";
import { FileService } from "../../services/FilesManagement/FileService";
import { MinioClient } from "../../services/storage/minio/MinioClient";
import { PrismaFileRepository } from "../files/FileRepository";
import crypto from "crypto";

// Type definitions for raw SQL queries
interface FolderWithPath {
  id: string;
  name: string;
  path: string;
  depth: number;
}

interface ParentFolderInfo {
  id: string;
  tenantId: string;
  path: string;
}

interface FolderPathInfo {
  path: string;
  parentId: string | null;
}

const minioClient = new MinioClient(process.env.MINIO_BUCKET || "file-storage");
const fileRepository = new PrismaFileRepository(prisma);


const fileService = new FileService(minioClient, fileRepository);
export function setupFolderRoutes(
  authService: AuthService,
  prismaClient: typeof prisma
) {
  const router = Router({ mergeParams: true });
  const { authenticate, requireTenantAccess } = createAuthMiddleware(
    authService,
    prismaClient
  );

  /**
   * GET /tenants/:tenantId/folders/:folderId
   * Get a folder's details and its immediate children with preview URLs
   */
  router.get(
    "/:folderId",
    authenticate,
    requireTenantAccess(),
    async (req: Request, res: Response) => {
      try {
        const { tenantId, folderId } = req.params;
        const userId = (req as any).user?.id; // Get user ID from auth middleware

        if (!userId) {
          return res.status(401).json({
            success: false,
            message: "User not authenticated.",
          });
        }

        const folder = await prismaClient.folder.findFirst({
          where: {
            id: folderId,
            tenantId,
          },
          select: {
            id: true,
            name: true,
            parentId: true,
            tenantId: true,
            createdAt: true,
            updatedAt: true,
            parent: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        });

        if (!folder) {
          return res.status(404).json({
            success: false,
            message: "Folder not found.",
          });
        }

        const children = await prismaClient.folder.findMany({
          where: {
            parentId: folderId,
            tenantId,
          },
          select: {
            id: true,
            name: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { name: "asc" },
        });

        // Add icon type for folders
        const childrenWithIcons = children.map((child) => ({
          ...child,
          type: "folder" as const,
          icon: "folder", // You can customize this based on folder properties
        }));

        // Get files in this folder
        const files = await prismaClient.file.findMany({
          where: {
            folderId,
            tenantId,
          },
          include: {
            currentVersion: {
              select: {
                size: true,
                versionNumber: true,
                createdAt: true,
              },
            },
          },
          orderBy: { name: "asc" },
        });

        // Generate preview URLs for all files
        const fileIds = files.map((f) => f.id);
        const previewUrls = await fileService.getPreviewUrls(
          tenantId,
          fileIds,
          userId,
          3600 // 1 hour expiry
        );

        // Enhance files with preview URLs and icons
        const filesWithPreviews = files.map((file) => {
          const previewUrl = previewUrls.get(file.id);
          const icon = getFileIcon(file.mimeType || "application/pdf");

          return {
            ...file,
            type: "file" as const,
            icon,
            previewUrl: previewUrl || null,
          };
        });

        return res.status(200).json({
          success: true,
          data: {
            folder,
            children: childrenWithIcons,
            files: filesWithPreviews,
          },
        });
      } catch (error) {
        console.error("Error fetching folder:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to retrieve folder.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  /**
   * GET /tenants/:tenantId/folders/:folderId/children
   * Get only the subfolders of a folder
   */
  router.get(
    "/:folderId/children",
    authenticate,
    requireTenantAccess(),
    async (req: Request, res: Response) => {
      try {
        const { folderId, tenantId } = req.params;

        const folder = await prismaClient.folder.findFirst({
          where: {
            id: folderId,
            tenantId,
          },
        });

        if (!folder) {
          return res.status(404).json({
            success: false,
            message: "Folder not found.",
          });
        }

        const children = await prismaClient.folder.findMany({
          where: {
            parentId: folderId,
            tenantId,
          },
          select: {
            id: true,
            name: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { name: "asc" },
        });

        return res.status(200).json({
          success: true,
          data: children,
        });
      } catch (error) {
        console.error("Error fetching children:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to retrieve subfolders.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  /**
   * GET /tenants/:tenantId/folders/:folderId/descendants
   * Get ALL descendants (entire subtree) using ltree
   */
  router.get(
    "/:folderId/descendants",
    authenticate,
    requireTenantAccess(),
    async (req: Request, res: Response) => {
      try {
        const { folderId, tenantId } = req.params;

        const folderPath = await prismaClient.$queryRaw<{ path: string }[]>`
        SELECT path::text as path FROM "Folder" 
        WHERE id = ${folderId} AND "tenantId" = ${tenantId}
      `;

        if (folderPath.length === 0) {
          return res.status(404).json({
            success: false,
            message: "Folder not found.",
          });
        }

        const path = folderPath[0].path;

        const descendants = await prismaClient.$queryRaw<FolderWithPath[]>`
        SELECT id, name, path::text as path, nlevel(path) - nlevel(${path}::ltree) as depth
        FROM "Folder"
        WHERE path <@ ${path}::ltree 
          AND id != ${folderId}
          AND "tenantId" = ${tenantId}
        ORDER BY path ASC
      `;

        return res.status(200).json({
          success: true,
          data: descendants,
        });
      } catch (error) {
        console.error("Error fetching descendants:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to retrieve descendants.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  /**
   * GET /tenants/:tenantId/folders/:folderId/ancestors
   * Get the path from root to this folder (breadcrumb navigation)
   */
  router.get(
    "/:folderId/ancestors",
    authenticate,
    requireTenantAccess(),
    async (req: Request, res: Response) => {
      try {
        const { folderId, tenantId } = req.params;

        const folderPath = await prismaClient.$queryRaw<{ path: string }[]>`
        SELECT path::text as path FROM "Folder" 
        WHERE id = ${folderId} AND "tenantId" = ${tenantId}
      `;

        if (folderPath.length === 0) {
          return res.status(404).json({
            success: false,
            message: "Folder not found.",
          });
        }

        const path = folderPath[0].path;

        const ancestors = await prismaClient.$queryRaw<FolderWithPath[]>`
        SELECT id, name, path::text as path, nlevel(path) as depth
        FROM "Folder"
        WHERE path @> ${path}::ltree
          AND "tenantId" = ${tenantId}
        ORDER BY nlevel(path) ASC
      `;

        return res.status(200).json({
          success: true,
          data: ancestors,
        });
      } catch (error) {
        console.error("Error fetching ancestors:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to retrieve ancestors.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  /**
   * POST /tenants/:tenantId/folders
   * Create a new subfolder
   * Body: { name: string, parentId: string }
   */
  router.post(
    "/",
    authenticate,
    requireTenantAccess(),
    async (req: Request, res: Response) => {
      try {
        const { tenantId, name, parentId } = req.body;

        if (!name || typeof name !== "string" || name.trim() === "") {
          return res.status(400).json({
            success: false,
            message: "Folder name is required and must be a non-empty string.",
          });
        }

        if (!parentId || typeof parentId !== "string") {
          return res.status(400).json({
            success: false,
            message: "Parent folder ID is required.",
          });
        }

        const trimmedName = name.trim();

        // Verify parent folder exists and belongs to this tenant
        const parentFolder = await prismaClient.$queryRaw<ParentFolderInfo[]>`
        SELECT id, "tenantId", path::text as path 
        FROM "Folder" 
        WHERE id = ${parentId} AND "tenantId" = ${tenantId}
      `;

        if (parentFolder.length === 0) {
          return res.status(404).json({
            success: false,
            message: "Parent folder not found in this tenant.",
          });
        }

        const parent = parentFolder[0];

        // Check for duplicate folder name
        const existingFolder = await prismaClient.folder.findFirst({
          where: {
            name: trimmedName,
            parentId: parentId,
            tenantId,
          },
        });

        if (existingFolder) {
          return res.status(409).json({
            success: false,
            message: `A folder named "${trimmedName}" already exists in this location.`,
          });
        }

        // Create the folder
        const newFolderId = crypto.randomUUID();
        const safeFolderId = newFolderId.replace(/-/g, "_");
        const newPath = `${parent.path}.${safeFolderId}`;

        await prismaClient.$queryRaw`
        INSERT INTO "Folder" (id, name, "parentId", "tenantId", path, "createdAt", "updatedAt")
        VALUES (${newFolderId}, ${trimmedName}, ${parentId}, ${tenantId}, ${newPath}::ltree, NOW(), NOW())
      `;

        const createdFolder = await prismaClient.folder.findUnique({
          where: { id: newFolderId },
          select: {
            id: true,
            name: true,
            parentId: true,
            tenantId: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        return res.status(201).json({
          success: true,
          message: "Folder created successfully.",
          data: createdFolder,
        });
      } catch (error) {
        console.error("Error creating folder:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to create folder.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  /**
   * DELETE /tenants/:tenantId/folders/:folderId
   * Delete a folder and all its descendants
   * Only TENANT_ADMIN can delete folders
   */
  router.delete(
    "/:folderId",
    authenticate,
    requireTenantAccess(UserRole.TENANT_ADMIN),
    async (req: Request, res: Response) => {
      try {
        const { folderId, tenantId } = req.params;

        const folderData = await prismaClient.$queryRaw<FolderPathInfo[]>`
        SELECT path::text as path, "parentId" 
        FROM "Folder" 
        WHERE id = ${folderId} AND "tenantId" = ${tenantId}
      `;

        if (folderData.length === 0) {
          return res.status(404).json({
            success: false,
            message: "Folder not found.",
          });
        }

        if (folderData[0].parentId === null) {
          return res.status(403).json({
            success: false,
            message: "Cannot delete root folder.",
          });
        }

        const path = folderData[0].path;

        // Delete in transaction
        const result = await prismaClient.$transaction(async (tx) => {
          // First, delete all files in this folder and descendants
          // await tx.file.deleteMany({
          //   where: {
          //     folder: {
          //       path: {
          //         // This won't work directly, need raw SQL
          //       },
          //     },
          //     tenantId,
          //   },
          // });

          // Delete files using raw SQL
          await tx.$executeRaw`
          DELETE FROM "File" 
          WHERE "folderId" IN (
            SELECT id FROM "Folder" WHERE path <@ ${path}::ltree AND "tenantId" = ${tenantId}
          )
        `;

          // Delete folders
          const deletedFolders = await tx.$queryRaw<{ count: bigint }[]>`
          WITH deleted AS (
            DELETE FROM "Folder" 
            WHERE path <@ ${path}::ltree AND "tenantId" = ${tenantId}
            RETURNING id
          )
          SELECT COUNT(*) as count FROM deleted
        `;

          return Number(deletedFolders[0].count);
        });

        return res.status(200).json({
          success: true,
          message: `Successfully deleted ${result} folder(s) and their contents.`,
          deletedCount: result,
        });
      } catch (error) {
        console.error("Error deleting folder:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to delete folder.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  /**
   * PATCH /tenants/:tenantId/folders/:folderId
   * Rename a folder
   * Body: { name: string }
   */
  router.patch(
    "/:folderId",
    authenticate,
    requireTenantAccess(),
    async (req: Request, res: Response) => {
      try {
        const { folderId, tenantId } = req.params;
        const { name } = req.body;

        if (!name || typeof name !== "string" || name.trim() === "") {
          return res.status(400).json({
            success: false,
            message: "Folder name is required and must be a non-empty string.",
          });
        }

        const trimmedName = name.trim();

        const folder = await prismaClient.folder.findFirst({
          where: {
            id: folderId,
            tenantId,
          },
        });

        if (!folder) {
          return res.status(404).json({
            success: false,
            message: "Folder not found.",
          });
        }

        // Check for duplicate name in same parent
        if (folder.parentId) {
          const duplicate = await prismaClient.folder.findFirst({
            where: {
              name: trimmedName,
              parentId: folder.parentId,
              tenantId,
              id: { not: folderId },
            },
          });

          if (duplicate) {
            return res.status(409).json({
              success: false,
              message: `A folder named "${trimmedName}" already exists in this location.`,
            });
          }
        }

        const updatedFolder = await prismaClient.folder.update({
          where: { id: folderId },
          data: { name: trimmedName },
          select: {
            id: true,
            name: true,
            parentId: true,
            tenantId: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        return res.status(200).json({
          success: true,
          message: "Folder renamed successfully.",
          data: updatedFolder,
        });
      } catch (error) {
        console.error("Error renaming folder:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to rename folder.",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  return router;
}
/**
 * Helper function to determine file icon based on MIME type
 */
function getFileIcon(mimeType: string): string {
  const iconMap: Record<string, string> = {
    // Images
    "image/jpeg": "image",
    "image/jpg": "image",
    "image/png": "image",
    "image/gif": "image",
    "image/webp": "image",
    "image/svg+xml": "image",

    // Documents
    "application/pdf": "file-pdf",
    "application/msword": "file-text",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "file-text",

    // Spreadsheets
    "application/vnd.ms-excel": "file-spreadsheet",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      "file-spreadsheet",
    "text/csv": "file-spreadsheet",

    // Text files
    "text/plain": "file-text",
    "text/html": "file-code",
    "text/css": "file-code",
    "application/json": "file-code",

    // Archives
    "application/zip": "file-archive",
    "application/x-rar-compressed": "file-archive",
    "application/x-7z-compressed": "file-archive",

    // Video
    "video/mp4": "file-video",
    "video/mpeg": "file-video",
    "video/quicktime": "file-video",

    // Audio
    "audio/mpeg": "file-audio",
    "audio/wav": "file-audio",
    "audio/ogg": "file-audio",
  };

  return iconMap[mimeType.toLowerCase()] || "file";
}

export default setupFolderRoutes;
