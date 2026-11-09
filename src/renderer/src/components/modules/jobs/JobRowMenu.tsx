import {
  FileText,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Send,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";

import type { Job } from "@shared/types";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function JobRowMenu({
  job,
  hasTailored,
  evaluating,
  onGenerateResume,
  onEvaluate,
  onScript,
  onInterview,
  onAdvance,
  onEdit,
  onDelete,
  onOverlayChange,
}: {
  job: Job;
  hasTailored: boolean;
  evaluating: boolean;
  onGenerateResume: () => void;
  onEvaluate: () => void;
  onScript: () => void;
  onInterview: () => void;
  onAdvance: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOverlayChange: (open: boolean) => void;
}) {
  return (
    <DropdownMenu onOpenChange={onOverlayChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={`「${job.title}」的操作`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          求职流程
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={onGenerateResume}>
          <FileText />
          生成简历{hasTailored ? "" : "（起草）"}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={evaluating} onSelect={onEvaluate}>
          <Sparkles />
          {job.matchReport === null ? "简历评估" : "重新评估"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onScript}>
          <MessageSquareText />
          话术管理
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onInterview}>
          <Users />
          模拟面试
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">投递</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onAdvance}>
          <Send />
          {job.timeline.length === 0 ? "标记投递" : "推进状态"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">数据</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil />
          编辑
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
