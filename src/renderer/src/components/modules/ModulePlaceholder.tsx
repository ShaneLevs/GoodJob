import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

import type { ModuleMeta } from "@/modules";

/** P2 以后才有的模块：占位说明页，保持导航结构完整。 */
export function ModulePlaceholder({ module }: { module: ModuleMeta }) {
  return (
    <div className="flex h-full items-center justify-center rounded-2xl bg-card shadow-sm">
      <Empty className="max-w-sm">
        <EmptyHeader>
          <EmptyMedia variant="icon">{module.icon}</EmptyMedia>
          <EmptyTitle>{module.label}</EmptyTitle>
          <EmptyDescription>
            {module.planned !== undefined
              ? `「${module.label}」模块计划在 ${module.planned} 交付。在那之前，简历相关的准备都可以先在「简历」里完成。`
              : "这个模块还没有开放。"}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
