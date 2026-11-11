"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"
import { animate } from "motion"

import { haptic } from "@/lib/haptics"

import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 md:supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

// On phones a dialog is a bottom sheet (globals.css): drag this bar down to close it. Only the bar, so scrolling
// the sheet's content is never mistaken for a drag. The sheet stays under the finger; let go, and it carries on
// at the finger's speed to where a throw that fast would land (not to whichever end was nearer); pulled up past
// its place it resists more the further it goes; and it can be caught again mid-flight.
const rubberband = (over: number, limit = 64) => (over * limit * 0.55) / (limit + 0.55 * over)
// where something let go at this speed (px/s) comes to rest: the slowing-down a scrolled list has
const project = (velocity: number, rate = 0.998) => ((velocity / 1000) * rate) / (1 - rate)

// On a phone, opening a sheet doesn't throw the keyboard up over it by focusing its first field: Base UI only
// holds back when its own trigger opened the sheet by touch, and most of ours open from a tapped row instead.
export const noKeyboardOnTouch = (type: string) =>
  type === "touch" || window.matchMedia("(pointer: coarse)").matches ? false : true

export function SheetGrabber() {
  const drag = React.useRef<{ start: number; from: number; y: number; trail: [time: number, y: number][] } | null>(null)
  const flight = React.useRef<{ stop(): void } | null>(null)

  const dimOf = (el: HTMLElement) => el.parentElement?.querySelector<HTMLElement>(':scope > [data-slot$="-overlay"]')
  const place = (el: HTMLElement, y: number) => {
    el.style.transform = `translateY(${y}px)`
    // the dimming behind lifts as the sheet leaves
    const dim = dimOf(el)
    if (dim) dim.style.opacity = String(1 - Math.min(1, Math.max(0, y / el.offsetHeight)))
  }

  const release = (e: React.PointerEvent, cancelled = false) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    const el = e.currentTarget.parentElement!
    const [t0, y0] = d.trail[0]!
    const [t1, y1] = d.trail.at(-1)!
    // held still before letting go: no speed to carry on with
    const still = cancelled || t1 === t0 || e.timeStamp - t1 > 100
    // no faster than a hand flicks: one odd sample must not fling the sheet off its place
    const velocity = still ? 0 : Math.max(-3000, Math.min(3000, ((y1 - y0) / (t1 - t0)) * 1000))
    // the way it was moving decides: thrown back up it stays, otherwise it goes where it would land
    const close = !cancelled && velocity > -50 && d.y + project(velocity) > el.offsetHeight / 2
    const to = close ? el.offsetHeight : 0
    const done = () => {
      if (close) return el.querySelector<HTMLElement>(':scope > [data-slot$="-close"]')?.click()
      el.style.transform = ""
      const dim = dimOf(el)
      if (dim) dim.style.opacity = ""
    }
    if (close) haptic()
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return place(el, to), done()
    flight.current = animate(d.y, to, {
      type: "spring",
      velocity,
      visualDuration: 0.3,
      // a little bounce only when it was thrown back into place
      bounce: !close && Math.abs(velocity) > 300 ? 0.2 : 0,
      onUpdate: (y) => place(el, y),
      onComplete: done,
    })
  }

  return (
    <div
      aria-hidden
      className="absolute inset-x-16 top-0 z-10 h-6 touch-none sm:hidden"
      onPointerDown={(e) => {
        const el = e.currentTarget.parentElement!
        e.currentTarget.setPointerCapture(e.pointerId)
        flight.current?.stop()
        // from where it is on screen right now: also when caught mid-flight, or while still sliding in
        const from = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42
        el.dataset.dragged = ""
        place(el, from)
        drag.current = { start: e.clientY, from, y: from, trail: [[e.timeStamp, from]] }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const raw = d.from + e.clientY - d.start
        d.y = raw < 0 ? -rubberband(-raw) : raw
        place(e.currentTarget.parentElement!, d.y)
        d.trail.push([e.timeStamp, d.y])
        while (d.trail.length > 2 && e.timeStamp - d.trail[0]![0] > 100) d.trail.shift()
      }}
      onPointerUp={(e) => release(e)}
      onPointerCancel={(e) => release(e, true)}
    >
      <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-foreground/20" />
    </div>
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        initialFocus={noKeyboardOnTouch}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {showCloseButton && <SheetGrabber />}
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
