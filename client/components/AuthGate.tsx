import { useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import {
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
  RefreshCw,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import {
  createEmailAccount,
  formatFirebaseAuthError,
  resendVerificationEmail,
  sendAccountPasswordReset,
  signInWithAppleAccount,
  signInWithEmailAccount,
  signInWithGithubAccount,
  signInWithGoogleAccount,
  signOutAccount,
  type FriendlyAuthError,
} from '../firebase';
import { SiteGrabLogo } from './SiteGrabLogo';

interface AuthGateProps {
  onReadTerms: () => void;
  pendingVerificationUser?: User | null;
  onVerificationComplete?: (verifiedUser: User) => Promise<void> | void;
}

type AuthMode = 'signin' | 'signup' | 'reset';

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29c-.24-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
      />
    </svg>
  );
}

function AppleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 fill-current" aria-hidden="true">
      <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.374 2.19-.13.09-2.383 1.37-2.383 4.19 0 3.26 2.854 4.42 2.955 4.45z" />
    </svg>
  );
}

function GithubGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 fill-current" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export function AuthGate({
  onReadTerms,
  pendingVerificationUser,
  onVerificationComplete,
}: AuthGateProps) {
  const [mode, setMode] = useState<AuthMode>('signin');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [busyAction, setBusyAction] = useState<
    null | 'google' | 'apple' | 'github' | 'email' | 'verify-check' | 'verify-resend'
  >(null);
  const [authError, setAuthError] = useState<FriendlyAuthError | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);

  const isBusy = busyAction !== null;

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setAuthError(null);
    setNoticeMessage(null);
  };

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    setNoticeMessage(null);
    setBusyAction('google');
    try {
      await signInWithGoogleAccount();
    } catch (err) {
      setAuthError(formatFirebaseAuthError(err, 'google'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleAppleSignIn = async () => {
    setAuthError(null);
    setNoticeMessage(null);
    setBusyAction('apple');
    try {
      await signInWithAppleAccount();
    } catch (err) {
      setAuthError(formatFirebaseAuthError(err, 'apple'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleGithubSignIn = async () => {
    setAuthError(null);
    setNoticeMessage(null);
    setBusyAction('github');
    try {
      await signInWithGithubAccount();
    } catch (err) {
      setAuthError(formatFirebaseAuthError(err, 'github'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setNoticeMessage(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setAuthError({ code: 'validation', message: 'Please enter a valid email address.' });
      return;
    }

    if (mode === 'reset') {
      setBusyAction('email');
      try {
        await sendAccountPasswordReset(trimmedEmail);
        setNoticeMessage(
          `Password reset link sent to ${trimmedEmail}. Check your inbox and return to sign in.`,
        );
      } catch (err) {
        setAuthError(formatFirebaseAuthError(err, 'email'));
      } finally {
        setBusyAction(null);
      }
      return;
    }

    if (mode === 'signup') {
      if (!fullName.trim()) {
        setAuthError({ code: 'validation', message: 'Please enter your name for your workspace.' });
        return;
      }
      if (password.length < 8) {
        setAuthError({
          code: 'validation',
          message: 'Please choose a password with at least 8 characters.',
        });
        return;
      }
      if (password !== confirmPassword) {
        setAuthError({ code: 'validation', message: 'Passwords do not match.' });
        return;
      }

      setBusyAction('email');
      try {
        await createEmailAccount(fullName, trimmedEmail, password);
      } catch (err) {
        setAuthError(formatFirebaseAuthError(err, 'email'));
      } finally {
        setBusyAction(null);
      }
      return;
    }

    if (!password) {
      setAuthError({ code: 'validation', message: 'Please enter your password.' });
      return;
    }

    setBusyAction('email');
    try {
      await signInWithEmailAccount(trimmedEmail, password);
    } catch (err) {
      setAuthError(formatFirebaseAuthError(err, 'email'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleCheckVerified = async () => {
    if (!pendingVerificationUser) return;
    setAuthError(null);
    setNoticeMessage(null);
    setBusyAction('verify-check');
    try {
      await pendingVerificationUser.reload();
      await pendingVerificationUser.getIdToken(true);
      if (pendingVerificationUser.emailVerified) {
        await onVerificationComplete?.(pendingVerificationUser);
      } else {
        setAuthError({
          code: 'not-verified-yet',
          message:
            'Your email is not verified yet. Open the verification link sent to your inbox, then click Continue.',
        });
      }
    } catch (err) {
      setAuthError(formatFirebaseAuthError(err, 'email'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleResendVerification = async () => {
    if (!pendingVerificationUser) return;
    setAuthError(null);
    setNoticeMessage(null);
    setBusyAction('verify-resend');
    try {
      await resendVerificationEmail(pendingVerificationUser);
      setNoticeMessage(
        `Verification email resent to ${pendingVerificationUser.email || 'your address'}. Check spam if it does not arrive within a minute.`,
      );
    } catch (err) {
      setAuthError(formatFirebaseAuthError(err, 'email'));
    } finally {
      setBusyAction(null);
    }
  };

  if (pendingVerificationUser) {
    return (
      <section className="mx-auto max-w-md py-8 sm:py-14">
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 sm:p-8 shadow-sm space-y-5">
          <div className="space-y-2.5 text-center">
            <div className="flex justify-center">
              <SiteGrabLogo size="lg" />
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
              Verify your email
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              We sent a verification link to{' '}
              <span className="font-semibold text-slate-900 dark:text-slate-200">
                {pendingVerificationUser.email}
              </span>
              . Click the link in your inbox to unlock your private SiteGrab workspace.
            </p>
          </div>

          {authError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300"
            >
              {authError.message}
            </div>
          )}

          {noticeMessage && (
            <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-3.5 py-2.5 text-xs text-emerald-700 dark:text-emerald-300 flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{noticeMessage}</span>
            </div>
          )}

          <div className="space-y-2.5">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleCheckVerified()}
              className="h-11 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-60 px-5 text-sm font-semibold text-white transition-colors cursor-pointer"
            >
              {busyAction === 'verify-check' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              <span>
                {busyAction === 'verify-check'
                  ? 'Checking status...'
                  : "I've Verified — Continue"}
              </span>
            </button>

            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleResendVerification()}
              className="h-10 w-full inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0B0F17] hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60 px-4 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
            >
              {busyAction === 'verify-resend' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              <span>Resend Verification Email</span>
            </button>

            <button
              type="button"
              disabled={isBusy}
              onClick={() => void signOutAccount()}
              className="h-9 w-full inline-flex items-center justify-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors cursor-pointer"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign out / Use another account</span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-md py-6 sm:py-12">
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 sm:p-8 shadow-sm space-y-5">
        <div className="space-y-2.5 text-center">
          <div className="flex justify-center">
            <SiteGrabLogo size="lg" />
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {mode === 'signup'
              ? 'Create your SiteGrab account'
              : mode === 'reset'
                ? 'Reset your password'
                : 'Sign in to SiteGrab'}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            {mode === 'reset'
              ? 'Enter your email address to receive a password reset link.'
              : 'Your captured websites, screenshot builds, previews, AI edits, and history stay private to your account.'}
          </p>
        </div>

        {/* Sign In / Create Account Tabs */}
        {mode !== 'reset' && (
          <div
            role="tablist"
            aria-label="Account authentication mode"
            className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-[#0B0F17] p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signin'}
              disabled={isBusy}
              onClick={() => switchMode('signin')}
              className={`h-9 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                mode === 'signin'
                  ? 'bg-white dark:bg-[#1E293B] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signup'}
              disabled={isBusy}
              onClick={() => switchMode('signup')}
              className={`h-9 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                mode === 'signup'
                  ? 'bg-white dark:bg-[#1E293B] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Create Account
            </button>
          </div>
        )}

        {/* OAuth Providers: Google, Apple & GitHub */}
        {mode !== 'reset' && (
          <>
            <div className="space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleGoogleSignIn()}
                  className="h-10.5 inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0B0F17] hover:bg-slate-50 dark:hover:bg-slate-800/80 disabled:opacity-60 px-3.5 text-xs font-semibold text-slate-800 dark:text-slate-100 transition-colors cursor-pointer"
                >
                  {busyAction === 'google' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <GoogleGlyph />
                  )}
                  <span>Continue with Google</span>
                </button>

                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleAppleSignIn()}
                  className="h-10.5 inline-flex items-center justify-center gap-2 rounded-xl border border-slate-900 dark:border-slate-700 bg-slate-950 dark:bg-white hover:bg-slate-900 dark:hover:bg-slate-100 disabled:opacity-60 px-3.5 text-xs font-semibold text-white dark:text-slate-950 transition-colors cursor-pointer"
                >
                  {busyAction === 'apple' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <AppleGlyph />
                  )}
                  <span>Continue with Apple</span>
                </button>
              </div>

              <button
                type="button"
                disabled={isBusy}
                onClick={() => void handleGithubSignIn()}
                className="h-10.5 w-full inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-900 dark:bg-[#1E293B] hover:bg-slate-800 dark:hover:bg-slate-700 disabled:opacity-60 px-3.5 text-xs font-semibold text-white transition-colors cursor-pointer"
              >
                {busyAction === 'github' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <GithubGlyph />
                )}
                <span>Continue with GitHub</span>
              </button>
            </div>

            <div className="relative flex items-center py-0.5">
              <div className="grow border-t border-slate-200 dark:border-slate-800" />
              <span className="mx-3 shrink text-[11px] font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">
                or with email
              </span>
              <div className="grow border-t border-slate-200 dark:border-slate-800" />
            </div>
          </>
        )}

        {authError && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300 space-y-2"
          >
            <p>{authError.message}</p>
            {authError.suggestSignUp && mode === 'signin' && (
              <button
                type="button"
                onClick={() => switchMode('signup')}
                className="inline-flex items-center gap-1 font-semibold text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
              >
                <UserPlus className="h-3.5 w-3.5" />
                <span>Create an account with this email</span>
                <ArrowRight className="h-3 w-3" />
              </button>
            )}
            {authError.suggestSignIn && mode === 'signup' && (
              <button
                type="button"
                onClick={() => switchMode('signin')}
                className="inline-flex items-center gap-1 font-semibold text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
              >
                <span>Switch to Sign In</span>
                <ArrowRight className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        {noticeMessage && (
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-3.5 py-2.5 text-xs text-emerald-700 dark:text-emerald-300">
            {noticeMessage}
          </div>
        )}

        {/* Email / Password Form */}
        <form onSubmit={(e) => void handleEmailSubmit(e)} className="space-y-3">
          {mode === 'signup' && (
            <div className="space-y-1">
              <label
                htmlFor="auth-full-name"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Full Name
              </label>
              <input
                id="auth-full-name"
                type="text"
                autoComplete="name"
                maxLength={120}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                disabled={isBusy}
                placeholder="Alex Rivera"
                className="h-10 w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-3.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20"
              />
            </div>
          )}

          <div className="space-y-1">
            <label
              htmlFor="auth-email"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Email Address
            </label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <input
                id="auth-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isBusy}
                placeholder="you@example.com"
                className="h-10 w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] pl-9 pr-3.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20"
              />
            </div>
          </div>

          {mode !== 'reset' && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="auth-password"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Password
                </label>
                {mode === 'signin' && (
                  <button
                    type="button"
                    onClick={() => switchMode('reset')}
                    className="text-[11px] font-medium text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                <input
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isBusy}
                  placeholder={mode === 'signup' ? 'At least 8 characters' : 'Enter your password'}
                  className="h-10 w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] pl-9 pr-10 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                >
                  {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          )}

          {mode === 'signup' && (
            <div className="space-y-1">
              <label
                htmlFor="auth-confirm-password"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Confirm Password
              </label>
              <input
                id="auth-confirm-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={isBusy}
                placeholder="Re-enter your password"
                className="h-10 w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-3.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={isBusy}
            className="h-11 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-60 px-5 text-sm font-semibold text-white transition-colors cursor-pointer"
          >
            {busyAction === 'email' && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>
              {mode === 'signup'
                ? busyAction === 'email'
                  ? 'Creating account...'
                  : 'Create Account'
                : mode === 'reset'
                  ? busyAction === 'email'
                    ? 'Sending reset link...'
                    : 'Send Reset Link'
                  : busyAction === 'email'
                    ? 'Signing in...'
                    : 'Sign In'}
            </span>
          </button>

          {mode === 'reset' ? (
            <button
              type="button"
              onClick={() => switchMode('signin')}
              className="w-full text-center text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline cursor-pointer pt-1"
            >
              Back to Sign In
            </button>
          ) : (
            <p className="text-center text-xs text-slate-500 dark:text-slate-400 pt-0.5">
              {mode === 'signin' ? (
                <>
                  Don&apos;t have an account?{' '}
                  <button
                    type="button"
                    onClick={() => switchMode('signup')}
                    className="font-semibold text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
                  >
                    Create Account
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => switchMode('signin')}
                    className="font-semibold text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
                  >
                    Sign In
                  </button>
                </>
              )}
            </p>
          )}
        </form>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/70 p-3.5 space-y-2 text-[11px] text-slate-600 dark:text-slate-300">
          <div className="flex items-start gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
            <span>Only you can view, inspect, edit, or download your captured archives.</span>
          </div>
          <div className="flex items-start gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
            <span>Your snapshot history syncs privately to your signed-in account.</span>
          </div>
        </div>

        <p className="text-center text-xs text-slate-500 dark:text-slate-400">
          By continuing, you agree to capture only websites you own or have permission to copy.{' '}
          <button
            type="button"
            onClick={onReadTerms}
            className="text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
          >
            Read Terms
          </button>
        </p>
      </div>
    </section>
  );
}
