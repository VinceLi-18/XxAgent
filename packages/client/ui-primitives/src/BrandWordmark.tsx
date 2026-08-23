import type { IconProps } from './icons/props.ts'

/**
 * Render the XAgent wordmark.
 * @param props.size - height in px (default 24; width keeps the 116:24 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={(size * 116) / 24}
      height={size}
      className={className}
      viewBox="0 0 116 24"
      fill="none"
      aria-hidden="true"
    >
      <path d="M1 2H6.5L14 11.8L21.5 2H27L16.8 14L27 22H21.5L14 16.2L6.5 22H1L11.2 14L1 2Z" fill="currentColor" />
      <text x="33" y="17.4" fill="currentColor" fontFamily="ui-sans-serif, system-ui, sans-serif" fontSize="18" fontWeight="700" letterSpacing="-0.7">XAgent</text>
    </svg>
  )
}
