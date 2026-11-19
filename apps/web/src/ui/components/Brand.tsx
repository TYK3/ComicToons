import { href } from '../router';
import { LogoMark } from './Icons';

export function Logo({ to = '/' }: { to?: string }) {
  return <a className="ct-logo" href={href(to)} aria-label="ComicToons home"><LogoMark/><span aria-hidden="true">ComicToons</span></a>;
}
export function Sample({ label = 'Sample', ink = false }: { label?: string; ink?: boolean }) {
  return <span className={`ct-sample${ink ? ' ct-sample--ink' : ''}`}>{label}</span>;
}
