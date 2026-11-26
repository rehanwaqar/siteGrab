import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    message: '',
  };

  public static getDerivedStateFromError(error: Error): State {
    let message = 'An unexpected error occurred in SiteGrab.';
    try {
      const parsed = JSON.parse(error.message) as { error?: string };
      if (parsed && typeof parsed.error === 'string') {
        message = parsed.error;
      }
    } catch {
      if (error.message) {
        message = error.message;
      }
    }
    return { hasError: true, message };
  }

  public componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Uncaught ErrorBoundary exception:', error, info);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#0B0F17] text-slate-100 p-6">
          <div className="max-w-md w-full rounded-xl border border-red-900/60 bg-[#111827] p-6 space-y-4">
            <div className="flex items-center gap-2.5 text-red-400">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <h1 className="text-base font-semibold">Something went wrong</h1>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed break-words">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, message: '' });
                window.location.reload();
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-sky-600 hover:bg-sky-500 px-4 py-2 text-xs font-semibold text-white transition-colors cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Reload SiteGrab</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
