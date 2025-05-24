'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { signIn } from 'next-auth/react';

import { AuthForm } from '@/components/auth-form';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/toast';

export default function RegisterPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  /* -------------------------------------------------------------- */
  /*  Called by <AuthForm> on submit                                */
  /* -------------------------------------------------------------- */
  async function handleSubmit(formData: FormData) {
    setSubmitting(true);

    /** 1️⃣  Call your server action that creates the user row.
     *       The repo already has `register()` in `app/(auth)/actions.ts`.
     */
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      body: formData,
    });

    setSubmitting(false);

    if (!res.ok) {
      toast({
        type: 'error',
        description: 'Could not create account. Please try again.',
      });
      return;
    }

    /** 2️⃣  Automatically sign the user in, then go to chat */
    const { email, password } = Object.fromEntries(formData) as {
      email: string;
      password: string;
    };

    const login = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });

    if (login?.error) {
      toast({ type: 'error', description: 'Account created; sign-in failed.' });
    } else {
      router.replace('/');
    }
  }

  /* -------------------------------------------------------------- */
  /*                           UI                                   */
  /* -------------------------------------------------------------- */
  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-6 p-8">
          {/* Header */}
          <h2 className="text-xl font-semibold text-center">Create an account</h2>

          {/* Email / password fields come FROM AuthForm itself – we only pass a button */}
          <AuthForm action={handleSubmit}>
            <Button
              type="submit"
              className="w-full"
              disabled={submitting}
            >
              {submitting ? 'Creating…' : 'Sign up'}
            </Button>
          </AuthForm>

          {/* Link back to login */}
          <p className="pt-2 text-center text-sm text-muted-foreground">
            Already have an account?{' '}
            <a href="/login" className="underline">
              Sign in
            </a>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
