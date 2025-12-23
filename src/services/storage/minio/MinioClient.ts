import * as Minio from "minio";
import { Stream, Readable } from "stream";

export interface MinioConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  region?: string;
}

export interface UploadOptions {
  metadata?: Record<string, string>;
  contentType?: string;
}

export interface FileInfo {
  name: string;
  size: number;
  etag: string;
  lastModified: Date;
  contentType?: string;
}

export class MinioClientError extends Error {
  constructor(message: string, public readonly originalError?: Error) {
    super(message);
    this.name = "MinioClientError";
  }
}

export class MinioClient {
  private minioClient: Minio.Client;
  private bucketName: string;
  private initialized: boolean = false;

  constructor(bucketName: string, config?: Partial<MinioConfig>) {
    if (!bucketName) {
      throw new MinioClientError("Bucket name is required");
    }

    this.bucketName = bucketName;

    // Initialize MinIO client with config or environment variables
    const minioConfig: MinioConfig = {
      endPoint: config?.endPoint || process.env.MINIO_ENDPOINT || "127.0.0.1",
      port: config?.port || parseInt(process.env.MINIO_PORT || "9000"),
      useSSL: config?.useSSL ?? process.env.MINIO_USE_SSL === "true",
      accessKey:
        config?.accessKey || process.env.MINIO_ACCESS_KEY || "minioadmin",
      secretKey:
        config?.secretKey || process.env.MINIO_SECRET_KEY || "minioadmin",
      region: config?.region || process.env.MINIO_REGION,
    };

    this.minioClient = new Minio.Client(minioConfig);
  }

  /**
   * Initializes the client by ensuring the bucket exists.
   * Call this before using other methods, or they will auto-initialize.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const exists = await this.minioClient.bucketExists(this.bucketName);
      if (!exists) {
        await this.minioClient.makeBucket(this.bucketName);
        console.log(`Bucket '${this.bucketName}' created successfully`);
      }
      this.initialized = true;
    } catch (error) {
      throw new MinioClientError(
        `Failed to initialize bucket '${this.bucketName}'`,
        error as Error
      );
    }
  }

  /**
   * Ensures the client is initialized before operations.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Uploads a file buffer or stream to MinIO.
   * @param objectName The unique key for the file in the bucket.
   * @param stream The file data (Buffer or Readable stream).
   * @param options Optional metadata and content type.
   */
  async uploadFile(
    objectName: string,
    stream: Buffer | Readable,
    options?: UploadOptions
  ): Promise<{ etag: string; versionId?: string | null }> {
    await this.ensureInitialized();

    if (!objectName) {
      throw new MinioClientError("Object name is required");
    }

    try {
      const metadata: Minio.ItemBucketMetadata = {
        ...options?.metadata,
      };

      if (options?.contentType) {
        metadata["Content-Type"] = options.contentType;
      }

      // For Buffer, we know the size
      if (Buffer.isBuffer(stream)) {
        const result = await this.minioClient.putObject(
          this.bucketName,
          objectName,
          stream,
          stream.length,
          metadata
        );
        return {
          etag: result.etag,
          versionId: result.versionId || null,
        };
      }

      // For streams, use putObject without size (MinIO handles it)
      const result = await this.minioClient.putObject(
        this.bucketName,
        objectName,
        stream,
        //metadata
      );
      return {
        etag: result.etag,
        versionId: result.versionId || null,
      };
    } catch (error) {
      throw new MinioClientError(
        `Failed to upload file '${objectName}'`,
        error as Error
      );
    }
  }

  /**
   * Retrieves a file as a Readable Stream from MinIO.
   * @param objectName The unique key for the file in the bucket.
   */
  async downloadFile(objectName: string): Promise<Readable> {
    await this.ensureInitialized();

    if (!objectName) {
      throw new MinioClientError("Object name is required");
    }

    try {
      const exists = await this.fileExists(objectName);
      if (!exists) {
        throw new MinioClientError(`File '${objectName}' does not exist`);
      }

      return await this.minioClient.getObject(this.bucketName, objectName);
    } catch (error) {
      if (error instanceof MinioClientError) throw error;
      throw new MinioClientError(
        `Failed to download file '${objectName}'`,
        error as Error
      );
    }
  }

  /**
   * Downloads a file as a Buffer.
   * @param objectName The unique key for the file in the bucket.
   */
  async downloadFileAsBuffer(objectName: string): Promise<Buffer> {
    const stream = await this.downloadFile(objectName);

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", (error) =>
        reject(
          new MinioClientError(
            `Failed to read stream for '${objectName}'`,
            error
          )
        )
      );
    });
  }

  /**
   * Deletes a file from MinIO.
   * @param objectName The unique key for the file in the bucket.
   */
  async deleteFile(objectName: string): Promise<void> {
    await this.ensureInitialized();

    if (!objectName) {
      throw new MinioClientError("Object name is required");
    }

    try {
      await this.minioClient.removeObject(this.bucketName, objectName);
    } catch (error) {
      throw new MinioClientError(
        `Failed to delete file '${objectName}'`,
        error as Error
      );
    }
  }

  /**
   * Deletes multiple files from MinIO.
   * @param objectNames Array of object names to delete.
   */
  async deleteFiles(objectNames: string[]): Promise<void> {
    await this.ensureInitialized();

    if (!objectNames || objectNames.length === 0) {
      return;
    }

    try {
      await this.minioClient.removeObjects(this.bucketName, objectNames);
    } catch (error) {
      throw new MinioClientError(
        `Failed to delete multiple files`,
        error as Error
      );
    }
  }

  /**
   * Checks if a file exists in the bucket.
   * @param objectName The unique key for the file in the bucket.
   */
  async fileExists(objectName: string): Promise<boolean> {
    await this.ensureInitialized();

    try {
      await this.minioClient.statObject(this.bucketName, objectName);
      return true;
    } catch (error: any) {
      if (error.code === "NotFound") {
        return false;
      }
      throw new MinioClientError(
        `Failed to check if file '${objectName}' exists`,
        error
      );
    }
  }

  /**
   * Gets metadata and information about a file.
   * @param objectName The unique key for the file in the bucket.
   */
  async getFileInfo(objectName: string): Promise<FileInfo> {
    await this.ensureInitialized();

    try {
      const stat = await this.minioClient.statObject(
        this.bucketName,
        objectName
      );
      return {
        name: objectName,
        size: stat.size,
        etag: stat.etag,
        lastModified: stat.lastModified,
        contentType: stat.metaData?.["content-type"],
      };
    } catch (error) {
      throw new MinioClientError(
        `Failed to get file info for '${objectName}'`,
        error as Error
      );
    }
  }

  /**
   * Lists all files in the bucket with an optional prefix.
   * @param prefix Optional prefix to filter files.
   * @param recursive Whether to list recursively (default: true).
   */
  async listFiles(
    prefix?: string,
    recursive: boolean = true
  ): Promise<FileInfo[]> {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const files: FileInfo[] = [];
      const stream = this.minioClient.listObjectsV2(
        this.bucketName,
        prefix,
        recursive
      );

      stream.on("data", (obj) => {
        if (obj.name) {
          files.push({
            name: obj.name,
            size: obj.size,
            etag: obj.etag,
            lastModified: obj.lastModified,
          });
        }
      });

      stream.on("end", () => resolve(files));
      stream.on("error", (error) =>
        reject(new MinioClientError("Failed to list files", error))
      );
    });
  }

  /**
   * Generates a presigned URL for downloading a file.
   * @param objectName The unique key for the file in the bucket.
   * @param expirySeconds URL expiry time in seconds (default: 24 hours).
   */
  async getDownloadUrl(
    objectName: string,
    expirySeconds: number = 24 * 60 * 60
  ): Promise<string> {
    await this.ensureInitialized();

    try {
      return await this.minioClient.presignedGetObject(
        this.bucketName,
        objectName,
        expirySeconds
      );
    } catch (error) {
      throw new MinioClientError(
        `Failed to generate download URL for '${objectName}'`,
        error as Error
      );
    }
  }

  /**
   * Generates a presigned URL for uploading a file.
   * @param objectName The unique key for the file in the bucket.
   * @param expirySeconds URL expiry time in seconds (default: 1 hour).
   */
  async getUploadUrl(
    objectName: string,
    expirySeconds: number = 60 * 60
  ): Promise<string> {
    await this.ensureInitialized();

    try {
      return await this.minioClient.presignedPutObject(
        this.bucketName,
        objectName,
        expirySeconds
      );
    } catch (error) {
      throw new MinioClientError(
        `Failed to generate upload URL for '${objectName}'`,
        error as Error
      );
    }
  }

  /**
   * Copies a file from one location to another within the same bucket or across buckets.
   * @param sourceObjectName Source object name.
   * @param destObjectName Destination object name.
   * @param destBucketName Destination bucket (defaults to same bucket).
   */
  async copyFile(
    sourceObjectName: string,
    destObjectName: string,
    destBucketName?: string
  ): Promise<void> {
    await this.ensureInitialized();

    try {
      const conditions = new Minio.CopyConditions();
      await this.minioClient.copyObject(
        destBucketName || this.bucketName,
        destObjectName,
        `/${this.bucketName}/${sourceObjectName}`,
        conditions
      );
    } catch (error) {
      throw new MinioClientError(
        `Failed to copy file from '${sourceObjectName}' to '${destObjectName}'`,
        error as Error
      );
    }
  }

  /**
   * Gets the underlying MinIO client for advanced operations.
   */
  getClient(): Minio.Client {
    return this.minioClient;
  }

  /**
   * Gets the bucket name.
   */
  getBucketName(): string {
    return this.bucketName;
  }
}
