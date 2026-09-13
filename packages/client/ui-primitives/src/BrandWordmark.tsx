import type { IconProps } from './icons/props.ts'

/**
 * Render the kosma wordmark.
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
      <path d="M3 2H8V22H3ZM10 14L18 7H25L16 14L26 22H19L10 14Z" fill="currentColor" />
      <text x="33" y="17.4" fill="currentColor" fontFamily="ui-sans-serif, system-ui, sans-serif" fontSize="18" fontWeight="700" letterSpacing="-0.7">kosma</text>
    </svg>
  )
}
