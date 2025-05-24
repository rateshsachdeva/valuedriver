'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signIn, useSession } from 'next-auth/react';

import { AuthForm } from '@/components/auth-form';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/toast';

export default function Page() {
  const router = useRouter();
  const { update: updateSession } = useSession();

  const [isSuccessful, setIsSuccessful] = useState(false);

  /* -------------------------------- form action -------------------------------- */
  async function handleSubmit(formData: FormData) {
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;

    const res = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });

    if (res?.error) {
      toast({ type: 'error', description: 'Invalid credentials!' });
    } else {
      setIsSuccessful(true);
      await updateSession();
      router.replace('/'); // go to chat
    }
  }

  /* -------------------------------- component ---------------------------------- */
  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-6 p-8">
          {/* Google button */}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => signIn('google', { callbackUrl: '/' })}
          >
            <svg aria-hidden className="mr-2 h-5 w-5" viewBox="0 0 24 24">
              <path
                d="M12 12v4.8h6.8A6.7 6.7 0 0 1 12 19.6 7.6 7.6 0 0 1 4.4 12 7.6 7.6 0 0 1 12 4.4a7.2 7.2 0 0 1 5.1 2l3.6-3.6A12 12 0 0 0 0 12a12 12 0 0 0 12 12c6.9 0 12-5 12-12 0-.8-.1-1.6-.2-2.4H12Z"
                fill="currentColor"
              />
            </svg>
            Continue with Google
          </Button>

          {/* divider */}
          <div className="relative flex items-center">
            <span className="flex-grow border-t border-muted-foreground/20" />
            <span className="mx-3 text-xs uppercase text-muted-foreground">or</span>
            <span className="flex-grow border-t border-muted-foreground/20" />
          </div>

          {/* email / password */}
          <AuthForm action={handleSubmit}>
            <input
              name="email"
              type="email"
              placeholder="you@example.com"
              required
              className="w-full rounded-md border p-2 text-sm"
            />
            <input
              name="password"
              type="password"
              placeholder="••••••"
              required
              className="w-full rounded-md border p-2 text-sm"
            />
            <Button type="submit" className="w-full">
              {isSuccessful ? '✓ Signed in' : 'Sign in'}
            </Button>
          </AuthForm>
        </CardContent>
      </Card>
    </main>
  );
}
