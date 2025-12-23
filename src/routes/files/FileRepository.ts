// src/repositories/FileRepository.ts
import {
  FileMetadata,
  FileRepository,
} from "../../services/FilesManagement/FileService";

export class PrismaFileRepository implements FileRepository {
  constructor(private prisma: any) {} // Use your PrismaClient type

  async findById(
    fileId: string,
    tenantId: string
  ): Promise<FileMetadata | null> {
    try {
      const file = await this.prisma.file.findFirst({
        where: {
          id: fileId,
          tenantId: tenantId,
          // No deletedAt field in your schema, so removed
        },
        include: {
          currentVersion: true, // Get the latest version info
        },
      });

      if (!file) return null;

      return this.mapToFileMetadata(file);
    } catch (error) {
      console.error("Error finding file by ID:", error);
      throw new Error("Database query failed");
    }
  }

  async findByStorageKey(
    storageKey: string,
    tenantId: string
  ): Promise<FileMetadata | null> {
    try {
      const fileVersion = await this.prisma.fileVersion.findFirst({
        where: {
          storageKey: storageKey,
          file: {
            tenantId: tenantId,
          },
        },
        include: {
          file: true,
        },
      });

      if (!fileVersion) return null;

      return this.mapToFileMetadata(fileVersion.file, fileVersion);
    } catch (error) {
      console.error("Error finding file by storage key:", error);
      throw new Error("Database query failed");
    }
  }

  async create(
    metadata: Omit<FileMetadata, "id" | "createdAt" | "updatedAt">
  ): Promise<FileMetadata> {
    try {
      // Use a transaction to ensure both file and version are created atomically
      const result = await this.prisma.$transaction(async (tx: any) => {
        // Create the file
        const file = await tx.file.create({
          data: {
            tenantId: metadata.tenantId,
            folderId: metadata.folderId,
            name: metadata.name,
            mimeType: metadata.mimeType,
          },
        });

        // Create the initial version
        const version = await tx.fileVersion.create({
          data: {
            fileId: file.id,
            storageKey: metadata.storageKey,
            storageBucket: process.env.MINIO_BUCKET || "file-storage", // Add bucket info
            versionNumber: metadata.versionNumber,
            size: metadata.size,
          },
        });

        // Update file to point to current version
        await tx.file.update({
          where: { id: file.id },
          data: { currentVersionId: version.id },
        });

        return { ...file, currentVersion: version };
      });

      return this.mapToFileMetadata(result);
    } catch (error) {
      console.error("Error creating file:", error);
      throw new Error("Failed to create file record");
    }
  }

  async update(
    fileId: string,
    updates: Partial<FileMetadata>
  ): Promise<FileMetadata> {
    try {
      const file = await this.prisma.file.update({
        where: { id: fileId },
        data: {
          name: updates.name,
          // Note: size and mimeType are on FileVersion, not File in your schema
          updatedAt: new Date(),
        },
        include: {
          currentVersion: true,
        },
      });

      return this.mapToFileMetadata(file);
    } catch (error) {
      console.error("Error updating file:", error);
      throw new Error("Failed to update file record");
    }
  }

  async softDelete(fileId: string): Promise<void> {
    try {
      // Your schema doesn't have soft delete (deletedAt), so use hard delete
      // Or you need to add deletedAt to your File model
      await this.hardDelete(fileId);
    } catch (error) {
      console.error("Error deleting file:", error);
      throw new Error("Failed to delete file");
    }
  }

  async hardDelete(fileId: string): Promise<void> {
    try {
      // Delete in transaction: versions first, then file
      await this.prisma.$transaction(async (tx: any) => {
        await tx.fileVersion.deleteMany({
          where: { fileId: fileId },
        });

        await tx.file.delete({
          where: { id: fileId },
        });
      });
    } catch (error) {
      console.error("Error hard deleting file:", error);
      throw new Error("Failed to hard delete file");
    }
  }

  async findVersionsByFileId(fileId: string): Promise<FileMetadata[]> {
    try {
      const versions = await this.prisma.fileVersion.findMany({
        where: { fileId: fileId },
        include: {
          file: true,
        },
        orderBy: {
          versionNumber: "desc",
        },
      });

      return versions.map((version: any) =>
        this.mapToFileMetadata(version.file, version)
      );
    } catch (error) {
      console.error("Error finding versions:", error);
      throw new Error("Failed to retrieve file versions");
    }
  }

  async checkFolderExists(
    folderId: string,
    tenantId: string
  ): Promise<boolean> {
    try {
      const folder = await this.prisma.folder.findFirst({
        where: {
          id: folderId,
          tenantId: tenantId,
          // No 'type' field in your Folder model, removed
          // No deletedAt field, removed
        },
      });

      return !!folder;
    } catch (error) {
      console.error("Error checking folder existence:", error);
      return false;
    }
  }

  async checkUserPermissions(
    userId: string,
    folderId: string,
    permission: string
  ): Promise<boolean> {
    try {
      // Check if user is a tenant member with access to this tenant
      const folder = await this.prisma.folder.findFirst({
        where: {
          id: folderId,
        },
        include: {
          tenant: {
            include: {
              members: {
                where: {
                  userId: userId,
                },
              },
            },
          },
        },
      });

      if (!folder) return false;

      // User has access if they're a member of the tenant
      return folder.tenant.members.length > 0;
    } catch (error) {
      console.error("Error checking user permissions:", error);
      return false;
    }
  }

  // Helper method to map database model to FileMetadata interface
  private mapToFileMetadata(file: any, version?: any): FileMetadata {
    const currentVersion = version || file.currentVersion;

    return {
      id: file.id,
      tenantId: file.tenantId,
      folderId: file.folderId,
      name: file.name,
      storageKey: currentVersion?.storageKey || "",
      size: currentVersion?.size?.toString() || "0", // Size is BigInt in schema
      mimeType: currentVersion?.mimeType || file.mimeType,
      versionNumber: currentVersion?.versionNumber || 1,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    };
  }
}
