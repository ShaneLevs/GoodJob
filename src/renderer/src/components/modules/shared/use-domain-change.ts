import { useEffect, useRef } from "react";

import type { DomainEntity } from "@shared/types";

/**
 * 订阅领域集合变更：Agent 工具（以及任何别的入口）写完 companies / jobs /
 * applications / interviews 之后，main 会广播集合名，这里把它们折算成一次重拉。
 *
 * 为什么需要：模块页只在挂载时拉一次数据，而 Agent 是在同一页右边的对话里写库的。
 * 没有这个订阅，用户得切一次模块才看得见 Agent 刚建的岗位 / 公司。
 *
 * 150ms 防抖：一次建档（公司 + 岗位）会连发两条事件，合并成一次刷新。
 */
export function useDomainChange(entities: readonly DomainEntity[], handler: () => void): void {
  const latest = useRef(handler);
  latest.current = handler;

  // entities 是字面量数组，每次渲染都是新引用；用拼接出来的字符串当依赖。
  const key = entities.join(",");

  useEffect(() => {
    const watched = new Set(key === "" ? [] : key.split(","));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.goodjob.domain.onChanged((event) => {
      if (!watched.has(event.entity)) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        latest.current();
      }, 150);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      off();
    };
  }, [key]);
}
