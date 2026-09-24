import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { createApiClient, type ApiClient, ApiRequestError } from '@pencillift/contracts/client';
import { unconfiguredAuth, type AuthAdapter, type ParentSession } from './auth.ts';
import { readWebConfig, type WebConfig } from './config.ts';
import { Loading, Notice } from '../components/states.tsx';

export interface SessionValue {
  readonly config: WebConfig;
  readonly auth: AuthAdapter;
  readonly api: ApiClient;
}

const SessionContext = createContext<SessionValue | null>(null);

export function createDefaultSession(
  config = readWebConfig(),
  auth: AuthAdapter = unconfiguredAuth,
): SessionValue {
  const api = createApiClient(
    config.apiBaseUrl,
    async () => (await auth.currentSession())?.accessToken ?? null,
  );
  return { config, auth, api };
}

export function SessionProvider({ value, children }: { value: SessionValue; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

type ParentState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'signed_out' }
  | { status: 'signed_in'; session: ParentSession };

export function useParentSession(): ParentState {
  const { auth } = useSession();
  const [state, setState] = useState<ParentState>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    if (!auth.configured) {
      setState({ status: 'unconfigured' });
      return;
    }
    const refresh = () => {
      void auth.currentSession().then((session) => {
        if (active) setState(session ? { status: 'signed_in', session } : { status: 'signed_out' });
      });
    };
    refresh();
    const unsubscribe = auth.onChange?.(refresh);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [auth]);
  return state;
}

function SignInPrompt() {
  const location = useLocation();
  const next = encodeURIComponent(`${location.pathname}${location.search}`);
  return (
    <Notice>
      Please <Link to={`/sign-in?next=${next}`}>sign in</Link> to see your family.
    </Notice>
  );
}

/** Gate for parent-portal pages. Never renders protected content without a signed-in parent. */
export function RequireParent({ children }: { children: ReactNode }) {
  const state = useParentSession();
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'unconfigured') {
    return (
      <Notice>
        <strong>Parent sign-in isn’t available yet.</strong> The PencilLift account service has not
        been connected in this environment, so no family data can be shown.
      </Notice>
    );
  }
  if (state.status === 'signed_out') return <SignInPrompt />;
  return <>{children}</>;
}

export type QueryState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: ApiRequestError }
  | { status: 'ready'; data: T };

/** Minimal data hook with explicit loading/error/ready states (spec P14: no blank or fake screens). */
export function useApiQuery<T>(
  load: (api: ApiClient) => Promise<T>,
  deps: readonly unknown[],
): QueryState<T> & { reload: () => void } {
  const { api } = useSession();
  const [state, setState] = useState<QueryState<T>>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    load(api).then(
      (data) => active && setState({ status: 'ready', data }),
      (error: unknown) =>
        active &&
        setState({
          status: 'error',
          error:
            error instanceof ApiRequestError
              ? error
              : new ApiRequestError('INTERNAL', 'Something went wrong.', 0),
        }),
    );
    return () => {
      active = false;
    };
    // `deps` is spread deliberately: callers pass the values their loader closes over.
  }, [api, version, ...deps]);
  return { ...state, reload };
}
