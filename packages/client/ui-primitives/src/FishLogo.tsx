import type { IconProps } from './icons/props.ts'

/**
 * Render the kosma geometric mark.
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
      <path d="M3 2H8V22H3ZM10 14L17 7H23L15 14L23 22H17L10 14Z" fill="currentColor" />
    </svg>
  )
}
