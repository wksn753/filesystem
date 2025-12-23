// src/services/FileService.ts
import { MinioClient } from "../storage/minio/MinioClient";
import { v4 as uuidv4 } from "uuid";
import { Readable } from "stream";
import * as path from "path";

// ============================================================================
// INTERFACES
// ============================================================================

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export interface FileMetadata {
  id: string;
  tenantId: string;
  folderId: string;
  name: string;
  storageKey: string;
  size: number;
  mimeType: string;
  versionNumber: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FileDownloadInfo {
  stream: Readable;
  metadata: {
    originalName: string;
    mimeType: string;
    size: number;
    storageKey: string;
  };
}

export interface FileUploadOptions {
  allowedMimeTypes?: string[];
  maxFileSize?: number; // in bytes
  sanitizeFileName?: boolean;
}

export interface FileRepository {
  findById(fileId: string, tenantId: string): Promise<FileMetadata | null>;
  findByStorageKey(
    storageKey: string,
    tenantId: string
  ): Promise<FileMetadata | null>;
  create(
    metadata: Omit<FileMetadata, "id" | "createdAt" | "updatedAt">
  ): Promise<FileMetadata>;
  update(fileId: string, updates: Partial<FileMetadata>): Promise<FileMetadata>;
  softDelete(fileId: string): Promise<void>;
  hardDelete(fileId: string): Promise<void>;
  findVersionsByFileId(fileId: string): Promise<FileMetadata[]>;
  checkFolderExists(folderId: string, tenantId: string): Promise<boolean>;
  checkUserPermissions(
    userId: string,
    folderId: string,
    permission: string
  ): Promise<boolean>;
}

// ============================================================================
// CUSTOM ERRORS
// ============================================================================

export class FileServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: any
  ) {
    super(message);
    this.name = "FileServiceError";
  }
}

export class FileNotFoundError extends FileServiceError {
  constructor(fileId: string) {
    super(`File with ID '${fileId}' not found`, "FILE_NOT_FOUND", 404);
  }
}

export class FileTooLargeError extends FileServiceError {
  constructor(size: number, maxSize: number) {
    super(
      `File size ${size} bytes exceeds maximum allowed size of ${maxSize} bytes`,
      "FILE_TOO_LARGE",
      413
    );
  }
}

export class InvalidFileTypeError extends FileServiceError {
  constructor(mimeType: string, allowedTypes: string[]) {
    super(
      `File type '${mimeType}' is not allowed. Allowed types: ${allowedTypes.join(
        ", "
      )}`,
      "INVALID_FILE_TYPE",
      400
    );
  }
}

export class FolderNotFoundError extends FileServiceError {
  constructor(folderId: string) {
    super(`Folder with ID '${folderId}' not found`, "FOLDER_NOT_FOUND", 404);
  }
}

export class PermissionDeniedError extends FileServiceError {
  constructor(resource: string) {
    super(`Permission denied to access ${resource}`, "PERMISSION_DENIED", 403);
  }
}

// ============================================================================
// FILE SERVICE
// ============================================================================

export class FileService {
  private minioClient: MinioClient;
  private fileRepository: FileRepository;

  // Default configuration
  private readonly DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
  private readonly DEFAULT_ALLOWED_MIME_TYPES = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "text/csv",
  ];

  constructor(minioClient: MinioClient, fileRepository: FileRepository) {
    this.minioClient = minioClient;
    this.fileRepository = fileRepository;
  }

  // =========================================================================
  // PUBLIC METHODS
  // =========================================================================

  /**
   * Handles file upload with validation, storage, and metadata persistence.
   */
  async handleFileUpload(
    tenantId: string,
    folderId: string,
    userId: string,
    file: UploadedFile,
    options?: FileUploadOptions
  ): Promise<FileMetadata> {
    // Step 1: Validate inputs
    this.validateUploadInputs(tenantId, folderId, userId, file);

    // Step 2: Validate file constraints
    await this.validateFileConstraints(file, options);

    // Step 3: Check folder exists and user has permissions
    await this.validateFolderAccess(folderId, tenantId, userId);

    // Step 4: Sanitize filename if needed
    const sanitizedFileName = options?.sanitizeFileName
      ? this.sanitizeFileName(file.originalname)
      : file.originalname;

    // Step 5: Generate unique storage key
    const storageKey = this.generateStorageKey(tenantId, sanitizedFileName);

    // Step 6: Upload to MinIO with proper content type
    try {
      await this.minioClient.uploadFile(storageKey, file.buffer, {
        contentType: file.mimetype,
        metadata: {
          originalName: sanitizedFileName,
          tenantId: tenantId,
          uploadedBy: userId,
          uploadedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      throw new FileServiceError(
        "Failed to upload file to storage",
        "STORAGE_UPLOAD_FAILED",
        500,
        error
      );
    }

    // Step 7: Persist metadata to database
    try {
      const fileMetadata = await this.fileRepository.create({
        tenantId,
        folderId,
        name: sanitizedFileName,
        storageKey,
        size: file.size,
        mimeType: file.mimetype,
        versionNumber: 1,
      });

      return fileMetadata;
    } catch (error) {
      // Rollback: Delete from MinIO if DB insert fails
      try {
        await this.minioClient.deleteFile(storageKey);
      } catch (rollbackError) {
        // Log rollback failure but don't throw
        console.error("Failed to rollback file upload:", rollbackError);
      }

      throw new FileServiceError(
        "Failed to save file metadata",
        "METADATA_SAVE_FAILED",
        500,
        error
      );
    }
  }

  /**
   * Retrieves file stream for download with access validation.
   */
  async getFileStream(
    tenantId: string,
    fileId: string,
    userId: string
  ): Promise<FileDownloadInfo> {
    // Step 1: Validate inputs
    if (!tenantId || !fileId || !userId) {
      throw new FileServiceError(
        "Tenant ID, File ID, and User ID are required",
        "INVALID_INPUT",
        400
      );
    }

    // Step 2: Retrieve file metadata from database
    const fileRecord = await this.fileRepository.findById(fileId, tenantId);

    if (!fileRecord) {
      throw new FileNotFoundError(fileId);
    }

    // Step 3: Check user permissions (implement based on your auth system)
    const hasPermission = await this.fileRepository.checkUserPermissions(
      userId,
      fileRecord.folderId,
      "read"
    );

    if (!hasPermission) {
      throw new PermissionDeniedError(`file ${fileId}`);
    }

    // Step 4: Check if file exists in MinIO
    const fileExists = await this.minioClient.fileExists(fileRecord.storageKey);
    if (!fileExists) {
      throw new FileServiceError(
        "File not found in storage",
        "STORAGE_FILE_NOT_FOUND",
        404
      );
    }

    // Step 5: Retrieve file stream from MinIO
    let stream: Readable;
    try {
      stream = await this.minioClient.downloadFile(fileRecord.storageKey);
    } catch (error) {
      throw new FileServiceError(
        "Failed to retrieve file from storage",
        "STORAGE_DOWNLOAD_FAILED",
        500,
        error
      );
    }

    return {
      stream,
      metadata: {
        originalName: fileRecord.name,
        mimeType: fileRecord.mimeType,
        size: fileRecord.size,
        storageKey: fileRecord.storageKey,
      },
    };
  }

  /**
   * Generates a presigned URL for direct file download.
   */
  async getDownloadUrl(
    tenantId: string,
    fileId: string,
    userId: string,
    expirySeconds: number = 3600
  ): Promise<string> {
    // Step 1: Validate access
    const fileRecord = await this.fileRepository.findById(fileId, tenantId);

    if (!fileRecord) {
      throw new FileNotFoundError(fileId);
    }

    const hasPermission = await this.fileRepository.checkUserPermissions(
      userId,
      fileRecord.folderId,
      "read"
    );

    if (!hasPermission) {
      throw new PermissionDeniedError(`file ${fileId}`);
    }

    // Step 2: Generate presigned URL
    try {
      return await this.minioClient.getDownloadUrl(
        fileRecord.storageKey,
        expirySeconds
      );
    } catch (error) {
      throw new FileServiceError(
        "Failed to generate download URL",
        "URL_GENERATION_FAILED",
        500,
        error
      );
    }
  }

  /**
   * Generates a presigned URL for file preview (similar to download but optimized for viewing).
   */
  async getPreviewUrl(
    tenantId: string,
    fileId: string,
    userId: string,
    expirySeconds: number = 3600
  ): Promise<string> {
    // Step 1: Validate access
    const fileRecord = await this.fileRepository.findById(fileId, tenantId);

    if (!fileRecord) {
      throw new FileNotFoundError(fileId);
    }

    const hasPermission = await this.fileRepository.checkUserPermissions(
      userId,
      fileRecord.folderId,
      "read"
    );

    if (!hasPermission) {
      throw new PermissionDeniedError(`file ${fileId}`);
    }

    // Step 2: Generate presigned URL
    try {
      return await this.minioClient.getDownloadUrl(
        fileRecord.storageKey,
        expirySeconds
      );
    } catch (error) {
      throw new FileServiceError(
        "Failed to generate preview URL",
        "URL_GENERATION_FAILED",
        500,
        error
      );
    }
  }

  /**
   * Batch generate preview URLs for multiple files.
   * More efficient than calling getPreviewUrl multiple times.
   */
  async getPreviewUrls(
    tenantId: string,
    fileIds: string[],
    userId: string,
    expirySeconds: number = 3600
  ): Promise<Map<string, string>> {
    const previewUrls = new Map<string, string>();

    for (const fileId of fileIds) {
      try {
        const url = await this.getPreviewUrl(
          tenantId,
          fileId,
          userId,
          expirySeconds
        );
        previewUrls.set(fileId, url);
      } catch (error) {
        // Log error but continue processing other files
        console.error(
          `Failed to generate preview URL for file ${fileId}:`,
          error
        );
        // Optionally, you could set a placeholder or skip this file
      }
    }

    return previewUrls;
  }
  /**
   * Deletes a file and all its versions.
   */
  async deleteFile(
    tenantId: string,
    fileId: string,
    userId: string,
    hardDelete: boolean = false
  ): Promise<void> {
    // Step 1: Validate inputs
    if (!tenantId || !fileId || !userId) {
      throw new FileServiceError(
        "Tenant ID, File ID, and User ID are required",
        "INVALID_INPUT",
        400
      );
    }

    // Step 2: Retrieve file metadata
    const fileRecord = await this.fileRepository.findById(fileId, tenantId);

    if (!fileRecord) {
      throw new FileNotFoundError(fileId);
    }

    // Step 3: Check permissions
    const hasPermission = await this.fileRepository.checkUserPermissions(
      userId,
      fileRecord.folderId,
      "delete"
    );

    if (!hasPermission) {
      throw new PermissionDeniedError(`file ${fileId}`);
    }

    // Step 4: Get all versions if needed
    const versions = await this.fileRepository.findVersionsByFileId(fileId);
    const storageKeys = versions.map((v) => v.storageKey);

    // Step 5: Delete from MinIO
    try {
      if (storageKeys.length > 1) {
        await this.minioClient.deleteFiles(storageKeys);
      } else if (storageKeys.length === 1) {
        await this.minioClient.deleteFile(storageKeys[0]);
      }
    } catch (error) {
      throw new FileServiceError(
        "Failed to delete file from storage",
        "STORAGE_DELETE_FAILED",
        500,
        error
      );
    }

    try {
      if (hardDelete) {
        await this.fileRepository.hardDelete(fileId);
      } else {
        await this.fileRepository.softDelete(fileId);
      }
    } catch (error) {
      throw new FileServiceError(
        "Failed to delete file metadata",
        "METADATA_DELETE_FAILED",
        500,
        error
      );
    }
  }

  /**
   * Creates a new version of an existing file.
   */
  async createNewVersion(
    tenantId: string,
    fileId: string,
    userId: string,
    file: UploadedFile,
    options?: FileUploadOptions
  ): Promise<FileMetadata> {
    // Step 1: Validate existing file
    const existingFile = await this.fileRepository.findById(fileId, tenantId);

    if (!existingFile) {
      throw new FileNotFoundError(fileId);
    }

    // Step 2: Check permissions
    const hasPermission = await this.fileRepository.checkUserPermissions(
      userId,
      existingFile.folderId,
      "write"
    );

    if (!hasPermission) {
      throw new PermissionDeniedError(`file ${fileId}`);
    }

    // Step 3: Validate new file
    await this.validateFileConstraints(file, options);

    // Step 4: Generate new storage key
    const storageKey = this.generateStorageKey(tenantId, existingFile.name);

    // Step 5: Upload to MinIO
    try {
      await this.minioClient.uploadFile(storageKey, file.buffer, {
        contentType: file.mimetype,
        metadata: {
          originalName: existingFile.name,
          tenantId: tenantId,
          uploadedBy: userId,
          versionNumber: String(existingFile.versionNumber + 1),
        },
      });
    } catch (error) {
      throw new FileServiceError(
        "Failed to upload new version to storage",
        "STORAGE_UPLOAD_FAILED",
        500,
        error
      );
    }

    // Step 6: Update metadata
    try {
      return await this.fileRepository.create({
        tenantId,
        folderId: existingFile.folderId,
        name: existingFile.name,
        storageKey,
        size: file.size,
        mimeType: file.mimetype,
        versionNumber: existingFile.versionNumber + 1,
      });
    } catch (error) {
      // Rollback
      try {
        await this.minioClient.deleteFile(storageKey);
      } catch (rollbackError) {
        console.error("Failed to rollback version upload:", rollbackError);
      }

      throw new FileServiceError(
        "Failed to save version metadata",
        "METADATA_SAVE_FAILED",
        500,
        error
      );
    }
  }

  /**
   * Gets file information without downloading it.
   */
  async getFileInfo(
    tenantId: string,
    fileId: string,
    userId: string
  ): Promise<FileMetadata> {
    const fileRecord = await this.fileRepository.findById(fileId, tenantId);

    if (!fileRecord) {
      throw new FileNotFoundError(fileId);
    }

    const hasPermission = await this.fileRepository.checkUserPermissions(
      userId,
      fileRecord.folderId,
      "read"
    );

    if (!hasPermission) {
      throw new PermissionDeniedError(`file ${fileId}`);
    }

    return fileRecord;
  }

  //get preview

  // =========================================================================
  // PRIVATE VALIDATION METHODS
  // =========================================================================

  private validateUploadInputs(
    tenantId: string,
    folderId: string,
    userId: string,
    file: UploadedFile
  ): void {
    if (!tenantId || !folderId || !userId) {
      throw new FileServiceError(
        "Tenant ID, Folder ID, and User ID are required",
        "INVALID_INPUT",
        400
      );
    }

    if (!file || !file.buffer || !file.originalname) {
      throw new FileServiceError(
        "Invalid file data provided",
        "INVALID_FILE_DATA",
        400
      );
    }
  }

  private async validateFileConstraints(
    file: UploadedFile,
    options?: FileUploadOptions
  ): Promise<void> {
    // Validate file size
    const maxSize = options?.maxFileSize || this.DEFAULT_MAX_FILE_SIZE;
    if (file.size > maxSize) {
      throw new FileTooLargeError(file.size, maxSize);
    }

    // Validate MIME type
    const allowedTypes =
      options?.allowedMimeTypes || this.DEFAULT_ALLOWED_MIME_TYPES;
    if (allowedTypes.length > 0 && !allowedTypes.includes(file.mimetype)) {
      throw new InvalidFileTypeError(file.mimetype, allowedTypes);
    }

    // Additional validation: Check if buffer is actually a valid file
    if (file.buffer.length === 0) {
      throw new FileServiceError("File buffer is empty", "EMPTY_FILE", 400);
    }
  }

  private async validateFolderAccess(
    folderId: string,
    tenantId: string,
    userId: string
  ): Promise<void> {
    // Check folder exists
    const folderExists = await this.fileRepository.checkFolderExists(
      folderId,
      tenantId
    );

    if (!folderExists) {
      throw new FolderNotFoundError(folderId);
    }

    // Check user has write permission to folder
    const hasPermission = await this.fileRepository.checkUserPermissions(
      userId,
      folderId,
      "write"
    );

    if (!hasPermission) {
      throw new PermissionDeniedError(`folder ${folderId}`);
    }
  }

  // =========================================================================
  // PRIVATE UTILITY METHODS
  // =========================================================================

  


  private generateStorageKey(tenantId: string, fileName: string): string {
    const fileExt = path.extname(fileName);
    const uniqueId = uuidv4();
    const timestamp = Date.now();

    return `${tenantId}/${timestamp}-${uniqueId}${fileExt}`;
  }

  private sanitizeFileName(fileName: string): string {
    // Remove or replace dangerous characters
    const sanitized = fileName
      .replace(/[^a-zA-Z0-9._-]/g, "_") // Replace special chars with underscore
      .replace(/_{2,}/g, "_") // Replace multiple underscores with single
      .replace(/^_+|_+$/g, "") // Remove leading/trailing underscores
      .toLowerCase();

    // Ensure the filename isn't empty after sanitization
    if (!sanitized || sanitized === "") {
      return `file_${Date.now()}`;
    }

    // Limit filename length (keep extension)
    const ext = path.extname(sanitized);
    const nameWithoutExt = path.basename(sanitized, ext);
    const maxLength = 200;

    if (nameWithoutExt.length > maxLength) {
      return nameWithoutExt.substring(0, maxLength) + ext;
    }

    return sanitized;
  }

  
}
