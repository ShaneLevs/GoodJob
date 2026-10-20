import type { ChatRole } from "@shared/types";

export interface UiMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Assistant message still receiving tokens. */
  streaming?: boolean;
  /** Stream ended with an error; content holds the reason instead of a reply. */
  failed?: boolean;
}
