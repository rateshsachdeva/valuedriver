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

  async function handleSubmit(formData: FormData) {
    setSubmitting(true);

    /* call your existing server action /api/auth/register */
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      toast({
        type: 'error',
        description: 'Could not create account. Please try again.',
      });
      setSubmitting(false);
      return;
    }

    /* auto-signin */
    const { email, password } = Object.fromEntries(formData) as {
      email: string;
      password: string;
    };

    const login = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });

    setSubmitting(false);

    if (login?.error) {
      toast({ type: 'error', description: 'Account created; sign-in failed' });
    } else {
      router.replace('/');
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <Card
        className="
          w-full max-w-[478px]
          shadow-md
          border-l-[4px] border-[#D4AF37]
        "
      >
        <CardContent className="space-y-6 p-8">
          <h2 className="text-xl font-semibold text-center">
            Create an account
          </h2>

          <AuthForm action={handleSubmit}>
            <Button
              type="submit"
              className="w-full"
              disabled={submitting}
            >
              {submitting ? 'Creating…' : 'Sign up'}
            </Button>
          </AuthForm>

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
