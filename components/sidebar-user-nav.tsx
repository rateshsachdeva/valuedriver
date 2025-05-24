'use client';

import Image from 'next/image';
import { User } from 'next-auth';
import { signOut, useSession } from 'next-auth/react';
import { useTheme } from 'next-themes';
import { Moon, Sun, LogOut } from 'lucide-react';
import { LoaderIcon } from './icons';
import { toast } from './toast';

export function SidebarUserNav({ user }: { user: User | undefined }) {
  const { status } = useSession();
  const { setTheme, theme } = useTheme();

  return (
    <div className="flex flex-col p-2 gap-2 text-sm">
      {/* avatar + email */}
      <div className="flex items-center gap-2">
        {status === 'loading' ? (
          <>
            <div className="size-6 bg-zinc-500/30 rounded-full animate-pulse" />
            <span className="bg-zinc-500/30 text-transparent rounded-md animate-pulse">
              Loading...
            </span>
            <span className="animate-spin ml-auto text-zinc-500">
              <LoaderIcon size={20} />
            </span>
          </>
        ) : (
          <>
            <Image
              src={`https://avatar.vercel.sh/${user?.email}`}
              alt={user?.email ?? 'User Avatar'}
              width={24}
              height={24}
              className="rounded-full"
            />
            <span className="truncate">{user?.email}</span>
          </>
        )}
      </div>

      {/* theme toggle */}
      <button
        className="flex items-center gap-2 text-left hover:underline"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        {theme === 'light' ? (
          <>
            <Moon size={16} /> Switch to dark mode
          </>
        ) : (
          <>
            <Sun size={16} /> Switch to light mode
          </>
        )}
      </button>

      {/* sign-out */}
      <button
        className="flex items-center gap-2 text-left hover:underline"
        onClick={async () => {
          if (status === 'loading') {
            toast({
              type: 'error',
              description:
                'Checking authentication status, please try again!',
            });
            return;
          }
          await signOut({ callbackUrl: '/login' });
        }}
      >
        <LogOut size={16} /> Sign out
      </button>
    </div>
  );
}
