// src/routes/files/fileRouter.ts
import { Router } from "express";
import multer from "multer";
import { PrismaClient } from "../../generated/prisma/client";
import { MinioClient } from "../../services/storage/minio/MinioClient";
import { FileService } from "../../services/FilesManagement/FileService";
import { FileController, fileErrorHandler } from "./FileController";
import { PrismaFileRepository } from "./FileRepository";
import { AuthMiddleware } from "../../middleware/auth";
import { AuthService } from "../../services/auth/AuthService";

// Configure Multer to store files in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
  },
});

// Factory function to create router with dependencies
export function createFileRouter(
  prisma: PrismaClient,
  authMiddleware: AuthMiddleware
): Router {
  const router = Router();

  // Initialize dependencies
  const minioClient = new MinioClient(
    process.env.MINIO_BUCKET || "file-storage"
  );
  const fileRepository = new PrismaFileRepository(prisma);
  const fileService = new FileService(minioClient, fileRepository);
  const fileController = new FileController(fileService);

  // Apply authentication middleware to all routes
  router.use(authMiddleware.authenticate);

  // Upload file
  router.post(
    "/tenants/:tenantId/folders/:folderId/files",
    upload.single("file"),
    fileController.uploadFile
  );

  // Download file (stream)
  router.get(
    "/tenants/:tenantId/files/:fileId/download",
    fileController.downloadFile
  );

  // Get presigned download URL
  router.get(
    "/tenants/:tenantId/files/:fileId/download-url",
    fileController.getDownloadUrl
  );

  // Get file info
  router.get("/tenants/:tenantId/files/:fileId", fileController.getFileInfo);

  // Delete file
  router.delete("/tenants/:tenantId/files/:fileId", fileController.deleteFile);

  // Create new version
  router.post(
    "/tenants/:tenantId/files/:fileId/versions",
    upload.single("file"),
    fileController.createNewVersion
  );

  // Error handler (must be last)
  router.use(fileErrorHandler);

  return router;
}

// For backwards compatibility, export default
export default createFileRouter;
