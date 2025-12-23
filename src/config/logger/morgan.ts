// src/config/logger/morgan.ts
import morgan from "morgan";
import { createStream } from "rotating-file-stream";
import path from "path";

const accessLogStream = createStream("access.log", {
  interval: "1d", // rotate daily
  size: "10M", // optional: rotate by size
  path: path.join("logs", "access"),
  compress: "gzip",
  maxFiles: 30,
});

export const httpLogger = morgan("combined", {
  stream: accessLogStream,
});
