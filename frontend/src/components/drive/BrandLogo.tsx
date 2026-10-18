import { cn } from '@/lib/utils'
import logo from '@/assets/cloudix-logo.png'

export function BrandLogo({ className }: { className?: string }) {
  return <img src={logo} alt="Cloudix logo" className={cn('h-10 w-10 rounded-xl object-contain', className)} />
}
