import type { IconProps } from './icons/props.ts'

/**
 * Render the XAgent geometric mark.
 * @param props.size - width and height in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path d="M2 2H6.8L22 22H17.2L2 2ZM17.2 2H22L6.8 22H2L17.2 2Z" fill="currentColor" />
    </svg>
  )
}
