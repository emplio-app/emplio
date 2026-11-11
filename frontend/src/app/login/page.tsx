"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import type { AuthStartResponse } from "@emplio/shared";
import { api, meQueryKey, useMe } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: me, isPending } = useMe();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  // just named a new account (and made their first business): the welcome steps first
  const [joined, setJoined] = useState(false);

  // Logged in without a name = new account that still needs onboarding.
  const step = me ? "name" : codeSent ? "code" : "email";

  // where they were going before being sent here (only a page of this app)
  useEffect(() => {
    const next = new URLSearchParams(location.search).get("next");
    if (!me?.user.name) return;
    // a new business's owner gets the welcome steps wherever they were headed; invited people go on as usual
    if (joined && me.workspaces[0]?.role === "owner") router.replace("/welcome");
    else router.replace(next?.startsWith("/") && !next.startsWith("//") ? next : "/home");
  }, [me, router, joined]);

  const refreshMe = () => queryClient.invalidateQueries({ queryKey: meQueryKey });

  const start = useMutation({
    mutationFn: () => api<AuthStartResponse>("/auth/start", { email }),
    onError: () => (setCodeSent(false), setCode("")),
  });
  const verify = useMutation({
    mutationFn: () => api("/auth/verify", { email, code }),
    onSuccess: refreshMe,
  });
  const saveName = useMutation({
    mutationFn: () => api("/me/name", { name }),
    onSuccess: () => (setJoined(true), refreshMe()),
  });

  const current = { email: start, code: verify, name: saveName }[step];

  if (isPending || me?.user.name) return null;

  return (
    // on a phone, near the top and clear of the status bar: centered, the keyboard made the page scroll the logo
    // up under the clock to reach the field
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-24 max-sm:justify-start max-sm:gap-6 max-sm:pt-[calc(var(--safe-top)+2.5rem)] max-sm:pb-10">
      <Logo />
      <Card className="w-full max-w-sm shadow-xl shadow-primary/5">
        <CardHeader>
          <CardTitle className="font-heading text-2xl">
            {step === "name" ? "Welcome aboard" : "Sign up or log in"}
          </CardTitle>
          <CardDescription>
            {step === "email" && "Enter your email and we'll send you a code. Joining a team? Use the email they added you with."}
            {step === "code" && !start.data?.notEmailed && `We sent a 6-digit code to ${email}.`}
            {step === "code" && start.data?.notEmailed && (
              <>
                Email isn't set up on this server, so the code is in its log. On the server, run{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">docker compose logs app | grep "sign-in code"</code>
              </>
            )}
            {step === "name" && "What should we call you?"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              // the code box opens during the tap, not after the request: a phone only brings up its keyboard for
              // a field focused during a tap. If sending fails it goes back to the email, with the error.
              if (step === "email") flushSync(() => setCodeSent(true));
              current.mutate();
            }}
          >
            {step === "email" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                />
              </div>
            )}

            {step === "code" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="code">Verification code</Label>
                <InputOTP id="code" containerClassName="justify-center" maxLength={6} value={code} onChange={setCode} autoFocus>
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <InputOTPSlot key={i} index={i} />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>
            )}

            {step === "name" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Full name</Label>
                <Input
                  id="name"
                  autoComplete="name"
                  required
                  autoFocus
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                />
              </div>
            )}

            {current.error && <p className="text-sm text-destructive">{current.error.message}</p>}

            <Button
              type="submit"
              size="lg"
              className="h-10"
              disabled={current.isPending || (step === "code" && code.length < 6)}
            >
              {step === "code" ? "Verify" : "Continue"}
            </Button>

            {step === "code" && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setCodeSent(false);
                  setCode("");
                  verify.reset();
                }}
              >
                Use a different email
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
