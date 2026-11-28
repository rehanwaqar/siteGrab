interface SiteGrabLogoProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-7 w-7 rounded-lg',
  md: 'h-8 w-8 rounded-lg',
  lg: 'h-12 w-12 rounded-xl',
};

export function SiteGrabLogo({ size = 'md', className = '' }: SiteGrabLogoProps) {
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-white border border-slate-200/90 dark:border-sky-400/30 shadow-xs p-0.5 ${SIZE_CLASSES[size]} ${className}`}
    >
      <img
        src="/assets/aistudio/Glossy_Blue_Glass_Folder_Icon_3c132e87.png"
        alt="SiteGrab symbol"
        className="h-full w-full object-contain"
      />
    </span>
  );
}
