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
 * Renders a controlled modal that makes the background inert and traps focus while open.
 * @param props.open Whether the dialog is visible.
 * @param props.onClose Handles Escape, mask, and close-button dismissal.
 * @param props.title Accessible dialog name.
 * @param props.closeLabel Accessible close-button name.
 * @param props.description Optional description below the title.
 * @param props.children Dialog body.
 * @param props.footer Dialog action area.
 * @param props.className Optional dialog container class.
 * @param props.contentClassName Optional scrollable content class.
 * @param props.headless Whether the caller supplies the complete header, close control, and body structure.
 * @returns Nothing while closed, otherwise a body-portaled mask and dialog.
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
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), '
      + 'iframe:not([hidden]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
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
