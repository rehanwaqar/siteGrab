import { useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import {
  CheckCircle2,
  FolderGit2,
  Loader2,
  LogOut,
  Mail,
  ShieldCheck,
  User as UserIcon,
  X,
} from 'lucide-react';
import { updateAccountDisplayName } from '../firebase';

interface AccountModalProps {
  user: User;
  snapshotsCount: number;
  onClose: () => void;
  onProfileUpdated: (newName: string) => void;
  onSignOut: () => void;
}

function getProviderLabel(user: User): string {
  const providerIds = user.providerData.map((p) => p.providerId);
  if (providerIds.includes('google.com')) return 'Google';
  if (providerIds.includes('apple.com')) return 'Apple';
  if (providerIds.includes('github.com')) return 'GitHub';
  if (providerIds.includes('password')) return 'Email & Password';
  return 'Firebase Auth';
}

export function AccountModal({
  user,
  snapshotsCount,
  onClose,
  onProfileUpdated,
  onSignOut,
}: AccountModalProps) {
  const [displayName, setDisplayName] = useState(
    user.displayName || user.email?.split('@')[0] || '',
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const providerLabel = getProviderLabel(user);
  const initial = (user.displayName || user.email || 'U')[0].toUpperCase();

  const handleSaveName = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaveMessage(null);
    const cleaned = displayName.trim();
    if (!cleaned) {
      setError('Please enter a display name.');
      return;
    }

    setIsSaving(true);
    try {
      await updateAccountDisplayName(user, cleaned);
      onProfileUpdated(cleaned);
      setSaveMessage('Display name updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update display name.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-xs px-4"
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-5 py-4">
          <div className="flex items-center gap-2">
            <UserIcon className="h-4 w-4 text-sky-500" />
            <h2
              id="account-modal-title"
              className="font-display text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              Account & Private Workspace
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close account modal"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-200 transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Identity summary */}
          <div className="flex items-center gap-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-[#0B0F17]/70 p-3.5">
            {user.photoURL ? (
              <img
                src={user.photoURL}
                alt={user.displayName || 'Account avatar'}
                referrerPolicy="no-referrer"
                className="h-11 w-11 rounded-full object-cover shrink-0 border border-slate-300 dark:border-slate-700"
              />
            ) : (
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-sky-600 text-sm font-bold text-white shrink-0">
                {initial}
              </span>
            )}
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                {user.displayName || user.email?.split('@')[0] || 'SiteGrab User'}
              </div>
              {user.email && (
                <div className="flex items-center gap-1.5 truncate text-xs text-slate-500 dark:text-slate-400">
                  <Mail className="h-3 w-3 shrink-0" />
                  <span className="truncate">{user.email}</span>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px]">
                <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] px-2 py-0.5 font-medium text-slate-700 dark:text-slate-300">
                  {providerLabel}
                </span>
                {user.emailVerified && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="h-3 w-3" />
                    Verified
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Workspace summary */}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/60 p-3">
              <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                <FolderGit2 className="h-3.5 w-3.5 text-sky-500" />
                <span>Saved Snapshots</span>
              </div>
              <div className="mt-1 font-mono text-base font-semibold text-slate-900 dark:text-slate-100">
                {snapshotsCount}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/60 p-3">
              <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                <span>Workspace Access</span>
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
                Owner Only
              </div>
            </div>
          </div>

          {/* Display name update form */}
          <form onSubmit={(e) => void handleSaveName(e)} className="space-y-2.5">
            <label
              htmlFor="account-display-name"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              Display Name
            </label>
            <div className="flex gap-2">
              <input
                id="account-display-name"
                type="text"
                maxLength={120}
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setSaveMessage(null);
                }}
                disabled={isSaving}
                placeholder="Your name"
                className="h-10 flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-3 text-xs text-slate-900 dark:text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20"
              />
              <button
                type="submit"
                disabled={isSaving}
                className="h-10 inline-flex items-center justify-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-60 px-4 text-xs font-semibold text-white transition-colors cursor-pointer"
              >
                {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>Save</span>
              </button>
            </div>
            {error && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            {saveMessage && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400">{saveMessage}</p>
            )}
          </form>

          {/* Actions */}
          <div className="flex items-center justify-between gap-3 border-t border-slate-200 dark:border-slate-800 pt-4">
            <button
              type="button"
              onClick={onSignOut}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 hover:bg-red-100 dark:hover:bg-red-950/50 px-3.5 py-2 text-xs font-semibold text-red-700 dark:text-red-300 transition-colors cursor-pointer"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign out</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] hover:bg-slate-100 dark:hover:bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
