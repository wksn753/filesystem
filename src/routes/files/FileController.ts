// src/controllers/FileController.ts
import { Request, Response, NextFunction } from "express";
import {
  FileService,
  FileServiceError,
} from "../../services/FilesManagement/FileService";
import { MinioClient } from "../../services/storage/minio/MinioClient";
import { PrismaFileRepository } from "./FileRepository";
import multer from "multer";

// ============================================================================
// MULTER CONFIGURATION
// ============================================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
  },
});

// ============================================================================
// CONTROLLER CLASS
// ============================================================================

export class FileController {
  private fileService: FileService;

  constructor(fileService: FileService) {
    this.fileService = fileService;
  }

  /**
   * Upload a file
   * POST /api/v1/tenants/:tenantId/folders/:folderId/files
   */
  uploadFile = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { tenantId, folderId } = req.params;

      // Check authentication
      if (!req.user?.id) {
        res.status(401).json({
          success: false,
          error: "Authentication required",
          code: "AUTH_REQUIRED",
        });
        return;
      }

      const userId = req.user.id;

      if (!req.file) {
        res.status(400).json({
          success: false,
          error: "No file provided",
        });
        return;
      }

      // Optional: Parse additional options from request
      const options = {
        sanitizeFileName: req.body.sanitizeFileName === "true",
        maxFileSize: req.body.maxFileSize
          ? parseInt(req.body.maxFileSize)
          : undefined,
        allowedMimeTypes: req.body.allowedMimeTypes
          ? JSON.parse(req.body.allowedMimeTypes)
          : undefined,
      };

      const result = await this.fileService.handleFileUpload(
        tenantId,
        folderId,
        userId,
        {
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          buffer: req.file.buffer,
          size: req.file.size,
        },
        options
      );

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Download a file
   * GET /api/v1/tenants/:tenantId/files/:fileId/download
   */
  downloadFile = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { tenantId, fileId } = req.params;

      if (!req.user?.id) {
        res.status(401).json({
          success: false,
          error: "Authentication required",
          code: "AUTH_REQUIRED",
        });
        return;
      }

      const userId = req.user.id;

      const { stream, metadata } = await this.fileService.getFileStream(
        tenantId,
        fileId,
        userId
      );

      // Set appropriate headers
      res.setHeader("Content-Type", metadata.mimeType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(metadata.originalName)}"`
      );
      res.setHeader("Content-Length", metadata.size);

      // Pipe the stream to response
      stream.pipe(res);

      // Handle stream errors
      stream.on("error", (error) => {
        console.error("Stream error:", error);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            error: "Failed to stream file",
          });
        }
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get presigned download URL
   * GET /api/v1/tenants/:tenantId/files/:fileId/download-url
   */
  getDownloadUrl = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { tenantId, fileId } = req.params;

      if (!req.user?.id) {
        res.status(401).json({
          success: false,
          error: "Authentication required",
          code: "AUTH_REQUIRED",
        });
        return;
      }

      const userId = req.user.id;
      const expirySeconds = req.query.expiry
        ? parseInt(req.query.expiry as string)
        : 3600;

      const url = await this.fileService.getDownloadUrl(
        tenantId,
        fileId,
        userId,
        expirySeconds
      );

      res.json({
        success: true,
        data: {
          url,
          expiresIn: expirySeconds,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get file information
   * GET /api/v1/tenants/:tenantId/files/:fileId
   */
  getFileInfo = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { tenantId, fileId } = req.params;

      if (!req.user?.id) {
        res.status(401).json({
          success: false,
          error: "Authentication required",
          code: "AUTH_REQUIRED",
        });
        return;
      }

      const userId = req.user.id;

      const fileInfo = await this.fileService.getFileInfo(
        tenantId,
        fileId,
        userId
      );

      res.json({
        success: true,
        data: fileInfo,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Delete a file
   * DELETE /api/v1/tenants/:tenantId/files/:fileId
   */
  deleteFile = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { tenantId, fileId } = req.params;

      if (!req.user?.id) {
        res.status(401).json({
          success: false,
          error: "Authentication required",
          code: "AUTH_REQUIRED",
        });
        return;
      }

      const userId = req.user.id;
      const hardDelete = req.query.hard === "true";

      await this.fileService.deleteFile(tenantId, fileId, userId, hardDelete);

      res.json({
        success: true,
        message: "File deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Create new file version
   * POST /api/v1/tenants/:tenantId/files/:fileId/versions
   */
  createNewVersion = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { tenantId, fileId } = req.params;

      if (!req.user?.id) {
        res.status(401).json({
          success: false,
          error: "Authentication required",
          code: "AUTH_REQUIRED",
        });
        return;
      }

      const userId = req.user.id;

      if (!req.file) {
        res.status(400).json({
          success: false,
          error: "No file provided",
        });
        return;
      }

      const result = await this.fileService.createNewVersion(
        tenantId,
        fileId,
        userId,
        {
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          buffer: req.file.buffer,
          size: req.file.size,
        }
      );

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };
}

// ============================================================================
// ERROR HANDLER MIDDLEWARE
// ============================================================================

export const fileErrorHandler = (
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  console.error("File operation error:", error);

  if (error instanceof FileServiceError) {
    res.status(error.statusCode).json({
      success: false,
      error: error.message,
      code: error.code,
      details: error.details,
    });
    return;
  }

  // Handle Multer errors
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        success: false,
        error: "File too large",
        code: "FILE_TOO_LARGE",
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: error.message,
      code: "UPLOAD_ERROR",
    });
    return;
  }

  // Generic error
  res.status(500).json({
    success: false,
    error: "Internal server error",
    code: "INTERNAL_ERROR",
  });
};

// ============================================================================
// ROUTES SETUP
// ============================================================================

import { Router } from "express";
import { AuthMiddleware } from "../../middleware/auth"; // FIXED: Correct import

export function setupFileRoutes(
  fileService: FileService,
  authMiddleware: AuthMiddleware, // Pass as parameter
  router: Router = Router()
): Router {
  const controller = new FileController(fileService);

  // All routes require authentication
  router.use(authMiddleware.authenticate);

  // Upload file
  router.post(
    "/tenants/:tenantId/folders/:folderId/files",
    upload.single("file"),
    controller.uploadFile
  );

  // Download file (stream)
  router.get(
    "/tenants/:tenantId/files/:fileId/download",
    controller.downloadFile
  );

  // Get presigned download URL
  router.get(
    "/tenants/:tenantId/files/:fileId/download-url",
    controller.getDownloadUrl
  );

  // Get file info
  router.get("/tenants/:tenantId/files/:fileId", controller.getFileInfo);

  // Delete file
  router.delete("/tenants/:tenantId/files/:fileId", controller.deleteFile);

  // Create new version
  router.post(
    "/tenants/:tenantId/files/:fileId/versions",
    upload.single("file"),
    controller.createNewVersion
  );

  // Error handler (must be last)
  router.use(fileErrorHandler);

  return router;
}

// ============================================================================
// DEPENDENCY INJECTION SETUP
// ============================================================================

export function initializeFileModule(
  prismaClient: any,
  authMiddleware: AuthMiddleware
) {
  // Initialize dependencies
  const minioClient = new MinioClient("file-storage");
  const fileRepository = new PrismaFileRepository(prismaClient);
  const fileService = new FileService(minioClient, fileRepository); // FIXED: Added fileRepository

  // Setup routes
  const fileRouter = setupFileRoutes(fileService, authMiddleware);

  return {
    fileService,
    fileRouter,
  };
}
