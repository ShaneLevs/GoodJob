import { useEffect, useState } from "react";

import { FileText, Image as ImageIcon, X } from "lucide-react";

import { isImageUploadName, type ConversationKey, type UploadedFileMeta } from "@shared/types";

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/ai-elements/attachment";
import { formatBytes } from "@/lib/format";

interface UploadAttachmentProps {
  file: UploadedFileMeta;
  /** 缩略图要从这个会话的 upload/ 里取；没传时只显示文件图标。 */
  conversationKey?: ConversationKey;
  /** 待发送的附件才有移除按钮；已发出的消息不传。 */
  onRemove?: () => void;
}

/**
 * 对话里的一条上传回执。图片由 main 缩成 320px 的 data URL 再展示，
 * 渲染层拿不到文件系统路径，也不需要把原图塞进消息历史。
 */
export function UploadAttachment({ file, conversationKey, onRemove }: UploadAttachmentProps) {
  const image = isImageUploadName(file.fileName);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!image || conversationKey === undefined) {
      setPreview(null);
      return;
    }
    let alive = true;
    void window.goodjob.chat
      .uploadPreview(conversationKey, file.fileName)
      .then((url) => {
        if (alive) setPreview(url);
      })
      .catch(() => {
        if (alive) setPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [conversationKey, file.fileName, image]);

  return (
    <Attachment size="sm" className="max-w-60">
      <AttachmentMedia variant={image ? "image" : "icon"}>
        {image ? (
          preview === null ? (
            <ImageIcon className="text-muted-foreground" />
          ) : (
            <img src={preview} alt={file.fileName} />
          )
        ) : (
          <FileText />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{file.fileName}</AttachmentTitle>
        <AttachmentDescription>{formatBytes(file.size)}</AttachmentDescription>
      </AttachmentContent>
      {onRemove !== undefined && (
        <AttachmentActions>
          <AttachmentAction
            type="button"
            aria-label={`移除 ${file.fileName}`}
            onClick={onRemove}
          >
            <X />
          </AttachmentAction>
        </AttachmentActions>
      )}
    </Attachment>
  );
}
