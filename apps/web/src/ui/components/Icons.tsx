/** Drawn here, not taken from any brand kit. The Connect glyph is a generic chat bubble, not the Twitch logo. */
export function LogoMark() {
  return <svg viewBox="0 0 32 28" width="32" height="28" aria-hidden="true" focusable="false">
    <path d="M2 2h28v18H14l-7 6v-6H2z" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
    <path d="M8 8h16M8 13h10" stroke="var(--ct-logo-cut, #0b0b0c)" strokeWidth="2.6" strokeLinecap="square"/>
  </svg>;
}
export function ChatGlyph() {
  return <svg className="ct-glyph" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    <path d="M3 2h14v11h-6l-4 4v-4H3z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
    <path d="M8 6v4M12 6v4" stroke="currentColor" strokeWidth="2"/>
  </svg>;
}
export function Arrow({ dir = 'right' }: { dir?: 'right' | 'left' | 'up' }) {
  const rotate = dir === 'left' ? 180 : dir === 'up' ? -90 : 0;
  return <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false" style={{ transform: `rotate(${rotate}deg)` }}>
    <path d="M3 10h13M11 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.4"/>
  </svg>;
}
