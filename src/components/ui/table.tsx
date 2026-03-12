"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const dragRef = React.useRef({
    active: false,
    moved: false,
    startX: 0,
    startLeft: 0,
  })
  const [dragging, setDragging] = React.useState(false)

  const stopDrag = React.useCallback(() => {
    if (!dragRef.current.active) return
    dragRef.current.active = false
    setDragging(false)
  }, [])

  React.useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const node = containerRef.current
      const state = dragRef.current
      if (!node || !state.active) return
      const deltaX = event.clientX - state.startX
      if (Math.abs(deltaX) > 3) state.moved = true
      node.scrollLeft = state.startLeft - deltaX
      event.preventDefault()
    }
    const onUp = () => stopDrag()
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    return () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
  }, [stopDrag])

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (
      target?.closest(
        "a,button,input,textarea,select,option,label,[role='button'],[role='menuitem'],[data-no-drag-scroll='1']",
      )
    ) {
      return
    }
    // Default behavior: drag-to-scroll even when starting on table text/cells.
    // Hold Alt to select/copy text in cells.
    if (
      event.altKey &&
      target?.closest("td,th,[data-slot='table-cell'],[data-slot='table-head']")
    ) {
      return
    }
    const node = containerRef.current
    if (!node) return
    dragRef.current.active = true
    dragRef.current.moved = false
    dragRef.current.startX = event.clientX
    dragRef.current.startLeft = node.scrollLeft
    setDragging(true)
  }

  const onClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (dragRef.current.moved) {
      event.preventDefault()
      event.stopPropagation()
      dragRef.current.moved = false
    }
  }

  return (
    <div
      ref={containerRef}
      data-slot="table-container"
      className={cn(
        "relative w-full overflow-x-auto cursor-grab active:cursor-grabbing",
        dragging && "select-none",
      )}
      onMouseDown={onMouseDown}
      onMouseLeave={stopDrag}
      onClickCapture={onClickCapture}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "bg-muted/50 border-t font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "text-foreground h-10 px-2 text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-muted-foreground mt-4 text-sm", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
