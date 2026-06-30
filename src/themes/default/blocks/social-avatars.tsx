import { Star } from 'lucide-react';

import { Avatar } from '@/shared/components/ui/avatar';

const avatarInitials = ['A', 'P', 'I', 'K', 'U', 'M'];

export function SocialAvatars({ tip }: { tip: string }) {
  return (
    <div className="mx-auto mt-8 flex w-fit flex-col items-center gap-2 sm:flex-row">
      <span className="mx-4 inline-flex items-center -space-x-2">
        {avatarInitials.map((initial, index) => (
          <Avatar
            className="bg-background text-primary flex size-10 items-center justify-center border text-xs font-semibold"
            key={`${initial}-${index}`}
          >
            {initial}
          </Avatar>
        ))}
      </span>
      <div className="flex flex-col items-center gap-1 md:items-start">
        <div className="flex items-center gap-1">
          {Array.from({ length: 5 }).map((_, index) => (
            <Star
              key={index}
              className="size-4 fill-yellow-400 text-yellow-400"
            />
          ))}
        </div>
        <p className="text-muted-foreground text-left text-sm font-normal">
          {tip}
        </p>
      </div>
    </div>
  );
}
