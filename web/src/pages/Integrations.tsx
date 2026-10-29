import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { get } from '../lib/api';
import { useUser } from '../lib/session';
import type { IntegrationView, SourcesResponse } from '../lib/types';
import { CenterLoading, ErrorState, PageHeader, ProviderMark, Time } from '../components/ui';

export const SERVICE_COPY: Record<string, { name: string; role: string }> = {
  jellyfin: { name: 'Jellyfin', role: 'Library availability and viewing progress' },
  seerr: { name: 'Seerr', role: 'Requests and their status' },
  tmdb: { name: 'TMDb', role: 'Artwork, synopses and title matching' },
  trakt: { name: 'Trakt API App', role: 'Required for Trakt lists and sign-in' },
};

function StatusText({ v }: { v: Pick<IntegrationView, 'ready' | 'status' | 'lastOkAt'> }) {
  if (!v.ready) return <span className="inline footnote secondary"><span className="dot dot-gray" aria-hidden />Not set up</span>;
  if (v.status === 'error') return <span className="inline footnote" style={{ color: 'var(--red)' }}><span className="dot dot-red" aria-hidden />Connection problem</span>;
  return (
    <span className="inline footnote secondary">
      <span className="dot dot-green" aria-hidden />
      {v.lastOkAt ? <>Connected · <Time iso={v.lastOkAt} /></> : 'Connected'}
    </span>
  );
}

export function IntegrationsPage() {
  const { isAdmin, services } = useUser();
  const ints = useQuery({ queryKey: ['integrations'], queryFn: () => get<{ integrations: IntegrationView[] }>('/integrations') });
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => get<SourcesResponse>('/sources') });
  if (ints.isLoading || sources.isLoading) return <CenterLoading />;
  if (ints.isError) return <ErrorState error={ints.error} onRetry={() => ints.refetch()} />;
  if (sources.isError) return <ErrorState error={sources.error} onRetry={() => sources.refetch()} />;
  const s = sources.data!;

  const account = [
    {
      id: 'jellyfin',
      name: 'Jellyfin Account',
      sub: s.jellyfin.linked ? `Linked as ${s.jellyfin.linked.username ?? 'your account'}` : s.jellyfin.available ? 'Not linked · needed for viewing progress' : 'Jellyfin server not connected',
      ok: Boolean(s.jellyfin.linked),
    },
    {
      id: 'seerr',
      name: 'Seerr Account',
      sub: s.seerr.linked ? `Requests as ${s.seerr.linked.username ?? `user #${s.seerr.linked.userId}`}` : s.seerr.available ? 'Not linked · ask an administrator' : 'Seerr not connected',
      ok: Boolean(s.seerr.linked),
    },
    ...s.sources.map((src) => ({
      id: src.id,
      href: src.id === 'trakt' || src.id === 'letterboxd' ? `/integrations/${src.id}` : `/integrations/sources/${src.id}`,
      name: src.name,
      sub:
        src.id === 'trakt'
          ? src.connection
            ? src.connection.status === 'needs_reauth'
              ? 'Sign-in expired · reconnect'
              : `Signed in as ${src.connection.accountName}`
            : src.available
              ? 'Not connected'
              : 'Waiting for an administrator to add the Trakt app'
          : src.id === 'letterboxd'
            ? src.connection
              ? `${src.connection.accountName} · ${src.listCount} ${src.listCount === 1 ? 'list' : 'lists'}`
              : `${src.listCount ? `${src.listCount} ${src.listCount === 1 ? 'list' : 'lists'}` : 'Add lists by link or file'}`
            : src.listCount
              ? `${src.listCount} ${src.listCount === 1 ? 'list' : 'lists'}`
              : src.link && src.upload
                ? 'Add lists by link or file'
                : src.link
                  ? 'Add lists by link'
                  : 'Import by file upload',
      ok: src.id === 'trakt' ? src.connection?.status === 'connected' : src.listCount > 0,
    })),
  ];

  return (
    <>
      <PageHeader title="Integrations" subtitle="Connect your media server, request manager and watchlist sources." />
      <div className="stack-l">
        <section aria-labelledby="server-h">
          <h2 className="group-title" id="server-h">
            Server Connections{!isAdmin && ' · managed by an administrator'}
          </h2>
          <div className="group">
            {ints.data!.integrations.map((v) => (
              <Link key={v.provider} to={`/integrations/${v.provider}`} className="row row-link">
                <ProviderMark provider={v.provider} size={36} />
                <div className="row-main">
                  <div className="row-title">{SERVICE_COPY[v.provider]!.name}</div>
                  <div className="row-sub">{SERVICE_COPY[v.provider]!.role}</div>
                </div>
                <StatusText v={v} />
                <ChevronRight size={18} className="row-chevron" aria-hidden />
              </Link>
            ))}
          </div>
          {!services.tmdb && services.seerr && <p className="group-footer">Without a TMDb token, artwork and matching use Seerr’s built-in TMDb access.</p>}
        </section>
        <section aria-labelledby="acct-h">
          <h2 className="group-title" id="acct-h">
            Your Accounts and Sources
          </h2>
          <div className="group">
            {account.map((a) => (
              <Link key={a.id + a.name} to={'href' in a && a.href ? a.href : `/integrations/${a.id}`} className="row row-link">
                <ProviderMark provider={a.id} size={36} />
                <div className="row-main">
                  <div className="row-title">{a.name}</div>
                  <div className="row-sub">{a.sub}</div>
                </div>
                {a.ok && <span className="dot dot-green" aria-label="Connected" />}
                <ChevronRight size={18} className="row-chevron" aria-hidden />
              </Link>
            ))}
          </div>
          <p className="group-footer">Your watchlist connections are private to your account.</p>
        </section>
      </div>
    </>
  );
}
