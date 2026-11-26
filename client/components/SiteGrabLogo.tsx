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
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-[#060913] border border-sky-500/30 shadow-xs ${SIZE_CLASSES[size]} ${className}`}
    >
      <img
        src="/assets/aistudio/Neon_Globe_Download_Code_Icon_676bcc04.png"
        alt="SiteGrab symbol"
        className="h-full w-full object-cover scale-[1.28]"
      />
    </span>
  );
}
