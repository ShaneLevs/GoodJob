import type { GoodjobApi } from "@shared/types";

declare global {
  interface Window {
    readonly goodjob: GoodjobApi;
  }
}

export {};
