// Modal: controlled full-viewport dialog (create-workspace and similar).
// The overlay portals to this document's body so ancestor stacking contexts
// cannot leave sticky page controls above the mask. This is still an in-page
// WebUI dialog; it never creates or targets another browser/native window.

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCloseOutline16 } from './icons/index.tsx'
import css from './Modal.module.css'

/**
 * 渲染全屏遮罩上的受控模态框，并在打开期间封闭背景与键盘焦点。
 * @param props.open 是否显示对话框。
 * @param props.onClose Escape、遮罩或关闭按钮触发的关闭动作。
 * @param props.title 对话框的可访问名称。
 * @param props.closeLabel 关闭按钮的可访问名称。
 * @param props.description 标题下方的可选说明。
 * @param props.children 对话框正文。
 * @param props.footer 对话框操作区。
 * @param props.className 对话框容器的可选类名。
 * @param props.contentClassName 可滚动正文区域的可选类名。
 * @param props.headless 是否由调用方完整提供标题、关闭按钮和正文结构。
 * @returns 关闭时返回 null；打开时返回挂载到 body 的遮罩与对话框。
 */
export function Modal({
  open, onClose, title, closeLabel = 'Close', description, children, footer, className, contentClassName, headless = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  closeLabel?: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
  headless?: boolean
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement
    const appRoot = document.getElementById('root')
    const previousInert = appRoot?.inert
    if (appRoot !== null) appRoot.inert = true
    const focusable = () => [...(dialog.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])]
    if (!dialog.current?.contains(document.activeElement)) {
      const first = focusable()[0]
      if (first === undefined) dialog.current?.focus()
      else first.focus()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close.current()
        return
      }
      if (e.key !== 'Tab') return
      const entries = focusable()
      if (entries.length === 0) {
        e.preventDefault()
        dialog.current?.focus()
        return
      }
      const firstEntry = entries[0]
      const lastEntry = entries.at(-1)
      if (firstEntry === undefined || lastEntry === undefined) return
      const active = document.activeElement
      const outside = !dialog.current?.contains(active)
      const leavingBackwards = e.shiftKey && (active === firstEntry || outside)
      const leavingForwards = !e.shiftKey && (active === lastEntry || outside)
      if (leavingBackwards || leavingForwards) {
        e.preventDefault()
        if (e.shiftKey) lastEntry.focus()
        else firstEntry.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (appRoot !== null) appRoot.inert = previousInert ?? false
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [open])

  if (!open) return null

  return createPortal((
    <div className={css.root} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div
        ref={dialog}
        className={clsx(css.dialog, className)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        {headless
          ? children
          : (
            <>
              <div className={clsx(css.content, contentClassName)}>
                <div className={css.header}>
                  <h2 className={css.title}>{title}</h2>
                  <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
                    <IconCloseOutline16 size={14} />
                  </button>
                </div>
                {description !== undefined && description !== '' && (
                  <p className={css.description}>{description}</p>
                )}
                {children !== undefined && <div className={css.body}>{children}</div>}
              </div>
              {footer !== undefined && <div className={css.footer}>{footer}</div>}
            </>
          )}
      </div>
    </div>
  ), document.body)
}
