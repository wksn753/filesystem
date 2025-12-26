import swaggerAutogen from "swagger-autogen";

const doc = {
  info: {
    title: "File System API",
    description: "API documentation for the File System service",
    version: "1.0.0",
  },
  host: `localhost:${process.env.PORT || 3000}`,
  schemes: ["http"],
  basePath: "/api/v1",
};

const outputFile = "./src/swagger-output.json";

const endpointsFiles = [
  "./src/index.ts",
  "./src/routes/auth/authRoutes.ts",
  "./src/routes/tenants/tenantRouter.ts",
  "./src/routes/folders/folderRouter.ts",
  "./src/routes/files/fileRouter.ts",
];

swaggerAutogen({ openapi: "3.0.0" })(outputFile, endpointsFiles, doc);
