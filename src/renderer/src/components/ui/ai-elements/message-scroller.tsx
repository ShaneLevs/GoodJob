import { ArrowDown } from "lucide-react"
import * as React from "react"
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller"
import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>
) {
  return <MessageScrollerPrimitive.Provider {...props} />
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

function setRef<T>(ref: React.Ref<T> | undefined, node: T | null): void {
  if (typeof ref === "function") ref(node)
  else if (ref != null) (ref as React.MutableRefObject<T | null>).current = node
}

function MessageScrollerViewport({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  // 原生滚动条按容器隐藏，改由旁边这条细滚动条接管（见 MessageScrollerScrollbar）。
  const viewportRef = React.useRef<HTMLDivElement | null>(null)
  const setViewportRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      viewportRef.current = node
      setRef(ref, node)
    },
    [ref]
  )

  return (
    <>
      <MessageScrollerPrimitive.Viewport
        data-slot="message-scroller-viewport"
        ref={setViewportRef}
        className={cn(
          "size-full min-h-0 min-w-0 scroll-fade-b scrollbar-none overflow-y-auto overscroll-contain contain-content data-pending-scroll:invisible",
          className
        )}
        {...props}
      />
      <MessageScrollerScrollbar viewportRef={viewportRef} />
    </>
  )
}

interface ScrollbarMetrics {
  scrollable: boolean
  thumbHeight: number
  thumbTop: number
}

const HIDDEN_SCROLLBAR: ScrollbarMetrics = {
  scrollable: false,
  thumbHeight: 0,
  thumbTop: 0,
}

/**
 * 消息区的自绘滚动条：只有内容溢出时才出现，滚轮 / 拖动时短暂显现，
 * 指针悬停在消息区时也会显示。原生滚动条由 viewport 的 scrollbar-none 隐藏。
 */
function MessageScrollerScrollbar({
  viewportRef,
}: {
  viewportRef: React.RefObject<HTMLDivElement | null>
}) {
  const [metrics, setMetrics] = React.useState<ScrollbarMetrics>(HIDDEN_SCROLLBAR)
  const [scrolling, setScrolling] = React.useState(false)
  const dragRef = React.useRef<{ startY: number; startScrollTop: number } | null>(null)
  const hideTimerRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null) return

    const update = (): void => {
      const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      const scrollable = maxScroll > 1
      const thumbHeight = scrollable
        ? Math.max(24, (viewport.clientHeight / viewport.scrollHeight) * viewport.clientHeight)
        : 0
      const maxThumbTop = Math.max(0, viewport.clientHeight - thumbHeight)
      const thumbTop = maxScroll > 0 ? (viewport.scrollTop / maxScroll) * maxThumbTop : 0
      setMetrics((previous) =>
        previous.scrollable === scrollable &&
        Math.abs(previous.thumbHeight - thumbHeight) < 0.5 &&
        Math.abs(previous.thumbTop - thumbTop) < 0.5
          ? previous
          : { scrollable, thumbHeight, thumbTop }
      )
    }

    const onScroll = (): void => {
      update()
      // 自动跟随（流式输出）时不需要提示用户“正在滚”：那是程序在滚。
      const root = viewport.closest('[data-slot="message-scroller"]')
      if (root instanceof HTMLElement && root.hasAttribute("data-autoscrolling")) return
      setScrolling(true)
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null
        if (dragRef.current === null) setScrolling(false)
      }, 1000)
    }

    update()
    viewport.addEventListener("scroll", onScroll, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    const content = viewport.querySelector('[data-slot="message-scroller-content"]')
    if (content instanceof HTMLElement) observer.observe(content)
    return () => {
      viewport.removeEventListener("scroll", onScroll)
      observer.disconnect()
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [viewportRef])

  const scrollToPointer = (clientY: number, track: HTMLElement): void => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const maxScroll = viewport.scrollHeight - viewport.clientHeight
    if (maxScroll <= 0) return
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
    viewport.scrollTop = ratio * maxScroll
  }

  const onTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    event.preventDefault()
    scrollToPointer(event.clientY, event.currentTarget)
  }

  const onThumbPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const viewport = viewportRef.current
    if (viewport === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { startY: event.clientY, startScrollTop: viewport.scrollTop }
    setScrolling(true)
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }

  const onThumbPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const viewport = viewportRef.current
    if (drag === null || viewport === null) return
    const maxScroll = viewport.scrollHeight - viewport.clientHeight
    const maxThumbTop = Math.max(0, viewport.clientHeight - metrics.thumbHeight)
    if (maxScroll <= 0 || maxThumbTop <= 0) return
    const delta = ((event.clientY - drag.startY) / maxThumbTop) * maxScroll
    viewport.scrollTop = drag.startScrollTop + delta
  }

  const endThumbDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setScrolling(false)
  }

  return (
    <div
      data-slot="message-scroller-scrollbar"
      aria-hidden="true"
      data-active={scrolling ? "true" : "false"}
      className={cn(
        "absolute inset-y-0 end-0 z-20 w-3.5 touch-none select-none opacity-0 transition-opacity duration-200 group-hover/message-scroller:opacity-100 data-[active=true]:opacity-100",
        !metrics.scrollable && "pointer-events-none"
      )}
    >
      <div
        className={cn(
          "group/scrollbar absolute inset-0 flex justify-center",
          metrics.scrollable ? "pointer-events-auto" : "pointer-events-none"
        )}
        onPointerDown={onTrackPointerDown}
      >
        <div
          role="presentation"
          className="w-1 cursor-default rounded-full bg-foreground/15 transition-[width,background-color] duration-150 group-hover/scrollbar:w-1.5 group-hover/scrollbar:bg-foreground/30 active:bg-foreground/40"
          style={{ height: metrics.thumbHeight, transform: `translateY(${metrics.thumbTop}px)` }}
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={endThumbDrag}
          onPointerCancel={endThumbDrag}
        />
      </div>
    </div>
  )
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn("flex h-max min-h-full flex-col gap-8", className)}
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn(
        "min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerButton({
  direction = "end",
  className,
  children,
  render,
  variant = "secondary",
  size = "icon-sm",
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      data-variant={variant}
      data-size={size}
      direction={direction}
      className={cn(
        "absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180",
        className
      )}
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    >
      {children ?? (
        <>
          <ArrowDown />
          <span className="sr-only">
            {direction === "end" ? "Scroll to end" : "Scroll to start"}
          </span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  )
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}
