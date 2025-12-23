// Type definitions for raw queries
type FolderChild = {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
};

type FolderWithPath = {
  id: string;
  name: string;
  path: string;
  depth: number;
};

type ParentFolderInfo = {
  id: string;
  tenantId: string;
  path: string;
};

type FolderPathInfo = {
  path: string;
  parentId: string | null;
};
