import { useEffect, useState } from "react";

import {
  CircleAlert,
  CircleCheck,
  Download,
  ExternalLink,
  Info,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { siGithub } from "simple-icons";

import bee from "@/assets/bee.svg";
import {
  APP_REPOSITORY_URL,
  type AppInfo,
  type UpdateState,
} from "@shared/types";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";

/**
 * 设置 → 关于：版本、GitHub 仓库、自动更新。
 *
 * 更新状态由 main 的 UpdateService 推送；这里不直接发网络请求。
 * 开发模式（未打包）没有 app-update.yml，检查入口直接禁用并说明原因。
 */
export function AboutSettings() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.goodjob.app.info().then((next) => {
      if (alive) setInfo(next);
    });
    void window.goodjob.update.getState().then((next) => {
      if (alive) setUpdate(next);
    });
    const unsubscribe = window.goodjob.update.onState(setUpdate);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const version = update?.currentVersion ?? info?.version ?? "—";

  const check = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      setUpdate(await window.goodjob.update.check());
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const download = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      setUpdate(await window.goodjob.update.download());
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const openExternal = (url: string): void => {
    void window.goodjob.app.openExternal(url).catch((cause: unknown) => {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold tracking-tight">关于</h1>
      <p className="mt-1 text-sm text-muted-foreground">版本信息、开源仓库与自动更新。</p>

      <div className="mt-6 flex items-center gap-3 rounded-xl border p-4">
        <img src={bee} alt="" className="size-12 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">GoodJob</p>
          <p className="mt-0.5 text-xs text-muted-foreground">本地优先的求职全流程桌面 Agent</p>
        </div>
        <Badge variant="secondary" className="ml-auto font-mono">
          v{version}
        </Badge>
      </div>

      <div className="mt-4 divide-y rounded-xl border">
        <div className="flex items-center justify-between gap-6 p-4">
          <div className="min-w-0">
            <Label className="text-sm font-medium">版本</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              v{version} · {platformLabel(info?.platform)}
            </p>
          </div>
          <Button variant="outline" onClick={() => openExternal(APP_REPOSITORY_URL)}>
            <GithubMark />
            GitHub 仓库
            <ExternalLink data-icon="inline-end" />
          </Button>
        </div>

        <div className="p-4">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Label className="text-sm font-medium">自动更新</Label>
                {update !== null && <UpdateBadge state={update} />}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {update === null ? "正在读取更新状态…" : phaseText(update)}
              </p>
              {update !== null && update.checkedAt !== null && (
                <p className="mt-1 text-[11px] text-muted-foreground/80">
                  上次检查：{formatCheckedAt(update.checkedAt)}
                </p>
              )}
              {(notice ?? update?.error ?? null) !== null && (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span>{notice ?? update?.error}</span>
                </p>
              )}
              {update?.phase === "downloading" && (
                <div className="mt-3 max-w-sm">
                  <Progress value={update.progress ?? 0} />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {update.progress ?? 0}%
                  </p>
                </div>
              )}
            </div>

            <div className="flex shrink-0 flex-col items-end gap-2">
              <UpdateAction
                state={update}
                busy={busy}
                onCheck={() => void check()}
                onDownload={() => void download()}
                onInstall={() => window.goodjob.update.install()}
              />
              {update !== null && update.releaseUrl !== null && (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto px-0 text-xs"
                  onClick={() => openExternal(update.releaseUrl ?? "")}
                >
                  查看 Release
                  <ExternalLink data-icon="inline-end" />
                </Button>
              )}
            </div>
          </div>

          {update !== null && update.releaseNotes !== null && (
            <div className="mt-4 rounded-lg bg-muted/50 p-3">
              <p className="text-xs font-medium">
                {update.releaseName ?? `v${update.latestVersion}`} 更新内容
              </p>
              <p className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {update.releaseNotes}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-6 p-4">
          <div className="min-w-0">
            <Label className="text-sm font-medium">启动时自动检查</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              启动后自动检查 GitHub Releases；有更新时后台下载，退出时自动安装。
            </p>
          </div>
          <Switch
            checked={update?.autoCheck ?? true}
            disabled={update === null || !update.supported}
            onCheckedChange={(checked) => {
              void window.goodjob.update.setAutoCheck(checked).then(setUpdate);
            }}
            aria-label="启动时自动检查更新"
          />
        </div>
      </div>

      <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        检查更新只会访问 GitHub；简历、岗位与对话数据始终留在本机。
      </p>
    </div>
  );
}

function UpdateBadge({ state }: { state: UpdateState }) {
  switch (state.phase) {
    case "available":
    case "downloading":
      return <Badge variant="default">发现新版本</Badge>;
    case "downloaded":
      return <Badge variant="secondary">待重启安装</Badge>;
    case "up-to-date":
      return (
        <Badge variant="secondary">
          <CircleCheck data-icon="inline-start" />
          已是最新
        </Badge>
      );
    case "error":
      return <Badge variant="destructive">检查失败</Badge>;
    case "unsupported":
      return <Badge variant="outline">开发模式</Badge>;
    case "checking":
      return <Badge variant="outline">检查中</Badge>;
    default:
      return null;
  }
}

interface UpdateActionProps {
  state: UpdateState | null;
  busy: boolean;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}

function UpdateAction({ state, busy, onCheck, onDownload, onInstall }: UpdateActionProps) {
  if (state === null) return null;
  if (!state.supported) {
    return <span className="text-xs text-muted-foreground">仅打包版本支持</span>;
  }
  if (state.phase === "downloading") {
    return (
      <Button variant="outline" disabled>
        <LoaderCircle className="animate-spin" data-icon="inline-start" />
        下载中 {state.progress ?? 0}%
      </Button>
    );
  }
  if (state.phase === "checking" || busy) {
    return (
      <Button variant="outline" disabled>
        <LoaderCircle className="animate-spin" data-icon="inline-start" />
        检查中
      </Button>
    );
  }
  if (state.phase === "downloaded") {
    return <Button onClick={onInstall}>重启并安装</Button>;
  }
  if (state.phase === "available") {
    return (
      <Button onClick={onDownload}>
        <Download data-icon="inline-start" />
        下载更新
      </Button>
    );
  }
  return (
    <Button variant="outline" onClick={onCheck}>
      <RefreshCw data-icon="inline-start" />
      检查更新
    </Button>
  );
}

function phaseText(state: UpdateState): string {
  switch (state.phase) {
    case "idle":
      return "还没有检查过更新。";
    case "checking":
      return "正在检查 GitHub Releases…";
    case "up-to-date":
      return "当前已是最新版本。";
    case "available":
      return `发现新版本 v${state.latestVersion}，可以开始下载。`;
    case "downloading":
      return `正在下载 v${state.latestVersion}（${state.progress ?? 0}%）。`;
    case "downloaded":
      return `v${state.latestVersion} 已下载，重启应用完成安装。`;
    case "error":
      return "检查更新失败，可以稍后重试。";
    case "unsupported":
      return "开发模式下不检查更新；打包后的应用会自动检查。";
  }
}

function platformLabel(platform: string | undefined): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform ?? "桌面端";
  }
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4 fill-current" data-icon="inline-start">
      <path d={siGithub.path} />
    </svg>
  );
}
