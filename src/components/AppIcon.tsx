import { useAppIcon } from '../store/hooks';
import { cn } from '../utils/cn';
import { initialOf, tileColor } from '../utils/format';

interface Props {
  appId?: string;
  name: string;
  size?: number;
  className?: string;
}

/**
 * Shows the icon extracted by the back-end (`get_app_icon`) when available,
 * otherwise a deterministic coloured tile with the program's initial.
 */
export function AppIcon({ appId, name, size = 18, className }: Props) {
  const url = useAppIcon(appId);
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.52)) };
  if (url) {
    return <img src={url} alt="" width={size} height={size} draggable={false} className={cn('app-icon-img', className)} style={style} />;
  }
  return (
    <span
      className={cn('app-icon-tile', className)}
      style={{ ...style, backgroundColor: tileColor(name), borderRadius: Math.max(3, Math.round(size * 0.22)) }}
      aria-hidden
    >
      {initialOf(name)}
    </span>
  );
}
