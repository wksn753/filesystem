import express from "express";
import { httpLogger } from "./config/logger";
//import { LoggingService } from "./config/logger";
import morgan from "morgan";
import cors from "cors";
import { PrismaClient } from "./generated/prisma/client";
import { AuthService } from "./services/auth/AuthService";
import { AuthMiddleware } from "./middleware/auth";
import { initializeAuthModule } from "./routes/auth/authRoutes";
import {setupTenantRoutes} from "./routes/tenants/tenantRouter";
import {setupFolderRoutes} from "./routes/folders/folderRouter";
import { createFileRouter } from "./routes/files/fileRouter";
import { FileService } from "./services/FilesManagement/FileService";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express";
import swaggerFile from "./swagger-output.json";

dotenv.config();

declare global {
  interface BigInt {
    toJSON(): string;
  }
}


BigInt.prototype.toJSON = function () {
  return this.toString();
};


const app = express();
app.use(express.json());

const prisma = new PrismaClient();


// Morgan HTTP logs
app.use(httpLogger);

//Morgan HTTP logs to console
app.use(morgan('dev'));             // console logs


//
app.use(
  cors({
    origin: "*", // or frontend URL: "http://localhost:5173"
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  })
);
// Swagger UI
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerFile));

app.get("/", (req, res) => {
  const name = process.env.NAME || "World";
  res.send(`Hello ${name}!`); // Fixed: was using template literal in wrong way
});


// Initialize auth
const authService = new AuthService(prisma);
const authMiddleware = new AuthMiddleware(authService, prisma);
const { authRouter } = initializeAuthModule(prisma);

// Initialize file router with dependencies
const fileRouter = createFileRouter(prisma, authMiddleware);

// Initialize tenant router with dependencies
const tenantRouter = setupTenantRoutes(authService, prisma);

// Initialize folder router with dependencies
const folderRouter = setupFolderRoutes(authService, prisma);

// Mount routers
app.use("/api/v1/auth", authRouter);        // Auth routes
app.use("/api/v1/tenants", tenantRouter);
app.use("/api/v1/tenants/:tenantId/folders", folderRouter);
app.use("/api/v1", fileRouter);

// Global error handler
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    console.error("Unhandled error:", err);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: err.message,
    });
  }
);

const port = parseInt(process.env.PORT||"3000");

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing server...");
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, closing server...");
  await prisma.$disconnect();
  process.exit(0);
});
