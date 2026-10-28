import { useEffect, useState } from "react";

import { ChevronDown, CircleAlert, Sparkles } from "lucide-react";

import type { SkillInfo, SkillScenario } from "@shared/types";

import { AssistantMarkdown } from "@/components/chat/AssistantMarkdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SCENARIO_LABELS: Record<SkillScenario, string> = {
  resume: "简历",
  job: "岗位工作台",
  applications: "投递",
  companies: "公司",
  jobs: "岗位库",
  interview: "模拟面试",
};

/**
 * 设置 → Skill 管理：只读展示随应用发布的内置技能。
 * 技能正文由 main 的技能注册表通过 IPC 提供，渲染层不读磁盘。
 */
export function SkillSettings() {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.goodjob.skills
      .list()
      .then((next) => {
        if (alive) setSkills(next);
      })
      .catch((cause: unknown) => {
        if (alive) setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loadError !== null) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <h1 className="text-lg font-semibold tracking-tight">Skill 管理</h1>
        <div className="mt-6 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      </div>
    );
  }

  if (skills === null) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <h1 className="text-lg font-semibold tracking-tight">Skill 管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">正在读取内置技能…</p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold tracking-tight">Skill 管理</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        这些是随应用发布的内置技能。Agent 会在对应的会话里按需读取，这里只读查看。
      </p>

      <div className="mt-6 flex flex-col gap-3">
        {skills.map((skill) => (
          <SkillCard key={skill.name} skill={skill} />
        ))}
      </div>

      <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="size-3.5" />
        技能由应用版本提供，切换工作区不会改变。
      </p>
    </div>
  );
}

function SkillCard({ skill }: { skill: SkillInfo }) {
  const [open, setOpen] = useState(false);
  const [activePath, setActivePath] = useState(skill.files[0]?.path ?? "");
  const activeFile =
    skill.files.find((file) => file.path === activePath) ?? skill.files[0] ?? null;

  return (
    <section className="rounded-xl border">
      <button
        type="button"
        className="flex w-full items-start gap-3 p-4 text-left"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{skill.title}</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {skill.name}
            </code>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{skill.summary}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {skill.scenarios.map((scenario) => (
              <span
                key={scenario}
                className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                {SCENARIO_LABELS[scenario]}
              </span>
            ))}
          </div>
        </div>
        <ChevronDown
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && activeFile !== null && (
        <div className="border-t p-4">
          <div className="flex flex-wrap gap-1.5">
            {skill.files.map((file) => (
              <Button
                key={file.path}
                type="button"
                size="sm"
                variant={file.path === activeFile.path ? "secondary" : "ghost"}
                className="h-7 max-w-full font-mono text-[11px]"
                title={file.path}
                onClick={() => setActivePath(file.path)}
              >
                <span className="truncate">{file.path}</span>
              </Button>
            ))}
          </div>
          <div className="mt-3 max-h-[420px] overflow-auto rounded-lg border bg-muted/30 p-4">
            <AssistantMarkdown>{activeFile.content}</AssistantMarkdown>
          </div>
        </div>
      )}
    </section>
  );
}
