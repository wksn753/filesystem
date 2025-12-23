// src/config/logger/index.ts
import { appLogger } from "./winston";

export class LoggingService {
  static info(message: string): void {
    appLogger.info(message);
  }

  static error(message: string): void {
    appLogger.error(message);
  }

  static warn(message: string): void {
    appLogger.warn(message);
  }

  static debug(message: string): void {
    appLogger.debug(message);
  }
}

export { httpLogger } from "./morgan";
