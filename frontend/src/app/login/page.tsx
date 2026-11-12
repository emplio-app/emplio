"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Logo } from "@/components/logo";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import type { AuthStartResponse } from "@emplio/shared";
import { api, API_URL, meQueryKey, useMe } from "@/lib/api";
import { JUST_JOINED } from "@/components/chat/first-run";
import { track } from "@cloud/client";

const GOOGLE_ERRORS: Record<string, string> = {
  cancelled: "Google sign-in was cancelled.",
  failed: "Google sign-in didn't work. Try again.",
  "no-email": "Google didn't share a confirmed email address.",
  "invite-only": "This Emplio is invite-only. Ask its owner to add you to the team.",
};

const nextOf = () => {
  const next = new URLSearchParams(location.search).get("next");
  // only a page of this app: no "//", "/\\" or tabs and spaces a browser would turn into another site
  return next && /^\/(?![/\\])[^\\\s]*$/.test(next) ? next : null;
};

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: me, isPending } = useMe();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  // just named a new account (and made their first business): the welcome steps first
  const [joined, setJoined] = useState(() => typeof location !== "undefined" && new URLSearchParams(location.search).has("joined"));
  // a failed Google sign-in comes back with ?error=<code>
  const [googleError] = useState(() => (typeof location === "undefined" ? null : GOOGLE_ERRORS[new URLSearchParams(location.search).get("error") ?? ""] ?? null));
  const options = useQuery({ queryKey: ["auth-options"], queryFn: () => api<{ google: boolean }>("/auth/options"), staleTime: Infinity });

  // Logged in without a name = new account that still needs onboarding.
  const step = me ? "name" : codeSent ? "code" : "email";

  // where they were going before being sent here (only a page of this app)
  useEffect(() => {
    if (!me?.user.name) return;
    if (joined) {
      track("signed_up", { google: new URLSearchParams(location.search).has("joined") });
      try {
        sessionStorage.setItem(JUST_JOINED, "1");
      } catch {}
    }
    // a new business's owner goes straight to the chat (the welcome dialog opens there, and a job typed on the
    // homepage starts at once); invited people go on as usual
    router.replace(nextOf() ?? (joined && me.workspaces[0]?.role === "owner" ? "/chat" : "/home"));
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
          {step === "email" && options.data?.google && (
            <>
              <a
                className={buttonVariants({ variant: "outline", size: "lg", className: "h-10 w-full" })}
                href={`${API_URL}/auth/google?${new URLSearchParams({ next: nextOf() ?? "" })}`}
              >
                <svg viewBox="0 0 24 24" aria-hidden className="size-4">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.24 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
                </svg>
                Continue with Google
              </a>
              <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or use your email
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}
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

            {(current.error || (step === "email" && googleError)) && <p className="text-sm text-destructive">{current.error?.message ?? googleError}</p>}

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
