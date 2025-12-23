import swaggerAutogen from "swagger-autogen";

const doc = {
  info: {
    title: "FileSystem API",
    version: "1.0.0",
    description: "API for managing tenants and folders",
  },
  host: "localhost:3000",
  schemes: ["http"],
  tags: [
    { name: "Tenants", description: "Tenant management" },
    { name: "Folders", description: "Folder management" },
  ],
};

const outputFile = "./swagger-output.json";
const endpointsFiles = ["./src/index.ts"];

swaggerAutogen()(outputFile, endpointsFiles, doc);
