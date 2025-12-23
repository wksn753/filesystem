// src/config/logger/winston.ts
import { createLogger, format, transports } from "winston";
import path from "path";

const { combine, timestamp, printf, json } = format;

const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level.toUpperCase()}]: ${message}`;
});

export const appLogger = createLogger({
  level: "info",
  format: combine(timestamp(), json()),
  transports: [
    new transports.Console({
      format: combine(timestamp(), logFormat),
    }),
    new transports.File({
      filename: path.join("logs", "app", "error.log"),
      level: "error",
    }),
    new transports.File({
      filename: path.join("logs", "app", "combined.log"),
    }),
  ],
});
