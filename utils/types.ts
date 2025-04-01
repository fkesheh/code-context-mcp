/**
 * Common interfaces and types used across the codebase
 */

/**
 * Interface for objects that can send progress notifications
 */
export interface ProgressNotifier {
  sendProgress: (progress: number, total: number) => Promise<void>;
}
